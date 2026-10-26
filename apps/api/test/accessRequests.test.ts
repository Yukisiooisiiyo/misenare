// 利用の申請。会社のアカウントで入れたが、登録がまだの人を、店長が見て決める。
//
// 確かめたいのは2つ：
//   * 行き止まりにならない（申請が残り、店長の一覧に出る）
//   * **相手の IdP が名乗った名前を鵜呑みにしない**（直せる・同名を知らせる）

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { OidcDirectory } from '../src/auth/oidc.ts';
import { approveRequest, listRequests, rejectRequest, requestBadge } from '../src/domain/accessRequests.ts';
import { addProvider, finishSso, startSso } from '../src/domain/sso.ts';
import { verifySession } from '../src/domain/users.ts';
import { claimsFor, fakeIdp, type FakeIdp } from './ssoHelper.ts';
import { freshDatabase, hq, manager, STORE_A, STORE_B, T, trusted, visitor } from './helpers.ts';
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
