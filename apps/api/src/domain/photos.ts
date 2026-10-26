// ナレッジに付ける写真。
//
// 流れ：
//   1. 端末が「これから上げます」と申告する（枠を作る）→ 送り先の案内を受け取る
//   2. 端末が中身を送る（ローカル保存なら API 経由、S3 なら署名付きURLで直接）
//   3. 端末が「上げ終わりました」と伝える → 一覧に出るようになる
//
// 写真そのものに承認はない（ナレッジの版が承認制なので、未公開のナレッジは関係者しか見られない）。
// 消すのは、投稿した本人と承認できる人だけ。

import { randomUUID } from 'node:crypto';
import { maybeOne, one, type Db } from '../db/db.ts';
import type { Storage } from '../storage/storage.ts';
import { assert, canAccessStore, canModerate, type Actor } from './actor.ts';

/** 端末で縮小してから送らせる。縮小後にこれを超えるものは受け取らない */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** 1つのナレッジに付けられる枚数 */
export const MAX_PHOTOS = 8;

const EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * 中身の先頭が、申告した形式と合っているか。
 *
 * **申告された形式を信じない。** いまは「JPEG です」と言って別のものを送れる。
 * 返すときに content-type を申告どおりに付け、nosniff も付けているので、
 * HTML を送られても動かはしない。それでも先頭を見るのは2つの理由から：
 *   * 守りを1枚に頼らない（返す側のヘッダーを1つ外した日に、そこが穴になる）
 *   * 間違いがその場で分かる（HEIC を image/jpeg として送ると、
 *     全員の画面で写真が壊れて見える。受け取る前に断るほうが親切）
 *
 * SVG は最初から受けていない（中に script を書けるので、同じ出どころで開くと動く）。
 */
