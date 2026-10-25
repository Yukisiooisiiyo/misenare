// ハッシュタグの解決・作成と、タグ辞書の読み込み。

import {
  computeNpmi,
  normalizeTagName,
  pairKey,
  TagDictionary,
  type TagEntry,
  type TagRelation,
} from '@misenare/search-core';
import type { Db } from '../db/db.ts';
import { assert, isTrusted, type Actor } from './actor.ts';

interface TagRow { id: string; name: string; reading: string | null; use_count: number; state: string }

/** 検索・候補表示に使う辞書。active なタグと approved な関係だけを含む。 */
export async function loadDictionary(db: Db): Promise<TagDictionary> {
  const tags = await db.query<TagRow>(
    `SELECT id, name, reading, use_count, state FROM hashtags WHERE state = 'active'`,
  );
  const rels = await db.query<{ kind: TagRelation['kind']; from_tag_id: string | null; from_text: string | null; to_tag_id: string }>(
    `SELECT kind, from_tag_id, from_text, to_tag_id FROM tag_relations WHERE state = 'approved'`,
  );
  const entries: TagEntry[] = tags.map((t) => ({ id: t.id, name: t.name, reading: t.reading, useCount: t.use_count }));
  const relations: TagRelation[] = rels.map((r) =>
    r.kind === 'alias'
      ? { kind: 'alias', fromText: r.from_text!, toTagId: r.to_tag_id }
      : { kind: r.kind, fromTagId: r.from_tag_id!, toTagId: r.to_tag_id },
  );
  return new TagDictionary(entries, relations);
}

/**
 * タグ名の配列をタグIDにする。無いタグは作る。
 * trusted は active で、visitor は pending（承認されるまで辞書には入らない）で作る。
 * 統合済み（merged）のタグ名を指定された場合は統合先を返す。
 */
export async function resolveTags(db: Db, actor: Actor, names: string[]): Promise<string[]> {
  const normalized = [...new Set(names.map(normalizeTagName).filter((n) => n.length > 0))];
  assert(normalized.every((n) => [...n].length <= 30), 'invalid', 'タグは30文字以内にしてください');
  const ids: string[] = [];
  for (const name of normalized) {
    const existing = await db.query<{ id: string; state: string; merged_into: string | null }>(
      `SELECT id, state, merged_into FROM hashtags WHERE name = $1`,
      [name],
    );
    const row = existing[0];
    if (row) {
      ids.push(row.state === 'merged' && row.merged_into ? row.merged_into : row.id);
      continue;
    }
    const created = await db.query<{ id: string }>(
      `INSERT INTO hashtags (tenant_id, name, state, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [actor.tenantId, name, isTrusted(actor) ? 'active' : 'pending', actor.userId],
    );
    ids.push(created[0]!.id);
  }
  return [...new Set(ids)];
}

/** タグの使用回数（ナレッジ＋商品）を数え直す。 */
export async function refreshUseCounts(db: Db, tagIds: string[]): Promise<void> {
  if (tagIds.length === 0) return;
  await db.query(
    `UPDATE hashtags h SET use_count =
       (SELECT count(*) FROM knowledge_tags kt WHERE kt.hashtag_id = h.id) +
       (SELECT count(*) FROM product_tags pt WHERE pt.hashtag_id = h.id)
     WHERE h.id = ANY($1::uuid[])`,
    [tagIds],
  );
}

/** 承認待ちのタグを有効にする（ナレッジや商品の承認と一緒に行う）。 */
export async function activateTags(db: Db, tagIds: string[]): Promise<void> {
  if (tagIds.length === 0) return;
  await db.query(`UPDATE hashtags SET state = 'active' WHERE id = ANY($1::uuid[]) AND state = 'pending'`, [tagIds]);
}

/**
 * 端末に同期するタグ辞書。タグ・承認済みの関係・共起スコアを返し、候補表示は端末内で行う。
 * 共起は「同じナレッジに一緒に付いた」回数から NPMI で計算する。
 */
export async function exportDictionary(db: Db) {
  const tags = await db.query<TagRow>(
    `SELECT id, name, reading, use_count, state FROM hashtags WHERE state = 'active' ORDER BY use_count DESC`,
  );
  const relations = await db.query(
    `SELECT kind, from_tag_id, from_text, to_tag_id FROM tag_relations WHERE state = 'approved'`,
  );
  const total = (await db.query<{ n: number }>(`SELECT count(DISTINCT knowledge_id)::int AS n FROM knowledge_tags`))[0]!.n;
  const perTag = await db.query<{ hashtag_id: string; n: number }>(
    `SELECT hashtag_id, count(*)::int AS n FROM knowledge_tags GROUP BY hashtag_id`,
  );
  const pairs = await db.query<{ a: string; b: string; n: number }>(
    `SELECT x.hashtag_id AS a, y.hashtag_id AS b, count(*)::int AS n
       FROM knowledge_tags x JOIN knowledge_tags y
         ON x.knowledge_id = y.knowledge_id AND x.hashtag_id < y.hashtag_id
      GROUP BY 1, 2`,
  );
  const npmi = computeNpmi(
    total,
    new Map(perTag.map((r) => [r.hashtag_id, r.n])),
    new Map(pairs.map((p) => [pairKey(p.a, p.b), p.n])),
  );
  return {
    tags: tags.map((t) => ({ id: t.id, name: t.name, reading: t.reading, useCount: t.use_count })),
    relations,
    cooccurrence: Object.fromEntries([...npmi].filter(([, v]) => v > 0).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
  };
}
