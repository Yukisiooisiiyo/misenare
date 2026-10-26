// 会社のアカウントで入る（OpenID Connect）。偽の IdP を相手に、確かめ方を試す。
//
// ここで守りたいのは1つ：**相手の IdP が名乗ったことを、そのまま信じない**。
// 署名・発行元・宛先・期限・合言葉のどれか1つを見落とすと、他人として入れる。

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { OidcDirectory } from '../src/auth/oidc.ts';
import {
  addProvider, checkConnection, emailDomain, finishSso, listProviders, startSso, sweepSsoStates,
  verifyDomain, VERIFY_PREFIX,
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
  const added = await db.withTenant(T, (q) => addProvider(q, hq, {
    issuer: idp.issuer,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    domains: ['kdenki.example.co.jp'],
    ...over,
  }));
  // ドメインは DNS に印を置くまで入口で使われない（なりすまし対策）。
  // ここでは置けたことにする。印そのものの試験は「ドメインの持ち主…」の節。
  await db.withTenant(T, (q) => q.query(`UPDATE sso_domains SET verified_at = now()`));
  return added;
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
      await q.query(`DELETE FROM access_requests`);
      await q.query(`DELETE FROM sso_identities`);
      await q.query(`DELETE FROM sso_domains`);
      await q.query(`DELETE FROM sso_providers`);
      await q.query(`DELETE FROM sessions`);
      await q.query(`UPDATE users SET email = NULL`);
      await q.query(`DELETE FROM memberships WHERE user_id NOT IN ($1, $2)`, [trusted.userId, manager.userId]);
      await q.query(`DELETE FROM users WHERE email IS NOT NULL`);
    });
  }

  it('登録済みでなければ、既定では作らない（申請として受ける）', async () => {
    await setup();
    const { finish } = await roundTrip();
    // 行き止まりにせず、店長が見て決められる形にする（apps/api/test/accessRequests.test.ts）
    await assert.rejects(finish(), /利用の申請を出しました/);
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
      await q.query(`DELETE FROM access_requests`);
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
      if (url.endsWith('/token')) return { status: 200, text: JSON.stringify({ id_token: bare }) };
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

  it('**相手の文書が指す行き先を、そのまま信用しない**', async () => {
    // ここが本命の穴だった。相手は自分の設定文書に好きな URL を書けるので、
    // 社内のアドレスやクラウドの鍵置き場を書くだけで、こちらのサーバーが
    // そこへ取りに行ってしまう（SSRF）。
    const pointing = (endpoints: Record<string, string>) => new OidcDirectory(async (url) => {
      if (url.includes('.well-known')) {
        return { status: 200, text: JSON.stringify({
          issuer: 'https://idp5.example.com',
          authorization_endpoint: 'https://idp5.example.com/authorize',
          token_endpoint: 'https://idp5.example.com/token',
          jwks_uri: 'https://idp5.example.com/jwks',
          ...endpoints,
        }) };
      }
      return { status: 200, text: '{"keys":[]}' };
    });

    // クラウドの鍵置き場
    await assert.rejects(
      pointing({ jwks_uri: 'http://169.254.169.254/latest/meta-data/' }).describe('https://idp5.example.com'),
      /https である必要があります/,
    );
    // 社内の画面
    await assert.rejects(
      pointing({ token_endpoint: 'http://10.0.0.5:9000/admin' }).describe('https://idp5.example.com'),
      /https である必要があります/,
    );
    // 別の仕組みに手を伸ばす形
    await assert.rejects(
      pointing({ jwks_uri: 'file:///etc/passwd' }).describe('https://idp5.example.com'),
      /https である必要があります/,
    );
    // 利用者名を埋め込んで、見間違いを誘う形
    await assert.rejects(
      pointing({ authorization_endpoint: 'https://idp5.example.com@10.0.0.5/' }).describe('https://idp5.example.com'),
      /利用者名や合言葉/,
    );
    // まともな設定は通る
    const okay = await pointing({}).describe('https://idp5.example.com');
    assert.equal(okay.jwks_uri, 'https://idp5.example.com/jwks');
  });

  it('設定が名乗る発行元が違えば、信用しない', async () => {
    // 発行元の乗っ取り（別の issuer を名乗る設定を返す）を止める
    const lying = new OidcDirectory(async (url) => {
      if (url.includes('.well-known')) {
        return { status: 200, text: JSON.stringify({
          issuer: 'https://evil.example.com',
          authorization_endpoint: 'https://evil.example.com/authorize',
          token_endpoint: 'https://evil.example.com/token',
          jwks_uri: 'https://evil.example.com/jwks',
        }) };
      }
      return { status: 404, text: 'not found' };
    });
    await assert.rejects(lying.describe('https://idp4.example.com'), /設定の発行元が違います/);
  });
});

