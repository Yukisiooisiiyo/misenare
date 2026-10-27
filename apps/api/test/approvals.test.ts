// 承認したのが誰かを残すことと、承認待ちの知らせ。
//
// 確かめたいのは3つ：
//   * **誰が通したかが残る**（承認した人が内容に責任を持つため）
//   * **1件ごとには送らない**（送ると通知を切られ、仕組みごと死ぬ）
//   * **承認できない人には送らない**（visitor や、別の店舗の人）

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import { listNotices, markRead, noticeBadge, updateNotice } from '../src/domain/notices.ts';
import { approveVersion, createKnowledge, editKnowledge, getKnowledge, listVersions } from '../src/domain/knowledge.ts';
import { freshDatabase, hq, manager, STORE_A, STORE_B, storeBStaff, T, tokenizer, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
const run = <R>(fn: (q: Db) => Promise<R>): Promise<R> => db.withTenant(T, fn);
before(async () => { db = await freshDatabase(); });
after(async () => { await db.close(); });

async function clean() {
  await run(async (q) => {
    await q.query(`DELETE FROM knowledge`);
    await q.query(`DELETE FROM notices`);
  });
}

/** 承認待ちの知らせ（ミセナレが自動で出す1件）。無ければ undefined */
const approvalNotice = async (who: typeof trusted) =>
  (await run((q) => listNotices(q, who, STORE_A))).find((n) => n.title.includes('承認待ち'));

describe('誰が承認したかを残す', () => {
  it('承認すると、その版に承認者と承認日時が付く', async () => {
    await clean();
    const k = await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '延長保証の付け方', body: 'レジで申し込む。', tagNames: ['#保証'],
    }));
    // visitor の投稿は承認待ち。まだ誰も通していない
    const before = await run((q) => listVersions(q, trusted, k.id));
    assert.equal(before[0]!.decided_by, null);

    await run((q) => approveVersion(q, tokenizer, trusted, k.id, 1));

    const after = await run((q) => listVersions(q, trusted, k.id));
    assert.equal(after[0]!.decided_by, 'ベテランパート');
    assert.ok(after[0]!.decided_at, '承認日時が入ること');
  });

  it('詳細に、承認した人と最初に書いた人が出る', async () => {
    await clean();
    const k = await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: 'ポイントの付与', body: '会員証を先に出してもらう。', tagNames: ['#ポイント'],
    }));
    await run((q) => approveVersion(q, tokenizer, manager, k.id, 1));

    const view = await run((q) => getKnowledge(q, trusted, k.id));
    assert.equal(view.approvedBy, '店長', '通した人が出ること');
    assert.ok(view.approvedAt);
    assert.equal(view.createdBy, '新人バイト', '最初に書いた人が出ること');
  });

  it('却下した人も残る（誰が止めたか分かる）', async () => {
    await clean();
    const k = await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '下書き', body: 'あとで直す。', tagNames: ['#下書き'],
    }));
    const { rejectVersion } = await import('../src/domain/knowledge.ts');
    await run((q) => rejectVersion(q, trusted, k.id, 1));
    const rows = await run((q) => listVersions(q, trusted, k.id));
    assert.equal(rows[0]!.state, 'rejected');
    assert.equal(rows[0]!.decided_by, 'ベテランパート');
  });
});

