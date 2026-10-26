// パスキー（WebAuthn）の端末側。ブラウザの API とサーバーの経路をつなぐだけ。
//
// なぜ要るか：招待リンクは1回きりで、端末を替えたり消したりすると店長に
// もう一度発行してもらうことになる。売場では「スマホを買い替えた」「アプリの
// データを消した」が普通に起きるので、そのたびに店長の手が止まる。
// パスキーなら、本人が自分で入り直せる。
//
// 鍵は端末（またはパスワード管理）の中にあり、こちらには公開鍵しか来ない。
// 覚える合言葉が無いので、売場で紙に書いて貼られることもない。

import { api } from './api.ts';

const toB64 = (buf: ArrayBuffer): string => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64 = (value: string): Uint8Array => {
  const s = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/** この端末でパスキーが使えるか。古い端末や、埋め込みブラウザでは使えない */
export function passkeySupported(): boolean {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential === 'function'
    && typeof navigator.credentials?.create === 'function';
}

/** 端末の名前の見当。あとで「どの端末か」を見分けるために残す */
export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (ua.includes('iPhone')) return 'iPhone';
  if (ua.includes('iPad')) return 'iPad';
  if (ua.includes('Android')) return 'Android';
  if (ua.includes('Mac')) return 'Mac';
  if (ua.includes('Windows')) return 'Windows';
  return 'ブラウザ';
}

interface RegisterOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  timeout: number;
  attestation: 'none';
  authenticatorSelection: { residentKey: 'required'; userVerification: 'required' | 'preferred' };
  excludeCredentials: Array<{ type: 'public-key'; id: string }>;
}

/**
 * この端末にパスキーを作る。ログイン済みの状態から呼ぶ。
 * サーバーが出した合言葉に端末が署名し、公開鍵だけが送られる。
 */
export async function registerPasskey(name = guessDeviceName()): Promise<void> {
  const options = await api<RegisterOptions>('POST', '/passkeys/register/start', { name });
  const credential = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: fromB64(options.challenge),
      user: { ...options.user, id: fromB64(options.user.id) },
      excludeCredentials: options.excludeCredentials.map((c) => ({ ...c, id: fromB64(c.id) })),
    },
  }) as PublicKeyCredential | null;
  if (!credential) throw new Error('パスキーを作れませんでした');
  const response = credential.response as AuthenticatorAttestationResponse;
  await api('POST', '/passkeys/register/finish', {
    clientDataJSON: toB64(response.clientDataJSON),
    attestationObject: toB64(response.attestationObject),
    name,
  });
}

interface LoginOptions {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: 'required' | 'preferred';
}

/**
 * パスキーで入る。ログインしていない状態から呼ぶ。
 *
 * 誰かを先に聞かない（allowCredentials を渡さない）。端末が「この店の鍵」を
 * 自分で出してくるので、売場で ID を打つ手間が無い。そのために登録のときに
 * residentKey: 'required' を指定してある。
 */
export async function loginWithPasskey(deviceName = guessDeviceName()): Promise<string> {
  const options = await api<LoginOptions>('POST', '/auth/passkey/start', {});
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: fromB64(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification,
    },
  }) as PublicKeyCredential | null;
  if (!assertion) throw new Error('パスキーで入れませんでした');
  const response = assertion.response as AuthenticatorAssertionResponse;
  if (!response.userHandle) throw new Error('このパスキーは、入り直すのに使えません（登録しなおしてください）');
  const r = await api<{ sessionToken: string }>('POST', '/auth/passkey/finish', {
    credentialId: toB64(assertion.rawId),
    clientDataJSON: toB64(response.clientDataJSON),
    authenticatorData: toB64(response.authenticatorData),
    signature: toB64(response.signature),
    userHandle: toB64(response.userHandle),
    deviceName,
  });
  return r.sessionToken;
}

export interface PasskeyRow {
  id: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
  disabled: boolean;
}

export const listPasskeys = (): Promise<PasskeyRow[]> => api<PasskeyRow[]>('GET', '/passkeys');
export const deletePasskey = (id: string): Promise<unknown> => api('DELETE', `/passkeys/${id}`);
