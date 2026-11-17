// 資料の読み取りを別のプロセスに閉じ込めていることを確かめる（import/isolated.ts）。
//
// 見るのは3つ：
//   * 読み取りのあいだも、本体が動き続けること
//   * 記憶や時間の上限を超える資料は、本体を巻き込まずに断ること
//   * 子に鍵を渡さず、子が返したものをそのまま信じないこと

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ImportError } from '../src/import/error.ts';
import { acceptReply, childEnv, parseIsolated } from '../src/import/isolated.ts';
import { MAX_BODY_CHARS, MAX_DRAFTS, MAX_TITLE_CHARS, parseImport } from '../src/import/parse.ts';
import { MAX_PAGE_RUNS } from '../src/import/pdfText.ts';
import { deflateSync } from 'node:zlib';

const fixture = (name: string): Buffer => readFileSync(join(import.meta.dirname, 'fixtures', name));

/** 1ページだけの PDF（中身の流れを渡す） */
function onePagePdf(content: Buffer): Buffer {
  const z = deflateSync(content);
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n'
      + '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n'
      + '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n'
      + '3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n'
      + `5 0 obj << /Length ${z.length} /Filter /FlateDecode >> stream\n`),
    z,
    Buffer.from('\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'),
  ]);
}

/** 短い欄が何百万個も並ぶ、1行だけの表。読むと、欄の数だけ記憶を使う */
const manyCells = (bytes: number): Buffer => Buffer.from('a,'.repeat(bytes / 2));

describe('別のプロセスでの読み取り', () => {
  it('同じ資料なら、本体の中で読んだときと同じ結果になる', async () => {
    for (const name of ['manual.docx', 'faq.xlsx', 'manual-ja.pdf', 'compressed.pdf', 'scanned.pdf', 'encrypted.pdf']) {
      assert.deepEqual(await parseIsolated(name, fixture(name)), parseImport(name, fixture(name)), name);
    }
    const text = Buffer.from('# 返品の受付\nレシートを確かめる。\n\n# 配送の受付\n15時まで。\n', 'utf8');
    assert.deepEqual(await parseIsolated('手順.md', text), parseImport('手順.md', text));
  });

  it('読めなかった理由（利用者に見せてよい案内）は、そのまま届く', async () => {
    await assert.rejects(parseIsolated('資料.rtf', Buffer.from('{\\rtf1}')), (err: unknown) => {
      assert.ok(err instanceof ImportError);
      assert.match(err.message, /\.txt \.md \.csv/);
      return true;
    });
  });

  it('内部の事情で読めなかったときは、中身の文面を出さない', async () => {
    // 目録は正しいが、中身の場所がファイルの外を指している zip（読み取りの中で、範囲外の読み出しになる）
    const name = 'word/document.xml';
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(10, 20); central.writeUInt32LE(10, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0x7ffffff0, 42); central.write(name, 46);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(0, 16);
    const broken = Buffer.concat([central, end]);
    // 本体の中で読むと、内部の例外（範囲外）がそのまま出る形であることを確かめておく
    assert.throws(() => parseImport('こわれた.docx', broken), (err: unknown) => err instanceof RangeError);
    await assert.rejects(parseIsolated('こわれた.docx', broken), (err: unknown) => {
      assert.ok(err instanceof Error && !(err instanceof ImportError), String(err));
      assert.doesNotMatch(err.message, /offset|range|ERR_|Buffer|\d{6,}/i);
      return true;
    });
  });

  it('読み取りのあいだも、本体は動き続ける', async () => {
    // 上限いっぱい（8MB）の、短い段落ばかりの文章。本体の中で読むと、終わるまで何も動かない
    const heavy = Buffer.from('a\n\n'.repeat((8 * 1024 * 1024 - 16) / 3));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    const started = Date.now();
    try {
      await parseIsolated('大きい.txt', heavy).catch((err: unknown) => {
        // 上限に掛かって断られてもよい。見たいのは、そのあいだ本体が止まらないこと
        assert.ok(err instanceof ImportError, String(err));
      });
    } finally {
      clearInterval(timer);
    }
    const took = Date.now() - started;
    // 20ms ごとの刻みが、かかった時間の半分以上は回っている（本体の中で読むと、0〜1回になる）
    assert.ok(ticks >= took / 40, `${took}ms のあいだに ${ticks} 回しか動けなかった`);
  });

  it('記憶の上限を超える資料は、本体を巻き込まずに断る', async () => {
    const before = process.memoryUsage().rss;
    await assert.rejects(parseIsolated('欄が多すぎる.csv', manyCells(8 * 1024 * 1024 - 16), { heapMb: 64 }), (err: unknown) => {
      assert.ok(err instanceof ImportError, String(err));
      assert.match(err.message, /大きすぎて読み取れませんでした/);
      return true;
    });
    const grown = (process.memoryUsage().rss - before) / 1024 / 1024;
    // 本体が持つのは、子に渡す写し（8MB）くらい
    assert.ok(grown < 80, `本体の記憶が ${Math.round(grown)}MB 増えた`);
    // 断ったあとも、次の資料はふつうに読める
    assert.equal((await parseIsolated('manual.docx', fixture('manual.docx'))).drafts.length, 2);
  });

  it('時間の上限を超えたら、止めて断る', async () => {
    const started = Date.now();
    await assert.rejects(parseIsolated('manual.docx', fixture('manual.docx'), { timeoutMs: 1 }), (err: unknown) => {
      assert.ok(err instanceof ImportError, String(err));
      assert.match(err.message, /時間がかかりすぎました/);
      return true;
    });
    assert.ok(Date.now() - started < 5000, '止めるのに時間がかかっている');
  });

  it('同時に走るのは1つ。待てる人数を超えたら「読み取り中」と返す', async () => {
    const heavy = Buffer.from('a\n\n'.repeat(1_000_000));
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => parseIsolated('大きい.txt', heavy)));
    const busy = results.filter((r) => r.status === 'rejected' && /ほかの資料を読み取っています/.test(String((r.reason as Error).message)));
    const done = results.filter((r) => r.status === 'fulfilled');
    // 走る1つ＋待つ3つは読めて、残りの2つは待たずに断られる
    assert.equal(done.length, 4, JSON.stringify(results.map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as Error).message))));
    assert.equal(busy.length, 2);
    // 終わったあとは、また受け付ける
    assert.equal((await parseIsolated('大きい.txt', heavy)).drafts.length, MAX_DRAFTS);
  });

  it('前の読み取りが長引いたら、待つのをやめて断る', async () => {
    const heavy = Buffer.from('a\n\n'.repeat(1_000_000));
    const first = parseIsolated('大きい.txt', heavy);
    await assert.rejects(parseIsolated('小さい.txt', Buffer.from('題\n本文'), { waitMs: 1 }), /ほかの資料を読み取っています/);
    await first;
  });
});

