// 検索。対象はその店舗のナレッジと全店共通のナレッジのうち、公開中で期限切れでないもの。
// 索引（postings）から候補と統計を取り、採点は search-core の BM25F で行う。

import {
  analyzeQuery,
  rank,
  type CandidateDoc,
  type CorpusStats,
  type Field,
  type QueryGroup,
  type Tokenizer,
} from '@misenare/search-core';
import type { Db } from '../db/db.ts';
import { assert, canAccessStore, canModerate, type Actor } from './actor.ts';
import { loadDictionary } from './tags.ts';

export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
  tags: string[];
  score: number;
  matchedTerms: string[];
  verifiedAt: string | null;
  verifiedBy: string | null;
}

export interface SearchResult {
  hits: SearchHit[];
  /** 結果に付いているタグ（件数付き）。絞り込みチップに使う */
  chips: Array<{ name: string; count: number }>;
  /** 検索ログのID。結果を開いたら openedResult に渡す */
  logId: number;
}

/** 検索対象のナレッジ（公開中・期限内・この店舗または全店共通） */
const SCOPE = `
  SELECT k.id FROM knowledge k
   WHERE k.status = 'published'
     AND (k.expires_at IS NULL OR k.expires_at > now())
     AND (k.scope = 'tenant' OR k.store_id = $1)`;

/** 検索語のまとまりで採点し、上位を返す。商品からの検索でも使う。 */
export async function rankByGroups(
  db: Db,
  storeId: string,
  groups: QueryGroup[],
  options: { limit?: number; excludeIds?: string[] } = {},
) {
  const terms = [...new Set(groups.flatMap((g) => [...g.keys()]))];
  if (terms.length === 0) return [];

  const statsRow = (await db.query<{ n: number; tag: number | null; title: number | null; body: number | null }>(
    `WITH scope AS (${SCOPE})
     SELECT count(*)::int AS n, avg(s.tag_len)::float AS tag, avg(s.title_len)::float AS title, avg(s.body_len)::float AS body
       FROM knowledge_stats s JOIN scope ON scope.id = s.knowledge_id`,
    [storeId],
  ))[0]!;
  if (statsRow.n === 0) return [];

  const dfRows = await db.query<{ term: string; df: number }>(
    `WITH scope AS (${SCOPE})
     SELECT p.term, count(DISTINCT p.knowledge_id)::int AS df
       FROM postings p JOIN scope ON scope.id = p.knowledge_id
      WHERE p.term = ANY($2::text[])
      GROUP BY p.term`,
    [storeId, terms],
  );
  const postings = await db.query<{ knowledge_id: string; field: Field; term: string; tf: number }>(
    `WITH scope AS (${SCOPE})
     SELECT p.knowledge_id, p.field, p.term, p.tf
       FROM postings p JOIN scope ON scope.id = p.knowledge_id
      WHERE p.term = ANY($2::text[])`,
    [storeId, terms],
  );
  const ids = [...new Set(postings.map((p) => p.knowledge_id))].filter((id) => !options.excludeIds?.includes(id));
  if (ids.length === 0) return [];

  const lengthRows = await db.query<{ knowledge_id: string; tag_len: number; title_len: number; body_len: number; verified_at: string | null }>(
    `SELECT s.knowledge_id, s.tag_len, s.title_len, s.body_len, k.verified_at
       FROM knowledge_stats s JOIN knowledge k ON k.id = s.knowledge_id
      WHERE s.knowledge_id = ANY($1::uuid[])`,
    [ids],
  );
  const candidates = new Map<string, CandidateDoc>();
  const verifiedAt = new Map<string, string>();
  for (const r of lengthRows) {
    candidates.set(r.knowledge_id, {
      id: r.knowledge_id,
      length: { tag: r.tag_len, title: r.title_len, body: r.body_len },
      tf: new Map(),
    });
    verifiedAt.set(r.knowledge_id, r.verified_at ?? '');
  }
  for (const p of postings) {
    const c = candidates.get(p.knowledge_id);
    if (!c) continue;
    const tf = c.tf as Map<string, Partial<Record<Field, number>>>;
    tf.set(p.term, { ...tf.get(p.term), [p.field]: p.tf });
  }
  const stats: CorpusStats = {
    docCount: statsRow.n,
    avgLength: { tag: statsRow.tag ?? 0, title: statsRow.title ?? 0, body: statsRow.body ?? 0 },
    df: new Map(dfRows.map((r) => [r.term, r.df])),
  };
  // 同点なら最終確認日の新しい順
  const tieBreak = (a: string, b: string) => (verifiedAt.get(b) ?? '').localeCompare(verifiedAt.get(a) ?? '');
  return rank(groups, candidates.values(), stats, { tieBreak, ...(options.limit !== undefined ? { limit: options.limit } : {}) });
}

