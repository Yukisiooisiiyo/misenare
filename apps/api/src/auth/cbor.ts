// CBOR（RFC 8949）の読み取り。パスキー（WebAuthn）で使う分だけ。
// 認証器が返す attestationObject と、公開鍵（COSE_Key）がこの形式。ライブラリは足さない。

export type CborValue = number | bigint | string | Buffer | boolean | null | CborValue[] | Map<CborValue, CborValue>;

class Reader {
  constructor(readonly buf: Buffer, public pos = 0) {}

  private byte(): number {
    if (this.pos >= this.buf.length) throw new Error('CBOR: 途中で終わっています');
    return this.buf[this.pos++]!;
  }

  private take(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new Error('CBOR: 途中で終わっています');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** 追加情報から長さ・値を読む */
  private count(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.byte();
    if (info === 25) return this.take(2).readUInt16BE(0);
    if (info === 26) return this.take(4).readUInt32BE(0);
    if (info === 27) {
      const v = this.take(8).readBigUInt64BE(0);
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('CBOR: 大きすぎる値です');
      return Number(v);
    }
    throw new Error(`CBOR: 長さが不定の形式には対応していません（${info}）`);
  }

  read(depth = 0): CborValue {
    if (depth > 32) throw new Error('CBOR: 入れ子が深すぎます');
    const first = this.byte();
    const major = first >> 5;
    const info = first & 0x1f;
    switch (major) {
      case 0: return this.count(info);
      case 1: return -1 - this.count(info);
      case 2: return Buffer.from(this.take(this.count(info)));
      case 3: return this.take(this.count(info)).toString('utf8');
      case 4: {
        const length = this.count(info);
        const out: CborValue[] = [];
        for (let i = 0; i < length; i++) out.push(this.read(depth + 1));
        return out;
      }
      case 5: {
        const length = this.count(info);
        const map = new Map<CborValue, CborValue>();
        for (let i = 0; i < length; i++) {
          const key = this.read(depth + 1);
          map.set(key, this.read(depth + 1));
        }
        return map;
      }
      case 6: // タグ付き：中身だけを使う
        this.count(info);
        return this.read(depth + 1);
      case 7: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return null; // undefined
        if (info === 25) { const h = this.take(2); return halfFloat(h.readUInt16BE(0)); }
        if (info === 26) return this.take(4).readFloatBE(0);
        if (info === 27) return this.take(8).readDoubleBE(0);
        throw new Error(`CBOR: 知らない簡易値です（${info}）`);
      }
      default:
        throw new Error('CBOR: 読めません');
    }
  }
}

function halfFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -24 * fraction;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** 1つ読む。余りがあっても気にしない（attestationObject は1つの地図） */
export function decodeCbor(buf: Buffer): CborValue {
  return new Reader(buf).read();
}

/** 読んだあと、どこまで使ったかも返す（公開鍵のあとに続きがあるため） */
export function decodeCborWithLength(buf: Buffer): { value: CborValue; length: number } {
  const reader = new Reader(buf);
  const value = reader.read();
  return { value, length: reader.pos };
}
