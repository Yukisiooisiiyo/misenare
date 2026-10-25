import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { runNightly, type CandidateProvider } from '../src/batch/nightly.ts';
import type { Db } from '../src/db/db.ts';
import { createKnowledge, listStale, verifyKnowledge } from '../src/domain/knowledge.ts';
import { search } from '../src/domain/search.ts';
import { listRelations } from '../src/domain/tagAdmin.ts';
import { exportDictionary } from '../src/domain/tags.ts';
import { suggestTags, TagDictionary } from '@misenare/search-core';
import { freshDatabase, STORE_A, T, tokenizer, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
const run = <R>(fn: (q: Db) => Promise<R>): Promise<R> => db.withTenant(T, fn);
const ids = (r: { hits: Array<{ id: string }> }) => r.hits.map((h) => h.id);

let campaignId: string;
let oldId: string;

before(async () => {
  db = await freshDatabase();
  campaignId = (await run((q) => createKnowledge(q, tokenizer, trusted, {
    storeId: STORE_A, title: '秋のポイント10倍キャンペーン', body: '対象は大型家電。', tagNames: ['#キャンペーン', '#エアコン'],
  }))).id;
  oldId = (await run((q) => createKnowledge(q, tokenizer, trusted, {
    storeId: STORE_A, title: '古い手順', body: '去年の内容。', tagNames: ['#クーラー'],
  }))).id;
});
after(async () => { await db.close(); });

describe('夜間バッチ', () => {
  it('期限切れのナレッジを expired にして索引から外す', async () => {
    assert.ok(ids(await run((q) => search(q, tokenizer, trusted, STORE_A, 'キャンペーン'))).includes(campaignId));
    await run((q) => q.query(`UPDATE knowledge SET expires_at = now() - interval '1 day' WHERE id = $1`, [campaignId]));
    const [report] = await runNightly(db, tokenizer);
    assert.equal(report!.expired, 1);
    const k = await run((q) => q.query<{ status: string }>(`SELECT status FROM knowledge WHERE id = $1`, [campaignId]));
    assert.equal(k[0]!.status, 'expired');
    const postings = await run((q) => q.query<{ n: number }>(`SELECT count(*)::int AS n FROM postings WHERE knowledge_id = $1`, [campaignId]));
    assert.equal(postings[0]!.n, 0);
  });

  it('「もしかして」で3回以上選ばれた組み合わせを、同義の候補にする（自動承認はしない）', async () => {
    const tag = (name: string) => run((q) => q.query<{ id: string }>(`SELECT id FROM hashtags WHERE name = $1`, [name])).then((r) => r[0]!.id);
    const ac = await tag('エアコン');
    const cooler = await tag('クーラー');
    for (let i = 0; i < 3; i++) {
      await run((q) => q.query(
        `INSERT INTO search_logs (tenant_id, store_id, user_id, query, result_count, suggested_tag_id, picked_tag_id)
         VALUES ($1, $2, $3, 'エアコン', 1, $4, $5)`,
        [T, STORE_A, visitor.userId, ac, cooler],
      ));
    }
    const [report] = await runNightly(db, tokenizer);
    assert.equal(report!.candidatesFromLogs, 1);
    const cands = await run((q) => listRelations(q, trusted, 'candidate'));
    assert.equal(cands.length, 1);
    assert.equal(cands[0]!.source, 'picked_log');
    assert.equal(cands[0]!.evidence, 3);
    // 2回目の実行で重複して作らない
    const [again] = await runNightly(db, tokenizer);
    assert.equal(again!.candidatesFromLogs, 0);
  });

  it('外部の候補提供元（辞書・単語ベクトル）の候補も取り込む', async () => {
    const provider: CandidateProvider = {
      name: 'dictionary',
      propose: async (tags) => {
        const byName = new Map(tags.map((t) => [t.name, t.id]));
        return byName.has('キャンペーン') && byName.has('エアコン')
          ? [{ kind: 'includes', fromTagId: byName.get('エアコン')!, toTagId: byName.get('キャンペーン')!, score: 0.42 }]
          : [];
      },
    };
    const [report] = await runNightly(db, tokenizer, { candidateProviders: [provider] });
    assert.equal(report!.candidatesFromProviders, 1);
  });

  it('読みを返せるトークナイザーなら、タグに読みを付け、かなで漢字のタグが引ける', async () => {
    const readings: Record<string, string> = { キャンペーン: 'キャンペーン', エアコン: 'エアコン', クーラー: 'クーラー' };
    const withReading = Object.assign(Object.create(tokenizer), { reading: (w: string) => readings[w] ?? (w === '大型家電' ? 'オオガタカデン' : null) });
    await run((q) => createKnowledge(q, tokenizer, trusted, { storeId: STORE_A, title: '大型家電の配送', body: '2名で。', tagNames: ['#大型家電'] }));
    const [report] = await runNightly(db, withReading);
    assert.ok(report!.readingsFilled >= 1);
    const dict = await run((q) => exportDictionary(q, trusted, STORE_A));
    const local = new TagDictionary(dict.tags.map((t) => ({ id: t.id, name: t.name, reading: t.reading, useCount: t.useCount })));
    assert.equal(suggestTags({ input: 'おおがた', dictionary: local }).candidates[0]?.name, '大型家電');
  });

  it('半年以上確認されていないナレッジを見直しの一覧に出し、確認すると外れる', async () => {
    await run((q) => q.query(`UPDATE knowledge SET verified_at = now() - interval '200 days' WHERE id = $1`, [oldId]));
    const [report] = await runNightly(db, tokenizer);
    assert.equal(report!.staleKnowledge, 1);
    assert.deepEqual((await run((q) => listStale(q, trusted, STORE_A))).map((k) => k.id), [oldId]);
    await run((q) => verifyKnowledge(q, trusted, oldId));
    assert.equal((await run((q) => listStale(q, trusted, STORE_A))).length, 0);
  });
});
