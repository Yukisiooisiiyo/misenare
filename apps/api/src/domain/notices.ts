// 連絡事項（お知らせの掲示板）。
//
// ナレッジと分けている理由：
//   ・期間がある（終わったら引っ込む）ので、検索に残り続けると邪魔になる
//   ・「誰が読んだか・確認したか」を記録したい
// 書けるのは trusted 以上。お知らせは承認を待っていると意味が無くなるので、承認は挟まない。

import { maybeOne, one, type Db } from '../db/db.ts';
import { assert, canAccessStore, canModerate, isTrusted, type Actor } from './actor.ts';
import { assertStore } from './scope.ts';

export const MAX_TITLE = 100;
export const MAX_BODY = 2000;

export interface NoticeInput {
  title: string;
  body: string;
  priority?: 'normal' | 'important';
  requiresAck?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
}

export interface NoticeView {
  id: string;
  storeId: string | null;
  title: string;
  body: string;
  priority: 'normal' | 'important';
  requiresAck: boolean;
  startsAt: string;
  endsAt: string | null;
  createdBy: string | null;
  createdAt: string;
  /** 自分が読んだ日時・確認した日時 */
  readAt: string | null;
  ackedAt: string | null;
  /** 確認が要るお知らせで、まだ確認していない人の数（trusted 以上だけに入る） */
  pendingAcks?: number;
}

interface NoticeRow {
  id: string;
  store_id: string | null;
  title: string;
  body: string;
  priority: 'normal' | 'important';
  requires_ack: boolean;
  starts_at: string;
  ends_at: string | null;
  author: string | null;
  created_at: string;
  read_at: string | null;
  acked_at: string | null;
  pending_acks: number | null;
}

function view(row: NoticeRow, withCounts: boolean): NoticeView {
  return {
    id: row.id,
    storeId: row.store_id,
    title: row.title,
    body: row.body,
    priority: row.priority,
    requiresAck: row.requires_ack,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    createdBy: row.author,
    createdAt: row.created_at,
    readAt: row.read_at,
    ackedAt: row.acked_at,
    ...(withCounts && row.requires_ack ? { pendingAcks: Number(row.pending_acks ?? 0) } : {}),
  };
}

function validate(input: NoticeInput): void {
  const title = input.title?.trim() ?? '';
  const body = input.body?.trim() ?? '';
  assert(title.length > 0 && title.length <= MAX_TITLE, 'invalid', `件名を1〜${MAX_TITLE}文字で入力してください`);
  assert(body.length > 0 && body.length <= MAX_BODY, 'invalid', `本文を1〜${MAX_BODY}文字で入力してください`);
  for (const key of ['startsAt', 'endsAt'] as const) {
    const v = input[key];
    assert(v === undefined || v === null || !Number.isNaN(Date.parse(v)), 'invalid', `${key} は日時の文字列か空にしてください`);
  }
  if (input.startsAt && input.endsAt) {
    assert(Date.parse(input.endsAt) > Date.parse(input.startsAt), 'invalid', '掲示の終わりは、始まりより後にしてください');
  }
}

/** その店舗で今まさに掲示されているお知らせ（全店共通のものも含む） */
export async function listNotices(db: Db, actor: Actor, storeId: string, includeEnded = false): Promise<NoticeView[]> {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗の連絡事項は見られません');
  await assertStore(db, storeId);
  const rows = await db.query<NoticeRow>(
    `SELECT n.id, n.store_id, n.title, n.body, n.priority, n.requires_ack,
            n.starts_at::text AS starts_at, n.ends_at::text AS ends_at,
            u.name AS author, n.created_at::text AS created_at,
            r.read_at::text AS read_at, r.acked_at::text AS acked_at,
            CASE WHEN n.requires_ack THEN (
              SELECT count(*)::int FROM memberships m
               WHERE (n.store_id IS NULL OR m.store_id = n.store_id)
                 AND NOT EXISTS (
                   SELECT 1 FROM notice_reads nr
                    WHERE nr.notice_id = n.id AND nr.user_id = m.user_id AND nr.acked_at IS NOT NULL)
            ) END AS pending_acks
       FROM notices n
       JOIN users u ON u.id = n.created_by
       LEFT JOIN notice_reads r ON r.notice_id = n.id AND r.user_id = $2
      WHERE (n.store_id = $1 OR n.store_id IS NULL)
        AND n.starts_at <= now()
        AND ($3 OR n.ends_at IS NULL OR n.ends_at > now())
      ORDER BY (n.priority = 'important') DESC, n.starts_at DESC
      LIMIT 200`,
    [storeId, actor.userId, includeEnded],
  );
  return rows.map((r) => view(r, isTrusted(actor)));
}

export async function getNotice(db: Db, actor: Actor, id: string): Promise<NoticeView> {
  const row = await maybeOne<NoticeRow>(
    db,
    `SELECT n.id, n.store_id, n.title, n.body, n.priority, n.requires_ack,
            n.starts_at::text AS starts_at, n.ends_at::text AS ends_at,
            u.name AS author, n.created_at::text AS created_at,
            r.read_at::text AS read_at, r.acked_at::text AS acked_at, NULL::int AS pending_acks
       FROM notices n JOIN users u ON u.id = n.created_by
       LEFT JOIN notice_reads r ON r.notice_id = n.id AND r.user_id = $2
      WHERE n.id = $1`,
    [id, actor.userId],
  );
  assert(row !== undefined, 'not_found', '連絡事項が見つかりません');
  assert(canAccessStore(actor, row.store_id), 'forbidden', 'この連絡事項は見られません');
  return view(row, false);
}

