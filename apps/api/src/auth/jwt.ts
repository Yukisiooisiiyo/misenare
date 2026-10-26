// ID トークン（JWS）の検証。相手の IdP が公開している鍵（JWKS）で署名を確かめる。
//
// 外の部品を使わない理由：ここは**入口の判定**なので、何を確かめているかが
// 読んで分かる状態にしておきたい。使う形は OpenID Connect の ID トークンだけで、
// 必要な署名方式も RSA と EC の2系統に限られる。
//
// 確かめること（1つ欠けると別人として入れてしまう）：
//   * 署名   … 相手の公開鍵で検証する。alg は**ヘッダーを信用せず**鍵の種類と突き合わせる
//   * iss    … 登録した発行元と同じか（他社の IdP のトークンを持ち込まれないため）
//   * aud    … こちらの client_id が入っているか（別のアプリ向けのトークンを使われないため）
//   * exp    … 切れていないか
//   * nonce  … こちらが出したものと同じか（古いトークンの差し替え対策）

import { createPublicKey, createVerify, verify as verifySignature, type KeyObject } from 'node:crypto';

/** 時計のずれを許す幅。IdP とこちらの時刻が完全に合うことはない */
export const CLOCK_SKEW_SEC = 60;

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  azp?: string;
  [key: string]: unknown;
}

export class JwtError extends Error {}

const decode = (part: string): Buffer => Buffer.from(part, 'base64url');

/** RSA は PKCS#1 v1.5、EC は r‖s の生の形。どちらも node の crypto で確かめられる */
const RSA_ALGS: Record<string, string> = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512' };
const EC_ALGS: Record<string, { hash: string; crv: string }> = {
  ES256: { hash: 'sha256', crv: 'P-256' },
  ES384: { hash: 'sha384', crv: 'P-384' },
  ES512: { hash: 'sha512', crv: 'P-521' },
};

function toKey(jwk: Jwk): KeyObject {
  try {
    return createPublicKey({ key: jwk as never, format: 'jwk' });
  } catch (err) {
    throw new JwtError(`鍵を読めません: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 署名だけを確かめる。
 *
 * **alg はヘッダーの言うとおりにしない。** 鍵の種類（kty）と合うものだけを通す。
 * ヘッダーを信用すると、RSA の鍵を HMAC の合言葉として使わせる古い手口が通る。
 */
function checkSignature(signingInput: string, signature: Buffer, alg: string, jwk: Jwk): void {
  const key = toKey(jwk);
  if (jwk.kty === 'RSA') {
    const hash = RSA_ALGS[alg];
    if (!hash) throw new JwtError(`この署名方式には対応していません: ${alg}`);
    const v = createVerify(hash);
    v.update(signingInput);
    v.end();
    if (!v.verify(key, signature)) throw new JwtError('署名が合いません');
    return;
  }
  if (jwk.kty === 'EC') {
    const spec = EC_ALGS[alg];
    if (!spec) throw new JwtError(`この署名方式には対応していません: ${alg}`);
    if (jwk.crv !== spec.crv) throw new JwtError(`署名方式と曲線が合いません: ${alg} / ${jwk.crv}`);
    // JWS の EC 署名は r‖s をそのまま並べた形（DER ではない）
    const okay = verifySignature(spec.hash, Buffer.from(signingInput, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, signature);
    if (!okay) throw new JwtError('署名が合いません');
    return;
  }
  throw new JwtError(`この鍵の種類には対応していません: ${jwk.kty}`);
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  nonce?: string;
  /** 試験で時刻を固定するため */
  now?: number;
}

/**
 * ID トークンを確かめて、中身を返す。
 * keys には相手の JWKS の鍵を渡す。kid が合うものを使い、無ければ全部試す
 * （kid を付けない IdP があるため）。
 */
export function verifyIdToken(token: string, keys: readonly Jwk[], options: VerifyOptions): IdTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('ID トークンの形が違います');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: { alg?: string; kid?: string; typ?: string };
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(decode(headerPart).toString('utf8'));
    claims = JSON.parse(decode(payloadPart).toString('utf8'));
  } catch {
    throw new JwtError('ID トークンを読めません');
  }
  const alg = header.alg ?? '';
  if (alg === 'none' || alg.startsWith('HS')) throw new JwtError(`この署名方式は受け付けません: ${alg || 'なし'}`);

  const candidates = keys.filter((k) => (k.use === undefined || k.use === 'sig')
    && (header.kid === undefined || k.kid === undefined || k.kid === header.kid));
  if (candidates.length === 0) throw new JwtError('署名に使われた鍵が見つかりません');

  const signature = decode(signaturePart);
  const signingInput = `${headerPart}.${payloadPart}`;
  let lastError: unknown;
  let verified = false;
  for (const jwk of candidates) {
    try {
      checkSignature(signingInput, signature, alg, jwk);
      verified = true;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!verified) throw lastError instanceof JwtError ? lastError : new JwtError('署名が合いません');

  checkClaims(claims, options);
  return claims;
}

export function checkClaims(claims: IdTokenClaims, options: VerifyOptions): void {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (claims.iss !== options.issuer) throw new JwtError(`発行元が違います: ${claims.iss}`);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(options.audience)) throw new JwtError('このアプリ向けのトークンではありません');
  // aud が複数あるときは azp で宛先を絞るのが決まり
  if (audience.length > 1 && claims.azp !== undefined && claims.azp !== options.audience) {
    throw new JwtError('このアプリ向けのトークンではありません');
  }
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new JwtError('持ち主が分かりません');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SEC < now) throw new JwtError('トークンの期限が切れています');
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SEC > now) throw new JwtError('トークンがまだ有効ではありません');
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SEC > now) throw new JwtError('トークンの発行時刻が未来です');
  if (options.nonce !== undefined && claims.nonce !== options.nonce) throw new JwtError('合言葉が合いません。もう一度やり直してください');
}
