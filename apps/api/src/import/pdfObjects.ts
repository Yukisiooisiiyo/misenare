// PDF の中身を取り出すための、いちばん下の層：字句解析とオブジェクトの取り出し。
//
// PDF は「番号 世代 obj … endobj」の集まりで、参照（12 0 R）でつながっている。
// 索引（xref）を読まずに、ファイル全体から obj を拾って表を作る。壊れかけの PDF でも読めることが多い。

import { ImportError } from './error.ts';
import { inflateSync } from 'node:zlib';

export type PdfName = { name: string };
export type PdfRef = { ref: number; gen: number };
export type PdfDict = Map<string, PdfValue>;
export type PdfStream = { dict: PdfDict; raw: Buffer };
export type PdfValue =
  | null | boolean | number | string | Buffer
  | PdfName | PdfRef | PdfDict | PdfStream | PdfValue[];

export const isName = (v: PdfValue | undefined): v is PdfName => typeof v === 'object' && v !== null && 'name' in v;
export const isRef = (v: PdfValue | undefined): v is PdfRef => typeof v === 'object' && v !== null && 'ref' in v;
export const isDict = (v: PdfValue | undefined): v is PdfDict => v instanceof Map;
export const isStream = (v: PdfValue | undefined): v is PdfStream =>
  typeof v === 'object' && v !== null && 'raw' in v && 'dict' in v;

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/**
 * 1つの流れ（stream）を展開したあとの上限。
 *
 * **ここが無いと、小さな PDF でサーバーを落とせる。** zlib は最大で 1000 倍ほどに
 * 膨らむので、8MB の PDF に数 GB に展開される流れを1つ入れておけば、
 * 取り込んだ瞬間に台の記憶が尽きる（zip の方では前から上限を入れていた）。
 * 資料1ページぶんの文字は、どんなに多くても数十MBには収まらない。
 */
const MAX_STREAM_BYTES = 32 * 1024 * 1024;

/**
 * 1つの流れに重ねられる展開の数。
 * PDF は展開の仕方を並べて書けるので、同じ展開を何十回も並べられる。
 * ふつうは1つか2つ（FlateDecode と、画像なら DCTDecode）。
 */
const MAX_FILTERS = 8;

/**
 * 値の入れ子の深さ。
 * 配列と辞書はお互いを呼ぶので、`[[[[[…]]]]]` と書かれると呼び出しが積み上がる。
 * 本物の PDF で10を超えることはまずない。
 */
const MAX_DEPTH = 64;

/**
 * 文書全体で展開してよい量。
 * 1つの流れは MAX_STREAM_BYTES で止まるが、同じ流れを何度も参照されると
 * （`/Contents [5 0 R 5 0 R …]`）参照のたびに展開して足し合わせることになり、
 * 33KB の PDF で数 GB になった。文書で1つの財布にして、同じ流れは1回だけ展開する。
 */
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

/** PDF の字句解析。1つの値（辞書・配列・数・名前・文字列…）を読み進める */
export class Lexer {
  /** いま読んでいる入れ子の深さ。深すぎる値は読まずに捨てる */
  private depth = 0;

  constructor(readonly buf: Buffer, public pos = 0) {}

  atEnd(): boolean { return this.pos >= this.buf.length; }

