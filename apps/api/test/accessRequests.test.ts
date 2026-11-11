// 利用の申請。会社のアカウントで入れたが、登録がまだの人を、店長が見て決める。
//
// 確かめたいのは2つ：
//   * 行き止まりにならない（申請が残り、店長の一覧に出る）
//   * **相手の IdP が名乗った名前を鵜呑みにしない**（直せる・同名を知らせる）

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DomainError } from '../src/domain/actor.ts';
import { OidcDirectory } from '../src/auth/oidc.ts';
import { approveRequest, getNotifySettings, listRequests, pendingDigest, rejectRequest, requestBadge, setNotifyEmail } from '../src/domain/accessRequests.ts';
import { runNightly } from '../src/batch/nightly.ts';
import { addProvider, finishSso, startSso } from '../src/domain/sso.ts';
import { verifySession } from '../src/domain/users.ts';
import { claimsFor, fakeIdp, type FakeIdp } from './ssoHelper.ts';
import { freshDatabase, hq, manager, OTHER_T, otherTenant, STORE_A, STORE_B, T, tokenizer, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
before(async () => { db = await freshDatabase(); });
after(async () => { await db.close(); });

const SITE = { redirectUri: 'https://misenare.example.com/api/auth/sso/callback' };
let idp: FakeIdp;
let directory: OidcDirectory;

async function clean() {
  await db.withTenant(T, async (q) => {
    await q.query(`DELETE FROM access_requests`);
    await q.query(`DELETE FROM sso_identities`);
    await q.query(`DELETE FROM sso_domains`);
    await q.query(`DELETE FROM sso_providers`);
    await q.query(`DELETE FROM sessions`);
    await q.query(`DELETE FROM memberships WHERE user_id NOT IN ($1, $2, $3, $4)`,
      [trusted.userId, manager.userId, hq.userId, visitor.userId]);
    await q.query(`DELETE FROM users WHERE email IS NOT NULL`);
    await q.query(`UPDATE users SET email = NULL`);
    await q.query(`DELETE FROM tenant_settings`);
  });
}

async function setup() {
  // 前の試験が途中で落ちても次が動くように、先に片付ける
  await clean();
  idp = fakeIdp();
  directory = new OidcDirectory(idp.fetch);
  await db.withTenant(T, (q) => addProvider(q, hq, {
    issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret,
    domains: ['kdenki.example.co.jp'],
  }));
  // ドメインは DNS に印を置くまで入口で使われない（なりすまし対策）。
  // ここでは置けたことにする。印そのものの試験は sso.test.ts。
  await db.withTenant(T, (q) => q.query(`UPDATE sso_domains SET verified_at = now() WHERE tenant_id = $1`, [T]));
}

/** 会社のアカウントで入ろうとする（登録が無いので弾かれる） */
async function knock(over: Record<string, unknown> = {}) {
  const start = await startSso(db, directory, SITE, { email: 'tanaka@kdenki.example.co.jp' });
  const url = new URL(start.authorizeUrl);
  idp.issue(claimsFor(idp, { nonce: url.searchParams.get('nonce')!, ...over }));
  return finishSso(db, directory, SITE, { code: 'c', state: url.searchParams.get('state')! });
}

describe('利用の申請', () => {
  it('弾かれたら申請になり、店長の一覧に出る', async () => {
    await setup();
    await assert.rejects(knock(), /利用の申請を出しました/);
    const list = await db.withTenant(T, (q) => listRequests(q, manager));
    assert.equal(list.length, 1);
    assert.equal(list[0]!.email, 'tanaka@kdenki.example.co.jp');
    assert.equal(list[0]!.claimedName, '田中 太郎');
    assert.equal(list[0]!.attempts, 1);
    await clean();
  });

  it('2回目からは「まだ承認されていません」になり、申請は増えない', async () => {
    await setup();
    await assert.rejects(knock(), /利用の申請を出しました/);
    await assert.rejects(knock(), /まだ承認されていません/);
    await assert.rejects(knock(), /まだ承認されていません/);
    const list = await db.withTenant(T, (q) => listRequests(q, manager));
    assert.equal(list.length, 1, '同じ人で申請が増えている');
    assert.equal(list[0]!.attempts, 3, '入ろうとした回数を数える（急いでいる人を先に見られる）');
    await clean();
  });

  it('承認すると利用者が作られ、次は入れる', async () => {
    await setup();
    await assert.rejects(knock(), /申請を出しました/);
    const [req] = await db.withTenant(T, (q) => listRequests(q, manager));
    const approved = await db.withTenant(T, (q) => approveRequest(q, manager, req!.id, { storeId: STORE_A }));

    const rows = await db.withTenant(T, (q) => q.query<{ name: string; trust_level: string; email: string }>(
      `SELECT name, trust_level, email FROM users WHERE id = $1`, [approved.userId]));
    assert.equal(rows[0]!.name, '田中 太郎');
    assert.equal(rows[0]!.trust_level, 'visitor', '作ったばかりの人の投稿は承認を通す');
    assert.equal(rows[0]!.email, 'tanaka@kdenki.example.co.jp');

    // 入れるようになる
    const result = await knock();
    assert.equal(result.userId, approved.userId);
    const session = await db.withTenant(T, (q) => verifySession(q, result.sessionToken));
    assert.equal(session?.userId, approved.userId);

    // 一覧からは消える
    assert.equal((await db.withTenant(T, (q) => listRequests(q, manager))).length, 0);
    await clean();
  });

  it('同じメールの既存の利用者が無効化されていたら、承認しても結びつけない', async () => {
    await setup();
    await assert.rejects(knock(), /申請を出しました/);
    await db.withTenant(T, (q) => q.query(
      `INSERT INTO users (tenant_id, name, trust_level, email, status) VALUES ($1, '辞めた田中', 'visitor', 'tanaka@kdenki.example.co.jp', 'disabled')`, [T]));
    const [req] = await db.withTenant(T, (q) => listRequests(q, manager));
    await assert.rejects(
      db.withTenant(T, (q) => approveRequest(q, manager, req!.id, { storeId: STORE_A })),
      (e: unknown) => e instanceof DomainError && e.code === 'conflict' && /無効化されています/.test(e.message));
    assert.equal((await db.withTenant(T, (q) => listRequests(q, manager))).length, 1, '申請は残る');
    await clean();
  });

  it('名前は承認する人が直せる（IdP が名乗った名前を鵜呑みにしない）', async () => {
    await setup();
    await assert.rejects(knock({ name: '店長' }), /申請を出しました/);
    const [req] = await db.withTenant(T, (q) => listRequests(q, manager));
    assert.equal(req!.claimedName, '店長');
    const approved = await db.withTenant(T, (q) => approveRequest(q, manager, req!.id, {
      storeId: STORE_A, name: '田中（応援）',
    }));
    const rows = await db.withTenant(T, (q) => q.query<{ name: string }>(
      `SELECT name FROM users WHERE id = $1`, [approved.userId]));
    assert.equal(rows[0]!.name, '田中（応援）');
    await clean();
  });

  it('すでに同じ名前の人がいれば、一覧で知らせる', async () => {
    await setup();
    const existing = await db.withTenant(T, (q) => q.query<{ name: string }>(
      `SELECT name FROM users WHERE id = $1`, [trusted.userId]));
    await assert.rejects(knock({ name: existing[0]!.name }), /申請を出しました/);
    const [req] = await db.withTenant(T, (q) => listRequests(q, manager));
    assert.equal(req!.nameTaken, true);
    await clean();
  });

  it('断ると、入り直しても申請に戻らない', async () => {
    await setup();
    await assert.rejects(knock(), /申請を出しました/);
    const [req] = await db.withTenant(T, (q) => listRequests(q, manager));
    await db.withTenant(T, (q) => rejectRequest(q, manager, req!.id));
    await assert.rejects(knock(), /断られています/);
    assert.equal((await db.withTenant(T, (q) => listRequests(q, manager))).length, 0);
    await clean();
  });

  it('店長でない人は、申請を見られない・決められない', async () => {
    await setup();
    await assert.rejects(knock(), /申請を出しました/);
    const [req] = await db.withTenant(T, (q) => listRequests(q, manager));
    await db.withTenant(T, async (q) => {
      await assert.rejects(listRequests(q, trusted), /店長か本部/);
      await assert.rejects(approveRequest(q, trusted, req!.id, { storeId: STORE_A }), /店長か本部/);
      await assert.rejects(rejectRequest(q, visitor, req!.id), /店長か本部/);
    });
    await clean();
  });

  it('店長は自分の店舗にしか配属できない', async () => {
    await setup();
    await assert.rejects(knock(), /申請を出しました/);
    const [req] = await db.withTenant(T, (q) => listRequests(q, manager));
    await db.withTenant(T, async (q) => {
      await assert.rejects(approveRequest(q, manager, req!.id, { storeId: STORE_B }), /自分の店舗/);
      // 本部は店舗を選べる
      await approveRequest(q, hq, req!.id, { storeId: STORE_B });
    });
    await clean();
  });

  it('ホームに出す数は、店長・本部にだけ返す', async () => {
    // 承認・管理を開かないと気づけないと、申請した人がいつまでも待つことになる。
    // ただし、申請者のメールアドレスが絡む話なので、数を見せるのも管理者だけにする。
    await setup();
    await assert.rejects(knock(), /申請を出しました/);
    await db.withTenant(T, async (q) => {
      assert.deepEqual(await requestBadge(q, manager), { pending: 1 });
      assert.deepEqual(await requestBadge(q, hq), { pending: 1 });
      assert.deepEqual(await requestBadge(q, trusted), { pending: 0 }, 'trusted には見せない');
      assert.deepEqual(await requestBadge(q, visitor), { pending: 0 });
    });
    // 決めたら数が減る
    const [req] = await db.withTenant(T, (q) => listRequests(q, manager));
    await db.withTenant(T, (q) => rejectRequest(q, manager, req!.id));
    await db.withTenant(T, async (q) => {
      assert.deepEqual(await requestBadge(q, manager), { pending: 0 });
    });
    await clean();
  });

  it('同じ申請を2人が同時に承認しても、1人しか通らない', async () => {
    await setup();
    await assert.rejects(knock(), /申請を出しました/);
    const [req] = await db.withTenant(T, (q) => listRequests(q, manager));
    const results = await Promise.allSettled([
      db.withTenant(T, (q) => approveRequest(q, manager, req!.id, { storeId: STORE_A })),
      db.withTenant(T, (q) => approveRequest(q, hq, req!.id, { storeId: STORE_A })),
    ]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    const users = await db.withTenant(T, (q) => q.query(`SELECT 1 FROM users WHERE email = 'tanaka@kdenki.example.co.jp'`));
    assert.equal(users.length, 1);
    await clean();
  });

  it('同じ申請を2回決められない', async () => {
    await setup();
    await assert.rejects(knock(), /申請を出しました/);
    const [req] = await db.withTenant(T, (q) => listRequests(q, manager));
    await db.withTenant(T, (q) => approveRequest(q, manager, req!.id, { storeId: STORE_A }));
    await db.withTenant(T, async (q) => {
      await assert.rejects(approveRequest(q, manager, req!.id, { storeId: STORE_A }), /見つかりません/);
      await assert.rejects(rejectRequest(q, manager, req!.id), /見つかりません/);
    });
    await clean();
  });
});

describe('本部への知らせ', () => {
  /** 送ったものを覚えるだけの送り口 */
  function recorder() {
    const sent: Array<{ to: string[]; subject: string; text: string }> = [];
    return {
      sent,
      mailer: { send: async (m: { to: string[]; subject: string; text: string }) => { sent.push(m); return true; } },
    };
  }

  it('送り先を決めていなければ、送らない', async () => {
    await setup();
    await assert.rejects(knock(), /申請を出しました/);
    const box = recorder();
    const [report] = await runNightly(db, tokenizer, { mailer: box.mailer });
    assert.equal(report!.notifiedRequests, false);
    assert.equal(box.sent.length, 0);
    await clean();
  });

  it('申請があれば、会社の窓口に送る（誰のことか分かる文面で）', async () => {
    await setup();
    await db.withTenant(T, (q) => setNotifyEmail(q, hq, 'joho-system@kdenki.example.co.jp'));
    await assert.rejects(knock(), /申請を出しました/);
    const box = recorder();
    const [report] = await runNightly(db, tokenizer, { mailer: box.mailer, appUrl: 'https://misenare.example.com' });
    assert.equal(report!.notifiedRequests, true);
    assert.equal(box.sent.length, 1);
    const mail = box.sent[0]!;
    assert.deepEqual(mail.to, ['joho-system@kdenki.example.co.jp']);
    assert.ok(mail.subject.includes('1件'), mail.subject);
    // 受け取った本部が「誰のことか」分かる必要がある
    assert.ok(mail.text.includes('tanaka@kdenki.example.co.jp'), mail.text);
    assert.ok(mail.text.includes('田中 太郎'), mail.text);
    assert.ok(mail.text.includes('https://misenare.example.com/app/#/manage'), mail.text);
    await clean();
  });

  it('同じ申請で毎晩送らない（1か月で30通にしない）', async () => {
    await setup();
    await db.withTenant(T, (q) => setNotifyEmail(q, hq, 'joho-system@kdenki.example.co.jp'));
    await assert.rejects(knock(), /申請を出しました/);
    const box = recorder();
    await runNightly(db, tokenizer, { mailer: box.mailer });
    assert.equal(box.sent.length, 1);
    // 2晩目は送らない
    const [second] = await runNightly(db, tokenizer, { mailer: box.mailer });
    assert.equal(second!.notifiedRequests, false);
    assert.equal(box.sent.length, 1, '同じ申請で2回送っている');
    await clean();
  });

  it('新しい申請が来たら、また送る', async () => {
    await setup();
    await db.withTenant(T, (q) => setNotifyEmail(q, hq, 'joho-system@kdenki.example.co.jp'));
    await assert.rejects(knock(), /申請を出しました/);
    const box = recorder();
    await runNightly(db, tokenizer, { mailer: box.mailer });
    assert.equal(box.sent.length, 1);
    // 別の人が入ろうとする
    await assert.rejects(knock({ sub: 'idp-user-2', email: 'suzuki@kdenki.example.co.jp', name: '鈴木 花子' }),
      /申請を出しました/);
    await runNightly(db, tokenizer, { mailer: box.mailer });
    assert.equal(box.sent.length, 2);
    assert.ok(box.sent[1]!.subject.includes('2件'), box.sent[1]!.subject);
    await clean();
  });

  it('週に1回は念押しする（放置されたままにしない）', async () => {
    await setup();
    await db.withTenant(T, (q) => setNotifyEmail(q, hq, 'joho-system@kdenki.example.co.jp'));
    await assert.rejects(knock(), /申請を出しました/);
    const box = recorder();
    await runNightly(db, tokenizer, { mailer: box.mailer });
    assert.equal(box.sent.length, 1);
    // 8日前に知らせたことにする
    await db.withTenant(T, (q) => q.query(`UPDATE tenant_settings SET requests_notified_at = now() - interval '8 days'`));
    await runNightly(db, tokenizer, { mailer: box.mailer });
    assert.equal(box.sent.length, 2, '放置された申請の念押しが出ていない');
    await clean();
  });

  it('全部決まったら、もう送らない', async () => {
    await setup();
    await db.withTenant(T, (q) => setNotifyEmail(q, hq, 'joho-system@kdenki.example.co.jp'));
    await assert.rejects(knock(), /申請を出しました/);
    const [req] = await db.withTenant(T, (q) => listRequests(q, manager));
    await db.withTenant(T, (q) => rejectRequest(q, manager, req!.id));
    const box = recorder();
    const [report] = await runNightly(db, tokenizer, { mailer: box.mailer });
    assert.equal(report!.notifiedRequests, false);
    assert.equal(box.sent.length, 0);
    await clean();
  });

  it('送れなくても夜間バッチは止まらない（次の晩に送り直す）', async () => {
    await setup();
    await db.withTenant(T, (q) => setNotifyEmail(q, hq, 'joho-system@kdenki.example.co.jp'));
    await assert.rejects(knock(), /申請を出しました/);
    const broken = { send: async () => { throw new Error('つながりません'); } };
    const [report] = await runNightly(db, tokenizer, { mailer: broken });
    assert.equal(report!.notifiedRequests, false);
    // 印が付いていないので、次は送られる
    const box = recorder();
    await runNightly(db, tokenizer, { mailer: box.mailer });
    assert.equal(box.sent.length, 1);
    await clean();
  });

  it('送り先を触れるのは本部だけ。形も確かめる', async () => {
    await setup();
    await db.withTenant(T, async (q) => {
      await assert.rejects(setNotifyEmail(q, manager, 'a@example.com'), /本部の管理者/);
      await assert.rejects(setNotifyEmail(q, trusted, 'a@example.com'), /本部の管理者/);
      await assert.rejects(setNotifyEmail(q, hq, 'ただの文字'), /形が違います/);
      // 空にすれば止まる
      await setNotifyEmail(q, hq, 'a@example.com');
      const off = await setNotifyEmail(q, hq, '');
      assert.equal(off.notifyEmail, null);
    });
    await clean();
  });

  it('送り先は自社にだけ効く。他社の送り先を書き換えず、他社の申請が自社の宛先に来ない', async () => {
    await setup();
    await db.withTenant(T, (q) => setNotifyEmail(q, hq, 'joho-system@kdenki.example.co.jp'));
    // 他社から見ると未設定のまま
    const other = await db.withTenant(OTHER_T, (q) => getNotifySettings(q, otherTenant, true));
    assert.equal(other.notifyEmail, null);
    const otherDigest = await db.withTenant(OTHER_T, (q) => pendingDigest(q));
    assert.equal(otherDigest.to, null, '他社の宛先が自社の知らせの送り先になっている');
    // 他社が自分の送り先を決めても、自社の設定は変わらない
    await db.withTenant(OTHER_T, (q) => setNotifyEmail(q, otherTenant, 'hq@other.example.com'));
    const mine = await db.withTenant(T, (q) => getNotifySettings(q, hq, true));
    assert.equal(mine.notifyEmail, 'joho-system@kdenki.example.co.jp');
    await db.withTenant(OTHER_T, (q) => q.query(`DELETE FROM tenant_settings`));
    await clean();
  });
});
