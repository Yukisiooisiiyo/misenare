import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import type { Mail, Mailer } from '../src/mail/mailer.ts';
import { acceptInvitation, clearMyEmail, confirmEmailChange, inviteByEmail, requestEmailChange, sendEmailLogin, updateUser } from '../src/domain/users.ts';
import { createApp } from '../src/http/app.ts';
import { SessionAuthenticator } from '../src/http/auth.ts';
import { MemoryRateLimiter } from '../src/http/rateLimit.ts';
import type { Actor } from '../src/domain/actor.ts';
import { freshDatabase, hq, manager, STORE_A, storeBStaff, T, tokenizer, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

describe('メールでログインリンク／メアド登録', () => {
  let db: TestDatabase;
  const run = <R>(fn: (q: Db) => Promise<R>): Promise<R> => db.withTenant(T, fn);
  const collector = (): { mailer: Mailer; sent: Mail[] } => {
    const sent: Mail[] = [];
    return { sent, mailer: { send: async (m) => { sent.push(m); return true; } } };
  };
  before(async () => { db = await freshDatabase(); });
  after(async () => { await db.close(); });

  const emailOf = async (userId: string) =>
    (await run((q) => q.query<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [userId])))[0]!.email;
  /** 登録を申し込み、届いた確認メールのリンクを取り出す */
  async function requestEmail(actor: Actor, email: string) {
    const { mailer, sent } = collector();
    const r = await run((q) => requestEmailChange(q, actor, mailer, 'https://app.example.com/', email));
    const token = decodeURIComponent(/#verify-email=([^\s]+)/.exec(sent[0]!.text)![1]!);
    return { r, sent, token };
  }
  /** 申し込みから、確認のリンクを開くところまで */
  async function setMyEmail(actor: Actor, email: string) {
    const { token } = await requestEmail(actor, email);
    return run((q) => confirmEmailChange(q, token));
  }

  it('メアド登録→そのメアドにログインリンクが届き、同じ本人として入れる（大小無視）', async () => {
    await setMyEmail(visitor, 'baito@example.com');
    const { mailer, sent } = collector();
    await sendEmailLogin(db, mailer, 'https://app.example.com/', 'BAITO@Example.com');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.to, ['baito@example.com']);
    const m = /#invite=([^\s]+)/.exec(sent[0]!.text);
    assert.ok(m, 'ログインリンクが入っている');
    const accepted = await run((q) => acceptInvitation(q, T, decodeURIComponent(m![1]!), 'PC'));
    assert.equal(accepted.userId, visitor.userId, '新しい利用者を作らず、自分として入る');
  });

  it('登録の無いメアドには何も送らない（存在を漏らさない）', async () => {
    const { mailer, sent } = collector();
    await sendEmailLogin(db, mailer, 'https://app.example.com', 'nobody@example.com');
    assert.equal(sent.length, 0);
  });

  it('ログインリンクの依頼は、メールを送り終わるのを待たずに、登録の有無によらず同じ応答を返す', async () => {
    // いつまでも送り終わらない口。応答が送信を待つ作りだと、登録のあるアドレスのときだけ返ってこなくなる
    // （＝かかった時間から、そのアドレスの登録の有無が外から分かる）
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sent: Mail[] = [];
    const slow: Mailer = { send: async (m) => { await gate; sent.push(m); return true; } };
    const app = createApp({ database: db, auth: new SessionAuthenticator(db), tokenizer, limiter: new MemoryRateLimiter(), loginMailer: slow });
    const before = process.env.APP_URL;
    process.env.APP_URL = 'https://app.example.com';
    try {
      const ask = (email: string) => app(new Request('http://localhost/auth/email-link', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }),
      }));
      const known = await ask('baito@example.com');
      const unknown = await ask('nobody@example.com');
      assert.equal(known.status, 200);
      assert.deepEqual(await known.json(), { requested: true });
      assert.deepEqual(await unknown.json(), { requested: true });
      assert.equal(sent.length, 0, '応答した時点では、まだ送り終わっていない');
      release();
      await app.settled();
      assert.equal(sent.length, 1, '登録のあるアドレスにだけ、あとから届く');
      assert.deepEqual(sent[0]!.to, ['baito@example.com']);
    } finally {
      if (before === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = before;
    }
  });

  it('同じメアドは社内の別アカウントには登録できない', async () => {
    await setMyEmail(trusted, 'dup@example.com');
    await assert.rejects(setMyEmail(manager, 'DUP@example.com'), /別のアカウント/);
  });

  it('打っただけでは登録されない。届いた確認のリンクを開いて、はじめて登録される', async () => {
    const { r, sent, token } = await requestEmail(manager, 'tencho@example.com');
    assert.deepEqual(r, { pending: 'tencho@example.com' });
    assert.deepEqual(sent[0]!.to, ['tencho@example.com'], '確認は、打たれたアドレスあてに送る');
    assert.match(sent[0]!.text, /「店長」さんのアカウント/, 'だれのアカウントへの登録かを書く');
    assert.match(sent[0]!.text, /https:\/\/app\.example\.com\/app\/#verify-email=/);
    assert.equal(await emailOf(manager.userId), null, 'まだ登録されていない');
    // 登録されていないので、ログインリンクも出ない
    const login = collector();
    await sendEmailLogin(db, login.mailer, 'https://app.example.com', 'tencho@example.com');
    assert.equal(login.sent.length, 0);

    assert.deepEqual(await run((q) => confirmEmailChange(q, token)), { email: 'tencho@example.com' });
    assert.equal(await emailOf(manager.userId), 'tencho@example.com');
    await assert.rejects(run((q) => confirmEmailChange(q, token)), /使えません/, 'リンクは1回限り');
  });

  it('確認のリンクは30分で切れる。出し直すと、前のリンクは使えなくなる', async () => {
    const first = await requestEmail(hq, 'honbu@example.com');
    const second = await requestEmail(hq, 'honbu2@example.com');
    await assert.rejects(run((q) => confirmEmailChange(q, first.token)), /使えません/);
    await run((q) => q.query(`UPDATE email_verifications SET expires_at = now() - interval '1 second'`));
    await assert.rejects(run((q) => confirmEmailChange(q, second.token)), /使えません/);
    assert.equal(await emailOf(hq.userId), null);
  });

  it('申し込んでから開くまでに、ほかの人がそのアドレスを使い始めていたら登録しない', async () => {
    const { token } = await requestEmail(hq, 'race@example.com');
    await run((q) => q.query(`UPDATE users SET email = 'race@example.com' WHERE id = $1`, [storeBStaff.userId]));
    await assert.rejects(run((q) => confirmEmailChange(q, token)), /別のアカウント/);
    assert.equal(await emailOf(hq.userId), null);
  });

  it('登録を外すのに確認は要らない。管理者は、スタッフの登録を外せる（別のアドレスは入れられない）', async () => {
    assert.equal(await emailOf(trusted.userId), 'dup@example.com');
    assert.deepEqual(await run((q) => clearMyEmail(q, trusted)), { email: null });
    assert.equal(await emailOf(trusted.userId), null);
    assert.equal(await emailOf(visitor.userId), 'baito@example.com');
    await run((q) => updateUser(q, manager, visitor.userId, { email: null }));
    assert.equal(await emailOf(visitor.userId), null);
  });

  it('HTTP：登録の申し込みは 202 で、確認のリンクはログインなしでも開ける。空で送ると外れる', async () => {
    const { mailer, sent } = collector();
    const app = createApp({ database: db, auth: new SessionAuthenticator(db), tokenizer, limiter: new MemoryRateLimiter(), loginMailer: mailer });
    const { createInvitation } = await import('../src/domain/users.ts');
    const inv = await run((q) => createInvitation(q, manager, { storeId: STORE_A, name: '確認の試験の人' }));
    const session = await run((q) => acceptInvitation(q, T, inv.token, 'スマホ'));
    const call = async (token: string | null, method: string, path: string, body?: unknown) => {
      const res = await app(new Request(`http://localhost${path}`, {
        method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const before = process.env.APP_URL;
    process.env.APP_URL = 'https://app.example.com';
    try {
      // 同じ人の、もう1台の端末（あとで「登録されました」の知らせが出るのは、こちらだけ）
      const key = await run((q) => createInvitation(q, manager, { storeId: STORE_A, userId: session.userId }));
      const second = await run((q) => acceptInvitation(q, T, key.token, '2台目'));

      const asked = await call(session.sessionToken, 'POST', '/me/email', { email: 'http-test@example.com' });
      assert.equal(asked.status, 202);
      assert.deepEqual(asked.body, { pending: 'http-test@example.com' });
      assert.equal((await call(session.sessionToken, 'GET', '/me')).body.email, null, 'まだ登録されていない');
      const token = decodeURIComponent(/#verify-email=([^\s]+)/.exec(sent.at(-1)!.text)![1]!);

      assert.equal((await call(null, 'POST', '/auth/email-verify', { token: 'でたらめ' })).status, 400);
      assert.equal((await call(null, 'POST', '/auth/email-verify', { token: `${T}.${'x'.repeat(43)}` })).status, 404);
      const done = await call(null, 'POST', '/auth/email-verify', { token });
      assert.equal(done.status, 200);
      assert.deepEqual(done.body, { email: 'http-test@example.com' }, '鍵は返さない（開いた端末はログインしない）');
      assert.equal((await call(session.sessionToken, 'GET', '/me')).body.email, 'http-test@example.com');

      // 登録されたことは、申し込んだ端末**以外**に知らせる（端末を少し触れた人が自分のアドレスを入れていった、に気づけるように）
      assert.equal((await call(session.sessionToken, 'GET', '/me')).body.newEmail, null, '申し込んだ端末には出さない');
      assert.equal((await call(second.sessionToken, 'GET', '/me')).body.newEmail, 'http-test@example.com');
      const badges = await call(second.sessionToken, 'GET', `/stores/${STORE_A}/badges`);
      assert.equal(badges.body.devices.emailChanged, true);
      assert.equal((await call(session.sessionToken, 'GET', `/stores/${STORE_A}/badges`)).body.devices.emailChanged, false);
      await call(second.sessionToken, 'POST', '/me/devices/seen');
      assert.equal((await call(second.sessionToken, 'GET', '/me')).body.newEmail, null, '見たら消える');

      // 管理者は外せるが、別のアドレスは入れられない
      assert.equal((await call(session.sessionToken, 'POST', '/me/email', { email: '' })).status, 200);
      assert.equal((await call(session.sessionToken, 'GET', '/me')).body.email, null);
      assert.equal((await call(session.sessionToken, 'POST', '/me/email', { email: 'not-an-email' })).status, 400);

      // メールを送れない設定のときは、登録を受け付けない（届くことを確かめられないため）
      const noMail = createApp({ database: db, auth: new SessionAuthenticator(db), tokenizer, limiter: new MemoryRateLimiter() });
      const refused = await noMail(new Request('http://localhost/me/email', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.sessionToken}` },
        body: JSON.stringify({ email: 'http-test@example.com' }),
      }));
      assert.equal(refused.status, 400);

      // 好きな宛先にメールを飛ばせる口なので、回数で止める（1人あたり10分に5通）
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await call(session.sessionToken, 'POST', '/me/email', { email: `spam${i}@example.com` })).status);
      assert.equal(statuses.at(-1), 429, statuses.join(','));
    } finally {
      if (before === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = before;
    }
  });

  it('招待メールで入ると、その宛先が本人のメアドとして紐付く', async () => {
    const { mailer } = collector();
    const inv = await run((q) => inviteByEmail(q, manager, mailer, 'https://app.example.com', {
      storeId: STORE_A, name: '新人', email: 'newcomer@example.com',
    }));
    assert.equal(inv.sent, true);
    // 届いたリンクで受け入れ → 作られた利用者に email が入っている
    const { mailer: m2, sent } = collector();
    await run((q) => inviteByEmail(q, manager, m2, 'https://app.example.com', {
      storeId: STORE_A, name: '新人2', email: 'nc2@example.com',
    }));
    const token = decodeURIComponent(/#invite=([^\s]+)/.exec(sent[0]!.text)![1]!);
    const accepted = await run((q) => acceptInvitation(q, T, token, 'スマホ'));
    const row = await run((q) => q.query<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [accepted.userId]));
    assert.equal(row[0]!.email, 'nc2@example.com');
  });
});