/** 検索結果の表示用の情報（タイトル・抜粋・タグ・確認日）を付ける */
export async function describeHits(db: Db, ranked: Array<{ id: string; score: number; matchedTerms: string[] }>): Promise<SearchHit[]> {
  if (ranked.length === 0) return [];
  const rows = await db.query<{ id: string; title: string; body: string; verified_at: string | null; verified_by: string | null; tags: string[] }>(
    `SELECT k.id, v.title, v.body, k.verified_at, u.name AS verified_by,
            coalesce(array_agg(h.name ORDER BY h.use_count DESC) FILTER (WHERE h.id IS NOT NULL), '{}') AS tags
       FROM knowledge k
       JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version
       LEFT JOIN users u ON u.id = k.verified_by
       LEFT JOIN knowledge_tags kt ON kt.knowledge_id = k.id
       LEFT JOIN hashtags h ON h.id = kt.hashtag_id
      WHERE k.id = ANY($1::uuid[])
      GROUP BY k.id, v.title, v.body, k.verified_at, u.name`,
    [ranked.map((r) => r.id)],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ranked.flatMap((r) => {
    const row = byId.get(r.id);
    if (!row) return [];
    return [{
      id: r.id,
      title: row.title,
      snippet: row.body.replace(/\s+/g, ' ').slice(0, 80),
      tags: row.tags,
      score: Math.round(r.score * 1000) / 1000,
      matchedTerms: r.matchedTerms,
      verifiedAt: row.verified_at,
      verifiedBy: row.verified_by,
    }];
  });
}

export async function search(
  db: Db,
  tokenizer: Tokenizer,
  actor: Actor,
  storeId: string,
  query: string,
  options: { limit?: number } = {},
): Promise<SearchResult> {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗のナレッジは検索できません');
  assert(query.trim().length > 0 && query.length <= 200, 'invalid', '検索語は1〜200文字で入力してください');
  const dictionary = await loadDictionary(db);
  const analyzed = analyzeQuery(query, { tokenizer, dictionary });
  const ranked = await rankByGroups(db, storeId, analyzed.groups, { limit: options.limit ?? 20 });
  const hits = await describeHits(db, ranked);

  const counts = new Map<string, number>();
  for (const h of hits) for (const t of h.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const queried = new Set(analyzed.matchedTagIds.map((id) => dictionary.tags.get(id)!.name));
  const chips = [...counts]
    .filter(([name]) => !queried.has(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  const log = await db.query<{ id: number }>(
    `INSERT INTO search_logs (tenant_id, store_id, user_id, query, result_count)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [actor.tenantId, storeId, actor.userId, query, hits.length],
  );
  return { hits, chips, logId: log[0]!.id };
}

/** 検索結果を開いた・「もしかして」で別のタグを選んだ、を記録する（辞書を育てる元データ） */
export async function recordSearchFeedback(
  db: Db,
  actor: Actor,
  logId: number,
  feedback: { openedKnowledgeId?: string; suggestedTagId?: string; pickedTagId?: string },
) {
  await db.query(
    `UPDATE search_logs SET
        opened_knowledge_id = coalesce($3, opened_knowledge_id),
        suggested_tag_id    = coalesce($4, suggested_tag_id),
        picked_tag_id       = coalesce($5, picked_tag_id)
      WHERE id = $1 AND user_id = $2`,
    [logId, actor.userId, feedback.openedKnowledgeId ?? null, feedback.suggestedTagId ?? null, feedback.pickedTagId ?? null],
  );
}

/** 0件だった検索ワード（店長が見て、ナレッジや別名を足す） */
export async function zeroHitQueries(db: Db, actor: Actor, storeId: string, days = 30) {
  assert(canModerate(actor, storeId), 'forbidden', '0件ワードを見る権限がありません');
  return db.query<{ query: string; times: number; last_at: string }>(
    `SELECT query, count(*)::int AS times, max(created_at) AS last_at
       FROM search_logs
      WHERE store_id = $1 AND result_count = 0 AND created_at > now() - make_interval(days => $2)
      GROUP BY query ORDER BY times DESC, last_at DESC LIMIT 100`,
    [storeId, days],
  );
}
