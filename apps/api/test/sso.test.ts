// 会社のアカウントで入る（OpenID Connect）。偽の IdP を相手に、確かめ方を試す。
//
// ここで守りたいのは1つ：**相手の IdP が名乗ったことを、そのまま信じない**。
// 署名・発行元・宛先・期限・合言葉のどれか1つを見落とすと、他人として入れる。

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { OidcDirectory } from '../src/auth/oidc.ts';
import {
  addProvider, emailDomain, finishSso, listProviders, startSso, sweepSsoStates,
} from '../src/domain/sso.ts';
import { claimsFor, fakeIdp, type FakeIdp } from './ssoHelper.ts';
import { freshDatabase, hq, manager, STORE_A, T, trusted } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
before(async () => { db = await freshDatabase(); });
after(async () => { await db.close(); });

const SITE = { redirectUri: 'https://misenare.example.com/api/auth/sso/callback' };
const raw = (sql: string, params?: readonly unknown[]) => db.raw(sql, params);

let idp: FakeIdp;
let directory: OidcDirectory;

/** 会社アカウントの設定を1つ入れる */
async function setup(over: Partial<Parameters<typeof addProvider>[2]> = {}) {
  idp = fakeIdp();
  directory = new OidcDirectory(idp.fetch);
  return db.withTenant(T, (q) => addProvider(q, hq, {
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    domains: ['kdenki.example.co.jp'],
    ...over,
  }));
}

/** 入口から戻りまでを一通り。claims を差し替えて、異常も試せる */
async function roundTrip(email = 'tanaka@kdenki.example.co.jp', over: Record<string, unknown> = {}) {
  const start = await startSso(db, directory, SITE, { email });
  const url = new URL(start.authorizeUrl);
  const state = url.searchParams.get('state')!;
  const nonce = url.searchParams.get('nonce')!;
  idp.issue(claimsFor(idp, { email, nonce, ...over }));
  return { url, state, finish: () => finishSso(db, directory, SITE, { code: 'code-1', state }) };
}

describe('メールアドレスのドメイン', () => {
  it('取り出せる形と、取り出せない形', () => {
    assert.equal(emailDomain('a@Kdenki.Example.co.jp'), 'kdenki.example.co.jp');
    assert.equal(emailDomain('a@b'), null, '点が無いものは通さない');
    assert.equal(emailDomain('@example.com'), null);
    assert.equal(emailDomain('ただの文字'), null);
  });
});

describe('設定の管理', () => {
  it('本部の管理者だけが触れる', async () => {
    await db.withTenant(T, async (q) => {
      await assert.rejects(addProvider(q, trusted, {
        issuer: 'https://idp.example.com', clientId: 'x', domains: ['a.example.com'],
      }), /本部の管理者/);
      await assert.rejects(addProvider(q, manager, {
        issuer: 'https://idp.example.com', clientId: 'x', domains: ['a.example.com'],
      }), /本部の管理者/);
      await assert.rejects(listProviders(q, trusted), /本部の管理者/);
    });
  });

  it('発行元は https で、問い合わせや断片を付けられない', async () => {
    await db.withTenant(T, async (q) => {
      const bad = (issuer: string) => addProvider(q, hq, { issuer, clientId: 'x', domains: ['a.example.com'] });
      await assert.rejects(bad('http://idp.example.com'), /https/);
      await assert.rejects(bad('https://idp.example.com/?next=http://social.example.com'), /\? や #/);
      await assert.rejects(bad('ただの文字'), /形が違います/);
    });
  });

  it('自動登録を使うなら、配属先の店舗が要る', async () => {
    await db.withTenant(T, async (q) => {
      await assert.rejects(addProvider(q, hq, {
        issuer: 'https://idp2.example.com', clientId: 'x', domains: ['b.example.com'], jitEnabled: true,
      }), /配属先/);
    });
  });

  it('内緒の鍵は読み出せない（入っているかだけ）', async () => {
    const added = await setup();
    assert.equal(added.hasSecret, true);
    const list = await db.withTenant(T, (q) => listProviders(q, hq));
    const found = list.find((p) => p.id === added.id)!;
    assert.equal(found.hasSecret, true);
    assert.ok(!JSON.stringify(found).includes('とても内緒'), '鍵そのものが混ざっている');
    await db.withTenant(T, (q) => q.query(`DELETE FROM sso_domains`));
    await db.withTenant(T, (q) => q.query(`DELETE FROM sso_providers`));
  });
});

describe('入口', () => {
  it('相手の画面の URL を作る（PKCE と合言葉を付けて）', async () => {
    await setup();
    const { url } = await roundTrip();
    assert.equal(url.origin + url.pathname, `${idp.issuer}/authorize`);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), idp.clientId);
    assert.equal(url.searchParams.get('redirect_uri'), SITE.redirectUri);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.ok(url.searchParams.get('state'));
    assert.ok(url.searchParams.get('nonce'));
    assert.equal(url.searchParams.get('login_hint'), 'tanaka@kdenki.example.co.jp');
    await db.withTenant(T, (q) => q.query(`DELETE FROM sso_domains`));
    await db.withTenant(T, (q) => q.query(`DELETE FROM sso_providers`));
  });

  it('登録の無いドメインは、招待の案内に戻す', async () => {
    await setup();
    await assert.rejects(startSso(db, directory, SITE, { email: 'a@yodobashi.example.com' }),
      /まだ用意されていません/);
    await db.withTenant(T, (q) => q.query(`DELETE FROM sso_domains`));
    await db.withTenant(T, (q) => q.query(`DELETE FROM sso_providers`));
  });

  it('戻り先は経路だけを通す（外のサイトに飛ばさない）', async () => {
    await setup();
    const inside = await startSso(db, directory, SITE, { email: 'tanaka@kdenki.example.co.jp', returnTo: '#/k/abc' });
    const outside = await startSso(db, directory, SITE, { email: 'tanaka@kdenki.example.co.jp', returnTo: 'https://evil.example.com' });
    const [kept, dropped] = await Promise.all([
      raw(`SELECT return_to FROM sso_states WHERE state = $1`, [new URL(inside.authorizeUrl).searchParams.get('state')]),
      raw(`SELECT return_to FROM sso_states WHERE state = $1`, [new URL(outside.authorizeUrl).searchParams.get('state')]),
    ]);
    assert.equal((kept[0] as { return_to: string }).return_to, '#/k/abc');
    assert.equal((dropped[0] as { return_to: string | null }).return_to, null);
    await db.withTenant(T, (q) => q.query(`DELETE FROM sso_domains`));
    await db.withTenant(T, (q) => q.query(`DELETE FROM sso_providers`));
  });
});

