// パスキー（WebAuthn）。にせ認証器で、登録と認証の確かめ方を試す。
// 本物のブラウザでの通し確認は apps/web/e2e/passkey.mjs（Playwright の仮想認証器）。

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { decodeCbor } from '../src/auth/cbor.ts';
import { base64url, coseToKey, parseAuthData } from '../src/auth/webauthn.ts';
import {
  CHALLENGE_TTL_MS, deletePasskey, finishRegistration, listPasskeys, loginWithPasskey,
  parseUserHandle, siteConfigFromEnv, startLogin, startRegistration, sweepChallenges, userHandle,
} from '../src/domain/passkeys.ts';
import { verifySession } from '../src/domain/users.ts';
import { fakeAuthenticator } from './passkeyHelper.ts';
import { freshDatabase, manager, T, trusted } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
before(async () => { db = await freshDatabase(); });
after(async () => { await db.close(); });

const SITE = { rpId: 'localhost', origins: ['http://localhost:8787'], rpName: 'ミセナレ', requireUserVerification: true };
const raw = (sql: string, params?: readonly unknown[]) => db.raw(sql, params);

/** 登録を一通り行う */
async function register(actor = trusted, name = 'テストの端末') {
  const device = fakeAuthenticator();
  const options = await db.withTenant(T, (q) => startRegistration(q, actor, SITE, 'テスト'));
  const created = device.create({ challenge: options.challenge, origin: SITE.origins[0]!, rpId: SITE.rpId });
  const saved = await db.withTenant(T, (q) => finishRegistration(q, actor, SITE, { ...created, name }));
  return { device, saved, options };
}

