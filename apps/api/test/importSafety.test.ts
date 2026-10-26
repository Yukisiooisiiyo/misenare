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

  it('中身が PDF でないのに拡張子だけ PDF のものは、下書きを作らない', () => {
    const result = parseImport('うそ.pdf', Buffer.from('これは PDF ではありません', 'utf8'));
    assert.deepEqual(result.drafts, []);
    assert.ok(result.warnings.length > 0);
  });
});