const MAGIC: Record<string, { need: number; test: (b: Uint8Array) => boolean }> = {
  // JPEG は FF D8 FF で始まる
  'image/jpeg': { need: 3, test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // PNG は 89 'P' 'N' 'G' 0D 0A 1A 0A
  'image/png': {
    need: 8,
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  // WebP は 'RIFF' …4バイト… 'WEBP'
  'image/webp': {
    need: 12,
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
};

/** 申告した形式と、中身の先頭が合っているか */
export function looksLikeDeclared(body: Uint8Array, contentType: string): boolean {
  const magic = MAGIC[contentType];
  if (!magic) return false;
  if (body.byteLength < magic.need) return false;
  return magic.test(body);
}

export interface PhotoView {
  id: string;
  /** 閲覧用の場所。API が中身を返す相対パスか、保存先の署名付きURL */
  url: string;
  contentType: string;
  bytes: number;
  caption: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface PhotoRow {
  id: string;
  knowledge_id: string;
  storage_key: string;
  content_type: string;
  bytes: number;
  state: 'uploading' | 'active';
  caption: string | null;
  created_by: string;
  created_at: string;
  store_id: string | null;
  status: 'draft' | 'published' | 'expired';
}

/** 写真の置き場所（ナレッジ）を見られるか。未公開なら、書いた人と承認できる人だけ */
async function assertCanRead(db: Db, actor: Actor, knowledgeId: string): Promise<{ store_id: string | null }> {
  const k = await maybeOne<{ store_id: string | null; status: string }>(
    db, `SELECT store_id, status FROM knowledge WHERE id = $1`, [knowledgeId],
  );
  assert(k !== undefined, 'not_found', 'ナレッジが見つかりません');
  assert(canAccessStore(actor, k.store_id), 'forbidden', 'このナレッジは閲覧できません');
  if (k.status !== 'published') {
    const mine = await maybeOne(db, `SELECT 1 FROM knowledge_versions WHERE knowledge_id = $1 AND edited_by = $2`, [knowledgeId, actor.userId]);
    assert(mine !== undefined || canModerate(actor, k.store_id), 'forbidden', 'このナレッジはまだ公開されていません');
  }
  return k;
}

async function loadPhoto(db: Db, photoId: string): Promise<PhotoRow> {
  const row = await maybeOne<PhotoRow>(
    db,
    `SELECT p.id, p.knowledge_id, p.storage_key, p.content_type, p.bytes, p.state, p.caption,
            p.created_by, p.created_at::text AS created_at, k.store_id, k.status
       FROM knowledge_photos p JOIN knowledge k ON k.id = p.knowledge_id
      WHERE p.id = $1`,
    [photoId],
  );
  assert(row !== undefined, 'not_found', '写真が見つかりません');
  return row;
}

export interface UploadPlan {
  photoId: string;
  /** 中身の送り先 */
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  /** true なら、この API にログインの印（Authorization）を付けて送る */
  withSession: boolean;
}

/** 写真の枠を作り、中身の送り先を返す */
export async function startPhotoUpload(
  db: Db, storage: Storage, actor: Actor, knowledgeId: string,
  input: { contentType: string; bytes: number },
): Promise<UploadPlan> {
  await assertCanRead(db, actor, knowledgeId);
  assert((ALLOWED_TYPES as readonly string[]).includes(input.contentType), 'invalid', '写真は JPEG・PNG・WebP で送ってください');
  assert(Number.isInteger(input.bytes) && input.bytes > 0 && input.bytes <= MAX_PHOTO_BYTES, 'invalid', '写真が大きすぎます');
  const count = await one<{ n: number }>(
    db, `SELECT count(*)::int AS n FROM knowledge_photos WHERE knowledge_id = $1 AND state = 'active'`, [knowledgeId],
  );
  assert(count.n < MAX_PHOTOS, 'conflict', `写真は${MAX_PHOTOS}枚までです`);

  const photoId = randomUUID();
  const key = `${actor.tenantId}/${knowledgeId}/${photoId}.${EXTENSION[input.contentType]}`;
  const sortOrder = await one<{ n: number }>(
    db, `SELECT coalesce(max(sort_order), 0) + 1 AS n FROM knowledge_photos WHERE knowledge_id = $1`, [knowledgeId],
  );
  await db.query(
    `INSERT INTO knowledge_photos (id, tenant_id, knowledge_id, storage_key, content_type, bytes, sort_order, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [photoId, actor.tenantId, knowledgeId, key, input.contentType, input.bytes, sortOrder.n, actor.userId],
  );

  const presigned = storage.presignPut(key, input.contentType);
  return presigned
    ? { photoId, method: 'PUT', url: presigned.url, headers: presigned.headers, withSession: false }
    : { photoId, method: 'PUT', url: `/photos/${photoId}/data`, headers: { 'content-type': input.contentType }, withSession: true };
}

/** API 経由で中身を受け取る（ローカル保存のとき） */
export async function receivePhoto(db: Db, storage: Storage, actor: Actor, photoId: string, body: Uint8Array, contentType: string): Promise<void> {
  const p = await loadPhoto(db, photoId);
  assert(p.created_by === actor.userId, 'forbidden', 'この写真は送れません');
  assert(p.state === 'uploading', 'conflict', 'この写真はもう送られています');
  assert(contentType === p.content_type, 'invalid', '申告した形式と違います');
  assert(body.byteLength > 0 && body.byteLength <= MAX_PHOTO_BYTES, 'invalid', '写真が大きすぎます');
  // 中身の先頭も見る（申告だけを信じない）
  assert(looksLikeDeclared(body, p.content_type), 'invalid',
    '写真として読めませんでした。JPEG・PNG・WebP のまま送ってください');
  await storage.put(p.storage_key, body, p.content_type);
  await db.query(`UPDATE knowledge_photos SET bytes = $2 WHERE id = $1`, [photoId, body.byteLength]);
}

/** 送り終わったことを記録して、一覧に出るようにする */
export async function finishPhotoUpload(db: Db, storage: Storage, actor: Actor, photoId: string, caption?: string | null): Promise<PhotoView> {
  const p = await loadPhoto(db, photoId);
  assert(p.created_by === actor.userId, 'forbidden', 'この写真は登録できません');
  const row = await one<{ created_at: string }>(
    db,
    `UPDATE knowledge_photos SET state = 'active', caption = $2 WHERE id = $1 RETURNING created_at::text AS created_at`,
    [photoId, caption ?? null],
  );
  return view({ ...p, state: 'active', caption: caption ?? null, created_at: row.created_at }, storage, null);
}

function view(p: PhotoRow, storage: Storage, createdBy: string | null): PhotoView {
  return {
    id: p.id,
    url: storage.presignGet(p.storage_key) ?? `/photos/${p.id}/data`,
    contentType: p.content_type,
    bytes: p.bytes,
    caption: p.caption,
    createdBy,
    createdAt: p.created_at,
  };
}

export async function listPhotos(db: Db, storage: Storage, actor: Actor, knowledgeId: string): Promise<PhotoView[]> {
  await assertCanRead(db, actor, knowledgeId);
  const rows = await db.query<PhotoRow & { author: string | null }>(
    `SELECT p.id, p.knowledge_id, p.storage_key, p.content_type, p.bytes, p.state, p.caption,
            p.created_by, p.created_at::text AS created_at, u.name AS author
       FROM knowledge_photos p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.knowledge_id = $1 AND p.state = 'active'
      ORDER BY p.sort_order, p.created_at`,
    [knowledgeId],
  );
  return rows.map((r) => view(r, storage, r.author));
}

/** 閲覧。保存先が署名付きURLを作れるならそこへ飛ばし、作れないなら中身を返す */
export async function openPhoto(
  db: Db, storage: Storage, actor: Actor, photoId: string,
): Promise<{ kind: 'redirect'; url: string } | { kind: 'body'; body: Uint8Array; contentType: string }> {
  const p = await loadPhoto(db, photoId);
  await assertCanRead(db, actor, p.knowledge_id);
  assert(p.state === 'active', 'not_found', '写真が見つかりません');
  const url = storage.presignGet(p.storage_key);
  if (url) return { kind: 'redirect', url };
  return { kind: 'body', body: await storage.get(p.storage_key), contentType: p.content_type };
}

/** 消すのは、付けた本人と承認できる人だけ */
export async function deletePhoto(db: Db, storage: Storage, actor: Actor, photoId: string): Promise<{ ok: true }> {
  const p = await loadPhoto(db, photoId);
  assert(canAccessStore(actor, p.store_id), 'forbidden', 'この写真は消せません');
  assert(p.created_by === actor.userId || canModerate(actor, p.store_id), 'forbidden', 'この写真は消せません');
  await db.query(`DELETE FROM knowledge_photos WHERE id = $1`, [photoId]);
  // 保存先から消せなくても、一覧からは消えている。残骸は夜間バッチで片付ける
  await storage.remove(p.storage_key).catch(() => {});
  return { ok: true };
}

/** どのナレッジからも参照されていない中身を片付ける（夜間バッチ用） */
export async function sweepAbandonedPhotos(db: Db, storage: Storage, olderThanHours = 24): Promise<number> {
  const rows = await db.query<{ id: string; storage_key: string }>(
    `DELETE FROM knowledge_photos
      WHERE state = 'uploading' AND created_at < now() - ($1 || ' hours')::interval
      RETURNING id, storage_key`,
    [String(olderThanHours)],
  );
  for (const r of rows) await storage.remove(r.storage_key).catch(() => {});
  return rows.length;
}