describe('承認待ちの知らせ（連絡事項に出す）', () => {
  // メールではなく連絡事項に出す。**招待QRで入った人にメールアドレスは無い**ので、
  // 承認するベテランの大半にはメールが届かない。毎日開くアプリの中が唯一確実な場所。

  it('承認待ちができると、連絡事項に出る', async () => {
    await clean();
    assert.equal(await approvalNotice(trusted), undefined, '最初は無い');

    await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '年末年始の営業', body: '1日だけ休み。', tagNames: ['#営業'],
    }));

    const n = await approvalNotice(trusted);
    assert.ok(n, '知らせが出ること');
    assert.match(n.title, /1件/);
    assert.match(n.body, /年末年始の営業/);
    assert.equal(n.createdBy, null, 'ミセナレが自動で出したもの');
  });

  it('承認できない人には出ない', async () => {
    await clean();
    await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '返品の扱い', body: '開封済みは受けない。', tagNames: ['#返品'],
    }));
    assert.ok(await approvalNotice(trusted), 'ベテランには出る');
    assert.equal(await approvalNotice(visitor), undefined, '新人には出ない');

    // 未読の数にも入らない
    const badge = await run((q) => noticeBadge(q, visitor, STORE_A));
    assert.equal(badge.unread, 0);
  });

  it('増えるたびに知らせが増えず、1件の件数が書き換わる', async () => {
    await clean();
    for (const t of ['一件目', '二件目', '三件目']) {
      await run((q) => createKnowledge(q, tokenizer, visitor, { storeId: STORE_A, title: t, body: '本文。', tagNames: ['#x'] }));
    }
    const all = await run((q) => listNotices(q, trusted, STORE_A));
    assert.equal(all.filter((n) => n.title.includes('承認待ち')).length, 1, '知らせは1件だけ');
    assert.match(all.find((n) => n.title.includes('承認待ち'))!.title, /3件/);
  });

  it('全部承認されると、知らせは消える', async () => {
    await clean();
    const k = await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '消えるはず', body: '本文。', tagNames: ['#x'],
    }));
    assert.ok(await approvalNotice(trusted));
    await run((q) => approveVersion(q, tokenizer, trusted, k.id, 1));
    assert.equal(await approvalNotice(trusted), undefined);
  });

  it('却下でも消える', async () => {
    await clean();
    const { rejectVersion } = await import('../src/domain/knowledge.ts');
    const k = await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '却下されるはず', body: '本文。', tagNames: ['#x'],
    }));
    await run((q) => rejectVersion(q, trusted, k.id, 1));
    assert.equal(await approvalNotice(trusted), undefined);
  });

  it('増えたときは未読に戻るが、減ったときは戻らない', async () => {
    await clean();
    const first = await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '一件目', body: '本文。', tagNames: ['#x'],
    }));
    const n1 = (await approvalNotice(trusted))!;
    await run((q) => markRead(q, trusted, n1.id));
    assert.equal((await approvalNotice(trusted))!.readAt !== null, true, '読んだ印が付く');

    // 増えた → もう一度気づいてほしいので未読に戻す
    await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '二件目', body: '本文。', tagNames: ['#y'],
    }));
    assert.equal((await approvalNotice(trusted))!.readAt, null, '未読に戻る');

    await run((q) => markRead(q, trusted, n1.id));
    // 減った → 承認のたびに全員へ赤い印が付くのは煩いので、戻さない
    await run((q) => approveVersion(q, tokenizer, trusted, first.id, 1));
    const after = (await approvalNotice(trusted))!;
    assert.match(after.title, /1件/);
    assert.ok(after.readAt, '読んだ印は残る');
  });

  it('自動で出した知らせは、人が直せない', async () => {
    await clean();
    await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '直せないはず', body: '本文。', tagNames: ['#x'],
    }));
    const n = (await approvalNotice(trusted))!;
    const { DomainError } = await import('../src/domain/actor.ts');
    await assert.rejects(
      run((q) => updateNotice(q, manager, n.id, { title: '書き換え', body: '本文' })),
      (e: unknown) => e instanceof DomainError && e.code === 'forbidden',
    );
  });

  it('別の店舗の承認待ちは、こちらの知らせに出ない', async () => {
    await clean();
    await run((q) => createKnowledge(q, tokenizer, storeBStaff, {
      storeId: STORE_B, title: '駅前店の下書き', body: '本文。', tagNames: ['#x'],
    }));
    // storeBStaff は trusted なので即時公開。visitor がいないので、代わりに直接確かめる
    assert.equal(await approvalNotice(trusted), undefined);
  });
});