  skipSpace(): void {
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]!;
      if (WHITESPACE.has(c)) { this.pos++; continue; }
      if (c === 0x25) { // % から行末までは注釈
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos++;
        continue;
      }
      return;
    }
  }

  /** 次の語（演算子・キーワード）。値ではないもの */
  readKeyword(): string {
    this.skipSpace();
    const start = this.pos;
    while (this.pos < this.buf.length && !WHITESPACE.has(this.buf[this.pos]!) && !DELIMITER.has(this.buf[this.pos]!)) this.pos++;
    return this.buf.toString('latin1', start, this.pos);
  }

  peekByte(): number | undefined { return this.buf[this.pos]; }

  /** 値を1つ読む。読めないものに当たったら undefined（呼ぶ側がキーワードとして読み直す） */
  readValue(): PdfValue | undefined {
    this.skipSpace();
    const c = this.buf[this.pos];
    if (c === undefined) return undefined;

    if (c === 0x2f) return this.readName();
    if (c === 0x28) return this.readLiteralString();
    if (c === 0x5b) {
      // 深すぎる入れ子は読まずに飛ばす（呼び出しが積み上がって止まるのを防ぐ）
      if (this.depth >= MAX_DEPTH) { this.skipNested(0x5b, 0x5d); return null; }
      return this.readArray();
    }
    if (c === 0x3c) {
      if (this.buf[this.pos + 1] !== 0x3c) return this.readHexString();
      if (this.depth >= MAX_DEPTH) { this.skipNested(0x3c, 0x3e); return null; }
      return this.readDict();
    }
    if (c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39)) return this.readNumberOrRef();
    return undefined;
  }

  private readName(): PdfName {
    this.pos++; // /
    const bytes: number[] = [];
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]!;
      if (WHITESPACE.has(c) || DELIMITER.has(c)) break;
      if (c === 0x23 && this.pos + 2 < this.buf.length) { // #41 のような16進
        bytes.push(parseInt(this.buf.toString('latin1', this.pos + 1, this.pos + 3), 16));
        this.pos += 3;
        continue;
      }
      bytes.push(c);
      this.pos++;
    }
    return { name: Buffer.from(bytes).toString('latin1') };
  }

  /** (…) の文字列。中身はバイト列のまま返す（文字への直しはフォント次第） */
  private readLiteralString(): Buffer {
    this.pos++; // (
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos++]!;
      if (c === 0x5c) { // \
        const e = this.buf[this.pos++]!;
        const simple: Record<number, number> = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c };
        if (e in simple) { out.push(simple[e]!); continue; }
        if (e >= 0x30 && e <= 0x37) { // 8進
          let digits = String.fromCharCode(e);
          for (let i = 0; i < 2 && this.buf[this.pos]! >= 0x30 && this.buf[this.pos]! <= 0x37; i++) {
            digits += String.fromCharCode(this.buf[this.pos++]!);
          }
          out.push(parseInt(digits, 8) & 0xff);
          continue;
        }
        if (e === 0x0a) continue;            // 行継続
        if (e === 0x0d) { if (this.buf[this.pos] === 0x0a) this.pos++; continue; }
        out.push(e);
        continue;
      }
      if (c === 0x28) { depth++; out.push(c); continue; }
      if (c === 0x29) { depth--; if (depth === 0) break; out.push(c); continue; }
      out.push(c);
    }
    return Buffer.from(out);
  }

  private readHexString(): Buffer {
    this.pos++; // <
    let hex = '';
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const c = this.buf[this.pos++]!;
      if (!WHITESPACE.has(c)) hex += String.fromCharCode(c);
    }
    this.pos++; // >
    if (hex.length % 2 === 1) hex += '0';
    return Buffer.from(hex, 'hex');
  }

  /** 開き記号から対応する閉じ記号まで読み飛ばす。中身は見ない */
  private skipNested(open: number, close: number): void {
    let level = 0;
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos]!;
      if (c === open) level++;
      else if (c === close) { level--; if (level <= 0) { this.pos++; return; } }
      this.pos++;
    }
  }

  private readArray(): PdfValue[] {
    this.pos++; // [
    this.depth++;
    try {
      return this.readArrayBody();
    } finally {
      this.depth--;
    }
  }

  private readArrayBody(): PdfValue[] {
    const out: PdfValue[] = [];
    for (;;) {
      this.skipSpace();
      if (this.buf[this.pos] === 0x5d) { this.pos++; break; }
      if (this.pos >= this.buf.length) break;
      const v = this.readValue();
      if (v === undefined) {
        const word = this.readKeyword();
        if (word === '') { this.pos++; continue; }
        if (word === 'null') out.push(null);
        else if (word === 'true') out.push(true);
        else if (word === 'false') out.push(false);
        continue;
      }
      out.push(v);
    }
    return out;
  }

  readDict(): PdfDict {
    this.pos += 2; // <<
    this.depth++;
    try {
      return this.readDictBody();
    } finally {
      this.depth--;
    }
  }

  private readDictBody(): PdfDict {
    const dict: PdfDict = new Map();
    for (;;) {
      this.skipSpace();
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) { this.pos += 2; break; }
      if (this.pos >= this.buf.length) break;
      if (this.buf[this.pos] !== 0x2f) { // 鍵でないものが来たら読み飛ばす
        const v = this.readValue();
        if (v === undefined && this.readKeyword() === '') this.pos++;
        continue;
      }
      const key = this.readName().name;
      const value = this.readValue();
      if (value === undefined) {
        const word = this.readKeyword();
        dict.set(key, word === 'true' ? true : word === 'false' ? false : null);
      } else {
        dict.set(key, value);
      }
    }
    return dict;
  }

  /** 数。「12 0 R」の形なら参照として読む */
  private readNumberOrRef(): PdfValue {
    const start = this.pos;
    while (this.pos < this.buf.length && !WHITESPACE.has(this.buf[this.pos]!) && !DELIMITER.has(this.buf[this.pos]!)) this.pos++;
    const text = this.buf.toString('latin1', start, this.pos);
    const value = Number(text);
    if (!Number.isInteger(value) || value < 0) return Number.isNaN(value) ? 0 : value;

    // 先を覗いて「世代 R」が続くか見る
    const save = this.pos;
    this.skipSpace();
    const genStart = this.pos;
    while (this.pos < this.buf.length && this.buf[this.pos]! >= 0x30 && this.buf[this.pos]! <= 0x39) this.pos++;
    if (this.pos > genStart) {
      const gen = Number(this.buf.toString('latin1', genStart, this.pos));
      const afterGen = this.pos;
      this.skipSpace();
      if (this.buf[this.pos] === 0x52 /* R */
        && (this.pos + 1 >= this.buf.length || WHITESPACE.has(this.buf[this.pos + 1]!) || DELIMITER.has(this.buf[this.pos + 1]!))) {
        this.pos++;
        return { ref: value, gen };
      }
      this.pos = afterGen;
    }
    this.pos = save;
    return value;
  }
}