describe('誰として入れるか', () => {
  async function clean() {
    await db.withTenant(T, async (q) => {
      await q.query(`DELETE FROM sso_identities`);
      await q.query(`DELETE FROM sso_domains`);
      await q.query(`DELETE FROM sso_providers`);
      await q.query(`DELETE FROM sessions`);
      await q.query(`UPDATE users SET email = NULL`);
      await q.query(`DELETE FROM memberships WHERE user_id NOT IN ($1, $2)`, [trusted.userId, manager.userId]);
      await q.query(`DELETE FROM users WHERE email IS NOT NULL`);
    });
  }

  it('登録済みでなければ、既定では断る（自動で作らない）', async () => {
    await setup();
    const { finish } = await roundTrip();
    await assert.rejects(finish(), /まだ登録されていません/);
    await clean();
  });

  it('確認済みのメールアドレスが一致すれば、既存の利用者に結びつく', async () => {
    await setup();
    await db.withTenant(T, (q) => q.query(
      `UPDATE users SET email = $2 WHERE id = $1`, [trusted.userId, 'tanaka@kdenki.example.co.jp']));
    const { finish } = await roundTrip();
    const result = await finish();
    assert.equal(result.userId, trusted.userId);

    // 2回目は sub で引く（メールアドレスが変わっても同じ人として入れる）
    const again = await roundTrip('tanaka@kdenki.example.co.jp', { email: 'tanaka.new@kdenki.example.co.jp' });
    assert.equal((await again.finish()).userId, trusted.userId);
    await clean();
  });

  it('メールアドレスが確認されていなければ、結びつけない', async () => {
    await setup();
    await db.withTenant(T, (q) => q.query(
      `UPDATE users SET email = $2 WHERE id = $1`, [trusted.userId, 'tanaka@kdenki.example.co.jp']));
    const { finish } = await roundTrip('tanaka@kdenki.example.co.jp', { email_verified: false });
    await assert.rejects(finish(), /まだ登録されていません/);
    await clean();
  });

  it('**会社のドメインでないアカウントは通さない**（入口で打つアドレスとは別に確かめる）', async () => {
    // 入口では会社のアドレスを打ち、相手の画面では個人のアカウントで入る、という筋を止める。
    // 入口のドメインだけを見ていると、ここが通ってしまう。
    await setup({ jitEnabled: true, defaultStoreId: STORE_A });
    const { finish } = await roundTrip('tanaka@kdenki.example.co.jp', { email: 'warui@gmail.example.com' });
    await assert.rejects(finish(), /この会社のアカウントとして登録されていません/);
    await clean();
  });

  it('自動登録を入れたときだけ、初回に作る（visitor・指定の店舗）', async () => {
    await setup({ jitEnabled: true, defaultStoreId: STORE_A, defaultTrust: 'visitor' });
    const { finish } = await roundTrip();
    const result = await finish();
    const rows = await db.withTenant(T, (q) => q.query<{ name: string; trust_level: string; email: string }>(
      `SELECT name, trust_level, email FROM users WHERE id = $1`, [result.userId]));
    assert.equal(rows[0]!.name, '田中 太郎');
    assert.equal(rows[0]!.trust_level, 'visitor', '作ったばかりの人の投稿は承認を通す');
    assert.equal(rows[0]!.email, 'tanaka@kdenki.example.co.jp');
    const stores = await db.withTenant(T, (q) => q.query<{ store_id: string }>(
      `SELECT store_id FROM memberships WHERE user_id = $1`, [result.userId]));
    assert.deepEqual(stores.map((m) => m.store_id), [STORE_A]);
    await clean();
  });

  it('無効にした利用者は、会社のアカウントでも入れない', async () => {
    await setup();
    await db.withTenant(T, (q) => q.query(
      `UPDATE users SET email = $2 WHERE id = $1`, [trusted.userId, 'tanaka@kdenki.example.co.jp']));
    const first = await roundTrip();
    await first.finish();
    await db.withTenant(T, (q) => q.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [trusted.userId]));
    const second = await roundTrip();
    await assert.rejects(second.finish(), /無効化されています/);
    await db.withTenant(T, (q) => q.query(`UPDATE users SET status = 'active' WHERE id = $1`, [trusted.userId]));
    await clean();
  });
});

