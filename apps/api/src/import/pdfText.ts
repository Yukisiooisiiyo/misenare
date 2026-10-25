// PDF からテキストを取り出す。
//
// 読み取れる並びは3通り：
//   ToUnicode が付いている        … いちばん多い（Word や Google ドキュメントからの書き出し）
//   2バイトで中身が UCS-2        … UniJIS-UCS2-H などの指定
//   1バイトの欧文（WinAnsi 等）   … 英数字だけの資料
// どれでもない字は「□」にして、何ページ目が読めなかったかを知らせる。
//
// 見出しは文字の大きさで見分ける。ページの中でいちばん多い大きさを本文とみなし、
// それより目立って大きい行を見出しとして扱う（Word の見出しスタイルと同じ役割）。

import {
  isDict, isName, isStream, Lexer,
  type PdfDict, type PdfDocument, type PdfValue,
} from './pdfObjects.ts';

/** 読めなかった字の代わり */
export const UNREADABLE = '□';

export interface PdfLine {
  text: string;
  /** 行の中でいちばん大きい文字の大きさ */
  size: number;
}

export interface PdfPageText {
  number: number;
  lines: PdfLine[];
}

// --- 文字の対応表 -------------------------------------------------------------------

/** WinAnsiEncoding のうち、Latin-1 と違うところ（0x80〜0x9F） */
const WIN_ANSI_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

/** /Differences に出てくる字名のうち、よく使うもの */
const GLYPH_NAMES: Record<string, number> = {
  space: 0x20, exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24, percent: 0x25,
  ampersand: 0x26, quotesingle: 0x27, parenleft: 0x28, parenright: 0x29, asterisk: 0x2a, plus: 0x2b,
  comma: 0x2c, hyphen: 0x2d, period: 0x2e, slash: 0x2f, zero: 0x30, one: 0x31, two: 0x32, three: 0x33,
  four: 0x34, five: 0x35, six: 0x36, seven: 0x37, eight: 0x38, nine: 0x39, colon: 0x3a, semicolon: 0x3b,
  less: 0x3c, equal: 0x3d, greater: 0x3e, question: 0x3f, at: 0x40, bracketleft: 0x5b, backslash: 0x5c,
  bracketright: 0x5d, asciicircum: 0x5e, underscore: 0x5f, grave: 0x60, braceleft: 0x7b, bar: 0x7c,
  braceright: 0x7d, asciitilde: 0x7e, quoteleft: 0x2018, quoteright: 0x2019, quotedblleft: 0x201c,
  quotedblright: 0x201d, endash: 0x2013, emdash: 0x2014, bullet: 0x2022, yen: 0xa5, degree: 0xb0,
};

function glyphToChar(name: string): string | null {
  if (name in GLYPH_NAMES) return String.fromCodePoint(GLYPH_NAMES[name]!);
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) return String.fromCodePoint(parseInt(uni[1]!, 16));
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u) return String.fromCodePoint(parseInt(u[1]!, 16));
  if (name.length === 1) return name;
  return null;
}

// --- フォントごとの読み方 -----------------------------------------------------------

interface FontDecoder {
  /** バイト列を字に直す */
  decode(bytes: Buffer): string;
  /** 読める見込みがあるか（無ければ警告する） */
  readable: boolean;
}

/** ToUnicode の CMap を読む（bfchar / bfrange） */
function parseToUnicode(data: Buffer): { map: Map<number, string>; twoByte: boolean } {
  const map = new Map<number, string>();
  const text = data.toString('latin1');
  let twoByte = false;

  const codespace = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let m: RegExpExecArray | null;
  while ((m = codespace.exec(text)) !== null) {
    const pairs = m[1]!.match(/<([0-9A-Fa-f]+)>/g) ?? [];
    for (const p of pairs) if ((p.length - 2) / 2 >= 2) twoByte = true;
  }

  const utf16 = (hex: string): string => Buffer.from(hex, 'hex').toString('utf16le').length === 0
    ? ''
    : Buffer.from(hex.length % 4 === 0 ? hex : hex.padStart(Math.ceil(hex.length / 4) * 4, '0'), 'hex').swap16().toString('utf16le');

  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bfchar.exec(text)) !== null) {
    const entries = m[1]!.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g) ?? [];
    for (const e of entries) {
      const parts = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/.exec(e)!;
      if (parts[1]!.length >= 4) twoByte = true;
      map.set(parseInt(parts[1]!, 16), utf16(parts[2]!));
    }
  }

  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(text)) !== null) {
    const body = m[1]!;
    // <低> <高> <始まり>
    const simple = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    let r: RegExpExecArray | null;
    while ((r = simple.exec(body)) !== null) {
      const low = parseInt(r[1]!, 16);
      const high = parseInt(r[2]!, 16);
      if (r[1]!.length >= 4) twoByte = true;
      const startHex = r[3]!;
      for (let code = low; code <= high && code - low < 65536; code++) {
        const value = BigInt(`0x${startHex || '0'}`) + BigInt(code - low);
        const hex = value.toString(16).padStart(startHex.length || 4, '0');
        map.set(code, utf16(hex));
      }
    }
    // <低> <高> [ <字> <字> … ]
    const listed = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    while ((r = listed.exec(body)) !== null) {
      const low = parseInt(r[1]!, 16);
      if (r[1]!.length >= 4) twoByte = true;
      const items = r[3]!.match(/<([0-9A-Fa-f]*)>/g) ?? [];
      items.forEach((item, i) => {
        map.set(low + i, utf16(item.slice(1, -1)));
      });
    }
  }
  return { map, twoByte };
}

