// DB に入れる前に、内緒の値を包む。
//
// === 鍵をどこに置くか（決めたこと） ===
//
// **環境変数に置く。** クラウドの鍵管理（AWS KMS など）は、いまは使わない。
//
// 守りたいのは「DB の中身だけが漏れる」場合である。実際に起きるのはこれ：
//   * バックアップの置き場所を間違える
//   * 読み取り用の複製（レプリカ）に別の人が触れる
//   * 調査のために本番の DB を引いて、結果が手元に残る
//   * DB の台だけが乗っ取られる
// このとき、鍵がアプリ側（環境変数）にあれば、中身は読めない。
//
// サーバーごと乗っ取られたら、鍵も一緒に漏れる。それは防げない。
// ただし **クラウドの鍵管理を使っても、そこは大きく変わらない**（乗っ取った人は
// アプリと同じ権限で鍵管理を呼べる）。違いが出るのは「鍵そのものを持ち出せない」
// 点だけで、そのために払うものが大きい：
//   * クラウドに縛られる（1台の安いサーバーで動かす前提を壊す）
//   * 呼び出しごとに料金と待ち時間がかかる
//   * 権限の設定を間違えると、こちらのほうが事故になりやすい
//
// ミセナレは「月数千円で1台から始められる」ことを前提に値段を決めている。
// そこにクラウドの鍵管理を必須で挟むと、前提が崩れる。
//
// **後から変えられるようにはしてある。** 包み方を SecretBox という形にまとめ、
// 包んだ値に鍵の名前を一緒に残しているので、
//   * 鍵の入れ替え（古い鍵で開けて、新しい鍵で包み直す）ができる
//   * クラウドの鍵管理を使う SecretBox を足しても、DB の形は変わらない
// 大口の相手が「鍵管理を使っていること」を条件にしてきたら、そこで足す。
//
// === 包み方 ===
//
//   enc:v1:<鍵の名前>:<初期値>:<検印>:<中身>
//
// AES-256-GCM。**どの行のものかを検印に混ぜる**（AAD）。こうすると、
// A 社の行の値を B 社の行に貼り替えても開けない。貼り替えは、DB に書ける人が
// 「他社の設定を自社に持ってくる」ためにやる手口なので、ここで止める。
//
// 包んでいない値（この版より前に入れたもの）は、そのまま読める。
// 鍵を決めると、次に書き換えたときから包まれる。
// 一度にやり直すには apps/api/src/cli/rekey.ts を流す。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class SecretError extends Error {}

export interface SecretBox {
  /** 包む。鍵を決めていなければ、そのまま返す */
  seal(plaintext: string, aad: string): string;
  /** 開く。包まれていない値はそのまま返す */
  open(stored: string, aad: string): string;
  /** 鍵を決めているか（設定の点検と画面の案内に使う） */
  readonly configured: boolean;
  /** いま包むのに使う鍵の名前 */
  readonly keyId: string | null;
}

/** 鍵を決めていないときの箱。包まずに通す（古い動きのまま） */
export const plainBox: SecretBox = {
  configured: false,
  keyId: null,
  seal: (plaintext) => plaintext,
  open: (stored) => {
    if (stored.startsWith(`${PREFIX}:`)) {
      throw new SecretError('包まれた値を開く鍵がありません（MISENARE_SECRET_KEYS を決めてください）');
    }
    return stored;
  },
};

export class AesSecretBox implements SecretBox {
  readonly configured = true;

  constructor(
    private readonly keys: ReadonlyMap<string, Buffer>,
    readonly keyId: string,
  ) {
    if (!keys.has(keyId)) throw new SecretError(`包むのに使う鍵（${keyId}）が鍵の一覧にありません`);
  }

  seal(plaintext: string, aad: string): string {
    const key = this.keys.get(this.keyId)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      PREFIX,
      this.keyId,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      body.toString('base64url'),
    ].join(':');
  }

  open(stored: string, aad: string): string {
    if (!stored.startsWith(`${PREFIX}:`)) return stored; // 包む前に入れた値
    const parts = stored.split(':');
    if (parts.length !== 6) throw new SecretError('包まれた値の形が違います');
    const [, , keyId, iv, tag, body] = parts as [string, string, string, string, string, string];
    const key = this.keys.get(keyId);
    if (!key) throw new SecretError(`この値を包んだ鍵（${keyId}）が見つかりません`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      // 検印が合わない＝鍵が違う、値が書き換えられた、別の行から貼り替えられた
      throw new SecretError('包まれた値を開けません（鍵が違うか、書き換えられています）');
    }
  }
}

/**
 * 鍵の一覧を読む。形は `名前:鍵,名前:鍵`（鍵は32バイトを base64 で）。
 *
 *   MISENARE_SECRET_KEYS=k1:aG9nZWhvZ2U...,k2:ZnVnYWZ1Z2E...
 *   MISENARE_SECRET_KEY_ID=k2     ← これから包むのに使う鍵（省略すると最後のもの）
 *
 * 鍵を複数持てるようにしているのは、入れ替えのため。
 * 新しい鍵を足して KEY_ID を向け、rekey を流し、古い鍵を外す——の順で止めずに替えられる。
 */
export function secretBoxFromEnv(env: NodeJS.ProcessEnv = process.env): SecretBox {
  const raw = env.MISENARE_SECRET_KEYS;
  if (!raw || raw.trim() === '') return plainBox;
  const keys = new Map<string, Buffer>();
  for (const entry of raw.split(',')) {
    const text = entry.trim();
    if (text === '') continue;
    const at = text.indexOf(':');
    if (at <= 0) throw new SecretError(`鍵の形が違います（名前:鍵 で並べてください）: ${text.slice(0, 12)}…`);
    const name = text.slice(0, at);
    const key = Buffer.from(text.slice(at + 1), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new SecretError(`鍵 ${name} の長さが違います（${KEY_BYTES} バイトを base64 で。いまは ${key.length} バイト）`);
    }
    keys.set(name, key);
  }
  if (keys.size === 0) return plainBox;
  const keyId = env.MISENARE_SECRET_KEY_ID ?? [...keys.keys()].at(-1)!;
  return new AesSecretBox(keys, keyId);
}

/** 新しい鍵を1本作る（手引きに載せる用） */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/**
 * 包まれた値かどうか。中身は見ない。
 * 「もう包み直す必要があるか」を数えるのに使う。
 */
export function isSealed(stored: string): boolean {
  return stored.startsWith(`${PREFIX}:`);
}

/** 包まれた値を包んだ鍵の名前。包まれていなければ null */
export function sealedWith(stored: string): string | null {
  if (!isSealed(stored)) return null;
  return stored.split(':')[2] ?? null;
}