describe('相手が名乗ったことを、そのまま信じない', () => {
  async function clean() {
    await db.withTenant(T, async (q) => {
      await q.query(`DELETE FROM sso_identities`);
      await q.query(`DELETE FROM sso_domains`);
      await q.query(`DELETE FROM sso_providers`);
      await q.query(`UPDATE users SET email = NULL`);
    });
    await raw(`DELETE FROM sso_states`);
  }

  async function attempt(over: Record<string, unknown>) {
    await db.withTenant(T, (q) => q.query(
      `UPDATE users SET email = $2 WHERE id = $1`, [trusted.userId, 'tanaka@kdenki.example.co.jp']));
    const { finish } = await roundTrip('tanaka@kdenki.example.co.jp', over);
    return finish();
  }

  it('発行元・宛先・期限・合言葉のどれかが違えば通さない', async () => {
    await setup();
    await assert.rejects(attempt({ iss: 'https://evil.example.com' }), /発行元が違います/);
    await assert.rejects(attempt({ aud: 'ほかのアプリ' }), /このアプリ向けのトークンではありません/);
    await assert.rejects(attempt({ exp: Math.floor(Date.now() / 1000) - 600 }), /期限が切れています/);
    await assert.rejects(attempt({ nonce: 'ちがう合言葉' }), /合言葉が合いません/);
    await clean();
  });

  it('署名の無いトークン（alg: none）は受け付けない', async () => {
    await setup();
    const start = await startSso(db, directory, SITE, { email: 'tanaka@kdenki.example.co.jp' });
    const state = new URL(start.authorizeUrl).searchParams.get('state')!;
    const nonce = new URL(start.authorizeUrl).searchParams.get('nonce')!;
    // 署名の欄を空にした、形だけのトークンを相手が返してきたことにする
    const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url');
    const body = Buffer.from(JSON.stringify(claimsFor(idp, { nonce })), 'utf8').toString('base64url');
    const bare = `${head}.${body}.`;
    const faking = new OidcDirectory(async (url, init) => {
      if (url.endsWith('/token')) {
        return new Response(JSON.stringify({ id_token: bare }), { headers: { 'content-type': 'application/json' } });
      }
      return idp.fetch(url, init);
    });
    await assert.rejects(finishSso(db, faking, SITE, { code: 'c', state }), /この署名方式は受け付けません/);
    await clean();
  });

  it('覚え（state）は1回しか使えない', async () => {
    await setup();
    await db.withTenant(T, (q) => q.query(
      `UPDATE users SET email = $2 WHERE id = $1`, [trusted.userId, 'tanaka@kdenki.example.co.jp']));
    const { state, finish } = await roundTrip();
    await finish();
    idp.issue(claimsFor(idp, { nonce: 'なんでも' }));
    await assert.rejects(finishSso(db, directory, SITE, { code: 'code-1', state }), /時間が経ちすぎました/);
    await clean();
  });

  it('PKCE の検証子を相手に送っている（引換券だけでは交換させない）', async () => {
    await setup();
    await db.withTenant(T, (q) => q.query(
      `UPDATE users SET email = $2 WHERE id = $1`, [trusted.userId, 'tanaka@kdenki.example.co.jp']));
    const { finish } = await roundTrip();
    await finish();
    assert.ok(idp.lastTokenRequest?.code_verifier, '検証子を送っていない');
    assert.equal(idp.lastTokenRequest?.grant_type, 'authorization_code');
    assert.equal(idp.lastTokenRequest?.redirect_uri, SITE.redirectUri);
    // 内緒の鍵は本文ではなく Basic 認証で送る（本文は記録に残りやすい）
    assert.ok(idp.lastAuthorization?.startsWith('Basic '), '内緒の鍵を本文に書いている');
    assert.ok(!('client_secret' in (idp.lastTokenRequest ?? {})));
    await clean();
  });

  it('相手が交換を断ったら、そのまま通さない', async () => {
    await setup();
    const start = await startSso(db, directory, SITE, { email: 'tanaka@kdenki.example.co.jp' });
    const state = new URL(start.authorizeUrl).searchParams.get('state')!;
    idp.refuse('引換券が使われています');
    await assert.rejects(finishSso(db, directory, SITE, { code: 'c', state }), /引換券が使われています/);
    await clean();
  });

  it('鍵を入れ替えられても、取り直して通す', async () => {
    await setup();
    await db.withTenant(T, (q) => q.query(
      `UPDATE users SET email = $2 WHERE id = $1`, [trusted.userId, 'tanaka@kdenki.example.co.jp']));
    const start = await startSso(db, directory, SITE, { email: 'tanaka@kdenki.example.co.jp' });
    const state = new URL(start.authorizeUrl).searchParams.get('state')!;
    const nonce = new URL(start.authorizeUrl).searchParams.get('nonce')!;
    await directory.signingKeys(idp.issuer); // いちど覚えさせる
    idp.rotate('key-2');
    idp.issue(claimsFor(idp, { nonce }));
    const result = await finishSso(db, directory, SITE, { code: 'c', state });
    assert.equal(result.userId, trusted.userId);
    await clean();
  });
});

