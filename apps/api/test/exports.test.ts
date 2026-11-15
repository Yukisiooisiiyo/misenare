// 本部向けの書き出し（ナレッジ・検索の記録・タグ）。
//
// 確かめたいのは
//   ・出せるのは本部だけ
//   ・Excel でそのまま開ける CSV になっている（BOM・引用符・改行）。数式として実行させない
//   ・だれが検索したか・ブックマークの数は出ない

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addBookmark } from '../src/domain/bookmarks.ts';
import { csvCell, exportTable, toCsv, toJson } from '../src/domain/exports.ts';
import { createKnowledge } from '../src/domain/knowledge.ts';
import { createApp } from '../src/http/app.ts';
import { DevHeaderAuthenticator } from '../src/http/auth.ts';
import { MemoryRateLimiter } from '../src/http/rateLimit.ts';
import { freshDatabase, hq, manager, STORE_A, T, tokenizer, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

describe('CSV の形', () => {
  it('カンマ・改行・引用符は囲む。数式に見えるものは文字として読ませる', () => {
    assert.equal(csvCell('ふつう'), 'ふつう');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('1行目\n2行目'), '"1行目\n2行目"');
    assert.equal(csvCell('「"」を含む'), '"「""」を含む"');
    assert.equal(csvCell('=HYPERLINK("http://evil.example","押して")'), `"'=HYPERLINK(""http://evil.example"",""押して"")"`);
    assert.equal(csvCell('+819012345678'), "'+819012345678");
    assert.equal(csvCell('-5%まで'), "'-5%まで");
    assert.equal(csvCell('@山田'), "'@山田");
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(12), '12');
  });

  it('BOM 付き・CRLF・見出し行つき', () => {
    const csv = toCsv({ name: 'x', columns: ['タイトル', '本文'], rows: [['a', 'b'], ['c', null]] });
    assert.equal(csv, '﻿タイトル,本文\r\na,b\r\nc,\r\n');
  });

  it('JSON は列名を鍵にした配列', () => {
    const j = JSON.parse(toJson({ name: 'x', columns: ['タイトル', '本文'], rows: [['a', null]] }, new Date('2026-11-15T00:00:00Z')));
    assert.deepEqual(j, { name: 'x', exportedAt: '2026-11-15T00:00:00.000Z', count: 1, rows: [{ タイトル: 'a', 本文: null }] });
  });
});

describe('書き出し', () => {
  let db: TestDatabase;
  let app: (req: Request) => Promise<Response>;
  let k = '';
  before(async () => {
    db = await freshDatabase();
    app = createApp({ database: db, auth: new DevHeaderAuthenticator(), tokenizer, limiter: new MemoryRateLimiter() });
    await db.withTenant(T, async (q) => {
      k = (await createKnowledge(q, tokenizer, trusted, { storeId: STORE_A, title: '領収書の宛名', body: '=メモを見て打つ\n聞き取りで打たない', tagNames: ['レジ', '領収書'] })).id;
      await createKnowledge(q, tokenizer, hq, { storeId: null, title: 'ポイントカードの再発行', body: '本人確認のうえ即日', tagNames: ['レジ'] });
      await createKnowledge(q, tokenizer, visitor, { storeId: STORE_A, title: '承認待ちは出ない', body: 'まだ', tagNames: ['レジ'] });
      await addBookmark(q, visitor, k);
      await q.query(`INSERT INTO search_logs (tenant_id, store_id, user_id, query, result_count, opened_knowledge_id) VALUES ($1, $2, $3, '領収書 宛名', 1, $4)`, [T, STORE_A, visitor.userId, k]);
      await q.query(`INSERT INTO search_logs (tenant_id, store_id, user_id, query, result_count) VALUES ($1, $2, $3, 'ふるさと納税 領収書', 0)`, [T, STORE_A, visitor.userId]);
    });
  });
  after(async () => { await db.close(); });

  const get = (userId: string, path: string) => app(new Request(`http://app.example${path}`, { headers: { 'x-dev-tenant-id': T, 'x-dev-user-id': userId } }));

  it('出せるのは本部だけ（店長でも出せない）', async () => {
    await db.withTenant(T, async (q) => {
      await assert.rejects(exportTable(q, manager, 'knowledge'), /本部/);
      await assert.rejects(exportTable(q, trusted, 'searches'), /本部/);
    });
    assert.equal((await get(manager.userId, '/exports/knowledge')).status, 403);
    assert.equal((await get(hq.userId, '/exports/nothing')).status, 404);
    assert.equal((await get(hq.userId, '/exports/knowledge?format=xml')).status, 400);
  });

  it('ナレッジ：公開中だけ。全店共通も入る。ブックマークの数は出ない', async () => {
    await db.withTenant(T, async (q) => {
      const t = await exportTable(q, hq, 'knowledge');
      assert.deepEqual(t.columns.slice(0, 5), ['ID', '店舗', 'タイトル', '本文', 'タグ']);
      assert.ok(!t.columns.some((c) => c.includes('ブックマーク')));
      const byTitle = Object.fromEntries(t.rows.map((r) => [r[2], r]));
      assert.deepEqual(Object.keys(byTitle).sort(), ['ポイントカードの再発行', '領収書の宛名'].sort());
      const row = byTitle['領収書の宛名']!;
      assert.equal(row[0], k);
      assert.equal(row[1], '本店');
      assert.equal(row[4], '#レジ #領収書');
      assert.equal(row[5], 'ベテランパート');
      assert.match(String(row[6]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(row[t.columns.indexOf('検索から開かれた回数')], 1);
      assert.equal(byTitle['ポイントカードの再発行']![1], '全店共通');
    });
  });

  it('検索の記録：だれが探したかは出ない。見つからなかったものに印が付く', async () => {
    await db.withTenant(T, async (q) => {
      const t = await exportTable(q, hq, 'searches');
      assert.ok(!t.columns.some((c) => /人|利用者|ユーザー/.test(c)));
      assert.ok(!JSON.stringify(t.rows).includes('新人バイト'));
      const miss = t.rows.find((r) => r[2] === 'ふるさと納税 領収書')!;
      assert.deepEqual([miss[1], miss[3], miss[4], miss[5]], ['本店', 0, 1, null]);
      const hit = t.rows.find((r) => r[2] === '領収書 宛名')!;
      assert.deepEqual([hit[3], hit[4], hit[5]], [1, 0, '領収書の宛名']);
    });
  });

  it('タグ：付いている数と、探された回数', async () => {
    await db.withTenant(T, async (q) => {
      const t = await exportTable(q, hq, 'tags');
      const receipt = t.rows.find((r) => r[0] === '#領収書')!;
      assert.deepEqual([receipt[2], receipt[3], receipt[4]], [1, 2, 1]);
      assert.equal(t.rows.find((r) => r[0] === '#レジ')![2], 2);
    });
  });

  it('API：CSV はダウンロードとして返り、数式は無害にしてある。JSON も選べる', async () => {
    const res = await get(hq.userId, '/exports/knowledge');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="knowledge_\d{4}-\d{2}-\d{2}\.csv"; filename\*=UTF-8''%E3%83%8A/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'BOM が付いている（Excel が UTF-8 と分かる）');
    const body = new TextDecoder().decode(bytes);
    assert.ok(body.includes(`"'=メモを見て打つ\n聞き取りで打たない"`));
    const json = await (await get(hq.userId, '/exports/searches?format=json&days=30')).json() as { count: number; rows: Array<Record<string, unknown>> };
    assert.equal(json.count, 2);
    assert.ok('検索した言葉' in json.rows[0]!);
  });
});