describe('CBOR', () => {
  it('数・文字列・バイト列・配列・地図を読める', () => {
    assert.equal(decodeCbor(Buffer.from('17', 'hex')), 23);
    assert.equal(decodeCbor(Buffer.from('1818', 'hex')), 24);
    assert.equal(decodeCbor(Buffer.from('20', 'hex')), -1);
    assert.equal(decodeCbor(Buffer.from('6568656c6c6f', 'hex')), 'hello');
    assert.deepEqual(decodeCbor(Buffer.from('4401020304', 'hex')), Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(decodeCbor(Buffer.from('83010203', 'hex')), [1, 2, 3]);
    const map = decodeCbor(Buffer.from('a201020304', 'hex'));
    assert.ok(map instanceof Map);
    assert.equal((map as Map<number, number>).get(1), 2);
    assert.equal(decodeCbor(Buffer.from('f5', 'hex')), true);
    assert.equal(decodeCbor(Buffer.from('f6', 'hex')), null);
  });

  it('壊れたものは、そうと分かる言い方で断る', () => {
    assert.throws(() => decodeCbor(Buffer.from('18', 'hex')), /途中で終わって/);
    assert.throws(() => decodeCbor(Buffer.from('5f', 'hex')), /不定/);
  });
});

describe('認証器のデータ', () => {
  it('旗・回数・鍵を取り出せて、鍵として読める', () => {
    const device = fakeAuthenticator();
    const created = device.create({ challenge: 'x', origin: SITE.origins[0]!, rpId: SITE.rpId });
    const attestation = decodeCbor(base64url.decode(created.attestationObject)) as Map<string, Buffer>;
    const parsed = parseAuthData(attestation.get('authData')!);
    assert.equal(parsed.userPresent, true);
    assert.equal(parsed.userVerified, true);
    assert.ok(parsed.credentialId && parsed.publicKey);
    const { algorithm } = coseToKey(parsed.publicKey!);
    assert.equal(algorithm, -7, 'ES256');
  });
});

describe('利用者の印', () => {
  it('会社IDと利用者IDをつなぎ、戻せる', () => {
    const handle = userHandle(T, trusted.userId);
    assert.deepEqual(parseUserHandle(handle), { tenantId: T, userId: trusted.userId });
    assert.equal(parseUserHandle('でたらめ'), null);
    assert.equal(parseUserHandle(`${T}.${trusted.userId}.余計`), null);
  });
});

describe('設定', () => {
  it('WEBAUTHN_RP_ID が無ければ使えない', () => {
    assert.equal(siteConfigFromEnv({} as NodeJS.ProcessEnv), null);
    const site = siteConfigFromEnv({ WEBAUTHN_RP_ID: 'misenare.example.com' } as NodeJS.ProcessEnv)!;
    assert.deepEqual(site.origins, ['https://misenare.example.com']);
    assert.equal(site.requireUserVerification, true);
  });
});

describe('パスキーの登録と、パスキーで入る', () => {
  it('登録すると一覧に出る', async () => {
    const { saved } = await register(trusted, '店長のiPhone');
    await db.withTenant(T, async (q) => {
      const list = await listPasskeys(q, trusted);
      const found = list.find((p) => p.id === saved.id)!;
      assert.equal(found.name, '店長のiPhone');
      assert.equal(found.disabled, false);
      assert.equal(found.last_used_at, null);
    });
  });

  it('登録したパスキーで、招待なしに入り直せる', async () => {
    const { device } = await register();
    const options = await startLogin(raw, SITE);
    const assertion = device.get({ challenge: options.challenge, origin: SITE.origins[0]!, rpId: SITE.rpId });
    const result = await loginWithPasskey(db, SITE, {
      ...assertion,
      userHandle: base64url.encode(Buffer.from(userHandle(T, trusted.userId), 'utf8')),
      deviceName: '入り直した端末',
    });
    assert.equal(result.userId, trusted.userId);
    // 本物のセッションとして通る
    const session = await db.withTenant(T, (q) => verifySession(q, result.sessionToken));
    assert.equal(session?.userId, trusted.userId);
    await db.withTenant(T, async (q) => {
      const used = (await listPasskeys(q, trusted)).find((p) => p.last_used_at !== null);
      assert.ok(used, '使った日時が残る');
    });
  });

  it('合言葉は1回しか使えない', async () => {
    const { device } = await register();
    const options = await startLogin(raw, SITE);
    const assertion = device.get({ challenge: options.challenge, origin: SITE.origins[0]!, rpId: SITE.rpId });
    const handle = base64url.encode(Buffer.from(userHandle(T, trusted.userId), 'utf8'));
    await loginWithPasskey(db, SITE, { ...assertion, userHandle: handle });
    await assert.rejects(loginWithPasskey(db, SITE, { ...assertion, userHandle: handle }), /合言葉が切れています/);
  });

  it('出どころが違う・種類が違う・署名が合わないものは通さない', async () => {
    const { device } = await register();
    const handle = base64url.encode(Buffer.from(userHandle(T, trusted.userId), 'utf8'));
    const attempt = async (make: (challenge: string) => ReturnType<typeof device.get>) => {
      const options = await startLogin(raw, SITE);
      return loginWithPasskey(db, SITE, { ...make(options.challenge), userHandle: handle });
    };
    await assert.rejects(
      attempt((c) => device.get({ challenge: c, origin: 'https://にせもの.example.com', rpId: SITE.rpId })),
      /出どころが違います/,
    );
    await assert.rejects(
      attempt((c) => device.get({ challenge: c, origin: SITE.origins[0]!, rpId: 'evil.example.com' })),
      /サイトの指紋が一致しません/,
    );
    await assert.rejects(
      attempt((c) => device.get({ challenge: c, origin: SITE.origins[0]!, rpId: SITE.rpId, type: 'webauthn.create' })),
      /操作の種類が違います/,
    );
    await assert.rejects(
      attempt((c) => ({ ...device.get({ challenge: c, origin: SITE.origins[0]!, rpId: SITE.rpId }), signature: base64url.encode(Buffer.alloc(70)) })),
      /署名が合いません/,
    );
    await assert.rejects(
      attempt((c) => device.get({ challenge: c, origin: SITE.origins[0]!, rpId: SITE.rpId, userVerified: false })),
      /確認が必要です/,
    );
  });

  it('登録していないパスキーでは入れない', async () => {
    const stranger = fakeAuthenticator();
    const options = await startLogin(raw, SITE);
    const assertion = stranger.get({ challenge: options.challenge, origin: SITE.origins[0]!, rpId: SITE.rpId });
    await assert.rejects(
      loginWithPasskey(db, SITE, { ...assertion, userHandle: base64url.encode(Buffer.from(userHandle(T, trusted.userId), 'utf8')) }),
      /登録されていません/,
    );
  });

  it('他人の利用者IDを名乗っても通らない', async () => {
    const { device } = await register(trusted);
    const options = await startLogin(raw, SITE);
    const assertion = device.get({ challenge: options.challenge, origin: SITE.origins[0]!, rpId: SITE.rpId });
    await assert.rejects(
      loginWithPasskey(db, SITE, { ...assertion, userHandle: base64url.encode(Buffer.from(userHandle(T, manager.userId), 'utf8')) }),
      /登録されていません/,
    );
  });

  it('回数が戻っていたら、複製の疑いとしてそのパスキーを止める', async () => {
    const { device, saved } = await register();
    const handle = base64url.encode(Buffer.from(userHandle(T, trusted.userId), 'utf8'));
    const first = await startLogin(raw, SITE);
    await loginWithPasskey(db, SITE, {
      ...device.get({ challenge: first.challenge, origin: SITE.origins[0]!, rpId: SITE.rpId, signCount: 50 }),
      userHandle: handle,
    });
    const second = await startLogin(raw, SITE);
    await assert.rejects(
      loginWithPasskey(db, SITE, {
        ...device.get({ challenge: second.challenge, origin: SITE.origins[0]!, rpId: SITE.rpId, signCount: 10 }),
        userHandle: handle,
      }),
      /使えなくなりました/,
    );
    await db.withTenant(T, async (q) => {
      assert.equal((await listPasskeys(q, trusted)).find((p) => p.id === saved.id)!.disabled, true);
    });
    // 止まったあとは、正しい回数でも入れない
    const third = await startLogin(raw, SITE);
    {
      await assert.rejects(
        loginWithPasskey(db, SITE, {
          ...device.get({ challenge: third.challenge, origin: SITE.origins[0]!, rpId: SITE.rpId, signCount: 99 }),
          userHandle: handle,
        }),
        /登録されていません/,
      );
    }
  });

  it('無効にされた利用者のパスキーでは入れない', async () => {
    const { device } = await register(manager);
    await db.withTenant(T, (q) => q.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [manager.userId]));
    const options = await startLogin(raw, SITE);
    await assert.rejects(
      loginWithPasskey(db, SITE, {
        ...device.get({ challenge: options.challenge, origin: SITE.origins[0]!, rpId: SITE.rpId }),
        userHandle: base64url.encode(Buffer.from(userHandle(T, manager.userId), 'utf8')),
      }),
      /無効化されています/,
    );
    await db.withTenant(T, (q) => q.query(`UPDATE users SET status = 'active' WHERE id = $1`, [manager.userId]));
  });

  it('自分のパスキーは自分で消せる', async () => {
    const { saved } = await register();
    await db.withTenant(T, async (q) => {
      await deletePasskey(q, trusted, saved.id);
      assert.ok(!(await listPasskeys(q, trusted)).some((p) => p.id === saved.id));
      await assert.rejects(deletePasskey(q, trusted, saved.id), /見つかりません/);
    });
  });

  it('期限切れの合言葉は使えず、片付けられる', async () => {
    const options = await startLogin(raw, SITE);
    await db.raw(`UPDATE webauthn_challenges SET expires_at = now() - interval '1 minute' WHERE challenge = $1`, [options.challenge]);
    const device = fakeAuthenticator();
    await assert.rejects(
      loginWithPasskey(db, SITE, {
        ...device.get({ challenge: options.challenge, origin: SITE.origins[0]!, rpId: SITE.rpId }),
        userHandle: base64url.encode(Buffer.from(userHandle(T, trusted.userId), 'utf8')),
      }),
      /合言葉が切れています/,
    );
    assert.ok(CHALLENGE_TTL_MS > 0);
    const swept = await sweepChallenges(raw);
    assert.ok(swept >= 0);
  });
});
