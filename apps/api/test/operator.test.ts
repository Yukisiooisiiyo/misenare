// 運営者の管理画面の口（/operator/）。
//
// 全社のデータに届く入口なので、確かめたいのは
//   ・運営者のアドレス以外は、設定リンクももらえず、入れない
//   ・パスワードは設定リンクからしか決められない。リンクは1回限り
//   ・会社を作ると、その招待で本部の管理者として入れる
//   ・停止した会社の利用者は何もできない。再開すれば戻る
//   ・完全削除は、停止済み・会社名一致のときだけ。消えるのはその会社だけ

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/http/app.ts';
import { DevHeaderAuthenticator, SessionAuthenticator } from '../src/http/auth.ts';
import { MemoryRateLimiter } from '../src/http/rateLimit.ts';
import type { Mail, Mailer } from '../src/mail/mailer.ts';
import type { Storage } from '../src/storage/storage.ts';
import { freshDatabase, manager, OTHER_T, STORE_A, STORE_B, T, tokenizer } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

const OP = 'owner@tsugigami.example';
const PASSWORD = 'test-only-passphrase';
const env = { OPERATOR_EMAILS: `${OP}, second@tsugigami.example`, APP_URL: 'https://app.tsugigami.example' } as NodeJS.ProcessEnv;

