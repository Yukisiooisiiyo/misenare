// ナレッジの投稿・編集・承認・却下・過去版への戻し。
// visitor の変更は承認待ちの版（pending）として積み、trusted の変更はその場で公開する。
// どちらの場合も、編集のたびに版を1つ追加して残す。

import type { Tokenizer } from '@misenare/search-core';
import { maybeOne, one, type Db } from '../db/db.ts';
import { assert, canAccessStore, canModerate, isTrusted, type Actor } from './actor.ts';
import { indexKnowledge } from './indexer.ts';
import { activateTags, resolveTags } from './tags.ts';

export interface KnowledgeInput {
  /** null なら全店共通（本部のみ作成可） */
  storeId: string | null;
  title: string;
  body: string;
  tagNames: string[];
  areaIds?: string[];
  expiresAt?: string | null;
}

export interface KnowledgeView {
  id: string;
  storeId: string | null;
  status: 'draft' | 'published' | 'expired';
  version: number | null;
  title: string;
  body: string;
  tags: string[];
  verifiedAt: string | null;
  verifiedBy: string | null;
  /** 公開中の版より新しい承認待ちの版 */
  pendingVersions: number[];
}

interface KnowledgeRow {
  id: string;
  tenant_id: string;
  store_id: string | null;
  status: KnowledgeView['status'];
  current_version: number | null;
}

const MAX_TITLE = 100;
const MAX_BODY = 20_000;

