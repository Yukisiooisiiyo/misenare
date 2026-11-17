// 認証アプリの6桁のコード（TOTP。RFC 6238 / RFC 4226）。依存なし。
//
// 認証アプリ（Google Authenticator、Microsoft Authenticator、1Password など）と同じ鍵を分け合い、
// 30秒ごとに変わる6桁を両方で計算して突き合わせる。
//   ・鍵は20バイトの乱数。アプリには base32 で渡す（QR か、手で打つ）
//   ・時計のずれを見込んで、前後1つぶん（±30秒）まで通す
//   ・一度通したコードは、もう通さない（呼び出し側が、通した刻みを覚えておく）

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** 前後いくつぶんの刻みまで通すか */
const DRIFT_STEPS = 1;

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1; // 使い終わった上の桁は捨てる
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** base32 を戻す。空白と「=」は読み飛ばす。知らない文字があれば null */
export function base32Decode(text: string): Buffer | null {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) return null;
    value = ((value << 5) | index) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 新しい鍵（base32 で32文字） */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** いまの時刻が、何番目の刻みか */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** その刻みのコード（6桁。頭の0も含む） */
export function totpCode(secret: string, step: number): string {
  const key = base32Decode(secret);
  if (!key || key.length === 0) throw new Error('鍵の形が正しくありません');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const number = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(number % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * 打たれたコードが合っていれば、その刻みを返す。合わなければ null。
 * after より前（同じを含む）の刻みは通さない：一度通したコードを、のぞき見た人がもう一度使えないようにする。
 */
export function matchTotp(secret: string, code: string, nowMs: number, after: number | null = null): number | null {
  const text = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(text)) return null;
  const now = totpStep(nowMs);
  let found: number | null = null;
  // どの刻みで合ったかで、かかる時間を変えない（全部を比べてから返す）
  for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step++) {
    const same = timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(text));
    if (same && (after === null || step > after) && found === null) found = step;
  }
  return found;
}

/** 認証アプリに読ませる URI（QR の中身）。account はアプリの一覧に出る名前 */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}