describe('つなぎを確かめる', () => {
  async function clean() {
    await db.withTenant(T, async (q) => {
      await q.query(`DELETE FROM sso_domains`);
      await q.query(`DELETE FROM sso_providers`);
    });
  }

  it('発行元まで確かめ、確かめられないことは正直に返す', async () => {
    await setup();
    const result = await checkConnection(directory, hq, idp.issuer);
    assert.equal(result.ok, true, JSON.stringify(result.steps));
    assert.deepEqual(result.steps.map((s) => s.ok), [true, true, true, true, true]);
    // 「つながりました」で終わらせない。入れる気になって当日に詰まるのを防ぐ
    assert.ok(result.remaining.some((r) => r.includes('client_id')), result.remaining.join(' / '));
    await clean();
  });

  it('打ち間違いは、その場で分かる', async () => {
    await setup();
    const typo = await checkConnection(directory, hq, 'https://idp.example.com.typo');
    assert.equal(typo.ok, false);
    assert.equal(typo.steps.at(-1)!.label, '相手の設定を読めた');
    assert.ok(typo.steps.at(-1)!.detail);
    await clean();
  });

  it('形が違えば、相手に行く前に止める', async () => {
    await setup();
    for (const bad of ['http://idp.example.com', 'https://idp.example.com/?a=1', 'ただの文字']) {
      const r = await checkConnection(directory, hq, bad);
      assert.equal(r.ok, false, bad);
      assert.equal(r.steps.length, 1, `${bad} で相手に行ってしまった`);
    }
    await clean();
  });

  it('PKCE に対応していない相手は、はっきり落とす', async () => {
    const weak = new OidcDirectory(async (url) => {
      if (url.includes('.well-known')) {
        return { status: 200, text: JSON.stringify({
          issuer: 'https://old.example.com',
          authorization_endpoint: 'https://old.example.com/authorize',
          token_endpoint: 'https://old.example.com/token',
          jwks_uri: 'https://old.example.com/jwks',
          code_challenge_methods_supported: ['plain'],
        }) };
      }
      return { status: 200, text: JSON.stringify({ keys: [{ kty: 'RSA', kid: 'k' }] }) };
    });
    const r = await checkConnection(weak, hq, 'https://old.example.com');
    assert.equal(r.ok, false);
    assert.ok(r.steps.find((s) => s.label.includes('PKCE'))?.detail?.includes('対応していません'));
  });

  it('本部の管理者以外は確かめられない（外に取りに行く経路なので）', async () => {
    await setup();
    await assert.rejects(checkConnection(directory, manager, idp.issuer), /本部の管理者/);
    await assert.rejects(checkConnection(directory, trusted, idp.issuer), /本部の管理者/);
    await clean();
  });
});

