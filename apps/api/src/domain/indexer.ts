// 公開中の版を検索索引（postings / knowledge_stats / knowledge_tags）に反映する。

import { analyzeDocument, FIELDS, type Tokenizer } from '@misenare/search-core';
import type { Db } from '../db/db.ts';
import { canonicalTagIds, loadDictionary, refreshUseCounts } from './tags.ts';

interface PublishedRow { tenant_id: string; title: string; body: string; tag_ids: string[] }

/**
 * ナレッジ1件の索引を作り直す。公開中の版が無ければ索引から外す。
 * 投稿・編集・承認・戻しのたびに呼ぶ。タグ辞書が変わったときは reindexAll（夜間バッチ）で全件やり直す。
 */
export async function indexKnowledge(db: Db, tokenizer: Tokenizer, knowledgeId: string): Promise<void> {
  const before = await db.query<{ hashtag_id: string }>(
    `SELECT hashtag_id FROM knowledge_tags WHERE knowledge_id = $1`,
    [knowledgeId],
  );
  await db.query(`DELETE FROM postings WHERE knowledge_id = $1`, [knowledgeId]);
  await db.query(`DELETE FROM knowledge_stats WHERE knowledge_id = $1`, [knowledgeId]);
  await db.query(`DELETE FROM knowledge_tags WHERE knowledge_id = $1`, [knowledgeId]);

  const rows = await db.query<PublishedRow>(
    `SELECT k.tenant_id, v.title, v.body, v.tag_ids
       FROM knowledge k
       JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version
      WHERE k.id = $1 AND k.status = 'published' AND v.state = 'published'`,
    [knowledgeId],
  );
  const doc = rows[0];
  if (!doc) {
    await refreshUseCounts(db, before.map((r) => r.hashtag_id));
    return;
  }

  // 統合されたタグは統合先に置き換え、有効なタグだけを索引に載せる（承認待ちのタグは載せない）
  const tagRows = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM hashtags WHERE id = ANY($1::uuid[]) AND state = 'active'`,
    [await canonicalTagIds(db, doc.tag_ids)],
  );
  const dictionary = await loadDictionary(db);
  const analyzed = analyzeDocument(
    { title: doc.title, body: doc.body, tagNames: tagRows.map((t) => t.name) },
    { tokenizer, dictionary },
  );

  const terms: string[] = [];
  const fields: string[] = [];
  const tfs: number[] = [];
  for (const f of FIELDS) {
    for (const [term, tf] of analyzed.tf[f]) {
      terms.push(term);
      fields.push(f);
      tfs.push(tf);
    }
  }
  if (terms.length > 0) {
    await db.query(
      `INSERT INTO postings (tenant_id, knowledge_id, field, term, tf)
       SELECT $1, $2, f, t, n FROM unnest($3::text[], $4::text[], $5::int[]) AS u(f, t, n)`,
      [doc.tenant_id, knowledgeId, fields, terms, tfs],
    );
  }
  await db.query(
    `INSERT INTO knowledge_stats (tenant_id, knowledge_id, tag_len, title_len, body_len) VALUES ($1, $2, $3, $4, $5)`,
    [doc.tenant_id, knowledgeId, analyzed.length.tag, analyzed.length.title, analyzed.length.body],
  );
  if (tagRows.length > 0) {
    await db.query(
      `INSERT INTO knowledge_tags (tenant_id, knowledge_id, hashtag_id) SELECT $1, $2, unnest($3::uuid[])`,
      [doc.tenant_id, knowledgeId, tagRows.map((t) => t.id)],
    );
  }
  await refreshUseCounts(db, [...new Set([...before.map((r) => r.hashtag_id), ...tagRows.map((t) => t.id)])]);
}

/** テナント内の公開ナレッジをすべて索引し直す（タグ辞書が変わった夜に実行）。 */
export async function reindexAll(db: Db, tokenizer: Tokenizer): Promise<number> {
  const ids = await db.query<{ id: string }>(`SELECT id FROM knowledge WHERE status = 'published'`);
  for (const { id } of ids) await indexKnowledge(db, tokenizer, id);
  return ids.length;
}
