// ナレッジの投稿・編集・承認・却下・過去版への戻し。
// visitor の変更は承認待ちの版（pending）として積み、trusted の変更はその場で公開する。
// どちらの場合も、編集のたびに版を1つ追加して残す。

import type { Tokenizer } from '@misenare/search-core';
import { maybeOne, one, type Db } from '../db/db.ts';
import { assert, canAccessStore, canModerate, isTrusted, type Actor } from './actor.ts';
import { indexKnowledge } from './indexer.ts';
import { assertStore } from './scope.ts';
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
  /** 内容が最後に変わった日時（表示中の版の編集日時） */
  updatedAt: string;
  updatedBy: string | null;
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
  expires_at: string | null;
}

const MAX_TITLE = 100;
const MAX_BODY = 20_000;

function validate(input: Pick<KnowledgeInput, 'title' | 'body' | 'tagNames'>) {
  assert(input.title.trim().length > 0, 'invalid', 'タイトルを入力してください');
  assert(input.title.length <= MAX_TITLE, 'invalid', `タイトルは${MAX_TITLE}文字以内にしてください`);
  assert(input.body.length <= MAX_BODY, 'invalid', `本文は${MAX_BODY}文字以内にしてください`);
  assert(input.tagNames.some((t) => t.replace(/[#＃\s]/g, '').length > 0), 'invalid', 'ハッシュタグを1つ以上付けてください');
}

/** lock = true なら行ロックを取る（同時編集で版番号が衝突しないように、変更系では必ず使う）。 */
async function load(db: Db, id: string, lock = false): Promise<KnowledgeRow> {
  const row = await maybeOne<KnowledgeRow>(
    db,
    `SELECT id, tenant_id, store_id, status, current_version, expires_at::text AS expires_at
       FROM knowledge WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  assert(row !== undefined, 'not_found', 'ナレッジが見つかりません');
  return row;
}

async function nextVersion(db: Db, id: string): Promise<number> {
  const r = await one<{ v: number }>(db, `SELECT coalesce(max(version), 0) + 1 AS v FROM knowledge_versions WHERE knowledge_id = $1`, [id]);
  return r.v;
}

/**
 * 版を公開する：旧公開版と、それより古い承認待ちの案を過去版にし、current_version と期限を進め、
 * 確認日を更新し、索引に反映する。期限は版に持たせておき、公開した時点で初めて効かせる。
 */
async function publish(db: Db, tokenizer: Tokenizer, actor: Actor, id: string, version: number): Promise<void> {
  await db.query(
    `UPDATE knowledge_versions SET state = 'superseded'
      WHERE knowledge_id = $1 AND (state = 'published' OR (state = 'pending' AND version < $2))`,
    [id, version],
  );
  const v = await one<{ tag_ids: string[]; expires_at: string | null }>(
    db,
    `UPDATE knowledge_versions SET state = 'published', decided_by = $3, decided_at = now()
      WHERE knowledge_id = $1 AND version = $2 RETURNING tag_ids, expires_at`,
    [id, version, actor.userId],
  );
  await activateTags(db, v.tag_ids);
  await db.query(
    `UPDATE knowledge SET status = 'published', current_version = $2, expires_at = $3::timestamptz,
            verified_by = $4, verified_at = now()
      WHERE id = $1`,
    [id, version, v.expires_at, actor.userId],
  );
  await indexKnowledge(db, tokenizer, id);
}

async function insertVersion(
  db: Db,
  actor: Actor,
  id: string,
  version: number,
  v: { title: string; body: string; tagIds: string[]; areaIds: string[]; expiresAt: string | null },
) {
  await db.query(
    `INSERT INTO knowledge_versions (tenant_id, knowledge_id, version, title, body, tag_ids, area_ids, expires_at, state, edited_by)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7::uuid[], $8::timestamptz, 'pending', $9)`,
    [actor.tenantId, id, version, v.title, v.body, v.tagIds, v.areaIds, v.expiresAt, actor.userId],
  );
}

async function assertAreas(db: Db, storeId: string | null, areaIds: string[] | undefined) {
  if (!areaIds || areaIds.length === 0) return;
  assert(storeId !== null, 'invalid', '全店共通のナレッジには売場を指定できません');
  const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM areas WHERE id = ANY($1::uuid[]) AND store_id = $2`, [areaIds, storeId]);
  assert(n.n === new Set(areaIds).size, 'invalid', 'この店舗の売場ではありません');
}

export async function createKnowledge(db: Db, tokenizer: Tokenizer, actor: Actor, input: KnowledgeInput) {
  validate(input);
  if (input.storeId === null) {
    assert(actor.adminScope === 'tenant', 'forbidden', '全店共通のナレッジは本部のみ作成できます');
  } else {
    assert(canAccessStore(actor, input.storeId), 'forbidden', 'この店舗には投稿できません');
    await assertStore(db, input.storeId);
  }
  await assertAreas(db, input.storeId, input.areaIds);
  const tagIds = await resolveTags(db, actor, input.tagNames);
  const k = await one<{ id: string }>(
    db,
    `INSERT INTO knowledge (tenant_id, scope, store_id, status, created_by)
     VALUES ($1, $2, $3, 'draft', $4) RETURNING id`,
    [actor.tenantId, input.storeId === null ? 'tenant' : 'store', input.storeId, actor.userId],
  );
  await insertVersion(db, actor, k.id, 1, {
    title: input.title.trim(), body: input.body, tagIds, areaIds: input.areaIds ?? [], expiresAt: input.expiresAt ?? null,
  });
  if (isTrusted(actor)) await publish(db, tokenizer, actor, k.id, 1);
  // 新しく作ったタグのうち、まだ読みが決まっていないものを返す。
  // 画面はこれを見て、その場で読みを尋ねる（一番よく知っているのは、いま打った人）。
  const readingsNeeded = await pendingReadings(db, tagIds);
  return { id: k.id, version: 1, published: isTrusted(actor), readingsNeeded };
}

/** 読みが決まっていないタグ。保存した直後にその場で尋ねるために使う。 */
export interface ReadingNeeded { id: string; name: string; proposed: string }

async function pendingReadings(db: Db, tagIds: readonly string[]): Promise<ReadingNeeded[]> {
  if (tagIds.length === 0) return [];
  const rows = await db.query<{ id: string; name: string; reading_proposed: string | null }>(
    `SELECT id, name, reading_proposed
       FROM hashtags
      WHERE id = ANY($1::uuid[])
        AND state = 'active'
        AND reading IS NULL
        AND reading_checked_at IS NULL
      ORDER BY name`,
    [[...tagIds]],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, proposed: r.reading_proposed ?? '' }));
}

export async function editKnowledge(
  db: Db,
  tokenizer: Tokenizer,
  actor: Actor,
  id: string,
  input: Omit<KnowledgeInput, 'storeId'>,
) {
  validate(input);
  const k = await load(db, id, true);
  assert(canAccessStore(actor, k.store_id), 'forbidden', 'このナレッジは編集できません');
  if (k.store_id === null) assert(actor.adminScope === 'tenant', 'forbidden', '全店共通のナレッジは本部のみ編集できます');
  await assertAreas(db, k.store_id, input.areaIds);
  const tagIds = await resolveTags(db, actor, input.tagNames);
  const version = await nextVersion(db, id);
  // 期限を指定しなければ今の期限を引き継ぐ。どちらの場合も公開（承認）されるまで効かない
  await insertVersion(db, actor, id, version, {
    title: input.title.trim(), body: input.body, tagIds, areaIds: input.areaIds ?? [],
    expiresAt: input.expiresAt !== undefined ? input.expiresAt : k.expires_at,
  });
  const published = isTrusted(actor);
  if (published) await publish(db, tokenizer, actor, id, version);
  return { id, version, published };
}

export async function approveVersion(db: Db, tokenizer: Tokenizer, actor: Actor, id: string, version: number) {
  const k = await load(db, id, true);
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
  const k = await load(db, id, true);
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
  const k = await load(db, id, true);
  assert(canModerate(actor, k.store_id), 'forbidden', '過去版に戻す権限がありません');
  const old = await maybeOne<{ title: string; body: string; tag_ids: string[]; area_ids: string[]; expires_at: string | null; state: string }>(
    db,
    `SELECT title, body, tag_ids, area_ids, expires_at::text AS expires_at, state
       FROM knowledge_versions WHERE knowledge_id = $1 AND version = $2`,
    [id, version],
  );
  assert(old !== undefined, 'not_found', '版が見つかりません');
  // 戻せるのは一度公開された版だけ。承認待ち・却下の案を戻しで公開すると承認を飛ばせてしまう
  assert(old.state === 'superseded' || old.state === 'published', 'conflict', '一度も公開されていない版には戻せません');
  const next = await nextVersion(db, id);
  await insertVersion(db, actor, id, next, {
    title: old.title, body: old.body, tagIds: old.tag_ids, areaIds: old.area_ids, expiresAt: old.expires_at,
  });
  await publish(db, tokenizer, actor, id, next);
  return { id, version: next };
}

export async function getKnowledge(db: Db, actor: Actor, id: string): Promise<KnowledgeView> {
  const k = await load(db, id);
  assert(canAccessStore(actor, k.store_id), 'forbidden', 'このナレッジは閲覧できません');
  // 公開中の版。未公開なら最新の案（投稿者本人と承認者だけが見られる）
  const v = await maybeOne<{ version: number; title: string; body: string; tag_ids: string[]; edited_by: string; edited_at: string; editor: string | null }>(
    db,
    `SELECT version, title, body, tag_ids, edited_by, edited_at::text AS edited_at,
            (SELECT name FROM users WHERE id = edited_by) AS editor
       FROM knowledge_versions
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
    `SELECT k.verified_at::text AS verified_at, u.name AS verified_by FROM knowledge k LEFT JOIN users u ON u.id = k.verified_by WHERE k.id = $1`,
    [id],
  );
  // 承認待ちの版は、承認できる人には全部、それ以外の人には自分の案だけを見せる
  const pending = await db.query<{ version: number }>(
    `SELECT version FROM knowledge_versions
      WHERE knowledge_id = $1 AND state = 'pending' AND ($2 OR edited_by = $3)
      ORDER BY version`,
    [id, canModerate(actor, k.store_id), actor.userId],
  );
  return {
    id,
    storeId: k.store_id,
    status: k.status,
    version: k.current_version,
    title: v.title,
    body: v.body,
    tags: tags.map((t) => t.name),
    updatedAt: v.edited_at,
    updatedBy: v.editor,
    verifiedAt: meta.verified_at,
    verifiedBy: meta.verified_by,
    pendingVersions: pending.map((p) => p.version),
  };
}

/**
 * 版の一覧（差分表示・戻し用）。公開された版（公開中・過去版）は誰でも見られる。
 * 承認待ち・却下の案は、承認できる人と、その案を書いた本人にだけ見せる。
 */
export async function listVersions(db: Db, actor: Actor, id: string) {
  const k = await load(db, id);
  assert(canAccessStore(actor, k.store_id), 'forbidden', 'このナレッジは閲覧できません');
  return db.query<{ version: number; state: string; title: string; body: string; edited_at: string; edited_by: string }>(
    `SELECT v.version, v.state, v.title, v.body, v.edited_at, u.name AS edited_by
       FROM knowledge_versions v JOIN users u ON u.id = v.edited_by
      WHERE v.knowledge_id = $1
        AND (v.state IN ('published', 'superseded') OR $2 OR v.edited_by = $3)
      ORDER BY v.version DESC`,
    [id, canModerate(actor, k.store_id), actor.userId],
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

/**
 * 「古い」とみなすまでの日数。ここが1つの決まりごとで、
 * 承認・管理の一覧（下の listStale）と、詳細画面の注意書きの両方がこの値を使う。
 * 画面側には /me で配って、ずれないようにしている。
 */
export const STALE_DAYS = 180;

/** 一定期間、更新も確認もされていない公開ナレッジ（鮮度管理。承認できる人が見直す） */
export async function listStale(db: Db, actor: Actor, storeId: string, days = STALE_DAYS) {
  assert(canModerate(actor, storeId), 'forbidden', '見直しの一覧を見る権限がありません');
  return db.query<{ id: string; title: string; verified_at: string | null; verified_by: string | null }>(
    `SELECT k.id, v.title, k.verified_at::text AS verified_at, u.name AS verified_by
       FROM knowledge k
       JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version
       LEFT JOIN users u ON u.id = k.verified_by
      WHERE k.status = 'published' AND k.store_id = $1
        AND greatest(k.verified_at, v.edited_at) < now() - make_interval(days => $2)
      ORDER BY greatest(k.verified_at, v.edited_at)`,
    [storeId, days],
  );
}

/** 内容は変えずに「今も正しい」と確認した記録だけを残す（最終確認日・確認者を更新） */
export async function verifyKnowledge(db: Db, actor: Actor, id: string) {
  const k = await load(db, id, true);
  assert(canModerate(actor, k.store_id), 'forbidden', '確認する権限がありません');
  assert(k.status === 'published', 'conflict', '公開中のナレッジではありません');
  await db.query(`UPDATE knowledge SET verified_by = $2, verified_at = now() WHERE id = $1`, [id, actor.userId]);
  return { id };
}
