// 資料の取り込みで、**ファイルの言い値を信じない**ことを確かめる。
//
// 取り込めるのは trusted 以上だが、「身内しか触らない」は守りにならない。
// 端末が乗っ取られれば、同じ経路が台を落とす道具になる。
// ここで見るのは、小さなファイルで大きな害を出せる形：
//   * 展開すると何GBにもなる流れ（圧縮爆弾）
//   * 深く入れ子にした値（呼び出しが積み上がる）
//   * 展開の仕方を何十回も並べたもの

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';
import { Lexer, decodeStream, type PdfValue } from '../src/import/pdfObjects.ts';
import { parseImport } from '../src/import/parse.ts';

/** 1つの項目だけを無圧縮で収めた ZIP（.docx / .xlsx の形を手で作るため） */
function fakeZip(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38); central.writeUInt32LE(0, 42);
  const centralStart = local.length + nameBytes.length + data.length;
  const centralSize = central.length + nameBytes.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(centralStart, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** 中身が同じバイトだけの、よく縮む塊 */
const bomb = (bytes: number): Buffer => deflateSync(Buffer.alloc(bytes, 0x41));

describe('圧縮爆弾', () => {
  it('展開すると大きすぎる流れは、空として扱う（台を落とさない）', () => {
    // 200MB ぶんの「A」は、縮めると 200KB ほどになる。
    // 上限が無いと、ここで 200MB の塊が記憶に載る（本物の爆弾は数GBにできる）
    const raw = bomb(200 * 1024 * 1024);
    assert.ok(raw.byteLength < 1024 * 1024, `縮めた大きさ ${raw.byteLength}`);

    const dict = new Map<string, PdfValue>([['Filter', { name: 'FlateDecode' }]]);
    const out = decodeStream({ dict, raw }, (v) => v);
    assert.equal(out.byteLength, 0, '上限を超えた流れを、そのまま展開してしまった');
  });

  it('上限の中なら、ふつうに展開する', () => {
    const dict = new Map<string, PdfValue>([['Filter', { name: 'FlateDecode' }]]);
    const out = decodeStream({ dict, raw: deflateSync(Buffer.from('本文です', 'utf8')) }, (v) => v);
    assert.equal(out.toString('utf8'), '本文です');
  });

  it('展開の仕方を並べられるだけ並べても、数を限る', () => {
    // 同じ展開を 200 回並べた PDF。全部やろうとすると時間を使わされる
    const filters: PdfValue = Array.from({ length: 200 }, () => ({ name: 'FlateDecode' }));
    const dict = new Map<string, PdfValue>([['Filter', filters]]);
    const started = Date.now();
    decodeStream({ dict, raw: deflateSync(Buffer.from('x')) }, (v) => v);
    assert.ok(Date.now() - started < 3000, '並べた数だけ時間を使っている');
  });
});

describe('深い入れ子', () => {
  it('配列を深く入れ子にされても、読み進めて止まる', () => {
    // 10万重の「[」。上限が無いと呼び出しが積み上がる
    const deep = Buffer.from(`${'['.repeat(100_000)}1${']'.repeat(100_000)}`, 'latin1');
    const lexer = new Lexer(deep);
    const value = lexer.readValue();
    assert.ok(value !== undefined);
    // 最後まで読み進んでいる（途中で詰まっていない）
    assert.ok(lexer.pos > 0);
  });

  it('辞書を深く入れ子にされても、読み進めて止まる', () => {
    const deep = Buffer.from(`${'<</K '.repeat(50_000)}1${'>>'.repeat(50_000)}`, 'latin1');
    const lexer = new Lexer(deep);
    assert.ok(lexer.readDict() instanceof Map);
  });

  it('閉じ記号が無いものでも、終わりまでで止まる', () => {
    const lexer = new Lexer(Buffer.from('[1 2 3', 'latin1'));
    assert.deepEqual(lexer.readValue(), [1, 2, 3]);
  });
});

describe('ファイル全体', () => {
  it('爆弾を仕込んだ PDF でも、落ちずに断る', () => {
    const raw = bomb(200 * 1024 * 1024);
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<</Type /Page>>\nendobj\n2 0 obj\n<</Length '),
      Buffer.from(String(raw.byteLength)),
      Buffer.from(' /Filter /FlateDecode>>\nstream\n'),
      raw,
      Buffer.from('\nendstream\nendobj\n%%EOF\n'),
    ]);
    // 下書きが作れないのは構わない。**落ちないこと**と、すぐ終わることを見る。
    // 取り込みの入口（importManual）は、下書きが0件なら理由を添えて断る。
    const started = Date.now();
    const result = parseImport('爆弾.pdf', pdf);
    assert.deepEqual(result.drafts, []);
    assert.ok(result.warnings.length > 0, '理由が返っていない');
    assert.ok(Date.now() - started < 5000, `時間を使わされている（${Date.now() - started}ms）`);
  });

  it('同じ流れを何度も参照されても、文書全体の展開量で止まる（33KB で数 GB にならない）', () => {
    // 1つの流れは上限の中（31MB）。これを /Contents に 40 回並べると、
    // 参照ごとに展開して足し合わせる作りでは 1.2GB になる
    const big = deflateSync(Buffer.alloc(31 * 1024 * 1024, 0x20));
    const refs = Array.from({ length: 40 }, () => '5 0 R').join(' ');
    const pdf = Buffer.concat([
      Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n`
        + `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n`
        + `3 0 obj << /Type /Page /Parent 2 0 R /Contents [${refs}] >> endobj\n`
        + `5 0 obj << /Length ${big.length} /Filter /FlateDecode >> stream\n`),
      big,
      Buffer.from('\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'),
    ]);
    assert.ok(pdf.byteLength < 100 * 1024, `PDF が ${pdf.byteLength} バイト`);
    const before = process.memoryUsage().rss;
    const started = Date.now();
    assert.throws(() => parseImport('多重参照.pdf', pdf), /大きすぎます/);
    assert.ok(Date.now() - started < 10_000, `時間を使わされている（${Date.now() - started}ms）`);
    const grown = (process.memoryUsage().rss - before) / 1024 / 1024;
    assert.ok(grown < 400, `記憶が ${Math.round(grown)}MB 増えた`);
  });

  it('予測器の列数を巨大にされても、記憶を取らない', () => {
    const raw = deflateSync(Buffer.from('ab'));
    const dict = new Map<string, PdfValue>([
      ['Filter', { name: 'FlateDecode' }],
      ['DecodeParms', new Map<string, PdfValue>([['Predictor', 12], ['Columns', 1_000_000_000]])],
    ]);
    const out = decodeStream({ dict, raw }, (v) => v);
    assert.equal(out.toString(), 'ab', '外れた予測器は無視して中身をそのまま返す');
  });

  it('中身が PDF でないのに拡張子だけ PDF のものは、下書きを作らない', () => {
    const result = parseImport('うそ.pdf', Buffer.from('これは PDF ではありません', 'utf8'));
    assert.deepEqual(result.drafts, []);
    assert.ok(result.warnings.length > 0);
  });
});

describe('時間を使わされる入力', () => {
  it('行末に空白を何万個も並べても、一瞬で終わる', () => {
    const text = `見出し\n${' '.repeat(80_000)}x\n本文`;
    const started = Date.now();
    const result = parseImport('空白.txt', Buffer.from(text, 'utf8'));
    assert.ok(Date.now() - started < 2000, `${Date.now() - started}ms`);
    assert.ok(result.drafts.length >= 1);
  });

  it('閉じタグの無い段落タグを並べた Word でも、一瞬で終わる', () => {
    const xml = `<w:document><w:body>${'<w:p '.repeat(20_000)}</w:body></w:document>`;
    const started = Date.now();
    const result = parseImport('壊れた.docx', fakeZip('word/document.xml', xml));
    assert.ok(Date.now() - started < 2000, `${Date.now() - started}ms`);
    assert.deepEqual(result.drafts, []);
  });

  it('行末に全角空白を何万個も並べても、一瞬で終わる', () => {
    const text = `見出し\n${'　'.repeat(80_000)}x\n本文`;
    const started = Date.now();
    parseImport('全角空白.txt', Buffer.from(text, 'utf8'));
    assert.ok(Date.now() - started < 2000, `${Date.now() - started}ms`);
  });

  it('閉じないセルを1行に並べた Excel でも、一瞬で終わる', () => {
    const sheet = `<worksheet><sheetData><row r="1">${'<c '.repeat(50_000)}</row></sheetData></worksheet>`;
    const started = Date.now();
    parseImport('セル.xlsx', fakeZip('xl/worksheets/sheet1.xml', sheet));
    assert.ok(Date.now() - started < 2000, `${Date.now() - started}ms`);
  });

  it('Excel の列の番地が範囲外なら断る（巨大な配列を作らない）', () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="ZZZZZZZ1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>';
    assert.throws(() => parseImport('列.xlsx', fakeZip('xl/worksheets/sheet1.xml', sheet)), /読めませんでした/);
  });

  it('obj の見出しを長い数字で探されても、一瞬で終わる', () => {
    const started = Date.now();
    parseImport('数字.pdf', Buffer.from(`%PDF-1.4\n${'1'.repeat(200_000)}\n%%EOF`, 'latin1'));
    assert.ok(Date.now() - started < 2000, `${Date.now() - started}ms`);
  });
});
