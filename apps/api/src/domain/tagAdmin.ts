// タグ辞書の管理：同義・包含・別名の関係の提案と承認、タグの統合。
//
// タグとその関係は会社（テナント）全体で共有するので、変更は全店舗の検索に効く。
//   関係の承認・却下 … trusted 以上（visitor の提案は候補として残る）
//   タグの統合       … administrator（店長・本部）

import { normalizeTagName, normalizeText, type Tokenizer } from '@misenare/search-core';
import { maybeOne, one, type Db } from '../db/db.ts';
import { assert, isTrusted, type Actor } from './actor.ts';
import { indexKnowledge } from './indexer.ts';
import { canonicalTagIds, refreshUseCounts } from './tags.ts';

export type RelationKind = 'synonym' | 'includes' | 'alias';
export interface RelationState { id: string; state: 'candidate' | 'approved' | 'rejected' }

export interface RelationInput {
  kind: RelationKind;
  /** synonym / includes の起点のタグ名 */
  fromTag?: string;
  /** alias の起点の単語（「映らない」など） */
  fromText?: string;
  /** 行き先のタグ名 */
  toTag: string;
}

async function activeTagId(db: Db, name: string): Promise<string> {
  const t = await maybeOne<{ id: string }>(db, `SELECT id FROM hashtags WHERE name = $1 AND state = 'active'`, [normalizeTagName(name)]);
  assert(t !== undefined, 'not_found', `タグ #${normalizeTagName(name)} が見つかりません`);
  return t.id;
}

/** 包含が循環しないか（A ⊃ B ⊃ A にならないか）を確かめる */
async function wouldCycle(db: Db, fromId: string, toId: string): Promise<boolean> {
  const r = await db.query(
    `WITH RECURSIVE down(id, depth) AS (
       SELECT $2::uuid, 0
       UNION
       SELECT r.to_tag_id, d.depth + 1 FROM tag_relations r JOIN down d ON r.from_tag_id = d.id
        WHERE r.kind = 'includes' AND r.state = 'approved' AND d.depth < 20
     )
     SELECT 1 FROM down WHERE id = $1::uuid LIMIT 1`,
    [fromId, toId],
  );
  return r.length > 0;
}

/** 関係を提案する。trusted 以上なら即承認、visitor なら候補。既にあれば根拠の件数だけ増やす。 */
export async function proposeRelation(db: Db, actor: Actor, input: RelationInput): Promise<RelationState> {
  const toId = await activeTagId(db, input.toTag);
  const approved = isTrusted(actor);
  if (input.kind === 'alias') {
    const text = normalizeText(input.fromText ?? '').replace(/\s+/g, '');
    assert(text.length > 0 && [...text].length <= 30, 'invalid', '別名は1〜30文字で入力してください');
    const existing = await maybeOne<{ id: string; state: string }>(
      db, `SELECT id, state FROM tag_relations WHERE kind = 'alias' AND from_text = $1 AND to_tag_id = $2`, [text, toId],
    );
    if (existing) return decideIfTrusted(db, actor, existing.id, existing.state);
    return one<RelationState>(db,
      `INSERT INTO tag_relations (tenant_id, kind, from_text, to_tag_id, state, source, evidence, approved_by)
       VALUES ($1, 'alias', $2, $3, $4, 'manual', 1, $5) RETURNING id, state`,
      [actor.tenantId, text, toId, approved ? 'approved' : 'candidate', approved ? actor.userId : null]);
  }

  assert(input.fromTag !== undefined, 'invalid', '起点のタグを指定してください');
  const fromId = await activeTagId(db, input.fromTag);
  assert(fromId !== toId, 'invalid', '同じタグどうしには関係を作れません');
  if (input.kind === 'includes') {
    assert(!(await wouldCycle(db, fromId, toId)), 'conflict', '包含関係が循環してしまいます');
  }
  // 同義は向きを持たないので、どちら向きでも既存があればそれを使う
  const existing = await maybeOne<{ id: string; state: string }>(
    db,
    input.kind === 'synonym'
      ? `SELECT id, state FROM tag_relations WHERE kind = 'synonym'
          AND ((from_tag_id = $1 AND to_tag_id = $2) OR (from_tag_id = $2 AND to_tag_id = $1))`
      : `SELECT id, state FROM tag_relations WHERE kind = 'includes' AND from_tag_id = $1 AND to_tag_id = $2`,
    [fromId, toId],
  );
  if (existing) return decideIfTrusted(db, actor, existing.id, existing.state);
  return one<RelationState>(db,
    `INSERT INTO tag_relations (tenant_id, kind, from_tag_id, to_tag_id, state, source, evidence, approved_by)
     VALUES ($1, $2, $3, $4, $5, 'manual', 1, $6) RETURNING id, state`,
    [actor.tenantId, input.kind, fromId, toId, approved ? 'approved' : 'candidate', approved ? actor.userId : null]);
}

async function decideIfTrusted(db: Db, actor: Actor, id: string, state: string): Promise<RelationState> {
  await db.query(`UPDATE tag_relations SET evidence = evidence + 1 WHERE id = $1`, [id]);
  if (state === 'candidate' && isTrusted(actor)) return decideRelation(db, actor, id, 'approved');
  return one<RelationState>(db, `SELECT id, state FROM tag_relations WHERE id = $1`, [id]);
}

