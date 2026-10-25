import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/http/app.ts';
import { SessionAuthenticator } from '../src/http/auth.ts';
import { parseToken } from '../src/domain/users.ts';
import { freshDatabase, hq, OTHER_T, STORE_A, STORE_B, T, tokenizer } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
let app: (req: Request) => Promise<Response>;

before(async () => {
  db = await freshDatabase();
  app = createApp({ database: db, auth: new SessionAuthenticator(db), tokenizer });
});
after(async () => { await db.close(); });

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app(new Request(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** 本部の最初の1人：初期設定スクリプトと同じく、DB に直接招待を入れて受け取る */
async function hqSession(): Promise<string> {
  const { hashToken, issueToken } = await import('../src/domain/users.ts');
  const token = issueToken(T);
  await db.withTenant(T, (q) => q.query(
    `INSERT INTO invitations (tenant_id, token_hash, user_id, trust_level, admin_scope, expires_at)
     VALUES ($1, $2, $3, 'trusted', 'tenant', now() + interval '1 hour')`,
    [T, hashToken(token), hq.userId],
  ));
  const r = await call(null, 'POST', '/auth/accept', { token, deviceName: '本部PC' });
  assert.equal(r.status, 201);
  return r.body.sessionToken;
}

describe('招待と端末セッション', () => {
  let hqToken: string;
  let managerToken: string;
  let newbieToken: string;
  let newbieId: string;

  it('トークンは「会社ID.ランダム」の形で、DB にはハッシュだけが残る', async () => {
    hqToken = await hqSession();
    assert.deepEqual(parseToken(hqToken), { tenantId: T });
    const rows = await db.withTenant(T, (q) => q.query<{ token_hash: string }>(`SELECT token_hash FROM sessions`));
    assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash) && !hqToken.includes(r.token_hash)));
  });

  it('ログインしていない・形の違うトークン・存在しないトークンは 401', async () => {
    assert.equal((await call(null, 'GET', '/me')).status, 401);
    assert.equal((await call('garbage', 'GET', '/me')).status, 401);
    assert.equal((await call(`${T}.${'A'.repeat(43)}`, 'GET', '/me')).status, 401);
    assert.equal((await call(hqToken, 'GET', '/me')).body.adminScope, 'tenant');
  });

  it('本部は店長の招待を作れ、店長は自店舗のスタッフを招待できる', async () => {
    const inv = await call(hqToken, 'POST', '/invitations', { storeId: STORE_A, name: '佐藤店長', trustLevel: 'trusted', adminScope: 'store' });
    assert.equal(inv.status, 201);
    const accepted = await call(null, 'POST', '/auth/accept', { token: inv.body.token, deviceName: '店長のスマホ' });
    managerToken = accepted.body.sessionToken;
    const meRes = await call(managerToken, 'GET', '/me');
    assert.equal(meRes.body.name, '佐藤店長');
    assert.deepEqual(meRes.body.stores.map((s: { id: string }) => s.id), [STORE_A]);

    const staff = await call(managerToken, 'POST', '/invitations', { storeId: STORE_A, name: '新人バイトA' });
    assert.equal(staff.status, 201);
    const a = await call(null, 'POST', '/auth/accept', { token: staff.body.token, deviceName: 'iPhone' });
    newbieToken = a.body.sessionToken;
    newbieId = a.body.userId;
    assert.equal((await call(newbieToken, 'GET', '/me')).body.trustLevel, 'visitor');
  });

  it('招待は1回限り', async () => {
    const inv = await call(hqToken, 'POST', '/invitations', { storeId: STORE_B, name: '駅前のバイト' });
    assert.equal((await call(null, 'POST', '/auth/accept', { token: inv.body.token })).status, 201);
    assert.equal((await call(null, 'POST', '/auth/accept', { token: inv.body.token })).status, 409);
  });

  it('期限切れの招待は使えない', async () => {
    const inv = await call(hqToken, 'POST', '/invitations', { storeId: STORE_A, name: '遅れた人' });
    await db.withTenant(T, (q) => q.query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [inv.body.invitationId]));
    assert.equal((await call(null, 'POST', '/auth/accept', { token: inv.body.token })).status, 409);
  });

  it('店長は他店舗への招待も、店長・本部の権限付きの招待も作れない', async () => {
    assert.equal((await call(managerToken, 'POST', '/invitations', { storeId: STORE_B, name: 'x' })).status, 403);
    assert.equal((await call(managerToken, 'POST', '/invitations', { storeId: STORE_A, name: 'x', adminScope: 'store' })).status, 403);
    assert.equal((await call(newbieToken, 'POST', '/invitations', { storeId: STORE_A, name: 'x' })).status, 403);
  });

  it('他社のトークンでは自社のデータに触れない', async () => {
    const forged = `${OTHER_T}.${newbieToken.split('.')[1]}`;
    assert.equal((await call(forged, 'GET', '/me')).status, 401);
  });

  it('店長がスタッフを trusted に引き上げると、即時反映で投稿できるようになる', async () => {
    const before = await call(newbieToken, 'POST', `/stores/${STORE_A}/knowledge`, { title: 'メモ', body: '本文', tagNames: ['#メモ'] });
    assert.equal(before.body.published, false);
    const up = await call(managerToken, 'PATCH', `/users/${newbieId}`, { trustLevel: 'trusted' });
    assert.equal(up.status, 200);
    const after = await call(newbieToken, 'POST', `/stores/${STORE_A}/knowledge`, { title: 'メモ2', body: '本文', tagNames: ['#メモ'] });
    assert.equal(after.body.published, true);
    const users = await call(managerToken, 'GET', `/stores/${STORE_A}/users`);
    assert.ok(users.body.some((u: { id: string; trust_level: string; devices: number }) => u.id === newbieId && u.trust_level === 'trusted' && u.devices === 1));
  });

  it('店長は本部の権限を付けられず、自分の権限も変えられない', async () => {
    assert.equal((await call(managerToken, 'PATCH', `/users/${newbieId}`, { adminScope: 'store' })).status, 403);
    const meRes = await call(managerToken, 'GET', '/me');
    assert.equal((await call(managerToken, 'PATCH', `/users/${meRes.body.id}`, { trustLevel: 'visitor' })).status, 403);
  });

  it('無効化すると、その人の端末からは即座に使えなくなる', async () => {
    assert.equal((await call(managerToken, 'PATCH', `/users/${newbieId}`, { status: 'disabled' })).status, 200);
    assert.equal((await call(newbieToken, 'GET', '/me')).status, 401);
  });

  it('ログアウトするとその端末のトークンだけが失効する', async () => {
    assert.equal((await call(managerToken, 'POST', '/auth/logout')).status, 200);
    assert.equal((await call(managerToken, 'GET', '/me')).status, 401);
    assert.equal((await call(hqToken, 'GET', '/me')).status, 200);
  });
});