describe('期限切れの覚えの片付け', () => {
  it('夜間バッチで捨てる', async () => {
    await raw(
      `INSERT INTO sso_states (state, provider_id, tenant_id, code_verifier, nonce, expires_at)
       SELECT '古い覚え', p.id, p.tenant_id, 'v', 'n', now() - interval '1 hour' FROM sso_providers p LIMIT 1`,
    ).catch(() => undefined);
    const swept = await sweepSsoStates(raw);
    assert.ok(swept >= 0);
    const left = await raw(`SELECT state FROM sso_states WHERE expires_at < now()`);
    assert.equal(left.length, 0);
  });
});

describe('相手の設定と鍵の覚え', () => {
  it('知らない鍵を名乗られても、取り直しは連打しない', async () => {
    const idp2 = fakeIdp({ issuer: 'https://idp3.example.com' });
    let fetches = 0;
    const counted = new OidcDirectory((url, init) => {
      if (url.endsWith('/jwks')) fetches++;
      return idp2.fetch(url, init);
    });
    await counted.signingKeys(idp2.issuer);
    assert.equal(fetches, 1);
    // 覚えの中にある鍵なら取りに行かない
    await counted.signingKeys(idp2.issuer, 'key-1');
    assert.equal(fetches, 1);
    // 知らない鍵なら1回だけ取り直す（鍵の入れ替え直後がこれ）
    await counted.signingKeys(idp2.issuer, 'key-99');
    assert.equal(fetches, 2);
    // 続けて投げられても取りに行かない
    await counted.signingKeys(idp2.issuer, 'key-98');
    await counted.signingKeys(idp2.issuer, 'key-97');
    assert.equal(fetches, 2, '知らない鍵を名乗るトークンで、相手に連打してしまう');
  });

  it('設定が名乗る発行元が違えば、信用しない', async () => {
    // 発行元の乗っ取り（別の issuer を名乗る設定を返す）を止める
    const lying = new OidcDirectory(async (url) => {
      if (url.includes('.well-known')) {
        return new Response(JSON.stringify({
          issuer: 'https://evil.example.com',
          authorization_endpoint: 'https://evil.example.com/authorize',
          token_endpoint: 'https://evil.example.com/token',
          jwks_uri: 'https://evil.example.com/jwks',
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    });
    await assert.rejects(lying.describe('https://idp4.example.com'), /設定の発行元が違います/);
  });
});
