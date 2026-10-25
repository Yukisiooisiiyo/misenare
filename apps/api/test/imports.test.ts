import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { approveVersion, getKnowledge, listPending } from '../src/domain/knowledge.ts';
import { discardImport, importManual, listImports } from '../src/domain/imports.ts';
import { parseDelimited, parseImport } from '../src/import/parse.ts';
import { listZipEntries, readZipEntry } from '../src/import/zip.ts';
import { freshDatabase, manager, STORE_A, T, tokenizer, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

before(async () => { db = await freshDatabase(); });
after(async () => { await db.close(); });

describe('ZIP の読み取り', () => {
  it('中に入っている名前を数えて、指定した中身を取り出せる', () => {
    const docx = fixture('manual.docx');
    const names = listZipEntries(docx).map((e) => e.name);
    assert.ok(names.includes('word/document.xml'));
    assert.ok(names.includes('[Content_Types].xml'));
    const xml = readZipEntry(docx, 'word/document.xml')!;
    assert.match(xml.toString('utf8'), /^<\?xml/);
    assert.ok(xml.includes(Buffer.from('冷蔵庫の引き取り', 'utf8')));
    assert.equal(readZipEntry(docx, 'word/nothing.xml'), undefined);
  });

  it('ZIP でないものは読めないと伝える', () => {
    assert.throws(() => listZipEntries(Buffer.from('これはただの文章です')), /ZIP/);
  });
});

describe('資料の読み取り', () => {
  it('Markdown は見出しで区切る', () => {
    const md = Buffer.from(['# 返品の受け付け', '', 'レシートが必要。', '', '## 開封済みの場合', '', '店長に確認する。'].join('\n'), 'utf8');
    const drafts = parseImport('手順.md', md);
    assert.deepEqual(drafts.map((d) => d.title), ['返品の受け付け', '開封済みの場合']);
    assert.equal(drafts[0]!.body, 'レシートが必要。');
    assert.equal(drafts[1]!.source, '手順.md');
  });

  it('■ や 【】、第◯章 の見出しも区切りにする', () => {
    const txt = Buffer.from(['■ 朝の開店準備', 'レジを立ち上げる。', '', '【閉店作業】', '金庫を確認する。', '', '第3章 クレーム対応', 'まず謝る。'].join('\n'), 'utf8');
    assert.deepEqual(parseImport('店舗マニュアル.txt', txt).map((d) => d.title), ['朝の開店準備', '閉店作業', '第3章 クレーム対応']);
  });

  it('見出しの無い文章は、空行で区切って1行目をタイトルにする', () => {
    const txt = Buffer.from('ポイントカード\n再発行は本人確認が必要。\n\n駐車場\n2時間まで無料。', 'utf8');
    const drafts = parseImport('メモ.txt', txt);
    assert.deepEqual(drafts.map((d) => d.title), ['ポイントカード', '駐車場']);
    assert.equal(drafts[1]!.body, '2時間まで無料。');
  });

  it('BOM と Windows の改行があっても読める', () => {
    const txt = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 見出し\r\n\r\n本文です。\r\n', 'utf8')]);
    const drafts = parseImport('windows.md', txt);
    assert.deepEqual(drafts, [{ title: '見出し', body: '本文です。', source: 'windows.md' }]);
  });

  it('CSV は「タイトル」「本文」の列を見つけて使う', () => {
    const csv = Buffer.from('タイトル,本文,担当\n配送の日程,"中3日。\n離島は1週間。",サービス課\n設置工事,別料金。,工事課\n', 'utf8');
    const drafts = parseImport('faq.csv', csv);
    assert.equal(drafts.length, 2);
    assert.equal(drafts[0]!.title, '配送の日程');
    assert.equal(drafts[0]!.body, '中3日。\n離島は1週間。', '引用符の中の改行とカンマはそのまま');
    assert.equal(drafts[0]!.source, 'faq.csv 2行目');
  });

  it('列の名前が違う CSV は、1列目をタイトル・残りを「列名：値」にする', () => {
    const csv = Buffer.from('商品,売場,備考\n洗濯機,2階 奥,配送は翌日以降\n', 'utf8');
    const drafts = parseImport('売場.csv', csv);
    assert.equal(drafts[0]!.title, '洗濯機');
    assert.equal(drafts[0]!.body, '売場：2階 奥\n備考：配送は翌日以降');
  });

  it('引用符つきの CSV を正しく分ける', () => {
    assert.deepEqual(parseDelimited('a,"b,c","d""e"\n', ','), [['a', 'b,c', 'd"e']]);
    assert.deepEqual(parseDelimited('a\tb\n', '\t'), [['a', 'b']]);
  });

  it('Word は見出しスタイルで区切る', () => {
    const drafts = parseImport('manual.docx', fixture('manual.docx'));
    assert.deepEqual(drafts.map((d) => d.title), ['冷蔵庫の引き取り', 'エアコンの取り付け工事']);
    assert.equal(drafts[0]!.body, 'リサイクル券が必要。お客様控えは必ず渡す。\n大型は2人で運ぶこと。');
    assert.equal(drafts[1]!.body, '標準工事に含まれるのは配管4mまで。\n\n追加料金は見積書で確認する。');
  });

  it('Excel は1行1件で読み、題名の無い行は飛ばす', () => {
    const drafts = parseImport('faq.xlsx', fixture('faq.xlsx'));
    assert.deepEqual(drafts.map((d) => d.title), ['延長保証の説明', 'ポイントの使い方']);
    assert.equal(drafts[0]!.body, '5年保証は購入時のみ。あとから付けられない。');
    assert.equal(drafts[0]!.source, 'faq.xlsx 2行目');
  });

  it('列の名前が違う Excel も、1列目をタイトルにする', () => {
    const drafts = parseImport('areas.xlsx', fixture('areas.xlsx'));
    assert.deepEqual(drafts.map((d) => d.title), ['洗濯機', '炊飯器']);
    assert.equal(drafts[0]!.body, '売場：2階 奥\n備考：配送は翌日以降');
    assert.equal(drafts[1]!.body, '売場：1階 レジ横');
  });

  it('知らない形式と、中身の無い資料は断る', () => {
    assert.throws(() => parseImport('資料.pdf', Buffer.from('%PDF-1.4')), /\.txt \.md \.csv/);
    assert.deepEqual(parseImport('空.txt', Buffer.from('   \n\n ', 'utf8')), []);
  });
});

describe('取り込み', () => {
  it('取り込むと承認待ちの下書きができ、承認すると公開される', async () => {
    const result = await db.withTenant(T, (q) => importManual(q, manager, STORE_A, 'manual.docx', fixture('manual.docx')));
    assert.equal(result.drafts, 2);
    assert.equal(result.preview.length, 2);

    await db.withTenant(T, async (q) => {
      // trusted が取り込んでも、すぐには公開しない
      const pending = await listPending(q, manager, STORE_A);
      assert.equal(pending.length, 2);
      const first = result.preview[0]!;
      const before = await getKnowledge(q, manager, first.id);
      assert.equal(before.status, 'draft');

      await approveVersion(q, tokenizer, manager, first.id, 1);
      const after = await getKnowledge(q, manager, first.id);
      assert.equal(after.status, 'published');
      assert.equal(after.title, '冷蔵庫の引き取り');

      const imports = await listImports(q, manager, STORE_A);
      assert.equal(imports[0]!.file_name, 'manual.docx');
      assert.equal(imports[0]!.drafts, 2);
      assert.equal(imports[0]!.pending, 1, '承認した分は残りから減る');
      assert.equal(imports[0]!.created_by, '店長');
    });
  });

  it('取り下げると、まだ承認されていない下書きだけが消える', async () => {
    const result = await db.withTenant(T, (q) => importManual(q, manager, STORE_A, 'faq.xlsx', fixture('faq.xlsx')));
    await db.withTenant(T, async (q) => {
      await approveVersion(q, tokenizer, manager, result.preview[0]!.id, 1);
      const { discarded } = await discardImport(q, manager, result.importId);
      assert.equal(discarded, 1);
      // 公開済みのものは残る
      assert.equal((await getKnowledge(q, manager, result.preview[0]!.id)).status, 'published');
    });
  });

  it('visitor は取り込めない', async () => {
    await db.withTenant(T, async (q) => {
      await assert.rejects(importManual(q, visitor, STORE_A, 'manual.docx', fixture('manual.docx')), /trusted 以上/);
      await assert.rejects(listImports(q, visitor, STORE_A), /権限がありません/);
    });
  });

  it('読めない資料は、その旨を返す', async () => {
    await db.withTenant(T, async (q) => {
      await assert.rejects(importManual(q, manager, STORE_A, 'こわれた.docx', Buffer.from('これは Word ではない')), /ZIP|読めません/);
      await assert.rejects(importManual(q, manager, STORE_A, '空.txt', Buffer.from('   ', 'utf8')), /下書きを作れませんでした/);
      await assert.rejects(importManual(q, manager, STORE_A, '資料.pdf', Buffer.from('%PDF')), /\.txt \.md \.csv/);
    });
  });
});
