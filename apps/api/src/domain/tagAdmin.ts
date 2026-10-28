// タグ辞書の管理：同義・包含・別名の関係の提案と承認、タグの統合。
//
// タグとその関係は会社（テナント）全体で共有するので、変更は全店舗の検索に効く。
//   関係の承認・却下 … trusted 以上（visitor の提案は候補として残る）
//   タグの統合       … administrator（店長・本部）

import { hiraToKata, normalizeTagName, normalizeText, readingCandidates, suggestReading, type Tokenizer } from '@misenare/search-core';
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
  // 関係を付け替える。**付け替える前に**、自分自身への関係になるものと、付け替え先に既にあるものを消す。
  // UPDATE を先にやると、from↔into の同義（統合したいタグはたいてい同義として登録されている）が
  // into→into になった瞬間に CHECK（from_tag_id <> to_tag_id）で落ち、統合そのものが失敗していた
  await db.query(
    `DELETE FROM tag_relations
      WHERE (from_tag_id = $1 AND to_tag_id = $2) OR (from_tag_id = $2 AND to_tag_id = $1)`,
    [fromId, intoId],
  );
  // from 側の関係のうち、into 側に同じ種類・同じ相手の関係が既にあるものは、付け替えると重複するので消す
  await db.query(
    `DELETE FROM tag_relations a USING tag_relations b
      WHERE a.kind = b.kind AND a.kind <> 'alias'
        AND ((a.from_tag_id = $1 AND b.from_tag_id = $2 AND a.to_tag_id = b.to_tag_id)
          OR (a.to_tag_id = $1 AND b.to_tag_id = $2 AND a.from_tag_id = b.from_tag_id))`,
    [fromId, intoId],
  );
  // 別名も同じ：同じ単語が into を指す行が既にあれば、from を指す方を消す
  await db.query(
    `DELETE FROM tag_relations a USING tag_relations b
      WHERE a.kind = 'alias' AND b.kind = 'alias' AND a.to_tag_id = $1 AND b.to_tag_id = $2 AND a.from_text = b.from_text`,
    [fromId, intoId],
  );
  await db.query(`UPDATE tag_relations SET from_tag_id = $2 WHERE from_tag_id = $1`, [fromId, intoId]);
  await db.query(`UPDATE tag_relations SET to_tag_id = $2 WHERE to_tag_id = $1`, [fromId, intoId]);
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

// --- タグの読みの確認 ---------------------------------------------------------------
//
// 読みは「れいぞうこ」で #冷蔵庫 に当たるための別名になる。機械が出した読みは
// 音読み訓読みの揺れや連濁で外すことがあるので、**人が見るまで検索には効かせない**。
// 夜間バッチは reading_proposed に案を置くだけで、reading は人が決める。

export interface ReadingProposal {
  id: string;
  name: string;
  /**
   * 機械が出した案。**空のことがある。**
   * 信用できない読みは案にしないので、その語はここが空で来る。
   * 間違った案を見せるのは、何も見せないより悪い。
   */
  proposed: string;
  /** このタグが付いているナレッジの数。多いものから確かめたい */
  useCount: number;
  /** 漢字の読みの総当たりから作った候補。押すと入力欄に入り、そこから直せる */
  candidates: string[];
}

/** 読みの案はカタカナと長音符だけ。ひらがなで来たらカタカナに直して受ける。 */
export function normalizeReading(input: string): string {
  const kata = hiraToKata(normalizeText(input)).replace(/\s+/g, '');
  return kata;
}

export function validateReading(reading: string): void {
  assert([...reading].length <= 30, 'invalid', '読みは30文字までです');
  assert(/^[ァ-ヶー]+$/.test(reading), 'invalid', '読みはカタカナで入力してください');
}

/** 確認待ちの読み。使われている数が多い順に出す（直す価値が大きい順） */
export async function listReadingProposals(
  db: Db,
  tokenizer: Tokenizer,
  actor: Actor,
  limit = 50,
): Promise<ReadingProposal[]> {
  assert(isTrusted(actor), 'forbidden', 'タグの読みを確かめられるのは trusted 以上です');
  // 案の有無にかかわらず、読みが決まっていないタグを出す。
  // 案があるものを先に（直すだけで済むので手が早い）、次に使われている数の多い順。
  const rows = await db.query<{ id: string; name: string; reading_proposed: string | null; use_count: number }>(
    `SELECT id, name, reading_proposed, use_count
       FROM hashtags
      WHERE state = 'active' AND cardinality(readings) = 0 AND reading_checked_at IS NULL
      ORDER BY (reading_proposed IS NULL), use_count DESC, name
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => {
    // バッチが置いた案が無ければ、ここで作る（バッチが流れる前でも空欄にしない）
    const s = r.reading_proposed === null ? suggestReading(tokenizer, r.name) : null;
    const proposed = r.reading_proposed ?? (s?.kind === 'proposal' ? s.reading : '');
    return {
      id: r.id,
      name: r.name,
      proposed,
      useCount: r.use_count,
      candidates: readingCandidates(r.name).filter((c) => c !== proposed),
    };
  });
}

/** 1つのタグに登録できる読みの数。これ以上は辞書が太るだけで役に立たない。 */
const MAX_READINGS = 5;

/**
 * 読みを確定する。**複数登録できる。**
 * 「下取」は シタドリ とも シタトリ とも打たれる。どちらが正しいかを
 * 決めようとすると必ず外すし、決める必要もない。両方持てば両方で当たる。
 *
 * 空の配列は「読みなし」として確定する（以後この語に案は出さない）。
 * どちらの場合も、もう確認待ちには出てこない。
 */
export async function confirmReading(
  db: Db, actor: Actor, tagId: string, readings: readonly string[],
): Promise<{ id: string; readings: string[] }> {
  assert(isTrusted(actor), 'forbidden', 'タグの読みを確かめられるのは trusted 以上です');
  const cleaned: string[] = [];
  for (const raw of readings) {
    const value = normalizeReading(raw);
    if (value.length === 0) continue; // 空の欄は無視する（＋を押して打たなかった場合）
    validateReading(value);
    if (!cleaned.includes(value)) cleaned.push(value);
  }
  assert(cleaned.length <= MAX_READINGS, 'invalid', `読みは${MAX_READINGS}つまでです`);
  const rows = await db.query<{ id: string }>(
    `UPDATE hashtags
        SET readings = $2::text[], reading_proposed = NULL,
            reading_checked_at = now(), reading_checked_by = $3
      WHERE id = $1 AND state = 'active'
      RETURNING id`,
    [tagId, cleaned, actor.userId],
  );
  assert(rows.length === 1, 'not_found', 'タグが見つかりません');
  return { id: tagId, readings: cleaned };
}
