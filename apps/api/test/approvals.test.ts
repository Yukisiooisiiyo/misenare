// 承認したのが誰かを残すことと、承認待ちの知らせ。
//
// 確かめたいのは3つ：
//   * **誰が通したかが残る**（承認した人が内容に責任を持つため）
//   * **1件ごとには送らない**（送ると通知を切られ、仕組みごと死ぬ）
//   * **承認できない人には送らない**（visitor や、別の店舗の人）

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import {
  APPROVAL_REMINDER_DAYS,
  approvalMail,
  markApprovalsNotified,
  MAX_RECIPIENTS,
  pendingApprovals,
  shouldNotifyApprovals,
  type ApprovalDigest,
} from '../src/domain/approvals.ts';
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
    await q.query(`UPDATE users SET email = NULL`);
    await q.query(`UPDATE stores SET approvals_notified_at = NULL`);
    await q.query(`UPDATE tenants SET approvals_notified_at = NULL`);
  });
}

/** その人にメールアドレスを持たせる（宛先に入る条件） */
async function withEmail(userId: string, email: string) {
  await run((q) => q.query(`UPDATE users SET email = $2 WHERE id = $1`, [userId, email]));
}

const digestFor = (list: ApprovalDigest[], storeId: string | null) =>
  list.find((d) => d.storeId === storeId);

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

describe('承認待ちの知らせ', () => {
  it('承認待ちが無ければ、知らせることも無い', async () => {
    await clean();
    assert.deepEqual(await run((q) => pendingApprovals(q)), []);
  });

  it('その店舗の trusted 以上だけが宛先になる', async () => {
    await clean();
    await withEmail(trusted.userId, 'veteran@example.com');
    await withEmail(manager.userId, 'tencho@example.com');
    await withEmail(visitor.userId, 'shinjin@example.com');       // visitor は承認できない
    await withEmail(storeBStaff.userId, 'otherstore@example.com'); // 別の店舗
    await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '年末年始の営業', body: '1日だけ休み。', tagNames: ['#営業'],
    }));

    const d = digestFor(await run((q) => pendingApprovals(q)), STORE_A);
    assert.ok(d);
    assert.deepEqual([...d.to].sort(), ['tencho@example.com', 'veteran@example.com']);
    assert.equal(d.pending, 1);
    assert.equal(d.samples[0]!.title, '年末年始の営業');
    assert.equal(d.samples[0]!.editedBy, '新人バイト');
  });

  // **いまの作りでは、全店共通ナレッジに承認待ちは生まれない。**
  // 全店共通を作るのも直すのも本部だけ（knowledge.ts）で、本部は常に trusted 扱いなので
  // その場で公開されてしまう。つまり全店共通は「本部が作って配る」形のままで、
  // 現場から上げる経路が無い。approvals.ts の storeId === null の枝は、
  // そこに経路を足したときのために置いてある。ここではその現状を固定しておく。
  it('いまは全店共通に承認待ちが生まれない（現場から上げる経路が無い）', async () => {
    await clean();
    await withEmail(hq.userId, 'honbu@example.com');
    const k = await run((q) => createKnowledge(q, tokenizer, hq, {
      storeId: null, title: '全社の接客方針', body: '最初に名乗る。', tagNames: ['#接客'],
    }));
    await run((q) => editKnowledge(q, tokenizer, hq, k.id, {
      title: '全社の接客方針', body: '最初に名乗り、用件を聞く。', tagNames: ['#接客'],
    }));
    assert.deepEqual(await run((q) => pendingApprovals(q)), [], '本部の編集は即時公開される');

    // 現場の人は全店共通を直せない（＝提案もできない）
    const { DomainError } = await import('../src/domain/actor.ts');
    await assert.rejects(
      run((q) => editKnowledge(q, tokenizer, trusted, k.id, { title: 'x', body: 'y', tagNames: ['#接客'] })),
      (e: unknown) => e instanceof DomainError && e.code === 'forbidden',
    );
  });

  it('同じ件数のまま毎晩は送らない。新しいものが来たときと、週1回だけ', async () => {
    await clean();
    await withEmail(trusted.userId, 'veteran@example.com');
    await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '返品の扱い', body: '開封済みは受けない。', tagNames: ['#返品'],
    }));

    const first = digestFor(await run((q) => pendingApprovals(q)), STORE_A)!;
    assert.equal(first.hasNew, true);
    assert.equal(shouldNotifyApprovals(first), true, '初回は送る');

    await run((q) => markApprovalsNotified(q, STORE_A));

    const second = digestFor(await run((q) => pendingApprovals(q)), STORE_A)!;
    assert.equal(second.hasNew, false, '新しい下書きは来ていない');
    assert.equal(shouldNotifyApprovals(second), false, '翌晩は送らない');

    // 1週間放っておかれたら、もう一度だけ念を押す
    const later = Date.now() + (APPROVAL_REMINDER_DAYS + 1) * 24 * 60 * 60_000;
    assert.equal(shouldNotifyApprovals(second, later), true);
  });

  it('知らせたあとに新しい下書きが来たら、また送る', async () => {
    await clean();
    await withEmail(trusted.userId, 'veteran@example.com');
    await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '一件目', body: '本文。', tagNames: ['#一'],
    }));
    await run((q) => markApprovalsNotified(q, STORE_A));
    assert.equal(shouldNotifyApprovals(digestFor(await run((q) => pendingApprovals(q)), STORE_A)!), false);

    await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '二件目', body: '本文。', tagNames: ['#二'],
    }));
    const d = digestFor(await run((q) => pendingApprovals(q)), STORE_A)!;
    assert.equal(d.hasNew, true);
    assert.equal(d.pending, 2);
    assert.equal(shouldNotifyApprovals(d), true);
  });

  it('メールアドレスを持つ人が1人もいなければ送らない', async () => {
    await clean();
    await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '宛先なし', body: '本文。', tagNames: ['#なし'],
    }));
    const d = digestFor(await run((q) => pendingApprovals(q)), STORE_A)!;
    assert.deepEqual(d.to, []);
    assert.equal(shouldNotifyApprovals(d), false);
  });

  it('宛先が多すぎる店舗には送らない（画面の一覧に任せる）', () => {
    const many: ApprovalDigest = {
      storeId: STORE_A, storeName: '本店',
      to: Array.from({ length: MAX_RECIPIENTS }, (_, i) => `v${i}@example.com`),
      pending: 3, samples: [], notifiedAt: null, hasNew: true, tooMany: true,
    };
    assert.equal(shouldNotifyApprovals(many), false);
  });

  it('文面に件数と題名が入り、本文は入らない', () => {
    const mail = approvalMail({
      storeId: STORE_A, storeName: '高石店', to: ['v@example.com'],
      pending: 7,
      samples: [{ title: '延長保証の付け方', editedBy: '新人バイト' }],
      notifiedAt: null, hasNew: true, tooMany: false,
    }, 'https://app.example.com');
    assert.match(mail.subject, /7件/);
    assert.match(mail.text, /高石店/);
    assert.match(mail.text, /延長保証の付け方（新人バイトさん）/);
    assert.match(mail.text, /ほか 6 件/);
    assert.match(mail.text, /https:\/\/app\.example\.com/);
  });
});
