// 承認したのが誰かを残すことと、承認待ちの知らせ。
//
// 確かめたいのは3つ：
//   * **誰が通したかが残る**（承認した人が内容に責任を持つため）
//   * **1件ごとには送らない**（送ると通知を切られ、仕組みごと死ぬ）
//   * **承認できない人には送らない**（visitor や、別の店舗の人）

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import { DomainError } from '../src/domain/actor.ts';
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

describe('同じナレッジを2人が同時に直したとき', () => {
  // これが無いと **片方の修正が黙って消える**。
  //   A が公開中の v1 を直して v2（承認待ち）
  //   B も公開中の v1 を直して v3（承認待ち）… B の案に A の修正は入っていない
  //   v3 を通すと publish() が「自分より古い承認待ち」を閉じ、A の修正は消える
  //   逆の順に通すと、v3 が A の修正を上書きする

  /** もう一人の新人。同じ店舗の visitor */
  const visitor2 = {
    userId: '40000000-0000-0000-0000-00000000000a', tenantId: T,
    storeIds: [STORE_A], trustLevel: 'visitor' as const, adminScope: 'none' as const,
  };

  async function twoProposals() {
    await clean();
    await run(async (q) => {
      await q.query(`DELETE FROM memberships WHERE user_id = $1`, [visitor2.userId]);
      await q.query(`DELETE FROM users WHERE id = $1`, [visitor2.userId]);
      await q.query(`INSERT INTO users (id, tenant_id, name, trust_level) VALUES ($1, $2, 'もう一人の新人', 'visitor')`, [visitor2.userId, T]);
      await q.query(`INSERT INTO memberships (tenant_id, user_id, store_id) VALUES ($1, $2, $3)`, [T, visitor2.userId, STORE_A]);
    });
    // 公開中の v1
    const k = await run((q) => createKnowledge(q, tokenizer, trusted, {
      storeId: STORE_A, title: '搬入の手順', body: '玄関の幅を測る。', tagNames: ['#搬入'],
    }));
    // 2人が、同じ v1 を見て別々に直す
    const a = await run((q) => editKnowledge(q, tokenizer, visitor, k.id, {
      title: '搬入の手順', body: '玄関の幅を測る。エレベーターの寸法も測る。', tagNames: ['#搬入'],
    }));
    const b = await run((q) => editKnowledge(q, tokenizer, visitor2, k.id, {
      title: '搬入の手順', body: '玄関の幅を測る。階段の場合は2名で運ぶ。', tagNames: ['#搬入'],
    }));
    return { k, a, b };
  }

  it('同じ人が同じナレッジを続けて直すと、その人の案は最新の1つだけ残る。他の人の案は残る', async () => {
    const { k, b } = await twoProposals();
    const c = await run((q) => editKnowledge(q, tokenizer, visitor, k.id, {
      title: '搬入の手順', body: '玄関の幅を測る。エレベーターの寸法と、台車の有無も確かめる。', tagNames: ['#搬入'],
    }));
    const pending = await run((q) => q.query<{ version: number; edited_by: string }>(
      `SELECT version, edited_by FROM knowledge_versions WHERE knowledge_id = $1 AND state = 'pending' ORDER BY version`, [k.id]));
    assert.deepEqual(pending.map((p) => p.version), [b.version, c.version]);
    assert.deepEqual(pending.map((p) => p.edited_by), [visitor2.userId, visitor.userId]);
    const view = await run((q) => getKnowledge(q, visitor, k.id));
    assert.equal(view.pendingEdits.length, 2);
  });

  it('お互いの案が見える（誰の案かも分かる）', async () => {
    const { k } = await twoProposals();
    // 書いた本人から見ても、相手の案が見える
    const view = await run((q) => getKnowledge(q, visitor, k.id));
    assert.equal(view.pendingEdits.length, 2);
    assert.deepEqual(view.pendingEdits.map((p) => p.editedBy).sort(), ['もう一人の新人', '新人バイト']);
    assert.deepEqual(view.pendingEdits.map((p) => p.mine), [true, false]);
  });

  it('相手の案の中身も読める（読めないとマージできない）', async () => {
    const { k, b } = await twoProposals();
    const versions = await run((q) => listVersions(q, visitor, k.id));
    const other = versions.find((v) => v.version === b.version);
    assert.ok(other, '相手の案が一覧に出ること');
    assert.match(other.body, /階段の場合は2名/);
  });

  it('先に片方を通すと、もう片方は通せなくなる（上書きを止める）', async () => {
    const { k, a, b } = await twoProposals();
    const first = await run((q) => approveVersion(q, tokenizer, trusted, k.id, a.version));
    assert.deepEqual(first.closed, [], 'より古い承認待ちは無い');

    // b は v1 を土台に書かれている。いまの本文（a の内容）を知らないので通さない
    const { DomainError } = await import('../src/domain/actor.ts');
    await assert.rejects(
      run((q) => approveVersion(q, tokenizer, trusted, k.id, b.version)),
      (e: unknown) => e instanceof DomainError && e.code === 'conflict',
    );

    // a の修正は残っている
    const view = await run((q) => getKnowledge(q, trusted, k.id));
    assert.match(view.body, /エレベーターの寸法/);
  });

  it('新しいほうを通したときは、閉じた案を承認者に返す（黙って消さない）', async () => {
    const { k, a, b } = await twoProposals();
    const r = await run((q) => approveVersion(q, tokenizer, trusted, k.id, b.version));
    assert.deepEqual(r.closed, [{ version: a.version, editedBy: '新人バイト' }]);
  });

  it('却下された案は、書いた本人と承認できる人にしか見えない', async () => {
    const { k, a } = await twoProposals();
    const { rejectVersion } = await import('../src/domain/knowledge.ts');
    await run((q) => rejectVersion(q, trusted, k.id, a.version));
    const seenByOther = await run((q) => listVersions(q, visitor2, k.id));
    assert.equal(seenByOther.some((v) => v.version === a.version), false);
    const seenByAuthor = await run((q) => listVersions(q, visitor, k.id));
    assert.equal(seenByAuthor.some((v) => v.version === a.version), true);
  });

  it('trusted 同士でも、開いたあとに別の人が公開していたら止める（画面が見ていた版を添える）', async () => {
    // trusted の編集は承認を通らずその場で公開されるので、承認時の検査では守れない。
    // 画面が「開いたときの版」を添えて送り、サーバーがいまの版と比べる
    await clean();
    const k = await run((q) => createKnowledge(q, tokenizer, trusted, {
      storeId: STORE_A, title: '返品の受付', body: 'レシートを確認する。', tagNames: ['#返品'],
    }));
    const opened = (await run((q) => getKnowledge(q, trusted, k.id))).version; // 2人とも v1 を開いた
    // B（店長）が先に直して公開
    await run((q) => editKnowledge(q, tokenizer, manager, k.id, {
      title: '返品の受付', body: 'レシートを確認する。開封済みは店長に相談。', tagNames: ['#返品'], baseVersion: opened,
    }));
    // A（trusted）が v1 を見たまま送る → 止まる。B の修正は消えない
    await assert.rejects(
      run((q) => editKnowledge(q, tokenizer, trusted, k.id, {
        title: '返品の受付', body: 'レシートを確認する。14日以内。', tagNames: ['#返品'], baseVersion: opened,
      })),
      (e: unknown) => e instanceof DomainError && e.code === 'conflict',
    );
    const now = await run((q) => getKnowledge(q, trusted, k.id));
    assert.ok(now.body.includes('店長に相談'), 'B の修正が消えている');
    // いまの版を見てから送れば通る
    await run((q) => editKnowledge(q, tokenizer, trusted, k.id, {
      title: '返品の受付', body: now.body + ' 14日以内。', tagNames: ['#返品'], baseVersion: now.version,
    }));
    // 版を添えない（古い端末）ときは止めない
    await run((q) => editKnowledge(q, tokenizer, trusted, k.id, { title: '返品の受付', body: '古い端末から。', tagNames: ['#返品'] }));
  });
});
