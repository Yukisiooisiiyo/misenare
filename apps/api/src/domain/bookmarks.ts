// ブックマーク。役に立ったナレッジに、自分用の印を付ける。
//
// ・付けられるのは、そのナレッジを読める人。自分が書いたものには付けられない
// ・だれが付けたかは、だれにも見せない。いくつ付いたかは**書いた本人にだけ**見せる
//   （全員に見せると人気投票になり、数の少ないナレッジを書いた人が書かなくなる）

import { maybeOne, one, type Db } from '../db/db.ts';
import { assert, canAccessStore, type Actor } from './actor.ts';
import { assertStore } from './scope.ts';

async function target(db: Db, actor: Actor, knowledgeId: string) {
  const k = await maybeOne<{ store_id: string | null; status: string; created_by: string }>(
    db, `SELECT store_id, status, created_by FROM knowledge WHERE id = $1`, [knowledgeId],
  );
  assert(k !== undefined, 'not_found', 'ナレッジが見つかりません');
  assert(canAccessStore(actor, k.store_id), 'forbidden', 'このナレッジは閲覧できません');
  return k;
}

export async function addBookmark(db: Db, actor: Actor, knowledgeId: string): Promise<{ bookmarked: true }> {
  const k = await target(db, actor, knowledgeId);
  assert(k.status === 'published', 'conflict', '公開中のナレッジにだけ付けられます');
  assert(k.created_by !== actor.userId, 'invalid', '自分が書いたナレッジには付けられません');
  await db.query(
    `INSERT INTO knowledge_bookmarks (tenant_id, knowledge_id, user_id) VALUES ($1, $2, $3)
     ON CONFLICT (knowledge_id, user_id) DO NOTHING`,
    [actor.tenantId, knowledgeId, actor.userId],
  );
  return { bookmarked: true };
}

export async function removeBookmark(db: Db, actor: Actor, knowledgeId: string): Promise<{ bookmarked: false }> {
  await db.query(`DELETE FROM knowledge_bookmarks WHERE knowledge_id = $1 AND user_id = $2`, [knowledgeId, actor.userId]);
  return { bookmarked: false };
}

/** 詳細画面に添える状態。count は書いた本人にだけ返す（ほかの人には項目ごと出さない） */
export async function bookmarkState(db: Db, actor: Actor, knowledgeId: string, createdBy: string): Promise<{ bookmarked: boolean; canBookmark: boolean; bookmarkCount?: number }> {
  const mine = createdBy === actor.userId;
  if (mine) {
    const c = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM knowledge_bookmarks WHERE knowledge_id = $1`, [knowledgeId]);
    return { bookmarked: false, canBookmark: false, bookmarkCount: Number(c.n) };
  }
  const hit = await maybeOne(db, `SELECT 1 FROM knowledge_bookmarks WHERE knowledge_id = $1 AND user_id = $2`, [knowledgeId, actor.userId]);
  return { bookmarked: hit !== undefined, canBookmark: true };
}

export interface BookmarkItem { id: string; title: string; tags: string[]; bookmarkedAt: string }

/** 自分のブックマーク（新しい順）。いまの店舗で読めるもの＝その店舗のものと全店共通のもの、公開中だけ */
export async function listBookmarks(db: Db, actor: Actor, storeId: string): Promise<BookmarkItem[]> {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗は見られません');
  await assertStore(db, storeId);
  const rows = await db.query<{ id: string; title: string; tags: string[] | null; bookmarked_at: string }>(
    `SELECT k.id, v.title, b.created_at::text AS bookmarked_at,
            (SELECT array_agg(t.name ORDER BY array_position(v.tag_ids, t.id)) FROM hashtags t WHERE t.id = ANY(v.tag_ids)) AS tags
       FROM knowledge_bookmarks b
       JOIN knowledge k ON k.id = b.knowledge_id
       JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version
      WHERE b.user_id = $1 AND k.status = 'published' AND (k.store_id = $2 OR k.store_id IS NULL)
      ORDER BY b.created_at DESC
      LIMIT 100`,
    [actor.userId, storeId],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, tags: r.tags ?? [], bookmarkedAt: r.bookmarked_at }));
}