function validate(input: Pick<KnowledgeInput, 'title' | 'body' | 'tagNames'>) {
  assert(input.title.trim().length > 0, 'invalid', 'タイトルを入力してください');
  assert(input.title.length <= MAX_TITLE, 'invalid', `タイトルは${MAX_TITLE}文字以内にしてください`);
  assert(input.body.length <= MAX_BODY, 'invalid', `本文は${MAX_BODY}文字以内にしてください`);
  assert(input.tagNames.some((t) => t.replace(/[#＃\s]/g, '').length > 0), 'invalid', 'ハッシュタグを1つ以上付けてください');
}

async function load(db: Db, id: string): Promise<KnowledgeRow> {
  const row = await maybeOne<KnowledgeRow>(
    db,
    `SELECT id, tenant_id, store_id, status, current_version FROM knowledge WHERE id = $1`,
    [id],
  );
  assert(row !== undefined, 'not_found', 'ナレッジが見つかりません');
  return row;
}

async function nextVersion(db: Db, id: string): Promise<number> {
  const r = await one<{ v: number }>(db, `SELECT coalesce(max(version), 0) + 1 AS v FROM knowledge_versions WHERE knowledge_id = $1`, [id]);
  return r.v;
}

/** 版を公開する：旧公開版を過去版にし、current_version を進め、確認日を更新し、索引に反映する。 */
async function publish(db: Db, tokenizer: Tokenizer, actor: Actor, id: string, version: number): Promise<void> {
  await db.query(
    `UPDATE knowledge_versions SET state = 'superseded' WHERE knowledge_id = $1 AND state = 'published'`,
    [id],
  );
  const v = await one<{ tag_ids: string[] }>(
    db,
    `UPDATE knowledge_versions SET state = 'published', decided_by = $3, decided_at = now()
      WHERE knowledge_id = $1 AND version = $2 RETURNING tag_ids`,
    [id, version, actor.userId],
  );
  await activateTags(db, v.tag_ids);
  await db.query(
    `UPDATE knowledge SET status = 'published', current_version = $2, verified_by = $3, verified_at = now()
      WHERE id = $1`,
    [id, version, actor.userId],
  );
  await indexKnowledge(db, tokenizer, id);
}

export async function createKnowledge(db: Db, tokenizer: Tokenizer, actor: Actor, input: KnowledgeInput) {
  validate(input);
  if (input.storeId === null) {
    assert(actor.adminScope === 'tenant', 'forbidden', '全店共通のナレッジは本部のみ作成できます');
  } else {
    assert(canAccessStore(actor, input.storeId), 'forbidden', 'この店舗には投稿できません');
  }
  const tagIds = await resolveTags(db, actor, input.tagNames);
  const k = await one<{ id: string }>(
    db,
    `INSERT INTO knowledge (tenant_id, scope, store_id, status, expires_at, created_by)
     VALUES ($1, $2, $3, 'draft', $4, $5) RETURNING id`,
    [actor.tenantId, input.storeId === null ? 'tenant' : 'store', input.storeId, input.expiresAt ?? null, actor.userId],
  );
  await db.query(
    `INSERT INTO knowledge_versions (tenant_id, knowledge_id, version, title, body, tag_ids, area_ids, state, edited_by)
     VALUES ($1, $2, 1, $3, $4, $5::uuid[], $6::uuid[], 'pending', $7)`,
    [actor.tenantId, k.id, input.title.trim(), input.body, tagIds, input.areaIds ?? [], actor.userId],
  );
  if (isTrusted(actor)) await publish(db, tokenizer, actor, k.id, 1);
  return { id: k.id, version: 1, published: isTrusted(actor) };
}

export async function editKnowledge(
  db: Db,
  tokenizer: Tokenizer,
  actor: Actor,
  id: string,
  input: Omit<KnowledgeInput, 'storeId'>,
) {
  validate(input);
  const k = await load(db, id);
  assert(canAccessStore(actor, k.store_id), 'forbidden', 'このナレッジは編集できません');
  if (k.store_id === null) assert(actor.adminScope === 'tenant', 'forbidden', '全店共通のナレッジは本部のみ編集できます');
  const tagIds = await resolveTags(db, actor, input.tagNames);
  const version = await nextVersion(db, id);
  await db.query(
    `INSERT INTO knowledge_versions (tenant_id, knowledge_id, version, title, body, tag_ids, area_ids, state, edited_by)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7::uuid[], 'pending', $8)`,
    [k.tenant_id, id, version, input.title.trim(), input.body, tagIds, input.areaIds ?? [], actor.userId],
  );
  if (input.expiresAt !== undefined) {
    await db.query(`UPDATE knowledge SET expires_at = $2 WHERE id = $1`, [id, input.expiresAt]);
  }
  const published = isTrusted(actor);
  if (published) await publish(db, tokenizer, actor, id, version);
  return { id, version, published };
}

export async function approveVersion(db: Db, tokenizer: Tokenizer, actor: Actor, id: string, version: number) {
  const k = await load(db, id);
  assert(canModerate(actor, k.store_id), 'forbidden', '承認する権限がありません');
  const v = await maybeOne<{ state: string }>(
    db,
    `SELECT state FROM knowledge_versions WHERE knowledge_id = $1 AND version = $2`,
    [id, version],
  );
  assert(v !== undefined, 'not_found', '版が見つかりません');
  assert(v.state === 'pending', 'conflict', 'この版は承認待ちではありません');
  // 承認待ちの間に新しい版が公開されていたら、古い修正案で上書きしない
  assert(k.current_version === null || version > k.current_version, 'conflict', 'より新しい版が公開済みです。修正案を作り直してください');
  await publish(db, tokenizer, actor, id, version);
  return { id, version };
}

export async function rejectVersion(db: Db, actor: Actor, id: string, version: number) {
  const k = await load(db, id);
  assert(canModerate(actor, k.store_id), 'forbidden', '却下する権限がありません');
  const rows = await db.query(
    `UPDATE knowledge_versions SET state = 'rejected', decided_by = $3, decided_at = now()
      WHERE knowledge_id = $1 AND version = $2 AND state = 'pending' RETURNING version`,
    [id, version, actor.userId],
  );
  assert(rows.length === 1, 'conflict', 'この版は承認待ちではありません');
  // 一度も公開されていないナレッジの唯一の案を却下した場合、pending のタグも辞書に入らないまま残る
  return { id, version };
}

/** 過去版の内容で新しい版を作って公開する（履歴は消さない）。 */
export async function revertToVersion(db: Db, tokenizer: Tokenizer, actor: Actor, id: string, version: number) {
  const k = await load(db, id);
  assert(canModerate(actor, k.store_id), 'forbidden', '過去版に戻す権限がありません');
  const old = await maybeOne<{ title: string; body: string; tag_ids: string[]; area_ids: string[] }>(
    db,
    `SELECT title, body, tag_ids, area_ids FROM knowledge_versions WHERE knowledge_id = $1 AND version = $2`,
    [id, version],
  );
  assert(old !== undefined, 'not_found', '版が見つかりません');
  const next = await nextVersion(db, id);
  await db.query(
    `INSERT INTO knowledge_versions (tenant_id, knowledge_id, version, title, body, tag_ids, area_ids, state, edited_by)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7::uuid[], 'pending', $8)`,
    [k.tenant_id, id, next, old.title, old.body, old.tag_ids, old.area_ids, actor.userId],
  );
  await publish(db, tokenizer, actor, id, next);
  return { id, version: next };
}

export async function getKnowledge(db: Db, actor: Actor, id: string): Promise<KnowledgeView> {
  const k = await load(db, id);
  assert(canAccessStore(actor, k.store_id), 'forbidden', 'このナレッジは閲覧できません');
  // 公開中の版。未公開なら最新の案（投稿者本人と承認者だけが見られる）
  const v = await maybeOne<{ version: number; title: string; body: string; tag_ids: string[]; edited_by: string }>(
    db,
    `SELECT version, title, body, tag_ids, edited_by FROM knowledge_versions
      WHERE knowledge_id = $1 AND (version = $2 OR $2::int IS NULL)
      ORDER BY version DESC LIMIT 1`,
    [id, k.current_version],
  );
  assert(v !== undefined, 'not_found', 'ナレッジが見つかりません');
  if (k.status !== 'published') {
    assert(v.edited_by === actor.userId || canModerate(actor, k.store_id), 'forbidden', 'このナレッジはまだ公開されていません');
  }
  const tags = await db.query<{ name: string }>(
    `SELECT name FROM hashtags WHERE id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], id)`,
    [v.tag_ids],
  );
  const meta = await one<{ verified_at: string | null; verified_by: string | null }>(
    db,
    `SELECT k.verified_at, u.name AS verified_by FROM knowledge k LEFT JOIN users u ON u.id = k.verified_by WHERE k.id = $1`,
    [id],
  );
  const pending = await db.query<{ version: number }>(
    `SELECT version FROM knowledge_versions WHERE knowledge_id = $1 AND state = 'pending' ORDER BY version`,
    [id],
  );
  return {
    id,
    storeId: k.store_id,
    status: k.status,
    version: k.current_version,
    title: v.title,
    body: v.body,
    tags: tags.map((t) => t.name),
    verifiedAt: meta.verified_at,
    verifiedBy: meta.verified_by,
    pendingVersions: pending.map((p) => p.version),
  };
}

/** 版の一覧（差分表示・戻し用） */
export async function listVersions(db: Db, actor: Actor, id: string) {
  const k = await load(db, id);
  assert(canAccessStore(actor, k.store_id), 'forbidden', 'このナレッジは閲覧できません');
  return db.query(
    `SELECT v.version, v.state, v.title, v.body, v.edited_at, u.name AS edited_by
       FROM knowledge_versions v JOIN users u ON u.id = v.edited_by
      WHERE v.knowledge_id = $1 ORDER BY v.version DESC`,
    [id],
  );
}

/** 承認待ちの一覧（trusted / administrator 向け） */
export async function listPending(db: Db, actor: Actor, storeId: string) {
  assert(canModerate(actor, storeId), 'forbidden', '承認待ちを見る権限がありません');
  return db.query(
    `SELECT k.id, v.version, v.title, v.edited_at, u.name AS edited_by, k.current_version IS NULL AS is_new
       FROM knowledge_versions v
       JOIN knowledge k ON k.id = v.knowledge_id
       JOIN users u ON u.id = v.edited_by
      WHERE v.state = 'pending' AND k.store_id = $1
      ORDER BY v.edited_at`,
    [storeId],
  );
}
