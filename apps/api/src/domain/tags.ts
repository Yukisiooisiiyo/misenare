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
import { assert, canAccessStore, isTrusted, type Actor } from './actor.ts';

interface TagRow { id: string; name: string; readings: string[]; use_count: number; state: string }

// 辞書のプロセス内キャッシュ。
// 検索のたびに hashtags の active 全件と tag_relations の approved 全件を読んで作り直すと、
// タグが増えるほど検索が遅くなる（5,000件で 15ms → 45ms）。辞書は書き換わることが少ないので覚えておく。
// 1台・単一プロセスなので、プロセス内で持てばよい。台を増やすときはここを外に出す
// （他の台の書き換えが見えなくなるので、共有のキャッシュか、版番号の確認が要る）。
const DICTIONARY_TTL_MS = 30_000;
interface CachedDictionary { dictionary: TagDictionary; builtAt: number }
const dictionaryCache = new Map<string, CachedDictionary>();
// 作っている最中に書き換えが入ったら、その結果は古いので覚えない（invalidate のたびに進める）
const dictionaryGeneration = new Map<string, number>();

/** そのテナントの辞書を捨てる。タグや関係を書き換えたら、その最後で呼ぶ。 */
export function invalidateDictionary(tenantId: string): void {
  dictionaryCache.delete(tenantId);
  dictionaryGeneration.set(tenantId, (dictionaryGeneration.get(tenantId) ?? 0) + 1);
}

/** 全テナントの辞書を捨てる。スキーマごと作り直すテスト用。 */
export function clearDictionaryCache(): void {
  dictionaryCache.clear();
  dictionaryGeneration.clear();
}

/**
 * 検索・候補表示に使う辞書。active なタグと approved な関係だけを含む。
 * 同じテナントは 30 秒は作り直さない。別プロセスの夜間バッチが読みを埋めた分は、この期限で拾う。
 */
export async function loadDictionary(db: Db, tenantId: string): Promise<TagDictionary> {
  const hit = dictionaryCache.get(tenantId);
  if (hit && Date.now() - hit.builtAt < DICTIONARY_TTL_MS) return hit.dictionary;
  const generation = dictionaryGeneration.get(tenantId) ?? 0;
  const tags = await db.query<TagRow>(
    `SELECT id, name, readings, use_count, state FROM hashtags WHERE state = 'active'`,
  );
  const rels = await db.query<{ kind: TagRelation['kind']; from_tag_id: string | null; from_text: string | null; to_tag_id: string }>(
    `SELECT kind, from_tag_id, from_text, to_tag_id FROM tag_relations WHERE state = 'approved'`,
  );
  const entries: TagEntry[] = tags.map((t) => ({ id: t.id, name: t.name, readings: t.readings ?? [], useCount: t.use_count }));
  const relations: TagRelation[] = rels.map((r) =>
    r.kind === 'alias'
      ? { kind: 'alias', fromText: r.from_text!, toTagId: r.to_tag_id }
      : { kind: r.kind, fromTagId: r.from_tag_id!, toTagId: r.to_tag_id },
  );
  const dictionary = new TagDictionary(entries, relations);
  if ((dictionaryGeneration.get(tenantId) ?? 0) === generation) dictionaryCache.set(tenantId, { dictionary, builtAt: Date.now() });
  return dictionary;
}

/**
 * タグ名の配列をタグIDにする。無いタグは作る。
 * trusted は active で、visitor は pending（承認されるまで辞書には入らない）で作る。
 * 統合済み（merged）のタグ名を指定された場合は統合先を返す。
 */