/** 2バイトずつ読む（Type0 フォント） */
function twoByteDecoder(toUnicode: Map<number, string> | null): FontDecoder {
  return {
    readable: true,
    decode(bytes) {
      let out = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = (bytes[i]! << 8) | bytes[i + 1]!;
        if (toUnicode) {
          const mapped = toUnicode.get(code);
          out += mapped === undefined ? UNREADABLE : mapped;
        } else {
          // UCS-2 の並び（UniJIS-UCS2-H など）はそのまま字になる
          out += String.fromCharCode(code);
        }
      }
      return out;
    },
  };
}

function singleByteDecoder(table: Map<number, string>, toUnicode: Map<number, string> | null): FontDecoder {
  return {
    readable: true,
    decode(bytes) {
      let out = '';
      for (const b of bytes) {
        const mapped = toUnicode?.get(b) ?? table.get(b);
        if (mapped !== undefined) { out += mapped; continue; }
        out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b)
          : b in WIN_ANSI_HIGH ? String.fromCodePoint(WIN_ANSI_HIGH[b]!)
          : b >= 0xa0 ? String.fromCodePoint(b)
          : UNREADABLE;
      }
      return out;
    },
  };
}

/** フォント辞書から読み方を決める */
export function fontDecoder(doc: PdfDocument, font: PdfDict): FontDecoder {
  const subtype = doc.resolve(font.get('Subtype') ?? null);
  const isType0 = isName(subtype) && subtype.name === 'Type0';

  let toUnicode: Map<number, string> | null = null;
  let toUnicodeTwoByte = false;
  const toUnicodeStream = doc.resolve(font.get('ToUnicode') ?? null);
  if (isStream(toUnicodeStream)) {
    const data = doc.stream(toUnicodeStream);
    if (data && data.length > 0) {
      const parsed = parseToUnicode(data);
      if (parsed.map.size > 0) {
        toUnicode = parsed.map;
        toUnicodeTwoByte = parsed.twoByte;
      }
    }
  }

  if (isType0 || toUnicodeTwoByte) {
    const encoding = doc.resolve(font.get('Encoding') ?? null);
    const encodingName = isName(encoding) ? encoding.name : '';
    if (toUnicode) return twoByteDecoder(toUnicode);
    // UCS-2 の並びなら、符号がそのまま字になる
    if (/UCS2|UTF16/i.test(encodingName)) return twoByteDecoder(null);
    // Identity-H などは、対応表が無いと字に直せない
    return { readable: false, decode: (bytes) => UNREADABLE.repeat(Math.floor(bytes.length / 2)) };
  }

  // 1バイトのフォント。/Encoding の /Differences を見る
  const table = new Map<number, string>();
  const encoding = doc.resolve(font.get('Encoding') ?? null);
  if (isDict(encoding)) {
    const differences = doc.resolve(encoding.get('Differences') ?? null);
    if (Array.isArray(differences)) {
      let code = 0;
      for (const item of differences) {
        const v = doc.resolve(item);
        if (typeof v === 'number') { code = v; continue; }
        if (isName(v)) {
          const ch = glyphToChar(v.name);
          if (ch !== null) table.set(code, ch);
          code++;
        }
      }
    }
  }
  return singleByteDecoder(table, toUnicode);
}

// --- ページの取り出し ---------------------------------------------------------------