describe('子プロセスとの受け渡し', () => {
  it('子には、DB の接続先や鍵を渡さない', () => {
    const env = childEnv({
      PATH: '/usr/bin', NODE_ENV: 'production', TZ: 'Asia/Tokyo',
      DATABASE_URL: 'postgresql://misenare:secret@db/misenare', SMTP_PASS: 'x', MISENARE_SECRET_KEY: 'x', OPERATOR_EMAILS: 'a@example.com', METRICS_TOKEN: 'x',
    });
    assert.deepEqual(Object.keys(env).sort(), ['NODE_ENV', 'PATH', 'TZ']);
  });

  it('子が返したものは、形と大きさを確かめてから受け取る', () => {
    const r = acceptReply({
      drafts: [
        { title: 'x'.repeat(500), body: 'y'.repeat(9000), source: 'z'.repeat(900) },
        { title: '', body: '題が無い' },
        { title: 5, body: { toString: () => '文字列でない' } },
        null,
        ...Array.from({ length: 300 }, (_, i) => ({ title: `題${i}`, body: '本文', source: 's' })),
      ],
      warnings: ['w'.repeat(900), 7, ...Array.from({ length: 50 }, () => '注意')],
    });
    assert.equal(r.drafts.length <= MAX_DRAFTS, true);
    assert.equal(r.drafts[0]!.title.length, MAX_TITLE_CHARS);
    assert.equal(r.drafts[0]!.body.length, MAX_BODY_CHARS);
    assert.equal(r.drafts[0]!.source.length, 300);
    assert.ok(r.drafts.every((d) => typeof d.title === 'string' && d.title !== '' && typeof d.body === 'string' && d.body !== ''));
    assert.ok(r.warnings.length <= 20);
    assert.equal(r.warnings[0]!.length, 200);
    assert.deepEqual(acceptReply({ drafts: 'いたずら', warnings: null }), { drafts: [], warnings: [] });
  });
});

describe('読み取りの中の上限', () => {
  it('字を出す命令が何十万と並ぶページは、途中までを読んで知らせる（記憶を使い切らない）', () => {
    // 30MB ぶんの「1行出す」命令は、縮めると 100KB ほど。全部を拾うと、まとまりが40万個になる
    const op = 'BT /F1 12 Tf 72 700 Td (Hello world, this is a line of the manual.) Tj ET\n';
    const pdf = onePagePdf(Buffer.from(op.repeat(Math.floor((30 * 1024 * 1024) / op.length))));
    assert.ok(pdf.byteLength < 300 * 1024, `PDF が ${pdf.byteLength} バイト`);
    const before = process.memoryUsage().rss;
    const result = parseImport('命令だらけ.pdf', pdf);
    assert.ok(result.warnings.some((w) => /文字の数が多すぎる/.test(w)), JSON.stringify(result.warnings));
    assert.equal(result.drafts.length, 1);
    const grown = (process.memoryUsage().rss - before) / 1024 / 1024;
    assert.ok(grown < 300, `記憶が ${Math.round(grown)}MB 増えた`);
    assert.ok(MAX_PAGE_RUNS >= 20_000, 'ふつうのページ（1字ずつ出す作りで2万ほど）が切られる');
  });

  it('1行に何十万ものまとまりがあっても、読み切る', () => {
    // 同じ高さに 1 字ずつ 9 万個（上限のすぐ下）。行にまとめるとき、呼び出しの積み上げを使い切らないこと
    const pdf = onePagePdf(Buffer.from(`BT /F1 12 Tf\n${'1 0 0 1 72 700 Tm (a) Tj\n'.repeat(90_000)}ET\n`));
    const result = parseImport('1行.pdf', pdf);
    assert.equal(result.drafts.length, 1);
    assert.equal(result.drafts[0]!.title.length, MAX_TITLE_CHARS);
  });

  it('短い行や欄ばかりの大きな表でも、使う分だけを読む', () => {
    const rows = Buffer.from(`タイトル,本文\n${'題,本文\n'.repeat(700_000)}`);
    const before = process.memoryUsage().rss;
    const started = Date.now();
    const result = parseImport('行が多い.csv', rows);
    assert.equal(result.drafts.length, MAX_DRAFTS);
    assert.equal(result.drafts[199]!.source, '行が多い.csv 201行目');
    assert.ok(Date.now() - started < 2000, `時間がかかっている（${Date.now() - started}ms）`);
    const grown = (process.memoryUsage().rss - before) / 1024 / 1024;
    assert.ok(grown < 100, `記憶が ${Math.round(grown)}MB 増えた`);
  });
});
