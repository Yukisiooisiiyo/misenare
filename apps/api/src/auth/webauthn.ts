// パスキー（WebAuthn）の検証。依存は足さず、node:crypto だけで行う。
//
// 登録：端末が作った公開鍵を受け取って保存する
// 認証：端末の署名を、保存した公開鍵で確かめる
//
// 端末の種類を証明する書類（attestation statement）は見ない。
// パスキーでは「none」で届くのがふつうで、見ても得られるものが無いため。

import { createHash, createPublicKey, createVerify, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { decodeCbor, decodeCborWithLength, type CborValue } from './cbor.ts';

export const base64url = {
  encode(buf: Buffer): string { return buf.toString('base64url'); },
  decode(text: string): Buffer { return Buffer.from(text, 'base64url'); },
};

/** 認証器が返すデータ（authData）の中身 */
export interface AuthData {
  rpIdHash: Buffer;
  flags: number;
  /** 使う人がそこにいたか（指やPINで確かめたか） */
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  credentialId?: Buffer;
  /** COSE 形式の公開鍵 */
  publicKey?: Buffer;
}

export function parseAuthData(data: Buffer): AuthData {
  if (data.length < 37) throw new Error('authData が短すぎます');
  const flags = data[32]!;
  const result: AuthData = {
    rpIdHash: data.subarray(0, 32),
    flags,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount: data.readUInt32BE(33),
  };
  // 鍵が付いているとき（登録のとき）
  if (flags & 0x40) {
    if (data.length < 55) throw new Error('authData に鍵が入っていません');
    const idLength = data.readUInt16BE(53);
    const idStart = 55;
    if (data.length < idStart + idLength) throw new Error('authData が壊れています');
    result.credentialId = data.subarray(idStart, idStart + idLength);
    const rest = data.subarray(idStart + idLength);
    const { length } = decodeCborWithLength(rest);
    result.publicKey = rest.subarray(0, length);
  }
  return result;
}

/** COSE_Key を node:crypto の鍵に直す */
export function coseToKey(cose: Buffer): { key: KeyObject; algorithm: number } {
  const map = decodeCbor(cose);
  if (!(map instanceof Map)) throw new Error('公開鍵の形式が違います');
  const get = (k: number): CborValue | undefined => map.get(k);
  const kty = Number(get(1));
  const alg = Number(get(3));

  if (kty === 2) { // EC2
    const crv = Number(get(-1));
    const curve = crv === 1 ? 'P-256' : crv === 2 ? 'P-384' : crv === 3 ? 'P-521' : null;
    if (!curve) throw new Error(`対応していない曲線です（${crv}）`);
    const x = get(-2); const y = get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new Error('公開鍵が壊れています');
    return {
      key: createPublicKey({ key: { kty: 'EC', crv: curve, x: x.toString('base64url'), y: y.toString('base64url') }, format: 'jwk' }),
      algorithm: alg,
    };
  }
  if (kty === 3) { // RSA
    const n = get(-1); const e = get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error('公開鍵が壊れています');
    return {
      key: createPublicKey({ key: { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') }, format: 'jwk' }),
      algorithm: alg,
    };
  }
  if (kty === 1) { // OKP（Ed25519）
    const crv = Number(get(-1));
    if (crv !== 6) throw new Error(`対応していない曲線です（${crv}）`);
    const x = get(-2);
    if (!Buffer.isBuffer(x)) throw new Error('公開鍵が壊れています');
    return {
      key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: x.toString('base64url') }, format: 'jwk' }),
      algorithm: alg,
    };
  }
  throw new Error(`対応していない鍵の種類です（${kty}）`);
}

/** 署名を確かめる */
export function verifySignature(algorithm: number, key: KeyObject, data: Buffer, signature: Buffer): boolean {
  try {
    if (algorithm === -8) return cryptoVerify(null, data, key, signature); // Ed25519
    const hash = algorithm === -257 || algorithm === -7 ? 'sha256' : algorithm === -258 || algorithm === -35 ? 'sha384' : 'sha512';
    if (algorithm === -7 || algorithm === -35 || algorithm === -36) {
      // ECDSA の署名は DER で届く
      return cryptoVerify(hash, data, { key, dsaEncoding: 'der' }, signature);
    }
    if (algorithm === -257 || algorithm === -258 || algorithm === -259) {
      const verifier = createVerify(hash);
      verifier.update(data);
      verifier.end();
      return verifier.verify(key, signature);
    }
    return false;
  } catch {
    return false;
  }
}

export interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

export function parseClientData(json: Buffer): ClientData {
  const text = json.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('clientDataJSON を読めません');
  }
  const d = parsed as Partial<ClientData>;
  if (typeof d.type !== 'string' || typeof d.challenge !== 'string' || typeof d.origin !== 'string') {
    throw new Error('clientDataJSON の中身が足りません');
  }
  return { type: d.type, challenge: d.challenge, origin: d.origin, ...(d.crossOrigin !== undefined ? { crossOrigin: d.crossOrigin } : {}) };
}