describe('ドメインの持ち主であることを確かめる', () => {
  async function clean() {
    await db.withTenant(T, async (q) => {
      await q.query(`DELETE FROM sso_domains`);
      await q.query(`DELETE FROM sso_providers`);
    });
  }

  it('**確かめていないドメインは、入口で使われない**', async () => {
    // ここが塞げていないと、先に登録した会社が他社の社員の行き先を決められる。
    // 本物に似せた入力欄に送れば、合言葉を取られる。
    await setup();
    await db.withTenant(T, (q) => q.query(`UPDATE sso_domains SET verified_at = NULL`));
    await assert.rejects(
      startSso(db, directory, SITE, { email: 'tanaka@kdenki.example.co.jp' }),
      /まだ用意されていません/,
    );
    // 確かめ済みにすれば使える
    await db.withTenant(T, (q) => q.query(`UPDATE sso_domains SET verified_at = now()`));
    const okay = await startSso(db, directory, SITE, { email: 'tanaka@kdenki.example.co.jp' });
    assert.ok(okay.authorizeUrl);
    await clean();
  });

  it('DNS に印が置けていれば、確かめ済みになる', async () => {
    await setup();
    await db.withTenant(T, (q) => q.query(`UPDATE sso_domains SET verified_at = NULL, checked_at = NULL`));
    const [row] = await db.withTenant(T, (q) => q.query<{ verify_token: string }>(
      `SELECT verify_token FROM sso_domains WHERE domain = $1`, ['kdenki.example.co.jp']));
    const token = row!.verify_token;
    assert.match(token, /^[0-9a-f]{32}$/);

    const result = await db.withTenant(T, (q) => verifyDomain(q, hq, 'kdenki.example.co.jp',
      async (name) => {
        assert.equal(name, `${VERIFY_PREFIX}.kdenki.example.co.jp`);
        // TXT は分割されて返ることがあるので、つないで比べられること
        return [['misenare-verify=', token]];
      }));
    assert.equal(result.verified, true, result.detail ?? "");
    // 使えるようになる
    assert.ok(await startSso(db, directory, SITE, { email: 'tanaka@kdenki.example.co.jp' }));
    await clean();
  });

  it('印が違えば、確かめ済みにしない', async () => {
    await setup();
    await db.withTenant(T, (q) => q.query(`UPDATE sso_domains SET verified_at = NULL, checked_at = NULL`));
    const wrong = await db.withTenant(T, (q) => verifyDomain(q, hq, 'kdenki.example.co.jp',
      async () => [['misenare-verify=ちがう印']]));
    assert.equal(wrong.verified, false);
    assert.ok(wrong.detail?.includes('別の値'), wrong.detail ?? '');

    await db.withTenant(T, (q) => q.query(`UPDATE sso_domains SET checked_at = NULL`));
    const missing = await db.withTenant(T, (q) => verifyDomain(q, hq, 'kdenki.example.co.jp', async () => []));
    assert.equal(missing.verified, false);
    assert.ok(missing.detail?.includes('見つかりません'), missing.detail ?? '');
    await clean();
  });

  it('引けなくても落ちない（置いた直後は反映待ち）', async () => {
    await setup();
    await db.withTenant(T, (q) => q.query(`UPDATE sso_domains SET verified_at = NULL, checked_at = NULL`));
    const result = await db.withTenant(T, (q) => verifyDomain(q, hq, 'kdenki.example.co.jp',
      async () => { throw new Error('ENOTFOUND'); }));
    assert.equal(result.verified, false);
    assert.ok(result.detail?.includes('反映'), result.detail ?? '');
    await clean();
  });

  it('連打しても DNS を叩き続けない', async () => {
    await setup();
    await db.withTenant(T, (q) => q.query(`UPDATE sso_domains SET verified_at = NULL, checked_at = NULL`));
    let asked = 0;
    const ask = () => db.withTenant(T, (q) => verifyDomain(q, hq, 'kdenki.example.co.jp',
      async () => { asked++; return []; }));
    await ask();
    await ask();
    await ask();
    assert.equal(asked, 1, 'DNS を何度も引いている');
    await clean();
  });

  it('置き場所と値を返す（画面に出して、情報システム部に頼むため）', async () => {
    await setup();
    await db.withTenant(T, (q) => q.query(`UPDATE sso_domains SET verified_at = NULL, checked_at = NULL`));
    const result = await db.withTenant(T, (q) => verifyDomain(q, hq, 'kdenki.example.co.jp', async () => []));
    assert.equal(result.record.name, '_misenare-verify.kdenki.example.co.jp');
    assert.equal(result.record.type, 'TXT');
    assert.match(result.record.value, /^misenare-verify=[0-9a-f]{32}$/);
    await clean();
  });

  it('本部の管理者以外は確かめられない', async () => {
    await setup();
    await db.withTenant(T, async (q) => {
      await assert.rejects(verifyDomain(q, manager, 'kdenki.example.co.jp', async () => []), /本部の管理者/);
      await assert.rejects(verifyDomain(q, trusted, 'kdenki.example.co.jp', async () => []), /本部の管理者/);
    });
    await clean();
  });
});
