// 偽の IdP。相手の設定・鍵・引換券の交換を、こちらの中で作る。
//
// 本物の IdP に当てる試験はできない（相手の都合で落ちる・遅い・秘密が要る）。
// 確かめたいのは**こちらの確かめ方**なので、相手の振る舞いを自分で作る。
// 署名は本物の鍵で作るので、検証の筋道は本番と同じものが走る。

import { createSign, generateKeyPairSync } from 'node:crypto';

export interface FakeIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** OidcDirectory に差し込む取りに行く口（本番は safeFetch） */
  fetch: (url: string, init?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string })
    => Promise<{ status: number; text: string }>;
  /** 次の交換で返す ID トークンを決める */
  issue(claims: Record<string, unknown>, options?: { kid?: string; alg?: string }): void;
  /** 交換のときに相手が受け取った中身（PKCE が本当に送られているかを見る） */
  lastTokenRequest: Record<string, string> | null;
  lastAuthorization: string | null;
  /** 鍵を入れ替える（こちらが取り直すかを見る） */
  rotate(kid: string): void;
  /** 交換を断る */
  refuse(error: string): void;
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

export function fakeIdp(options: { issuer?: string; clientId?: string } = {}): FakeIdp {
  const issuer = options.issuer ?? 'https://idp.example.com';
  const clientId = options.clientId ?? 'misenare-client';
  const clientSecret = 'とても内緒';

  let keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let kid = 'key-1';
  let nextToken: string | null = null;
  let refusal: string | null = null;
  const self: FakeIdp = {
    issuer,
    clientId,
    clientSecret,
    lastTokenRequest: null,
    lastAuthorization: null,
    issue(claims, opts = {}) {
      const alg = opts.alg ?? 'RS256';
      const head = b64({ alg, kid: opts.kid ?? kid, typ: 'JWT' });
      const body = b64(claims);
      const signer = createSign(alg === 'RS512' ? 'sha512' : 'sha256');
      signer.update(`${head}.${body}`);
      signer.end();
      nextToken = `${head}.${body}.${signer.sign(keyPair.privateKey).toString('base64url')}`;
    },
    rotate(nextKid) {
      keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      kid = nextKid;
    },
    refuse(error) { refusal = error; },
    async fetch(url, init) {
      const json = (body: unknown, status = 200): { status: number; text: string } =>
        ({ status, text: JSON.stringify(body) });

      if (url === `${issuer}/.well-known/openid-configuration`) {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url === `${issuer}/jwks`) {
        const jwk = keyPair.publicKey.export({ format: 'jwk' });
        return json({ keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] });
      }
      if (url === `${issuer}/token`) {
        self.lastTokenRequest = Object.fromEntries(new URLSearchParams(init?.body ?? ''));
        const entries = Object.entries(init?.headers ?? {});
        self.lastAuthorization = entries.find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? null;
        if (refusal) { const e = refusal; refusal = null; return json({ error: 'invalid_grant', error_description: e }, 400); }
        if (!nextToken) return json({ error: 'invalid_grant', error_description: 'まだ用意していません' }, 400);
        const token = nextToken;
        nextToken = null;
        return json({ token_type: 'Bearer', id_token: token, access_token: 'aaa', expires_in: 3600 });
      }
      return { status: 404, text: 'not found' };
    },
  };
  return self;
}

/** よく使う中身。足したいところだけ上書きする */
export function claimsFor(idp: FakeIdp, over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: idp.issuer,
    aud: idp.clientId,
    sub: 'idp-user-1',
    exp: now + 300,
    iat: now,
    email: 'tanaka@kdenki.example.co.jp',
    email_verified: true,
    name: '田中 太郎',
    ...over,
  };
}