export async function resolveTags(db: Db, actor: Actor, names: string[]): Promise<string[]> {
  const normalized = [...new Set(names.map(normalizeTagName).filter((n) => n.length > 0))];
  assert(normalized.every((n) => [...n].length <= 30), 'invalid', 'タグは30文字以内にしてください');
  // 名前の解決は1本にまとめる（タグ数ぶん発行していた）。統合先への置き換えも全 id を1回で引く
  const found = normalized.length === 0
    ? []
    : await db.query<{ id: string; name: string }>(`SELECT id, name FROM hashtags WHERE name = ANY($1::text[])`, [normalized]);
  const idByName = new Map(found.map((r) => [r.name, r.id]));
  const canonical = await canonicalTagMap(db, [...idByName.values()]);
  const ids: string[] = [];
  let created = false;
  for (const name of normalized) {
    const existingId = idByName.get(name);
    if (existingId !== undefined) {
      const target = canonical.get(existingId);
      if (target !== undefined) ids.push(target);
      continue;
    }
    const row = await db.query<{ id: string }>(
      `INSERT INTO hashtags (tenant_id, name, state, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [actor.tenantId, name, isTrusted(actor) ? 'active' : 'pending', actor.userId],
    );
    ids.push(row[0]!.id);
    created = true;
  }
  // 新しいタグは辞書に載るので、覚えてある辞書は捨てる（この後の索引づくりが新しいタグを引けるように）
  if (created) invalidateDictionary(actor.tenantId);
  return [...new Set(ids)];
}

/**
 * 統合（merged）されたタグを、最終的な統合先に置き換える（A→B→C なら C）。
 * 循環していても止まるよう、たどるのは最大10段まで。
 */
export async function canonicalTagIds(db: Db, tagIds: string[]): Promise<string[]> {
  const map = await canonicalTagMap(db, tagIds);
  return [...new Set(tagIds.flatMap((id) => (map.has(id) ? [map.get(id)!] : [])))];
}

/** 各 id の統合先を、再帰 CTE 1本でまとめて引く（id → 統合先。存在しない id は入らない）。 */
async function canonicalTagMap(db: Db, tagIds: string[]): Promise<Map<string, string>> {
  if (tagIds.length === 0) return new Map();
  const rows = await db.query<{ id: string; target: string }>(
    `WITH RECURSIVE chain(start, id, merged_into, depth) AS (
       SELECT h.id, h.id, h.merged_into, 0 FROM hashtags h WHERE h.id = ANY($1::uuid[])
       UNION ALL
       SELECT c.start, h.id, h.merged_into, c.depth + 1
         FROM chain c JOIN hashtags h ON h.id = c.merged_into
        WHERE c.depth < 10
     )
     SELECT DISTINCT ON (start) start AS id, id AS target FROM chain ORDER BY start, depth DESC`,
    [tagIds],
  );
  return new Map(rows.map((r) => [r.id, r.target]));
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
  const rows = await db.query<{ tenant_id: string }>(
    `UPDATE hashtags SET state = 'active' WHERE id = ANY($1::uuid[]) AND state = 'pending' RETURNING tenant_id`,
    [tagIds],
  );
  // active になったタグは辞書に入る。テナントは RETURNING から取る（引数に持たず、SQL も増やさない）
  for (const t of new Set(rows.map((r) => r.tenant_id))) invalidateDictionary(t);
}

/**
 * 端末に同期するタグ辞書。候補表示と「もしかして」は端末内で計算する。
 * 店舗の範囲に絞る：その店舗から見えるナレッジ（自店舗＋全店共通の公開中）と、有効な商品に付いたタグだけを返す。
 * 他店舗だけで使われているタグ名や、その使われ方（共起）は返さない。
 * 使用回数と共起（NPMI）も、この範囲のナレッジだけで数える。
 */
export async function exportDictionary(db: Db, actor: Actor, storeId: string) {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗の辞書は取得できません');
  const VISIBLE = `
    SELECT kt.knowledge_id, kt.hashtag_id FROM knowledge_tags kt
      JOIN knowledge k ON k.id = kt.knowledge_id
     WHERE k.status = 'published' AND (k.scope = 'tenant' OR k.store_id = $1)`;
  const tags = await db.query<{ id: string; name: string; readings: string[]; n: number }>(
    `WITH v AS (${VISIBLE}),
          used AS (
            SELECT hashtag_id, count(*)::int AS n FROM v GROUP BY hashtag_id
            UNION ALL
            SELECT pt.hashtag_id, 0 FROM product_tags pt JOIN products p ON p.id = pt.product_id WHERE p.state = 'active'
          )
     SELECT h.id, h.name, h.readings, max(u.n)::int AS n
       FROM used u JOIN hashtags h ON h.id = u.hashtag_id
      WHERE h.state = 'active'
      GROUP BY h.id, h.name, h.readings
      ORDER BY n DESC, h.name`,
    [storeId],
  );
  const visibleIds = tags.map((t) => t.id);
  const relations = await db.query(
    `SELECT kind, from_tag_id, from_text, to_tag_id FROM tag_relations
      WHERE state = 'approved' AND to_tag_id = ANY($1::uuid[])
        AND (from_tag_id IS NULL OR from_tag_id = ANY($1::uuid[]))`,
    [visibleIds],
  );
  const total = (await db.query<{ n: number }>(
    `WITH v AS (${VISIBLE}) SELECT count(DISTINCT knowledge_id)::int AS n FROM v`, [storeId],
  ))[0]!.n;
  const pairs = await db.query<{ a: string; b: string; n: number }>(
    `WITH v AS (${VISIBLE})
     SELECT x.hashtag_id AS a, y.hashtag_id AS b, count(*)::int AS n
       FROM v x JOIN v y ON x.knowledge_id = y.knowledge_id AND x.hashtag_id < y.hashtag_id
      GROUP BY 1, 2`,
    [storeId],
  );
  const npmi = computeNpmi(
    total,
    new Map(tags.map((t) => [t.id, t.n])),
    new Map(pairs.map((p) => [pairKey(p.a, p.b), p.n])),
  );
  return {
    storeId,
    tags: tags.map((t) => ({ id: t.id, name: t.name, readings: t.readings ?? [], useCount: t.n })),
    relations,
    cooccurrence: Object.fromEntries([...npmi].filter(([, v]) => v > 0).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
  };
}