/** ページを順番に並べる（目録 → /Pages → /Kids の順にたどる） */
export function listPages(doc: PdfDocument): PdfDict[] {
  const pages: PdfDict[] = [];
  const seen = new Set<PdfDict>();

  const walk = (node: PdfValue, inherited: PdfDict, depth: number): void => {
    const d = doc.resolve(node);
    if (!isDict(d) || depth > 32 || seen.has(d)) return;
    seen.add(d);
    const merged: PdfDict = new Map(inherited);
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      const v = d.get(key);
      if (v !== undefined) merged.set(key, v);
    }
    const type = doc.resolve(d.get('Type') ?? null);
    const kids = doc.resolve(d.get('Kids') ?? null);
    if (Array.isArray(kids)) {
      for (const kid of kids) walk(kid, merged, depth + 1);
      return;
    }
    if (isName(type) && type.name === 'Page') {
      const page: PdfDict = new Map(d);
      for (const [k, v] of merged) if (!page.has(k)) page.set(k, v);
      pages.push(page);
    }
  };

  for (const value of doc.objects.values()) {
    const d = doc.resolve(value);
    if (!isDict(d)) continue;
    const type = doc.resolve(d.get('Type') ?? null);
    if (isName(type) && type.name === 'Catalog') {
      walk(d.get('Pages') ?? null, new Map(), 0);
      break;
    }
  }

  if (pages.length === 0) {
    // 目録が見つからないときは、/Type /Page を番号順に拾う
    for (const [, value] of [...doc.objects].sort((a, b) => a[0] - b[0])) {
      const d = doc.resolve(value);
      if (!isDict(d)) continue;
      const type = doc.resolve(d.get('Type') ?? null);
      if (isName(type) && type.name === 'Page') pages.push(d);
    }
  }
  return pages;
}

// --- 内容ストリームを読む -----------------------------------------------------------

interface Run { text: string; x: number; y: number; size: number }

/** 1ページ分の内容から、文字の並びを拾う */
function readPage(doc: PdfDocument, page: PdfDict, warn: (message: string) => void, pageNumber: number): PdfLine[] {
  const contents = doc.resolve(page.get('Contents') ?? null);
  const parts: Buffer[] = [];
  for (const item of Array.isArray(contents) ? contents : [contents]) {
    const data = doc.stream(item);
    if (data && data.length > 0) parts.push(data, Buffer.from('\n'));
  }
  if (parts.length === 0) return [];
  const content = Buffer.concat(parts);

  // 使えるフォントを集める
  const fonts = new Map<string, FontDecoder>();
  const resources = doc.resolve(page.get('Resources') ?? null);
  if (isDict(resources)) {
    const fontDict = doc.resolve(resources.get('Font') ?? null);
    if (isDict(fontDict)) {
      for (const [name, ref] of fontDict) {
        const font = doc.resolve(ref);
        if (isDict(font)) fonts.set(name, fontDecoder(doc, font));
      }
    }
  }

  const runs: Run[] = [];
  const lexer = new Lexer(content, 0);
  const stack: PdfValue[] = [];
  let decoder: FontDecoder | null = null;
  let fontSize = 0;
  // 行列は [a b c d e f]。大きさは a・d の縮尺も効く
  let textMatrix = [1, 0, 0, 1, 0, 0];
  let lineMatrix = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  let unreadableFont = false;

  const scale = (): number => {
    const sx = Math.hypot(textMatrix[0]!, textMatrix[1]!);
    return fontSize * (sx === 0 ? 1 : sx);
  };
  const show = (bytes: Buffer): void => {
    if (!decoder) return;
    if (!decoder.readable) unreadableFont = true;
    const text = decoder.decode(bytes);
    if (text === '') return;
    runs.push({ text, x: textMatrix[4]!, y: textMatrix[5]!, size: scale() });
    // 送り幅は正確に追わない（行の中の文字は順に並ぶ前提）
  };

  while (!lexer.atEnd()) {
    const before = lexer.pos;
    const value = lexer.readValue();
    if (value !== undefined) { stack.push(value); continue; }
    const op = lexer.readKeyword();
    if (op === '') {
      if (lexer.pos === before) lexer.pos++;
      continue;
    }
    switch (op) {
      case 'BT':
        textMatrix = [1, 0, 0, 1, 0, 0];
        lineMatrix = [1, 0, 0, 1, 0, 0];
        break;
      case 'Tf': {
        const size = stack.pop();
        const name = stack.pop();
        fontSize = typeof size === 'number' ? size : fontSize;
        decoder = isName(name) ? fonts.get(name.name) ?? null : null;
        break;
      }
      case 'TL': {
        const v = stack.pop();
        leading = typeof v === 'number' ? v : leading;
        break;
      }
      case 'Td': case 'TD': {
        const ty = Number(stack.pop() ?? 0);
        const tx = Number(stack.pop() ?? 0);
        if (op === 'TD') leading = -ty;
        lineMatrix = [lineMatrix[0]!, lineMatrix[1]!, lineMatrix[2]!, lineMatrix[3]!,
          lineMatrix[4]! + tx * lineMatrix[0]! + ty * lineMatrix[2]!,
          lineMatrix[5]! + tx * lineMatrix[1]! + ty * lineMatrix[3]!];
        textMatrix = [...lineMatrix];
        break;
      }
      case 'Tm': {
        const f = Number(stack.pop() ?? 0), e = Number(stack.pop() ?? 0);
        const d = Number(stack.pop() ?? 1), c = Number(stack.pop() ?? 0);
        const b = Number(stack.pop() ?? 0), a = Number(stack.pop() ?? 1);
        lineMatrix = [a, b, c, d, e, f];
        textMatrix = [...lineMatrix];
        break;
      }
      case 'T*': {
        lineMatrix = [lineMatrix[0]!, lineMatrix[1]!, lineMatrix[2]!, lineMatrix[3]!,
          lineMatrix[4]! - leading * lineMatrix[2]!, lineMatrix[5]! - leading * lineMatrix[3]!];
        textMatrix = [...lineMatrix];
        break;
      }
      case 'Tj': {
        const v = stack.pop();
        if (Buffer.isBuffer(v)) show(v);
        break;
      }
      case "'": case '"': {
        const v = stack.pop();
        lineMatrix = [lineMatrix[0]!, lineMatrix[1]!, lineMatrix[2]!, lineMatrix[3]!,
          lineMatrix[4]! - leading * lineMatrix[2]!, lineMatrix[5]! - leading * lineMatrix[3]!];
        textMatrix = [...lineMatrix];
        if (Buffer.isBuffer(v)) show(v);
        break;
      }
      case 'TJ': {
        const arr = stack.pop();
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (Buffer.isBuffer(item)) show(item);
            // 大きく戻す指定（-200 以下）は、語の切れ目とみなして空白を入れる
            else if (typeof item === 'number' && item <= -200 && runs.length > 0) runs[runs.length - 1]!.text += ' ';
          }
        }
        break;
      }
      case 'BI': {
        // 画像の埋め込みは中身を読み飛ばす
        const end = content.indexOf('EI', lexer.pos, 'latin1');
        lexer.pos = end < 0 ? content.length : end + 2;
        break;
      }
      default:
        break;
    }
    if (op !== 'TJ' && op !== 'Tj') stack.length = 0;
    else stack.length = 0;
  }

  if (unreadableFont) warn(`${pageNumber}ページ目に、文字の対応表が無いフォントがあります`);

  // 同じ高さのものを1行にまとめる（上から下へ、行の中は左から右へ）
  const lines: PdfLine[] = [];
  const sorted = [...runs].sort((a, b) => (Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x));
  let current: Run[] = [];
  for (const run of sorted) {
    if (current.length > 0 && Math.abs(current[0]!.y - run.y) > 2) {
      lines.push(toLine(current));
      current = [];
    }
    current.push(run);
  }
  if (current.length > 0) lines.push(toLine(current));
  return lines.filter((l) => l.text.trim() !== '');
}