/** FlateDecode などを解く。解けない方式はそのまま返す */
export function decodeStream(stream: PdfStream, resolve: (v: PdfValue) => PdfValue): Buffer {
  const filter = resolve(stream.dict.get('Filter') ?? null);
  const filters = Array.isArray(filter) ? filter : filter ? [filter] : [];
  const parmsValue = resolve(stream.dict.get('DecodeParms') ?? null);
  const parmsList = Array.isArray(parmsValue) ? parmsValue : [parmsValue];

  let data = stream.raw;
  // 展開の仕方を並べられるだけ並べた PDF（同じ展開を何十回も）で時間を使わせない
  for (const [i, f] of filters.slice(0, MAX_FILTERS).entries()) {
    const name = isName(resolve(f)) ? (resolve(f) as PdfName).name : '';
    if (name === 'FlateDecode') {
      // **上限を付けて展開する。** 付けないと、小さな PDF で台の記憶を使い切られる
      try {
        data = inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES });
      } catch {
        // 末尾が欠けていることがあるので、読めるところまでで諦める
        try {
          data = inflateSync(data, { finishFlush: 2 /* Z_SYNC_FLUSH */, maxOutputLength: MAX_STREAM_BYTES });
        } catch {
          return Buffer.alloc(0);
        }
      }
      const parms = resolve(parmsList[i] ?? null);
      if (isDict(parms)) data = undoPredictor(data, parms, resolve);
    } else if (name === 'ASCIIHexDecode') {
      const hex = data.toString('latin1').replace(/[^0-9a-fA-F]/g, '');
      data = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
    } else if (name === 'ASCII85Decode') {
      data = ascii85(data);
    } else if (name === 'FlateDecode' || name === '') {
      // なにもしない
    } else {
      // 画像などの方式は扱わない
      return Buffer.alloc(0);
    }
  }
  return data;
}

/** PNG 方式の予測器を戻す（索引ストリームでよく使われる） */
function undoPredictor(data: Buffer, parms: PdfDict, resolve: (v: PdfValue) => PdfValue): Buffer {
  const predictor = Number(resolve(parms.get('Predictor') ?? 1)) || 1;
  if (predictor < 10) return data;
  const colors = Number(resolve(parms.get('Colors') ?? 1)) || 1;
  const bpc = Number(resolve(parms.get('BitsPerComponent') ?? 8)) || 8;
  const columns = Number(resolve(parms.get('Columns') ?? 1)) || 1;
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLength = Math.ceil((colors * bpc * columns) / 8);
  // 行の長さは PDF 側の値で決まる。展開後のデータより長い行は意味が無く、
  // 巨大な Columns を書かれると Buffer.alloc で記憶を取り尽くす。外れた値なら予測器を無視する
  if (!Number.isFinite(rowLength) || rowLength <= 0 || rowLength > data.length || columns > 1_000_000) return data;
  const out: Buffer[] = [];
  let previous = Buffer.alloc(rowLength);
  for (let p = 0; p + 1 + rowLength <= data.length + rowLength; p += rowLength + 1) {
    if (p >= data.length) break;
    const type = data[p]!;
    const row = Buffer.from(data.subarray(p + 1, p + 1 + rowLength));
    for (let i = 0; i < row.length; i++) {
      const left = i >= bpp ? row[i - bpp]! : 0;
      const up = previous[i]!;
      const upLeft = i >= bpp ? previous[i - bpp]! : 0;
      if (type === 1) row[i] = (row[i]! + left) & 0xff;
      else if (type === 2) row[i] = (row[i]! + up) & 0xff;
      else if (type === 3) row[i] = (row[i]! + ((left + up) >> 1)) & 0xff;
      else if (type === 4) {
        const pa = Math.abs(up - upLeft), pb = Math.abs(left - upLeft), pc = Math.abs(left + up - 2 * upLeft);
        const best = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        row[i] = (row[i]! + best) & 0xff;
      }
    }
    out.push(row);
    previous = row;
  }
  return Buffer.concat(out);
}