describe('試行回数の制限', () => {
  it('招待の受け取りは、同じ接続元から10分に10回まで', async () => {
    const { RateLimiter, CLIENT_IP_HEADER } = await import('../src/http/rateLimit.ts');
    let now = 0;
    const limited = createApp({ database: db, auth: new SessionAuthenticator(db), tokenizer, limiter: new RateLimiter(() => now) });
    const accept = (ip: string) => limited(new Request('http://localhost/auth/accept', {
      method: 'POST', headers: { 'content-type': 'application/json', [CLIENT_IP_HEADER]: ip },
      body: JSON.stringify({ token: `${T}.${'B'.repeat(43)}` }),
    }));
    for (let i = 0; i < 10; i++) assert.equal((await accept('203.0.113.1')).status, 404);
    assert.equal((await accept('203.0.113.1')).status, 429);
    assert.equal((await accept('203.0.113.2')).status, 404, '別の接続元は止めない');
    now += 10 * 60_000 + 1;
    assert.equal((await accept('203.0.113.1')).status, 404, '時間がたてば戻る');
  });

  it('無効なトークンが30回続いた接続元は、正しいトークンでも一時的に止める', async () => {
    const { RateLimiter, CLIENT_IP_HEADER } = await import('../src/http/rateLimit.ts');
    const limited = createApp({ database: db, auth: new SessionAuthenticator(db), tokenizer, limiter: new RateLimiter() });
    const me = (ip: string, token: string) => limited(new Request('http://localhost/me', { headers: { authorization: `Bearer ${token}`, [CLIENT_IP_HEADER]: ip } }));
    for (let i = 0; i < 30; i++) assert.equal((await me('198.51.100.7', `${T}.${'C'.repeat(43)}`)).status, 401);
    const good = await hqSession();
    assert.equal((await me('198.51.100.7', good)).status, 429);
    assert.equal((await me('198.51.100.8', good)).status, 200);
  });
});