function toLine(runs: Run[]): PdfLine {
  return {
    text: runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim(),
    size: Math.max(...runs.map((r) => r.size)),
  };
}

/**
 * 鍵がかかっているか。
 * 標準の仕組み（/Filter /Standard と、鍵の素になる /O /U を持つ辞書）があれば、かかっているとみなす。
 */
export function isEncrypted(doc: PdfDocument): boolean {
  for (const value of doc.objects.values()) {
    const d = doc.resolve(value);
    if (!isDict(d)) continue;
    const filter = doc.resolve(d.get('Filter') ?? null);
    if (isName(filter) && filter.name === 'Standard' && d.has('O') && d.has('U')) return true;
  }
  return false;
}

export interface PdfText {
  pages: PdfPageText[];
  warnings: string[];
  /** 読めた字のうち、□ になった割合 */
  unreadableRatio: number;
}

export function extractPdfText(doc: PdfDocument): PdfText {
  const warnings: string[] = [];
  const pages: PdfPageText[] = [];
  const seen = new Set<string>();
  const warn = (message: string) => { if (!seen.has(message)) { seen.add(message); warnings.push(message); } };

  listPages(doc).forEach((page, i) => {
    pages.push({ number: i + 1, lines: readPage(doc, page, warn, i + 1) });
  });

  let total = 0;
  let unreadable = 0;
  for (const page of pages) {
    for (const line of page.lines) {
      total += [...line.text].length;
      unreadable += [...line.text].filter((c) => c === UNREADABLE).length;
    }
  }
  return { pages, warnings, unreadableRatio: total === 0 ? 0 : unreadable / total };
}