export async function decideRelation(db: Db, actor: Actor, id: string, decision: 'approved' | 'rejected'): Promise<RelationState> {
  assert(isTrusted(actor), 'forbidden', 'タグの関係を承認できるのは trusted 以上です');
  const r = await maybeOne<{ kind: RelationKind; from_tag_id: string | null; to_tag_id: string }>(
    db, `SELECT kind, from_tag_id, to_tag_id FROM tag_relations WHERE id = $1`, [id],
  );
  assert(r !== undefined, 'not_found', '関係が見つかりません');
  if (decision === 'approved' && r.kind === 'includes') {
    assert(!(await wouldCycle(db, r.from_tag_id!, r.to_tag_id)), 'conflict', '包含関係が循環してしまいます');
  }
  return one<RelationState>(db,
    `UPDATE tag_relations SET state = $2, approved_by = $3 WHERE id = $1 RETURNING id, state`,
    [id, decision, actor.userId]);
}

export async function deleteRelation(db: Db, actor: Actor, id: string) {
  assert(isTrusted(actor), 'forbidden', 'タグの関係を削除できるのは trusted 以上です');
  const rows = await db.query(`DELETE FROM tag_relations WHERE id = $1 RETURNING id`, [id]);
  assert(rows.length === 1, 'not_found', '関係が見つかりません');
}

export async function listRelations(db: Db, actor: Actor, state: 'candidate' | 'approved' | 'rejected') {
  assert(isTrusted(actor), 'forbidden', 'タグの関係を見られるのは trusted 以上です');
  return db.query<{ id: string; kind: RelationKind; from_tag: string | null; from_text: string | null; to_tag: string; state: string; source: string; evidence: number }>(
    `SELECT r.id, r.kind, f.name AS from_tag, r.from_text, t.name AS to_tag, r.state, r.source, r.evidence
       FROM tag_relations r
       LEFT JOIN hashtags f ON f.id = r.from_tag_id
       JOIN hashtags t ON t.id = r.to_tag_id
      WHERE r.state = $1
      ORDER BY r.evidence DESC, r.created_at DESC
      LIMIT 200`,
    [state],
  );
}

/**
 * タグ from を into に統合する（表記ゆれの整理）。from は merged になり、以後 from を指定しても into として扱う。
 * 商品のタグと関係を付け替え、from が付いていたナレッジを索引し直す。版の履歴（tag_ids）は書き換えない。
 */
export async function mergeTags(db: Db, tokenizer: Tokenizer, actor: Actor, fromName: string, intoName: string) {
  assert(actor.adminScope !== 'none', 'forbidden', 'タグを統合できるのは administrator のみです');
  const fromId = await activeTagId(db, fromName);
  const [intoId] = await canonicalTagIds(db, [await activeTagId(db, intoName)]);
  assert(intoId !== undefined && fromId !== intoId, 'invalid', '同じタグには統合できません');

  await db.query(`UPDATE hashtags SET state = 'merged', merged_into = $2 WHERE id = $1`, [fromId, intoId]);
  // 商品のタグを付け替える
  await db.query(
    `INSERT INTO product_tags (tenant_id, product_id, hashtag_id)
     SELECT tenant_id, product_id, $2 FROM product_tags WHERE hashtag_id = $1
     ON CONFLICT DO NOTHING`,
    [fromId, intoId],
  );
  await db.query(`DELETE FROM product_tags WHERE hashtag_id = $1`, [fromId]);
  // 関係を付け替える。自分自身への関係になるものと、重複するものは消す
  await db.query(`UPDATE tag_relations SET from_tag_id = $2 WHERE from_tag_id = $1`, [fromId, intoId]);
  await db.query(`UPDATE tag_relations SET to_tag_id = $2 WHERE to_tag_id = $1`, [fromId, intoId]);
  await db.query(`DELETE FROM tag_relations WHERE from_tag_id = to_tag_id`);
  await db.query(
    `DELETE FROM tag_relations a USING tag_relations b
      WHERE a.id > b.id AND a.kind = b.kind AND a.kind <> 'alias'
        AND a.from_tag_id = b.from_tag_id AND a.to_tag_id = b.to_tag_id`,
  );
  // 統合元のタグ名は、別名として残す（「#長期保障」と打っても「#長期保証」に読み替える）
  const fromTag = await one<{ name: string }>(db, `SELECT name FROM hashtags WHERE id = $1`, [fromId]);
  await db.query(
    `INSERT INTO tag_relations (tenant_id, kind, from_text, to_tag_id, state, source, approved_by)
     VALUES ($1, 'alias', $2, $3, 'approved', 'manual', $4)
     ON CONFLICT DO NOTHING`,
    [actor.tenantId, fromTag.name, intoId, actor.userId],
  );
  // 統合元が付いていたナレッジを索引し直す（索引は統合先のタグで作られる）
  const affected = await db.query<{ knowledge_id: string }>(`SELECT knowledge_id FROM knowledge_tags WHERE hashtag_id = $1`, [fromId]);
  for (const { knowledge_id } of affected) await indexKnowledge(db, tokenizer, knowledge_id);
  await refreshUseCounts(db, [fromId, intoId]);
  return { from: fromId, into: intoId, reindexed: affected.length };
}