describe('運営者の管理', () => {
  let db: TestDatabase;
  let app: (req: Request) => Promise<Response>;
  let userApp: (req: Request) => Promise<Response>;
  const sent: Mail[] = [];
  const removed: string[] = [];
  const mailer: Mailer = { send: async (m) => { sent.push(m); return true; } };
  const storage = { remove: async (key: string) => { removed.push(key); } } as unknown as Storage;
  let token = '';
  let ip = 0;

  before(async () => {
    db = await freshDatabase();
    app = createApp({ database: db, auth: new SessionAuthenticator(db), tokenizer, limiter: new MemoryRateLimiter(), operatorMailer: mailer, operatorEnv: env, storage });
    userApp = createApp({ database: db, auth: new DevHeaderAuthenticator(), tokenizer, limiter: new MemoryRateLimiter() });
  });
  after(async () => { await db.close(); });

  const call = (method: string, path: string, body?: unknown, auth: string | null = token, from?: string) => app(new Request(`https://app.tsugigami.example/operator${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-misenare-client-ip': from ?? `198.51.100.${++ip % 250}`, ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const asManager = (path: string) => userApp(new Request(`https://app.tsugigami.example${path}`, { headers: { 'x-dev-tenant-id': T, 'x-dev-user-id': manager.userId } }));
  const setupToken = (): string => decodeURIComponent(/#setup=(\S+)/.exec(sent.at(-1)!.text)![1]!);

  it('運営者でないアドレスには設定リンクを送らない（応答は同じ）', async () => {
    const r = await call('POST', '/auth/setup', { email: 'someone@example.com' }, null);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { sent: true });
    assert.equal(sent.length, 0);
  });

  it('パスワードを決める前は入れない。ログインなしでは一覧も見えない', async () => {
    assert.equal((await call('POST', '/auth/login', { email: OP, password: PASSWORD }, null)).status, 401);
    assert.equal((await call('GET', '/tenants', undefined, null)).status, 401);
    assert.equal((await call('GET', '/tenants', undefined, 'op.bogus')).status, 401);
  });

  it('設定リンクでパスワードを決めて入る。リンクは1回限りで、短いパスワードは断る', async () => {
    await call('POST', '/auth/setup', { email: ` ${OP.toUpperCase()} ` }, null);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.to, [OP]);
    assert.match(sent[0]!.text, /https:\/\/app\.tsugigami\.example\/admin\/#setup=/);
    const t = setupToken();
    assert.equal((await call('POST', '/auth/password', { token: t, password: 'short' }, null)).status, 400);
    assert.equal((await call('POST', '/auth/password', { token: t, password: PASSWORD }, null)).status, 200);
    assert.equal((await call('POST', '/auth/password', { token: t, password: 'another-passphrase' }, null)).status, 404);

    assert.equal((await call('POST', '/auth/login', { email: OP, password: 'wrong-passphrase' }, null)).status, 401);
    const r = await call('POST', '/auth/login', { email: OP, password: PASSWORD }, null);
    assert.equal(r.status, 200);
    token = ((await r.json()) as { token: string }).token;
    assert.match(token, /^op\./);
    assert.deepEqual(await (await call('GET', '/me')).json(), { email: OP });
    const stored = await db.raw(`SELECT password_hash FROM operators`) as Array<{ password_hash: string }>;
    assert.ok(!stored[0]!.password_hash.includes(PASSWORD), 'パスワードをそのまま残さない');
  });

  it('利用者のトークンでは運営者の口に入れず、運営者のトークンでは利用者の API に入れない', async () => {
    assert.equal((await call('GET', '/tenants', undefined, `${T}.xxxx`)).status, 401);
    const r = await app(new Request('https://app.tsugigami.example/me', { headers: { authorization: `Bearer ${token}` } }));
    assert.equal(r.status, 401);
  });

  it('会社の一覧に、店舗・利用者・ナレッジの数が出る', async () => {
    const { tenants } = await (await call('GET', '/tenants')).json() as { tenants: Array<{ id: string; name: string; stores: number; users: number; status: string }> };
    const t = tenants.find((x) => x.id === T)!;
    assert.equal(t.name, 'テスト電機');
    assert.equal(t.stores, 2);
    assert.equal(t.users, 5);
    assert.equal(t.status, 'active');
  });

  let created = '';
  it('会社を作ると、最初の店舗と本部の管理者への招待ができ、その招待で入れる', async () => {
    assert.equal((await call('POST', '/tenants', { name: '', storeName: '1号店', adminName: '楠本' })).status, 400);
    assert.equal((await call('POST', '/tenants', { name: 'バイト先', storeName: '1号店', adminName: '楠本', plan: 'gold' })).status, 400);
    const r = await call('POST', '/tenants', { name: 'バイト先', storeName: '1号店', adminName: '楠本' });
    assert.equal(r.status, 201);
    const made = await r.json() as { id: string; invite: { url: string } };
    created = made.id;
    const invite = decodeURIComponent(/#invite=(\S+)$/.exec(made.invite.url)![1]!);
    const accepted = await app(new Request('https://app.tsugigami.example/auth/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: invite, deviceName: '試験' }),
    }));
    assert.ok(accepted.ok);
    const session = (await accepted.json() as { sessionToken: string }).sessionToken;
    const me = await (await app(new Request('https://app.tsugigami.example/me', { headers: { authorization: `Bearer ${session}` } }))).json() as { name: string; adminScope: string };
    assert.equal(me.name, '楠本');
    assert.equal(me.adminScope, 'tenant');
    const d = await (await call('GET', `/tenants/${created}`)).json() as { plan: string; storeList: Array<{ name: string }>; admins: Array<{ name: string }> };
    assert.equal(d.plan, 'trial');
    assert.deepEqual(d.storeList.map((s) => s.name), ['1号店']);
    assert.deepEqual(d.admins.map((a) => a.name), ['楠本']);
  });

  it('名前と契約の控えを書き換えられる。形の違うものは断る', async () => {
    const r = await call('PATCH', `/tenants/${created}`, { name: 'バイト先（試用）', plan: 'lite', contractedStores: 3, periodEnd: '2027-03-31', billingNote: '手動で請求' });
    assert.equal(r.status, 200);
    const d = await r.json() as { name: string; plan: string; contractedStores: number; periodEnd: string; billingNote: string };
    assert.deepEqual([d.name, d.plan, d.contractedStores, d.periodEnd, d.billingNote], ['バイト先（試用）', 'lite', 3, '2027-03-31', '手動で請求']);
    assert.equal((await call('PATCH', `/tenants/${created}`, { contractedStores: -1 })).status, 400);
    assert.equal((await call('PATCH', `/tenants/${created}`, { periodEnd: '来年' })).status, 400);
    const cleared = await (await call('PATCH', `/tenants/${created}`, { periodEnd: null, contractedStores: '' })).json() as { periodEnd: null; contractedStores: null; name: string };
    assert.deepEqual([cleared.periodEnd, cleared.contractedStores, cleared.name], [null, null, 'バイト先（試用）']);
  });

  it('店舗を足す・名前を変える・空なら消す。人やナレッジのある店舗と最後の1店舗は消せない', async () => {
    const added = await (await call('POST', `/tenants/${created}/stores`, { name: '2号店' })).json() as { storeList: Array<{ id: string; name: string }> };
    const second = added.storeList.find((s) => s.name === '2号店')!;
    const first = added.storeList.find((s) => s.name === '1号店')!;
    const renamed = await (await call('PATCH', `/tenants/${created}/stores/${second.id}`, { name: '駅ナカ店' })).json() as { storeList: Array<{ name: string }> };
    assert.ok(renamed.storeList.some((s) => s.name === '駅ナカ店'));
    // 他社の店舗 ID を混ぜても触れない
    assert.equal((await call('PATCH', `/tenants/${created}/stores/${STORE_A}`, { name: '乗っ取り' })).status, 404);
    assert.equal((await call('DELETE', `/tenants/${T}/stores/${STORE_A}`)).status, 409); // 利用者がいる
    assert.equal((await call('DELETE', `/tenants/${created}/stores/${second.id}`)).status, 200);
    assert.equal((await call('DELETE', `/tenants/${created}/stores/${first.id}`)).status, 409); // 最後の1店舗
  });

  it('停止した会社の利用者は何もできない。再開すれば戻る', async () => {
    assert.equal((await asManager('/me')).status, 200);
    const s = await (await call('POST', `/tenants/${T}/suspend`)).json() as { status: string; suspendedAt: string | null };
    assert.equal(s.status, 'suspended');
    assert.ok(s.suspendedAt);
    const blocked = await asManager('/me');
    assert.equal(blocked.status, 403);
    assert.match(((await blocked.json()) as { message: string }).message, /利用を停止/);
    assert.equal((await call('POST', `/tenants/${T}/resume`)).status, 200);
    assert.equal((await asManager('/me')).status, 200);
  });

  it('完全削除は、停止済みで会社名が一致したときだけ。消えるのはその会社だけで、写真も片付ける', async () => {
    await db.withTenant(T, async (q) => {
      const k = await q.query<{ id: string }>(
        `INSERT INTO knowledge (tenant_id, scope, store_id, created_by) VALUES ($1, 'store', $2, $3) RETURNING id`,
        [T, STORE_B, manager.userId],
      );
      await q.query(
        `INSERT INTO knowledge_photos (tenant_id, knowledge_id, storage_key, content_type, bytes, created_by)
         VALUES ($1, $2, $3, 'image/jpeg', 10, $4)`,
        [T, k[0]!.id, `${T}/x/y.jpg`, manager.userId],
      );
    });
    assert.equal((await call('DELETE', `/tenants/${T}`, { confirmName: 'テスト電機' })).status, 409); // まだ動いている
    await call('POST', `/tenants/${T}/suspend`);
    assert.equal((await call('DELETE', `/tenants/${T}`, { confirmName: 'テスト' })).status, 400); // 名前が違う
    assert.equal((await call('DELETE', `/tenants/${T}`, { confirmName: 'テスト電機' })).status, 200);

    assert.equal((await call('GET', `/tenants/${T}`)).status, 404);
    for (const table of ['stores', 'users', 'memberships', 'knowledge', 'knowledge_photos']) {
      const left = await db.withTenant(T, (q) => q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`));
      assert.equal(Number(left[0]!.n), 0, `${table} が残っている`);
    }
    const others = await db.withTenant(OTHER_T, (q) => q.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`));
    assert.equal(Number(others[0]!.n), 1, '他社の利用者は残る');
    assert.deepEqual(removed, [`${T}/x/y.jpg`]);
  });

  it('操作が記録に残る', async () => {
    const { entries } = await (await call('GET', '/log')).json() as { entries: Array<{ action: string; tenantName: string | null; operator: string }> };
    const actions = entries.map((e) => e.action);
    for (const a of ['会社を作成', '会社を編集', '店舗を追加', '利用を停止', '利用を再開', '会社を完全に削除']) assert.ok(actions.includes(a), `${a} が無い`);
    assert.ok(entries.every((e) => e.operator === OP));
  });

  it('OPERATOR_EMAILS から外したアドレスは、その場で入れなくなる', async () => {
    const narrowed = createApp({ database: db, auth: new SessionAuthenticator(db), tokenizer, limiter: new MemoryRateLimiter(), operatorMailer: mailer, operatorEnv: { ...env, OPERATOR_EMAILS: 'second@tsugigami.example' }, storage });
    const r = await narrowed(new Request('https://app.tsugigami.example/operator/tenants', { headers: { authorization: `Bearer ${token}` } }));
    assert.equal(r.status, 401);
  });

  it('ログアウトするとトークンは使えない。ログインの連打は止まる', async () => {
    assert.equal((await call('POST', '/auth/logout')).status, 200);
    assert.equal((await call('GET', '/tenants')).status, 401);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call('POST', '/auth/login', { email: OP, password: 'x' }, null, '203.0.113.77')).status;
    assert.equal(last, 429);
  });
});
