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

  it('既存の利用者への招待でも、名前を付けるなら40文字まで', async () => {
    const r = await call(hqToken, 'POST', '/invitations', { storeId: STORE_A, userId: hq.userId, name: 'あ'.repeat(41) });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('ログインしていない・形の違うトークン・存在しないトークンは 401', async () => {
    assert.equal((await call(null, 'GET', '/me')).status, 401);
    assert.equal((await call('garbage', 'GET', '/me')).status, 401);
    assert.equal((await call(`${T}.${'A'.repeat(43)}`, 'GET', '/me')).status, 401);
    assert.equal((await call(hqToken, 'GET', '/me')).body.adminScope, 'tenant');
  });

  it('認証つきの GET は取引を1回しか開かない（BEGIN と COMMIT は1組、set_config は tenant_id と TimeZone）', async () => {
    const counter = db as unknown as { statements?: number };
    if (counter.statements === undefined) return; // pg ドライバーには数える口が無い
    const before = counter.statements;
    assert.equal((await call(hqToken, 'GET', '/me')).status, 200);
    // 内訳：BEGIN, set_config×2, verifySession, users, memberships, /me の本体3本, COMMIT = 10 本。
    // 以前は同じ GET で BEGIN / set_config / COMMIT の組が3回走り、TZ の分を除いても 15 本だった
    assert.equal(counter.statements - before, 10);
    // 取引が1つだけであることを直接確かめる
    const log: string[] = [];
    const orig = db.withTenant.bind(db);
    db.withTenant = ((t: string, fn: Parameters<typeof orig>[1]) => { log.push(t); return orig(t, fn); }) as typeof db.withTenant;
    try {
      assert.equal((await call(hqToken, 'GET', '/me')).status, 200);
    } finally {
      db.withTenant = orig;
    }
    assert.equal(log.length, 1, `取引が ${log.length} 回開かれました`);
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

  it('既存の人への招待（端末の追加）は、その人になりすませる鍵。店長は本部や店長の鍵を作れない', async () => {
    // 本部の人が店舗に所属していても（兼務）、店長はその人の鍵を作れない。
    // 作れると、返ってきたトークンを自分で受け取って本部になれる
    await db.withTenant(T, (q) => q.query(
      `INSERT INTO memberships (tenant_id, user_id, store_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [T, hq.userId, STORE_A],
    ));
    const up = await call(managerToken, 'POST', '/invitations', { storeId: STORE_A, userId: hq.userId });
    assert.equal(up.status, 403, '店長が本部の鍵を作れている');
    // 自店舗の一般スタッフの端末追加はできる（機種変更）
    const ok = await call(managerToken, 'POST', '/invitations', { storeId: STORE_A, userId: newbieId });
    assert.equal(ok.status, 201);
    const again = await call(null, 'POST', '/auth/accept', { token: ok.body.token, deviceName: '新しいスマホ' });
    assert.equal(again.body.userId, newbieId);
    await db.withTenant(T, (q) => q.query(`DELETE FROM sessions WHERE device_name = '新しいスマホ'`)); // 後の端末数の確認に影響させない
    // 他店舗の人の鍵は作れない
    const other = await call(hqToken, 'POST', '/invitations', { storeId: STORE_B, name: '駅前の人' });
    const otherAccepted = await call(null, 'POST', '/auth/accept', { token: other.body.token });
    assert.equal((await call(managerToken, 'POST', '/invitations', { storeId: STORE_A, userId: otherAccepted.body.userId })).status, 403);
    // 店長同士でもだめ（本部だけが店長の端末を追加できる）
    const manager2 = await call(hqToken, 'POST', '/invitations', { storeId: STORE_A, name: '副店長', trustLevel: 'trusted', adminScope: 'store' });
    const m2 = await call(null, 'POST', '/auth/accept', { token: manager2.body.token });
    assert.equal((await call(managerToken, 'POST', '/invitations', { storeId: STORE_A, userId: m2.body.userId })).status, 403);
    assert.equal((await call(hqToken, 'POST', '/invitations', { storeId: STORE_A, userId: m2.body.userId })).status, 201);
    await db.withTenant(T, (q) => q.query(`DELETE FROM memberships WHERE user_id = $1 AND store_id = $2`, [hq.userId, STORE_A]));
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
  it('招待の受け取りは、同じ接続元からの失敗を10分に20回まで。成功は数えない（店舗の一斉登録を止めない）', async () => {
    const { MemoryRateLimiter, CLIENT_IP_HEADER } = await import('../src/http/rateLimit.ts');
    let now = 0;
    const limited = createApp({ database: db, auth: new SessionAuthenticator(db), tokenizer, limiter: new MemoryRateLimiter(() => now) });
    const accept = (ip: string, token = `${T}.${'B'.repeat(43)}`) => limited(new Request('http://localhost/auth/accept', {
      method: 'POST', headers: { 'content-type': 'application/json', [CLIENT_IP_HEADER]: ip },
      body: JSON.stringify({ token }),
    }));
    // 同じ回線から25人が正しい招待で入る → 全員通る
    const hqTok = await hqSession();
    for (let i = 0; i < 25; i++) {
      const inv = await call(hqTok, 'POST', '/invitations', { storeId: STORE_B, name: `一斉${i}` });
      assert.equal((await accept('203.0.113.9', inv.body.token)).status, 201, `${i + 1}人目が止められた`);
    }
    // 失敗は数える
    for (let i = 0; i < 20; i++) assert.equal((await accept('203.0.113.1')).status, 404);
    assert.equal((await accept('203.0.113.1')).status, 429);
    assert.equal((await accept('203.0.113.2')).status, 404, '別の接続元は止めない');
    now += 10 * 60_000 + 1;
    assert.equal((await accept('203.0.113.1')).status, 404, '時間がたてば戻る');
  });

  it('認証後の書き込みは、利用者ごとに上限がある。別の利用者と GET は止めない', async () => {
    // 本番は10分で300回。試験では回数を小さくして、同じ数え方で確かめる
    const { MemoryRateLimiter, CLIENT_IP_HEADER } = await import('../src/http/rateLimit.ts');
    const limited = createApp({
      database: db, auth: new SessionAuthenticator(db), tokenizer,
      limiter: new MemoryRateLimiter(), userWriteRule: { limit: 5, windowMs: 10 * 60_000 },
    });
    // 同じ接続元から来る（店舗の回線）。鍵は利用者なので巻き添えにならないはず
    const as = async (token: string, method: string, path: string, body?: unknown) => {
      const res = await limited(new Request(`http://localhost${path}`, {
        method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, [CLIENT_IP_HEADER]: '203.0.113.50' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      await res.text();
      return res.status;
    };
    const hqTok = await hqSession();
    // 招待を1回（書き込み1回目）。受け取りはログイン前なので数えない
    const inv = await call(hqTok, 'POST', '/invitations', { storeId: STORE_B, name: '上限の試験' });
    const accepted = await limited(new Request('http://localhost/auth/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: inv.body.token }),
    }));
    const other = (await accepted.json() as { sessionToken: string }).sessionToken;
    assert.equal(await as(hqTok, 'POST', '/invitations', { storeId: STORE_B, name: '1' }), 201);
    for (let i = 0; i < 4; i++) assert.equal(await as(hqTok, 'POST', `/stores/${STORE_B}/handovers`, { body: `引き継ぎ${i}` }), 201, `${i + 1}回目が止められた`);
    assert.equal(await as(hqTok, 'POST', `/stores/${STORE_B}/handovers`, { body: 'あふれた分' }), 429);
    // パスキー登録の開始（POST）も共通の上限の対象
    assert.equal(await as(hqTok, 'POST', '/passkeys/register/start', {}), 429);
    assert.equal(await as(hqTok, 'GET', '/me'), 200, 'GET は何回でも通る');
    for (let i = 0; i < 10; i++) assert.equal(await as(hqTok, 'GET', `/stores/${STORE_B}/handovers`), 200);
    assert.equal(await as(other, 'POST', `/stores/${STORE_B}/handovers`, { body: '別の人' }), 201, '別の利用者は止めない');
  });

  it('無効なトークンが30回続いた接続元は、無効なトークンを止める。正しいトークンの人は通す', async () => {
    // 店舗のスマホは同じ回線（同じ接続元）から来る。誰かの古い端末が切れたトークンで
    // 鳴き続けただけで、店舗の全員が締め出されてはいけない
    const { MemoryRateLimiter, CLIENT_IP_HEADER } = await import('../src/http/rateLimit.ts');
    const limited = createApp({ database: db, auth: new SessionAuthenticator(db), tokenizer, limiter: new MemoryRateLimiter() });
    const me = (ip: string, token: string) => limited(new Request('http://localhost/me', { headers: { authorization: `Bearer ${token}`, [CLIENT_IP_HEADER]: ip } }));
    for (let i = 0; i < 30; i++) assert.equal((await me('198.51.100.7', `${T}.${'C'.repeat(43)}`)).status, 401);
    assert.equal((await me('198.51.100.7', `${T}.${'C'.repeat(43)}`)).status, 429, '無効なトークンは止まる');
    const good = await hqSession();
    assert.equal((await me('198.51.100.7', good)).status, 200, '同じ回線の正しいトークンまで止めている');
    assert.equal((await me('198.51.100.8', good)).status, 200);
  });
});