function ascii85(data: Buffer): Buffer {
  const text = data.toString('latin1').replace(/\s/g, '').replace(/^<~/, '').replace(/~>$/, '');
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of text) {
    if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let n = 0;
      for (const g of group) n = n * 85 + g;
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      group = [];
    }
  }
  if (group.length > 1) {
    const missing = 5 - group.length;
    for (let i = 0; i < missing; i++) group.push(84);
    let n = 0;
    for (const g of group) n = n * 85 + g;
    const bytes = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    out.push(...bytes.slice(0, 4 - missing));
  }
  return Buffer.from(out);
}

export interface PdfDocument {
  /** 番号 → 値 */
  objects: Map<number, PdfValue>;
  resolve(value: PdfValue | undefined): PdfValue;
  stream(value: PdfValue | undefined): Buffer | null;
}

/** ファイル全体から obj を拾って表にする */
export function readDocument(buf: Buffer): PdfDocument {
  const objects = new Map<number, PdfValue>();
  // 数字の途中から始めない（長い数字の並びで O(n²) にならないように）。桁数も PDF に出てくる範囲で止める
  const header = /(?<![0-9])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  let match: RegExpExecArray | null;
  const text = buf.toString('latin1');

  while ((match = header.exec(text)) !== null) {
    const number = Number(match[1]);
    const lexer = new Lexer(buf, match.index + match[0].length);
    let value: PdfValue;
    const read = lexer.readValue();
    if (read === undefined) {
      const word = lexer.readKeyword();
      value = word === 'true' ? true : word === 'false' ? false : null;
    } else {
      value = read;
    }
    // 辞書のあとに stream が続くことがある
    lexer.skipSpace();
    if (isDict(value) && buf.toString('latin1', lexer.pos, lexer.pos + 6) === 'stream') {
      let start = lexer.pos + 6;
      if (buf[start] === 0x0d) start++;
      if (buf[start] === 0x0a) start++;
      const declared = value.get('Length');
      let end = -1;
      if (typeof declared === 'number' && declared >= 0 && start + declared <= buf.length) {
        const after = buf.toString('latin1', start + declared, start + declared + 20);
        if (/^\s*endstream/.test(after)) end = start + declared;
      }
      if (end < 0) {
        const found = text.indexOf('endstream', start);
        end = found < 0 ? buf.length : found;
        while (end > start && (buf[end - 1] === 0x0a || buf[end - 1] === 0x0d)) end--;
      }
      value = { dict: value, raw: buf.subarray(start, end) };
      header.lastIndex = Math.max(header.lastIndex, end);
    }
    objects.set(number, value);
  }

  // 展開した流れの覚え（参照番号ごと）と、文書全体で展開した量
  const decoded = new Map<number, Buffer | null>();
  let decodedBytes = 0;
  const doc: PdfDocument = {
    objects,
    resolve(value) {
      let seen = 0;
      let v: PdfValue = value ?? null;
      while (isRef(v) && seen++ < 32) v = objects.get(v.ref) ?? null;
      return v;
    },
    stream(value) {
      const key = isRef(value) ? value.ref : null;
      if (key !== null && decoded.has(key)) return decoded.get(key)!;
      const v = doc.resolve(value);
      const data = isStream(v) ? decodeStream(v, (x) => doc.resolve(x)) : null;
      if (data) {
        decodedBytes += data.length;
        if (decodedBytes > MAX_DOCUMENT_BYTES) throw new ImportError('資料が大きすぎます（展開後の量が上限を超えました）');
      }
      if (key !== null) decoded.set(key, data);
      return data;
    },
  };

  expandObjectStreams(doc);
  return doc;
}

/** まとめて圧縮されたオブジェクト（/Type /ObjStm）の中身を取り出す */
function expandObjectStreams(doc: PdfDocument): void {
  for (const value of [...doc.objects.values()]) {
    if (!isStream(value)) continue;
    const type = doc.resolve(value.dict.get('Type') ?? null);
    if (!isName(type) || type.name !== 'ObjStm') continue;
    const data = decodeStream(value, (v) => doc.resolve(v));
    if (data.length === 0) continue;
    const count = Number(doc.resolve(value.dict.get('N') ?? 0));
    const first = Number(doc.resolve(value.dict.get('First') ?? 0));
    const headerLexer = new Lexer(data, 0);
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < count; i++) {
      const num = headerLexer.readKeyword();
      const off = headerLexer.readKeyword();
      if (num === '' || off === '') break;
      pairs.push([Number(num), Number(off)]);
    }
    for (const [number, offset] of pairs) {
      if (doc.objects.has(number)) continue; // 外にあるものを優先する
      const lexer = new Lexer(data, first + offset);
      const v = lexer.readValue();
      doc.objects.set(number, v ?? null);
    }
  }
}