export interface Expectations {
  type: 'webauthn.create' | 'webauthn.get';
  challenge: string;
  /** 受け付ける出どころ（https://misenare.example.com など） */
  origins: string[];
  rpId: string;
  /** 指やPINでの確認を必須にするか */
  requireUserVerification: boolean;
}

/** clientData と authData の、共通の確かめ方 */
function checkCommon(clientData: ClientData, authData: AuthData, expect: Expectations): void {
  if (clientData.type !== expect.type) throw new Error('操作の種類が違います');
  if (clientData.challenge !== expect.challenge) throw new Error('合言葉が一致しません');
  if (!expect.origins.includes(clientData.origin)) throw new Error(`出どころが違います（${clientData.origin}）`);
  const expectedHash = createHash('sha256').update(expect.rpId).digest();
  if (!authData.rpIdHash.equals(expectedHash)) throw new Error('サイトの指紋が一致しません');
  if (!authData.userPresent) throw new Error('端末の操作が確認できません');
  if (expect.requireUserVerification && !authData.userVerified) throw new Error('指紋や画面ロックでの確認が必要です');
}

export interface RegistrationResult {
  credentialId: Buffer;
  publicKey: Buffer;
  algorithm: number;
  signCount: number;
  userVerified: boolean;
}

/** 登録（navigator.credentials.create の結果）を確かめる */
export function verifyRegistration(
  input: { clientDataJSON: Buffer; attestationObject: Buffer },
  expect: Expectations,
): RegistrationResult {
  const clientData = parseClientData(input.clientDataJSON);
  const attestation = decodeCbor(input.attestationObject);
  if (!(attestation instanceof Map)) throw new Error('attestationObject の形式が違います');
  const rawAuthData = attestation.get('authData');
  if (!Buffer.isBuffer(rawAuthData)) throw new Error('attestationObject に authData がありません');
  const authData = parseAuthData(rawAuthData);
  checkCommon(clientData, authData, expect);
  if (!authData.credentialId || !authData.publicKey) throw new Error('公開鍵が入っていません');
  // 鍵として読めることをここで確かめておく（あとで使えない鍵を保存しないため）
  const { algorithm } = coseToKey(authData.publicKey);
  return {
    credentialId: authData.credentialId,
    publicKey: authData.publicKey,
    algorithm,
    signCount: authData.signCount,
    userVerified: authData.userVerified,
  };
}

export interface AuthenticationResult {
  signCount: number;
  userVerified: boolean;
  /** 使い回し（複製）の疑いがあるか */
  cloneWarning: boolean;
}

/** 認証（navigator.credentials.get の結果）を確かめる */
export function verifyAuthentication(
  input: { clientDataJSON: Buffer; authenticatorData: Buffer; signature: Buffer },
  stored: { publicKey: Buffer; signCount: number },
  expect: Expectations,
): AuthenticationResult {
  const clientData = parseClientData(input.clientDataJSON);
  const authData = parseAuthData(input.authenticatorData);
  checkCommon(clientData, authData, expect);

  const { key, algorithm } = coseToKey(stored.publicKey);
  const signed = Buffer.concat([input.authenticatorData, createHash('sha256').update(input.clientDataJSON).digest()]);
  if (!verifySignature(algorithm, key, signed, input.signature)) throw new Error('署名が合いません');

  // 回数が戻っている＝鍵が複製された疑い。0 のままの認証器もあるので、その場合は見ない
  const cloneWarning = authData.signCount > 0 && stored.signCount > 0 && authData.signCount <= stored.signCount;
  return { signCount: authData.signCount, userVerified: authData.userVerified, cloneWarning };
}