/** お知らせを出す。全店共通は本部だけ */
export async function createNotice(db: Db, actor: Actor, storeId: string | null, input: NoticeInput) {
  validate(input);
  if (storeId === null) {
    assert(actor.adminScope === 'tenant', 'forbidden', '全店共通の連絡事項は本部のみ出せます');
  } else {
    assert(canModerate(actor, storeId), 'forbidden', '連絡事項を出せるのは trusted 以上です');
    await assertStore(db, storeId);
  }
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO notices (tenant_id, store_id, title, body, priority, requires_ack, starts_at, ends_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), $8::timestamptz, $9, $9) RETURNING id`,
    [
      actor.tenantId, storeId, input.title.trim(), input.body.trim(),
      input.priority ?? 'normal', input.requiresAck ?? false,
      input.startsAt ?? null, input.endsAt ?? null, actor.userId,
    ],
  );
  return { id: row.id };
}

/** 出した人と administrator だけが直せる */
async function assertCanEdit(db: Db, actor: Actor, id: string): Promise<{ store_id: string | null }> {
  const row = await maybeOne<{ store_id: string | null; created_by: string }>(
    db, `SELECT store_id, created_by FROM notices WHERE id = $1`, [id],
  );
  assert(row !== undefined, 'not_found', '連絡事項が見つかりません');
  assert(canAccessStore(actor, row.store_id), 'forbidden', 'この連絡事項は直せません');
  assert(row.created_by === actor.userId || actor.adminScope !== 'none', 'forbidden', '出した人か administrator だけが直せます');
  return row;
}

export async function updateNotice(db: Db, actor: Actor, id: string, input: NoticeInput) {
  validate(input);
  await assertCanEdit(db, actor, id);
  await db.query(
    `UPDATE notices SET title = $2, body = $3, priority = $4, requires_ack = $5,
            starts_at = coalesce($6::timestamptz, starts_at), ends_at = $7::timestamptz,
            updated_by = $8, updated_at = now()
      WHERE id = $1`,
    [
      id, input.title.trim(), input.body.trim(), input.priority ?? 'normal', input.requiresAck ?? false,
      input.startsAt ?? null, input.endsAt ?? null, actor.userId,
    ],
  );
  return { id };
}

/** 掲示をやめる（消さずに、今日までにする）。記録は残る */
export async function endNotice(db: Db, actor: Actor, id: string) {
  await assertCanEdit(db, actor, id);
  await db.query(`UPDATE notices SET ends_at = now(), updated_by = $2, updated_at = now() WHERE id = $1`, [id, actor.userId]);
  return { id, ended: true };
}

export async function deleteNotice(db: Db, actor: Actor, id: string) {
  await assertCanEdit(db, actor, id);
  await db.query(`DELETE FROM notices WHERE id = $1`, [id]);
  return { ok: true };
}

/** 開いたら「読んだ」を記録する */
export async function markRead(db: Db, actor: Actor, id: string) {
  await getNotice(db, actor, id); // 見られる人かを確かめる
  await db.query(
    `INSERT INTO notice_reads (tenant_id, notice_id, user_id) VALUES ($1, $2, $3)
     ON CONFLICT (notice_id, user_id) DO NOTHING`,
    [actor.tenantId, id, actor.userId],
  );
  return { ok: true };
}

/** 「確認しました」を押す */
export async function ackNotice(db: Db, actor: Actor, id: string) {
  const notice = await getNotice(db, actor, id);
  assert(notice.requiresAck, 'invalid', 'この連絡事項に確認は要りません');
  const row = await one<{ acked_at: string }>(
    db,
    `INSERT INTO notice_reads (tenant_id, notice_id, user_id, acked_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (notice_id, user_id) DO UPDATE SET acked_at = coalesce(notice_reads.acked_at, now())
     RETURNING acked_at::text AS acked_at`,
    [actor.tenantId, id, actor.userId],
  );
  return { ackedAt: row.acked_at };
}

/** 誰が確認したか・まだかの一覧（trusted 以上） */
export async function noticeReaders(db: Db, actor: Actor, id: string) {
  const notice = await maybeOne<{ store_id: string | null }>(db, `SELECT store_id FROM notices WHERE id = $1`, [id]);
  assert(notice !== undefined, 'not_found', '連絡事項が見つかりません');
  assert(canModerate(actor, notice.store_id), 'forbidden', '確認の状況を見る権限がありません');
  return db.query<{ id: string; name: string; read_at: string | null; acked_at: string | null }>(
    `SELECT u.id, u.name, r.read_at::text AS read_at, r.acked_at::text AS acked_at
       FROM memberships m
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
       LEFT JOIN notice_reads r ON r.notice_id = $1 AND r.user_id = u.id
      WHERE ($2::uuid IS NULL OR m.store_id = $2)
      GROUP BY u.id, u.name, r.read_at, r.acked_at
      ORDER BY (r.acked_at IS NULL) DESC, u.name`,
    [id, notice.store_id],
  );
}

/** ホームに出す「未読・未確認の数」 */
export async function noticeBadge(db: Db, actor: Actor, storeId: string): Promise<{ unread: number; needsAck: number }> {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗の連絡事項は見られません');
  const row = await one<{ unread: number; needs_ack: number }>(
    db,
    `SELECT count(*) FILTER (WHERE r.read_at IS NULL)::int AS unread,
            count(*) FILTER (WHERE n.requires_ack AND r.acked_at IS NULL)::int AS needs_ack
       FROM notices n
       LEFT JOIN notice_reads r ON r.notice_id = n.id AND r.user_id = $2
      WHERE (n.store_id = $1 OR n.store_id IS NULL)
        AND n.starts_at <= now() AND (n.ends_at IS NULL OR n.ends_at > now())`,
    [storeId, actor.userId],
  );
  return { unread: Number(row.unread), needsAck: Number(row.needs_ack) };
}
