// 運営者の管理画面の口（/operator/）。
//
// 全社のデータに届く入口なので、確かめたいのは
//   ・運営者のアドレス以外は、設定リンクももらえず、入れない
//   ・パスワードは設定リンクからしか決められない。リンクは1回限り
//   ・会社を作ると、その招待で本部の管理者として入れる
//   ・停止した会社の利用者は何もできない。再開すれば戻る
//   ・完全削除は、停止済み・会社名一致のときだけ。消えるのはその会社だけ
//   ・2段階の確認を設定したら、認証アプリのコードが無いと入れない。設定リンクのメールでは外れない
//   ・失敗が続いたアドレスは受け付けない。ただし、前に入ったことのあるブラウザーは締め出されない
//   ・ログインは、成功も失敗も記録に残る

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { totpCode, totpStep } from '../src/auth/totp.ts';
import { generateKey, isSealed } from '../src/crypto/secretBox.ts';
import { forceDisableTotp, LOGIN_LOCK, RECOVERY_CODE_COUNT, resetOperatorSecretBox, sweepOperatorRecords } from '../src/domain/operator.ts';
import { submitContact } from '../src/domain/contact.ts';
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
  let app: ((req: Request) => Promise<Response>) & { settled(): Promise<void> };
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

  // 設定リンクのメールは応答のあとに送る（応答の速さで運営者のアドレスかどうかを知らせないため）。
  // 試験では、送り終わるのを待ってから結果を見る
  // ブラウザーが覚えている印（クッキー）。null なら、前に入ったことのないブラウザー
  let cookie: string | null = null;
  const call = async (method: string, path: string, body?: unknown, auth: string | null = token, from?: string) => {
    const res = await app(new Request(`https://app.tsugigami.example/operator${path}`, {
      method,
      headers: {
        'content-type': 'application/json', 'x-misenare-client-ip': from ?? `198.51.100.${++ip % 250}`, 'user-agent': 'TestBrowser/1.0',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    await app.settled();
    return res;
  };
  /** 応答が持たせてきた印（名前=値 の形） */
  const deviceOf = (res: Response): string | null => /^(tsugigami_op_device=[A-Za-z0-9_-]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? null;
  const login = (body: Record<string, unknown>) => call('POST', '/auth/login', body, null);
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
    const set = await call('POST', '/auth/password', { token: t, password: PASSWORD }, null);
    assert.equal(set.status, 200);
    assert.equal((await call('POST', '/auth/password', { token: t, password: 'another-passphrase' }, null)).status, 404);
    // 決めたことを、本人にメールで知らせる。決めたブラウザーには「前に入ったことがある」印を持たせる
    assert.equal(sent.length, 2);
    assert.match(sent[1]!.subject, /パスワードが設定されました/);
    assert.match(sent[1]!.text, /TestBrowser\/1\.0/);
    const setCookie = set.headers.get('set-cookie') ?? '';
    for (const part of ['Path=/api/operator/auth', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(setCookie.includes(part), `${part} が無い`);
    cookie = deviceOf(set);
    assert.ok(cookie);

    assert.equal((await login({ email: OP, password: 'wrong-passphrase' })).status, 401);
    const r = await login({ email: OP, password: PASSWORD });
    assert.equal(r.status, 200);
    const session = (await r.json()) as { token: string; email: string };
    assert.deepEqual(Object.keys(session).sort(), ['email', 'token'], '印は本文に入れない（スクリプトから読めないクッキーで持たせる）');
    token = session.token;
    assert.match(token, /^op\./);
    assert.deepEqual(await (await call('GET', '/me')).json(), { email: OP, totp: false });
    assert.equal(sent.length, 2, '前に入ったことのあるブラウザーからのログインは、知らせない');
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
    assert.equal((await call('POST', '/tenants', { name: '', storeName: '1号店', adminName: '山田' })).status, 400);
    assert.equal((await call('POST', '/tenants', { name: 'バイト先', storeName: '1号店', adminName: '山田', plan: 'gold' })).status, 400);
    const r = await call('POST', '/tenants', { name: 'バイト先', storeName: '1号店', adminName: '山田' });
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
    assert.equal(me.name, '山田');
    assert.equal(me.adminScope, 'tenant');
    const d = await (await call('GET', `/tenants/${created}`)).json() as { plan: string; storeList: Array<{ name: string }>; admins: Array<{ name: string }> };
    assert.equal(d.plan, 'trial');
    assert.deepEqual(d.storeList.map((s) => s.name), ['1号店']);
    assert.deepEqual(d.admins.map((a) => a.name), ['山田']);
  });

  it('名前と契約の控えを書き換えられる。形の違うものは断る', async () => {
    const r = await call('PATCH', `/tenants/${created}`, { name: 'バイト先（試用）', plan: 'standard', contractedStores: 3, periodEnd: '2027-03-31', billingNote: '手動で請求' });
    assert.equal(r.status, 200);
    const d = await r.json() as { name: string; plan: string; contractedStores: number; periodEnd: string; billingNote: string };
    assert.deepEqual([d.name, d.plan, d.contractedStores, d.periodEnd, d.billingNote], ['バイト先（試用）', 'standard', 3, '2027-03-31', '手動で請求']);
    // 料金を一律にする前の段階の名前は、もう受けない
    assert.equal((await call('PATCH', `/tenants/${created}`, { plan: 'lite' })).status, 400);
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

describe('運営者の管理：2段階の確認とログインの守り', () => {
  let db: TestDatabase;
  let app: ((req: Request) => Promise<Response>) & { settled(): Promise<void> };
  const sent: Mail[] = [];
  const mailer: Mailer = { send: async (m) => { sent.push(m); return true; } };
  const storage = { remove: async () => {} } as unknown as Storage;
  // 回数の制限は時計を進めて空にする（1つの試験の中の連打だけを数えたい）
  let tick = Date.now();
  let token = '';
  let cookie: string | null = null;
  let secret = '';
  let recovery: string[] = [];
  let ip = 0;

  const call = async (method: string, path: string, body?: unknown, auth: string | null = token, device: string | null = cookie) => {
    const res = await app(new Request(`https://app.tsugigami.example/operator${path}`, {
      method,
      headers: {
        'content-type': 'application/json', 'x-misenare-client-ip': `198.51.100.${++ip % 250}`, 'user-agent': 'TestBrowser/1.0',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(device ? { cookie: device } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    await app.settled();
    return res;
  };
  const deviceOf = (res: Response): string | null => /^(tsugigami_op_device=[A-Za-z0-9_-]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? null;
  /** device に null を渡すと、前に入ったことのないブラウザーから */
  const login = (body: Record<string, unknown>, device: string | null = cookie) => call('POST', '/auth/login', body, null, device);
  const codeAt = (offset = 0): string => totpCode(secret, totpStep(Date.now()) + offset);
  /** いまの前後どの刻みのコードとも違う6桁 */
  const wrongCode = (): string => ['000000', '111111', '222222', '333333'].find((c) => ![-1, 0, 1].map(codeAt).includes(c))!;
  /** 失敗の数えと、使ったコードの覚えを空にする（次の試験が前の試験の失敗を引きずらないように） */
  const calm = async (): Promise<void> => {
    await db.raw(`DELETE FROM operator_logins`);
    await db.raw(`UPDATE operators SET totp_last_step = NULL, lock_notified_at = NULL`);
    await db.raw(`UPDATE operator_devices SET failures = 0`);
    tick += 11 * 60_000;
  };
  const subjects = (): string[] => sent.map((m) => m.subject);

  before(async () => {
    db = await freshDatabase();
    app = createApp({ database: db, auth: new SessionAuthenticator(db), tokenizer, limiter: new MemoryRateLimiter(() => tick), operatorMailer: mailer, operatorEnv: env, storage });
    await call('POST', '/auth/setup', { email: OP }, null);
    const link = decodeURIComponent(/#setup=(\S+)/.exec(sent.at(-1)!.text)![1]!);
    cookie = deviceOf(await call('POST', '/auth/password', { token: link, password: PASSWORD }, null));
    token = ((await (await login({ email: OP, password: PASSWORD })).json()) as { token: string }).token;
  });
  after(async () => { await db.close(); });

  it('前に入ったことのないブラウザーから入ると、本人にメールで知らせる。同じブラウザーの2回目は知らせない', async () => {
    const before = sent.length;
    const first = await login({ email: OP, password: PASSWORD }, null);
    assert.equal(first.status, 200);
    assert.equal(sent.length, before + 1);
    assert.match(sent.at(-1)!.subject, /新しいブラウザーからログイン/);
    assert.deepEqual(sent.at(-1)!.to, [OP]);
    assert.match(sent.at(-1)!.text, /198\.51\.100\.\d+/);
    assert.match(sent.at(-1)!.text, /TestBrowser\/1\.0/);
    const another = deviceOf(first);
    assert.ok(another && another !== cookie, '入れたブラウザーには、新しい印を持たせる');
    assert.equal((await login({ email: OP, password: PASSWORD }, another)).status, 200);
    assert.equal(sent.length, before + 1);
    // 手元（localhost）で試すときだけ、Secure を付けない
    const local = await app(new Request('http://localhost/operator/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: OP, password: PASSWORD }) }));
    await app.settled();
    assert.ok(!/Secure/.test(local.headers.get('set-cookie') ?? 'Secure'));
  });

  it('2段階の確認は、パスワードを確かめてから始め、認証アプリのコードが合うまで有効にならない', async () => {
    await calm();
    assert.deepEqual(await (await call('GET', '/security')).json(), { totp: { enabled: false, enabledAt: null, recoveryCodesLeft: 0 } });
    assert.equal((await call('POST', '/security/totp/start', { password: 'wrong-passphrase' })).status, 403);
    assert.equal((await call('POST', '/security/totp/start', { password: PASSWORD }, null)).status, 401, 'ログインなしでは始められない');
    const started = await call('POST', '/security/totp/start', { password: PASSWORD });
    assert.equal(started.status, 200);
    const s = await started.json() as { secret: string; uri: string; qr: string[] };
    secret = s.secret;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.equal(s.uri, `otpauth://totp/Tsugigami:${encodeURIComponent(OP)}?secret=${secret}&issuer=Tsugigami&algorithm=SHA1&digits=6&period=30`);
    assert.ok(s.qr.length >= 21 && s.qr.every((row) => row.length === s.qr.length && /^[01]+$/.test(row)), 'QR は正方形の 0/1');

    // まだ有効ではない：コードなしで入れる
    assert.equal((await login({ email: OP, password: PASSWORD })).status, 200);
    assert.equal(((await (await call('GET', '/me')).json()) as { totp: boolean }).totp, false);

    assert.equal((await call('POST', '/security/totp/enable', { code: wrongCode() })).status, 400);
    const before = sent.length;
    const enabled = await call('POST', '/security/totp/enable', { code: codeAt() });
    assert.equal(enabled.status, 200);
    recovery = ((await enabled.json()) as { recoveryCodes: string[] }).recoveryCodes;
    assert.equal(recovery.length, RECOVERY_CODE_COUNT);
    for (const c of recovery) assert.match(c, /^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/);
    assert.equal(new Set(recovery).size, RECOVERY_CODE_COUNT);
    assert.match(sent.at(-1)!.subject, /2段階の確認が設定されました/);
    assert.equal(sent.length, before + 1);

    const st = await (await call('GET', '/security')).json() as { totp: { enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number } };
    assert.equal(st.totp.enabled, true);
    assert.ok(st.totp.enabledAt);
    assert.equal(st.totp.recoveryCodesLeft, RECOVERY_CODE_COUNT);
    assert.equal(((await (await call('GET', '/me')).json()) as { totp: boolean }).totp, true);
    assert.equal((await call('POST', '/security/totp/start', { password: PASSWORD })).status, 409, '設定済みなら、始め直せない');

    // 鍵も予備のコードも、そのままの形では残さない（鍵は、包む鍵を決めていればここで包まれる）
    const stored = await db.raw(`SELECT code_hash FROM operator_recovery_codes`) as Array<{ code_hash: string }>;
    assert.equal(stored.length, RECOVERY_CODE_COUNT);
    assert.ok(stored.every((r) => /^[0-9a-f]{64}$/.test(r.code_hash)));
    const log = await (await call('GET', '/log')).json() as { entries: Array<{ action: string }> };
    assert.ok(log.entries.some((e) => e.action === '2段階の確認を設定'));
  });

  it('設定したあとは、コードが無いと入れない。どれが違ったかは言わず、同じコードは二度通らない', async () => {
    await calm();
    const none = await login({ email: OP, password: PASSWORD });
    assert.equal(none.status, 401);
    const wrong = await login({ email: OP, password: PASSWORD, code: wrongCode() });
    assert.equal(wrong.status, 401);
    const badPassword = await login({ email: OP, password: 'wrong-passphrase', code: codeAt() });
    assert.equal(badPassword.status, 401);
    const messages = await Promise.all([none, wrong, badPassword].map(async (r) => ((await r.json()) as { message: string }).message));
    assert.equal(new Set(messages).size, 1, 'パスワードが違うのか、コードが違うのかを、応答から読ませない');

    const code = codeAt();
    const ok = await login({ email: OP, password: PASSWORD, code: ` ${code.slice(0, 3)} ${code.slice(3)} ` });
    assert.equal(ok.status, 200);
    token = ((await ok.json()) as { token: string }).token;
    assert.equal((await login({ email: OP, password: PASSWORD, code })).status, 401, '一度通したコードは、もう通さない');
  });

  it('予備のコードは、認証アプリの代わりに1回だけ使える', async () => {
    await calm();
    const one = recovery[0]!;
    assert.equal((await login({ email: OP, password: PASSWORD, code: one.toUpperCase().replace(/-/g, ' ') })).status, 200);
    assert.equal((await login({ email: OP, password: PASSWORD, code: one })).status, 401);
    assert.equal((await login({ email: OP, password: 'wrong-passphrase', code: recovery[1] })).status, 401);
    const st = await (await call('GET', '/security')).json() as { totp: { recoveryCodesLeft: number } };
    assert.equal(st.totp.recoveryCodesLeft, RECOVERY_CODE_COUNT - 1, 'パスワードが違うときは、予備のコードを減らさない');
  });

  it('メールの設定リンクでパスワードを決め直しても、2段階の確認は外れない', async () => {
    await calm();
    await call('POST', '/auth/setup', { email: OP }, null);
    const link = decodeURIComponent(/#setup=(\S+)/.exec(sent.at(-1)!.text)![1]!);
    const set = await call('POST', '/auth/password', { token: link, password: 'second-passphrase' }, null, null);
    assert.equal(set.status, 200);
    assert.match(sent.at(-1)!.text, /2段階の確認は設定されたまま/);
    const fresh = deviceOf(set);
    assert.ok(fresh);
    // それまでのログインは切れ、覚えていたブラウザーも忘れる
    assert.equal((await call('GET', '/tenants')).status, 401);
    const devices = await db.raw(`SELECT count(*)::int AS n FROM operator_devices`) as Array<{ n: number }>;
    assert.equal(Number(devices[0]!.n), 1);
    cookie = fresh;
    assert.equal((await login({ email: OP, password: 'second-passphrase' })).status, 401, 'メールを読めるだけでは入れない');
    const ok = await login({ email: OP, password: 'second-passphrase', code: codeAt() });
    assert.equal(ok.status, 200);
    token = ((await ok.json()) as { token: string }).token;
    // 以後の試験のために、もとのパスワードへ戻す
    await calm();
    await call('POST', '/auth/setup', { email: OP }, null);
    const again = decodeURIComponent(/#setup=(\S+)/.exec(sent.at(-1)!.text)![1]!);
    cookie = deviceOf(await call('POST', '/auth/password', { token: again, password: PASSWORD }, null));
    token = ((await (await login({ email: OP, password: PASSWORD, code: codeAt() })).json()) as { token: string }).token;
  });

  it('パスワードの間違いが続くと、前に入ったことのないブラウザーからは受け付けない。前に入ったことのあるブラウザーは入れる', async () => {
    await calm();
    const before = sent.length;
    for (let i = 0; i < LOGIN_LOCK.windowLimit; i++) assert.equal((await login({ email: OP, password: `guess-number-${i}` }, null)).status, 401);
    // 止まったら、合っていても入れない（当たったかどうかを確かめさせない）
    const locked = await login({ email: OP, password: PASSWORD, code: codeAt() }, null);
    assert.equal(locked.status, 429);
    assert.equal(((await locked.json()) as { error: string }).error, 'locked');
    assert.deepEqual(subjects().slice(before), ['【ツギガミ運営】ログインの失敗が続いています']);
    assert.match(sent.at(-1)!.text, /前に入ったことのあるブラウザーからは、これまでどおり入れます/);

    // 運営者でないアドレスでも、同じ回数で同じように止まる（どのアドレスが運営者かを、止まり方から読ませない）
    for (let i = 0; i < LOGIN_LOCK.windowLimit; i++) assert.equal((await login({ email: 'nobody@example.com', password: `guess-number-${i}` }, null)).status, 401);
    const stranger = await login({ email: 'nobody@example.com', password: 'x' }, null);
    assert.equal(stranger.status, 429);
    assert.deepEqual(await stranger.json(), await (await login({ email: OP, password: 'x' }, null)).json());
    assert.equal(sent.length, before + 1, '運営者でないアドレスの分は、だれにも知らせない');

    // アドレスを知っているだけの人には、本人を締め出せない
    const ok = await login({ email: OP, password: PASSWORD, code: codeAt() });
    assert.equal(ok.status, 200);
    token = ((await ok.json()) as { token: string }).token;
  });

  it('時間がたてば受け付けを戻す。1日に失敗が重なりすぎたら、その日は止めたままにする。知らせは1日に1通まで', async () => {
    await calm();
    const before = sent.length;
    for (let i = 0; i < LOGIN_LOCK.windowLimit; i++) await login({ email: OP, password: `guess-number-${i}` }, null);
    assert.equal((await login({ email: OP, password: 'x' }, null)).status, 429);
    await db.raw(`UPDATE operator_logins SET at = at - make_interval(mins => $1::int)`, [LOGIN_LOCK.windowMinutes + 1]);
    assert.equal((await login({ email: OP, password: 'guess-again-0' }, null)).status, 401, '時間がたてば、また受け付ける');
    for (let i = 1; i < LOGIN_LOCK.windowLimit; i++) await login({ email: OP, password: `guess-again-${i}` }, null);
    assert.equal((await login({ email: OP, password: 'x' }, null)).status, 429);
    assert.equal(sent.length, before + 1, '止めるたびには知らせない');

    await db.raw(`UPDATE operator_logins SET at = at - interval '3 hours'`);
    await db.raw(
      `INSERT INTO operator_logins (email, outcome, known, at) SELECT $1::text, 'password', false, now() - interval '2 hours' FROM generate_series(1, $2::int)`,
      [OP, LOGIN_LOCK.dayLimit],
    );
    assert.equal((await login({ email: OP, password: 'x' }, null)).status, 429, '直近15分に失敗が無くても、1日の数で止まる');
    // 最後に入れたとき以降だけを数える：本人が入れば、数えは空になる
    assert.equal((await login({ email: OP, password: PASSWORD, code: codeAt() })).status, 200);
    assert.equal((await login({ email: OP, password: 'x' }, null)).status, 401);
  });

  it('確認コードの間違いが続くと、前に入ったことのあるブラウザーでも止める（パスワードを知っている相手なので）', async () => {
    await calm();
    const before = sent.length;
    for (let i = 0; i < LOGIN_LOCK.windowLimit; i++) assert.equal((await login({ email: OP, password: PASSWORD, code: wrongCode() })).status, 401);
    assert.equal((await login({ email: OP, password: PASSWORD, code: codeAt() })).status, 429);
    assert.deepEqual(subjects().slice(before), ['【ツギガミ運営】確認コードの間違いが続いたので、ログインを止めています']);
    // ログインしたままの画面からコードを当てに来るのも、同じ数えで止まる
    const viaScreen = await call('POST', '/security/totp/disable', { password: PASSWORD, code: wrongCode() });
    assert.equal(viaScreen.status, 409);
    assert.equal(((await (await call('GET', '/security')).json()) as { totp: { enabled: boolean } }).totp.enabled, true);
  });

  it('前に入ったことのあるブラウザーでも、間違いが重なれば、知らないブラウザーの扱いに戻す', async () => {
    await calm();
    for (let i = 0; i < 10; i++) assert.equal((await login({ email: OP, password: `guess-number-${i}` })).status, 401);
    const devices = await db.raw(`SELECT count(*)::int AS n FROM operator_devices`) as Array<{ n: number }>;
    assert.equal(Number(devices[0]!.n), 0, '印を捨てる');
    const before = sent.length;
    const ok = await login({ email: OP, password: PASSWORD, code: codeAt() });
    assert.equal(ok.status, 200, '印を持っていた間の間違いは、知らないブラウザーの数えには入れない');
    assert.match(sent.at(-1)!.subject, /新しいブラウザーからログイン/);
    assert.equal(sent.length, before + 1);
    cookie = deviceOf(ok);
    token = ((await ok.json()) as { token: string }).token;
  });

  it('ログインは、入れたものも入れなかったものも記録に残る。アドレスの欄に打たれたアドレスでないものは控えない', async () => {
    await calm();
    await login({ email: 'my-secret-passphrase', password: 'x' }, null);
    await login({ email: OP, password: 'wrong-passphrase' }, null);
    await login({ email: OP, password: PASSWORD, code: wrongCode() });
    const ok = await login({ email: OP, password: PASSWORD, code: codeAt() });
    token = ((await ok.json()) as { token: string }).token;
    const { entries, next } = await (await call('GET', '/logins')).json() as { entries: Array<{ id: number; email: string; outcome: string; known: boolean; ip: string; agent: string }>; next: number | null };
    assert.equal(next, null);
    assert.deepEqual(entries.map((e) => [e.email, e.outcome, e.known]), [
      [OP, 'ok', true], [OP, 'code', true], [OP, 'password', false], ['（アドレスの形でない入力）', 'password', false],
    ]);
    assert.ok(entries.every((e) => /^198\.51\.100\.\d+$/.test(e.ip) && e.agent === 'TestBrowser/1.0'));
    assert.ok(!JSON.stringify(entries).includes('my-secret-passphrase'));
    assert.equal((await call('GET', '/logins', undefined, null)).status, 401);

    // 30件より前は、続きとして読める
    await db.raw(`INSERT INTO operator_logins (email, outcome, known) SELECT $1::text, 'locked', false FROM generate_series(1, 31)`, ['nobody@example.com']);
    const page1 = await (await call('GET', '/logins')).json() as { entries: Array<{ id: number }>; next: number | null };
    assert.equal(page1.entries.length, 30);
    assert.equal(page1.next, page1.entries.at(-1)!.id);
    const page2 = await (await call('GET', `/logins?before=${page1.next}`)).json() as { entries: Array<{ id: number }>; next: number | null };
    assert.equal(page2.entries.length, 5);
    assert.equal(page2.next, null);
    assert.ok(page2.entries.every((e) => e.id < page1.next!));
  });

  it('予備のコードの作り直しと、2段階の確認を外すのには、パスワードとコードの両方が要る', async () => {
    await calm();
    assert.equal((await call('POST', '/security/recovery-codes', { password: 'wrong-passphrase', code: codeAt() })).status, 403);
    assert.equal((await call('POST', '/security/recovery-codes', { password: PASSWORD, code: wrongCode() })).status, 400);
    const renewed = await call('POST', '/security/recovery-codes', { password: PASSWORD, code: codeAt() });
    assert.equal(renewed.status, 200);
    const codes = ((await renewed.json()) as { recoveryCodes: string[] }).recoveryCodes;
    assert.equal(codes.length, RECOVERY_CODE_COUNT);
    assert.ok(!codes.includes(recovery[1]!));
    assert.equal((await login({ email: OP, password: PASSWORD, code: recovery[1] })).status, 401, '前の予備のコードは使えない');
    recovery = codes;

    await calm();
    assert.equal((await call('POST', '/security/totp/disable', { password: 'wrong-passphrase', code: codeAt() })).status, 403);
    assert.equal((await call('POST', '/security/totp/disable', { password: PASSWORD })).status, 400);
    const before = sent.length;
    const off = await call('POST', '/security/totp/disable', { password: PASSWORD, code: recovery[0] });
    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { totp: { enabled: false, enabledAt: null, recoveryCodesLeft: 0 } });
    assert.deepEqual(subjects().slice(before), ['【ツギガミ運営】2段階の確認が外されました']);
    assert.equal((await login({ email: OP, password: PASSWORD })).status, 200, '外したあとは、パスワードだけで入れる');
    const left = await db.raw(`SELECT totp_secret, totp_enabled_at FROM operators`) as Array<{ totp_secret: string | null; totp_enabled_at: string | null }>;
    assert.deepEqual(left, [{ totp_secret: null, totp_enabled_at: null }]);
  });

  it('パスワードやコードを確かめ直す操作は、ログインしたままでも連打できない', async () => {
    await calm();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await call('POST', '/security/totp/start', { password: `guess-number-${i}` })).status;
    assert.equal(last, 429);
  });

  it('認証アプリも予備のコードも無くしたら、サーバーの中からだけ外せる。外すと、ログインはすべて切れる', async () => {
    await calm();
    const s = await (await call('POST', '/security/totp/start', { password: PASSWORD })).json() as { secret: string };
    secret = s.secret;
    assert.equal((await call('POST', '/security/totp/enable', { code: codeAt() })).status, 200);
    assert.equal((await login({ email: OP, password: PASSWORD })).status, 401);

    assert.equal(await forceDisableTotp(db, 'nobody@example.com'), false);
    assert.equal(await forceDisableTotp(db, ` ${OP.toUpperCase()} `), true);
    assert.equal((await call('GET', '/tenants')).status, 401);
    const ok = await login({ email: OP, password: PASSWORD });
    assert.equal(ok.status, 200);
    token = ((await ok.json()) as { token: string }).token;
    const log = await (await call('GET', '/log')).json() as { entries: Array<{ action: string; detail: string | null }> };
    assert.ok(log.entries.some((e) => e.action === '2段階の確認を解除' && /サーバーの中から/.test(e.detail ?? '')));
  });

  it('認証アプリと分け合う鍵は、包む鍵を決めていれば、包んでから DB に入れる', async () => {
    await calm();
    process.env.MISENARE_SECRET_KEYS = `k1:${generateKey()}`;
    resetOperatorSecretBox();
    try {
      const s = await (await call('POST', '/security/totp/start', { password: PASSWORD })).json() as { secret: string };
      secret = s.secret;
      const rows = await db.raw(`SELECT totp_secret FROM operators`) as Array<{ totp_secret: string }>;
      assert.ok(isSealed(rows[0]!.totp_secret), '包まれていない');
      assert.ok(!rows[0]!.totp_secret.includes(secret), '中身が見えている');
      assert.equal((await call('POST', '/security/totp/enable', { code: codeAt() })).status, 200);
      await calm();
      assert.equal((await login({ email: OP, password: PASSWORD, code: codeAt() })).status, 200);
      await calm();
      assert.equal((await call('POST', '/security/totp/disable', { password: PASSWORD, code: codeAt() })).status, 200);
    } finally {
      delete process.env.MISENARE_SECRET_KEYS;
      resetOperatorSecretBox();
    }
  });

  it('問い合わせを、新しい順に読める。知らせのメールを送れなかったものが分かる', async () => {
    await submitContact(db, mailer, ['owner@tsugigami.example'], { name: '最初の人', company: '角の電器店', email: 'first@example.com', message: '1行目\n2行目' });
    await submitContact(db, mailer, [], { name: 'あとの人', company: null, email: 'second@example.com', message: '宛先が無くて、メールは出ていない' });
    await db.raw(`UPDATE contact_inquiries SET created_at = created_at - interval '1 day' WHERE name = '最初の人'`);
    const r = await (await call('GET', '/inquiries')).json() as { inquiries: Array<{ name: string; company: string | null; email: string; message: string; mailed: boolean; at: string }>; next: string | null; unmailed: number };
    assert.deepEqual(r.inquiries.map((q) => [q.name, q.company, q.email, q.mailed]), [
      ['あとの人', null, 'second@example.com', false], ['最初の人', '角の電器店', 'first@example.com', true],
    ]);
    assert.equal(r.inquiries[1]!.message, '1行目\n2行目');
    assert.equal(r.unmailed, 1);
    assert.equal(r.next, null);
    assert.equal((await call('GET', '/inquiries', undefined, null)).status, 401);

    await db.raw(
      `INSERT INTO contact_inquiries (name, email, message, mailed, created_at)
       SELECT '人' || n, 'x@example.com', '本文', true, now() - make_interval(days => 10, mins => n) FROM generate_series(1, 30) AS n`,
    );
    const page1 = await (await call('GET', '/inquiries')).json() as { inquiries: Array<{ name: string; at: string }>; next: string | null };
    assert.equal(page1.inquiries.length, 30);
    assert.ok(page1.next);
    const page2 = await (await call('GET', `/inquiries?before=${encodeURIComponent(page1.next!)}`)).json() as { inquiries: Array<{ name: string }>; next: string | null };
    assert.deepEqual(page2.inquiries.map((q) => q.name), ['人29', '人30']);
    assert.equal(page2.next, null);
    // 形の違う目印は、最初からの扱い（DB に変な文字を渡さない）
    assert.equal(((await (await call('GET', `/inquiries?before=${encodeURIComponent("'; --")}`)).json()) as { inquiries: unknown[] }).inquiries.length, 30);
  });

  it('会社の利用者を一覧でき、止める・戻すができる。止めた人の端末は使えなくなる', async () => {
    const made = await (await call('POST', '/tenants', { name: '角の電器店', storeName: '本店', adminName: '山田' })).json() as { id: string; invite: { url: string } };
    const invite = decodeURIComponent(/#invite=(\S+)$/.exec(made.invite.url)![1]!);
    const accepted = await app(new Request('https://app.tsugigami.example/auth/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: invite, deviceName: '試験' }),
    }));
    const session = (await accepted.json() as { sessionToken: string }).sessionToken;
    const asUser = () => app(new Request('https://app.tsugigami.example/me', { headers: { authorization: `Bearer ${session}` } }));
    assert.equal((await asUser()).status, 200);

    const { users } = await (await call('GET', `/tenants/${made.id}/users`)).json() as { users: Array<Record<string, unknown> & { id: string }> };
    assert.equal(users.length, 1);
    assert.deepEqual(users[0], { id: users[0]!.id, name: '山田', adminScope: 'tenant', trustLevel: 'trusted', status: 'active', stores: [], devices: 1, lastUsedAt: users[0]!.lastUsedAt });
    assert.ok(!('email' in users[0]!), 'メールアドレスは出さない');

    // テスト電機：役割と所属が出る。並びは、本部 → 店長 → そのほか
    const others = await (await call('GET', `/tenants/${T}/users`)).json() as { users: Array<{ name: string; adminScope: string; stores: string[] }> };
    assert.deepEqual(others.users.map((u) => [u.name, u.adminScope, u.stores]), [
      ['本部', 'tenant', []], ['店長', 'store', ['本店']], ['ベテランパート', 'none', ['本店']], ['新人バイト', 'none', ['本店']], ['駅前店スタッフ', 'none', ['駅前店']],
    ]);

    const stopped = await call('POST', `/tenants/${made.id}/users/${users[0]!.id}/disable`);
    assert.equal(stopped.status, 200);
    assert.equal(((await stopped.json()) as { users: Array<{ status: string; devices: number }> }).users[0]!.status, 'disabled');
    assert.equal((await asUser()).status, 401);
    const resumed = await (await call('POST', `/tenants/${made.id}/users/${users[0]!.id}/enable`)).json() as { users: Array<{ status: string; devices: number }> };
    assert.deepEqual([resumed.users[0]!.status, resumed.users[0]!.devices], ['active', 0], '戻しても、止めたときに切った端末は戻らない（入り直してもらう）');
    assert.equal((await asUser()).status, 401);

    // 他社の利用者の ID を混ぜても触れない
    assert.equal((await call('POST', `/tenants/${made.id}/users/${manager.userId}/disable`)).status, 404);
    assert.equal((await call('POST', `/tenants/${made.id}/users/not-a-uuid/disable`)).status, 404);
    assert.equal((await call('GET', '/tenants/10000000-0000-0000-0000-00000000dead/users')).status, 404);
    assert.equal((await call('GET', `/tenants/${made.id}/users`, undefined, null)).status, 401);
    const log = await (await call('GET', '/log')).json() as { entries: Array<{ action: string; tenantName: string | null; detail: string | null }> };
    assert.deepEqual(log.entries.filter((e) => e.action.startsWith('利用者を')).map((e) => [e.action, e.tenantName, e.detail]), [
      ['利用者を再開', '角の電器店', '「山田」'], ['利用者を停止', '角の電器店', '「山田」'],
    ]);
  });

  it('操作の記録は、30件より前も続きとして読める', async () => {
    await db.raw(`INSERT INTO operator_log (action, detail) SELECT '試験の記録', n::text FROM generate_series(1, 40) AS n`);
    const page1 = await (await call('GET', '/log')).json() as { entries: Array<{ id: number; detail: string | null }>; next: number | null };
    assert.equal(page1.entries.length, 30);
    assert.equal(page1.entries[0]!.detail, '40');
    assert.equal(page1.next, page1.entries.at(-1)!.id);
    const page2 = await (await call('GET', `/log?before=${page1.next}`)).json() as { entries: Array<{ id: number; detail: string | null }>; next: number | null };
    assert.ok(page2.entries.length >= 10 && page2.entries.every((e) => e.id < page1.next!));
    assert.equal(page2.entries[0]!.detail, '10');
    assert.equal(((await (await call('GET', '/log?before=abc')).json()) as { entries: unknown[] }).entries.length, 30, '形の違う目印は、最初からの扱い');
  });

  it('古いログインの記録と、使われなくなったブラウザーの印は、夜間に片付ける', async () => {
    await db.raw(`DELETE FROM operator_logins`);
    await db.raw(`INSERT INTO operator_logins (email, outcome, at) VALUES ($1::text, 'ok', now() - interval '100 days'), ($1::text, 'ok', now() - interval '80 days')`, [OP]);
    const op = await db.raw(`SELECT id FROM operators`) as Array<{ id: string }>;
    await db.raw(`INSERT INTO operator_devices (token_hash, operator_id, last_used_at) VALUES ('old', $1::uuid, now() - interval '400 days'), ('recent', $1::uuid, now() - interval '300 days')`, [op[0]!.id]);
    assert.equal(await sweepOperatorRecords((sql, params) => db.raw(sql, params)), 1);
    const logins = await db.raw(`SELECT count(*)::int AS n FROM operator_logins`) as Array<{ n: number }>;
    assert.equal(Number(logins[0]!.n), 1);
    const devices = await db.raw(`SELECT token_hash FROM operator_devices WHERE token_hash IN ('old', 'recent')`) as Array<{ token_hash: string }>;
    assert.deepEqual(devices.map((d) => d.token_hash), ['recent']);
  });
});
