import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { runNightly, type CandidateProvider } from '../src/batch/nightly.ts';
import type { Db } from '../src/db/db.ts';
import { createKnowledge, listStale, verifyKnowledge } from '../src/domain/knowledge.ts';
import { search } from '../src/domain/search.ts';
import { confirmReading, listReadingProposals, listRelations } from '../src/domain/tagAdmin.ts';
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

  it('読みは案として置かれ、人が確かめて初めてかなで引ける', async () => {
    const readings: Record<string, string> = { キャンペーン: 'キャンペーン', エアコン: 'エアコン', クーラー: 'クーラー' };
    const withReading = Object.assign(Object.create(tokenizer), { reading: (w: string) => readings[w] ?? (w === '大型家電' ? 'オオガタカデン' : null) });
    await run((q) => createKnowledge(q, tokenizer, trusted, { storeId: STORE_A, title: '大型家電の配送', body: '2名で。', tagNames: ['#大型家電'] }));
    const [report] = await runNightly(db, withReading);
    assert.ok(report!.readingsFilled >= 1);

    const localDict = async () => {
      const dict = await run((q) => exportDictionary(q, trusted, STORE_A));
      return new TagDictionary(dict.tags.map((t) => ({ id: t.id, name: t.name, reading: t.reading, useCount: t.useCount })));
    };

    // 機械の読みは外すことがあるので、確かめるまでは効かせない
    assert.equal(suggestTags({ input: 'おおがた', dictionary: await localDict() }).candidates.length, 0,
      '確かめていない読みが検索に効いている');

    const pending = await run((q) => listReadingProposals(q, trusted));
    const target = pending.find((p) => p.name === '大型家電');
    assert.ok(target, `確認待ちに出ない: ${pending.map((p) => p.name).join(',')}`);
    assert.equal(target.proposed, 'オオガタカデン');

    await run((q) => confirmReading(q, trusted, target.id, target.proposed));
    assert.equal(suggestTags({ input: 'おおがた', dictionary: await localDict() }).candidates[0]?.name, '大型家電');
  });

  it('カタカナ語は見出しと読みが同じなので、確かめずに入れてよい', async () => {
    const withReading = Object.assign(Object.create(tokenizer), { reading: (w: string) => (w === 'キャンペーン' ? 'キャンペーン' : null) });
    await run((q) => createKnowledge(q, tokenizer, trusted, { storeId: STORE_A, title: 'キャンペーンの案内', body: '今月末まで。', tagNames: ['#キャンペーン'] }));
    await runNightly(db, withReading);
    const pending = await run((q) => listReadingProposals(q, trusted));
    assert.ok(!pending.some((p) => p.name === 'キャンペーン'), '確かめるまでもない語が確認待ちに出ている');
    const row = await run((q) => q.query<{ reading: string | null }>(`SELECT reading FROM hashtags WHERE name = 'キャンペーン'`));
    assert.equal(row[0]?.reading, 'キャンペーン');
  });

  it('一定期間、更新も確認もされていないナレッジを見直しの一覧に出し、確認すると外れる', async () => {
    // 「更新も確認もされていない」状態にする（画面の注意書きと同じ見方）
    await run((q) => q.query(`UPDATE knowledge SET verified_at = now() - interval '200 days' WHERE id = $1`, [oldId]));
    await run((q) => q.query(`UPDATE knowledge_versions SET edited_at = now() - interval '200 days' WHERE knowledge_id = $1`, [oldId]));
    const [report] = await runNightly(db, tokenizer);
    assert.equal(report!.staleKnowledge, 1);
    assert.deepEqual((await run((q) => listStale(q, trusted, STORE_A))).map((k) => k.id), [oldId]);
    await run((q) => verifyKnowledge(q, trusted, oldId));
    assert.equal((await run((q) => listStale(q, trusted, STORE_A))).length, 0);
  });
});

describe('読みの案を出す条件', () => {
  /** 漢字1文字に割れる（＝辞書に無い複合語）のを真似たトークナイザー */
  const splitting = (reading: string) => Object.assign(Object.create(tokenizer), {
    reading: () => reading,
    guessReading: () => ({ reading, morphemes: 3, loneKanji: 3, loneKanjiFree: 3 }),
  });
  /** 辞書にそのまま載っている語を真似たもの */
  const whole = (reading: string) => Object.assign(Object.create(tokenizer), {
    reading: () => reading,
    guessReading: () => ({ reading, morphemes: 1, loneKanji: 0, loneKanjiFree: 0 }),
  });

  it('漢字1文字に割れた語は、案を出さずに空欄で確認に回す', async () => {
    await run((q) => createKnowledge(q, tokenizer, trusted, { storeId: STORE_A, title: '食洗機の設置', body: '据付は2人で。', tagNames: ['#食洗機'] }));
    await runNightly(db, splitting('ショクアライキ'));
    const pending = await run((q) => listReadingProposals(q, trusted));
    const target = pending.find((p) => p.name === '食洗機');
    assert.ok(target, '確認に回っていない');
    assert.equal(target.proposed, '', '信用できない読みを案として見せている');
  });

  it('辞書にそのまま載っている語は、案として見せる', async () => {
    await run((q) => createKnowledge(q, tokenizer, trusted, { storeId: STORE_A, title: '搬入の手順', body: '2人で。', tagNames: ['#搬入'] }));
    await runNightly(db, whole('ハンニュウ'));
    const pending = await run((q) => listReadingProposals(q, trusted));
    assert.equal(pending.find((p) => p.name === '搬入')?.proposed, 'ハンニュウ');
  });
});
