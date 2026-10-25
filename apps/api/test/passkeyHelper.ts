// テスト用の「にせ認証器」。node:crypto で、本物と同じ形のデータを作る。
// 署名の確かめ方が正しいかを、ブラウザなしで試せるようにするため。

import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

/** CBOR を書く（テストに要る形だけ） */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value, 'utf8')]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  }
  throw new Error('cbor: 書けません');
}

export interface FakeAuthenticator {
  credentialId: Buffer;
  /** 登録（navigator.credentials.create）のふり */
  create(options: { challenge: string; origin: string; rpId: string; userVerified?: boolean }): {
    clientDataJSON: string; attestationObject: string;
  };
  /** 認証（navigator.credentials.get）のふり */
  get(options: {
    challenge: string; origin: string; rpId: string; userVerified?: boolean; signCount?: number; type?: string;
  }): { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string };
}

export function fakeAuthenticator(): FakeAuthenticator {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const credentialId = randomBytes(32);
  // COSE_Key（EC2・ES256・P-256）
  const cose = cbor(new Map<number, unknown>([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]));
  let counter = 1;

  const authData = (rpId: string, flags: number, count: number, withKey: boolean): Buffer => {
    const head = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags])]);
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32BE(count);
    if (!withKey) return Buffer.concat([head, counterBuf]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    return Buffer.concat([head, counterBuf, Buffer.alloc(16), idLength, credentialId, cose]);
  };

  const clientData = (type: string, challenge: string, origin: string): Buffer =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');

  return {
    credentialId,
    create({ challenge, origin, rpId, userVerified = true }) {
      const flags = 0x01 | (userVerified ? 0x04 : 0) | 0x40;
      const data = authData(rpId, flags, counter++, true);
      return {
        clientDataJSON: clientData('webauthn.create', challenge, origin).toString('base64url'),
        attestationObject: cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]]))
          .toString('base64url'),
      };
    },
    get({ challenge, origin, rpId, userVerified = true, signCount, type = 'webauthn.get' }) {
      const flags = 0x01 | (userVerified ? 0x04 : 0);
      const data = authData(rpId, flags, signCount ?? counter++, false);
      const json = clientData(type, challenge, origin);
      const signer = createSign('sha256');
      signer.update(Buffer.concat([data, createHash('sha256').update(json).digest()]));
      signer.end();
      return {
        credentialId: credentialId.toString('base64url'),
        clientDataJSON: json.toString('base64url'),
        authenticatorData: data.toString('base64url'),
        signature: signer.sign(privateKey).toString('base64url'),
      };
    },
  };
}
