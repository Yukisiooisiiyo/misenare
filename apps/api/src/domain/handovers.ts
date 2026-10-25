// 引き継ぎ（その日の申し送り）。
//
// ナレッジや連絡事項と違って、承認を待たない。visitor も書ける。
// 「次の人に伝える」ことが目的なので、遅れたら意味が無くなるから。
// 片付いていないものは翌日以降も出し続ける（持ち越し）。

import { maybeOne, one, type Db } from '../db/db.ts';
import { assert, canAccessStore, canModerate, type Actor } from './actor.ts';
import { assertStore } from './scope.ts';

export const MAX_BODY = 1000;
/** 持ち越しをどこまでさかのぼって出すか */
export const CARRY_OVER_DAYS = 14;

export interface HandoverView {
  id: string;
  body: string;
  state: 'open' | 'done';
  forDate: string;
  createdBy: string | null;
  createdAt: string;
  doneBy: string | null;
  doneAt: string | null;
  /** その日のものではなく、前の日から持ち越されたもの */
  carriedOver: boolean;
}

interface HandoverRow {
  id: string;
  body: string;
  state: 'open' | 'done';
  for_date: string;
  author: string | null;
  created_at: string;
  done_by_name: string | null;
  done_at: string | null;
}

function view(row: HandoverRow, today: string): HandoverView {
  return {
    id: row.id,
    body: row.body,
    state: row.state,
    forDate: row.for_date,
    createdBy: row.author,
    createdAt: row.created_at,
    doneBy: row.done_by_name,
    doneAt: row.done_at,
    carriedOver: row.for_date < today,
  };
}

/**
 * その日の引き継ぎ。
 * 「その日に書かれたもの」と「前の日までで片付いていないもの」を一緒に返す。
 */
export async function listHandovers(db: Db, actor: Actor, storeId: string, date?: string) {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗の引き継ぎは見られません');
  await assertStore(db, storeId);
  assert(date === undefined || /^\d{4}-\d{2}-\d{2}$/.test(date), 'invalid', '日付は YYYY-MM-DD で指定してください');
  const rows = await db.query<HandoverRow & { today: string }>(
    `WITH target AS (SELECT coalesce($2::date, current_date) AS d)
     SELECT h.id, h.body, h.state, h.for_date::text AS for_date,
            u.name AS author, h.created_at::text AS created_at,
            d.name AS done_by_name, h.done_at::text AS done_at,
            (SELECT d FROM target)::text AS today
       FROM handovers h
       JOIN users u ON u.id = h.created_by
       LEFT JOIN users d ON d.id = h.done_by
      WHERE h.store_id = $1
        AND (h.for_date = (SELECT d FROM target)
             OR (h.state = 'open' AND h.for_date < (SELECT d FROM target)
                 AND h.for_date >= (SELECT d FROM target) - $3::int))
      ORDER BY (h.state = 'done'), h.for_date, h.created_at`,
    [storeId, date ?? null, CARRY_OVER_DAYS],
  );
  const today = rows[0]?.today ?? (date ?? new Date().toISOString().slice(0, 10));
  return rows.map((r) => view(r, today));
}

/** 書く。その店舗にいる人なら誰でも（visitor も） */
export async function addHandover(db: Db, actor: Actor, storeId: string, body: string, forDate?: string) {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗には書けません');
  await assertStore(db, storeId);
  const text = body?.trim() ?? '';
  assert(text.length > 0 && text.length <= MAX_BODY, 'invalid', `引き継ぎは1〜${MAX_BODY}文字で書いてください`);
  assert(forDate === undefined || /^\d{4}-\d{2}-\d{2}$/.test(forDate), 'invalid', '日付は YYYY-MM-DD で指定してください');
  const row = await one<{ id: string; for_date: string }>(
    db,
    `INSERT INTO handovers (tenant_id, store_id, body, for_date, created_by)
     VALUES ($1, $2, $3, coalesce($4::date, current_date), $5)
     RETURNING id, for_date::text AS for_date`,
    [actor.tenantId, storeId, text, forDate ?? null, actor.userId],
  );
  return { id: row.id, forDate: row.for_date };
}

async function load(db: Db, id: string) {
  const row = await maybeOne<{ store_id: string; created_by: string; state: string }>(
    db, `SELECT store_id, created_by, state FROM handovers WHERE id = $1`, [id],
  );
  assert(row !== undefined, 'not_found', '引き継ぎが見つかりません');
  return row;
}

/** 片付いた・やり直す。その店舗の人なら誰でも押せる（見た人が片付ける前提） */
export async function setHandoverState(db: Db, actor: Actor, id: string, state: 'open' | 'done') {
  const row = await load(db, id);
  assert(canAccessStore(actor, row.store_id), 'forbidden', 'この引き継ぎは触れません');
  await db.query(
    state === 'done'
      ? `UPDATE handovers SET state = 'done', done_by = $2, done_at = now() WHERE id = $1`
      : `UPDATE handovers SET state = 'open', done_by = NULL, done_at = NULL WHERE id = $1`,
    [id, actor.userId],
  );
  return { id, state };
}

/** 消せるのは書いた本人と trusted 以上 */
export async function deleteHandover(db: Db, actor: Actor, id: string) {
  const row = await load(db, id);
  assert(canAccessStore(actor, row.store_id), 'forbidden', 'この引き継ぎは消せません');
  assert(row.created_by === actor.userId || canModerate(actor, row.store_id), 'forbidden', '書いた人か trusted 以上だけが消せます');
  await db.query(`DELETE FROM handovers WHERE id = $1`, [id]);
  return { ok: true };
}

/** ホームに出す「今日の引き継ぎで、まだ片付いていない数」 */
export async function handoverBadge(db: Db, actor: Actor, storeId: string): Promise<{ open: number; carriedOver: number }> {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗の引き継ぎは見られません');
  const row = await one<{ open: number; carried: number }>(
    db,
    `SELECT count(*)::int AS open,
            count(*) FILTER (WHERE for_date < current_date)::int AS carried
       FROM handovers
      WHERE store_id = $1 AND state = 'open' AND for_date >= current_date - $2::int`,
    [storeId, CARRY_OVER_DAYS],
  );
  return { open: Number(row.open), carriedOver: Number(row.carried) };
}

/**
 * 古い引き継ぎを片付ける（夜間バッチ）。
 * 持ち越しの期間を過ぎて残っているものは、出し続けても見られないので done にする。
 */
export async function closeStaleHandovers(db: Db, days = CARRY_OVER_DAYS): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `UPDATE handovers SET state = 'done', done_at = now()
      WHERE state = 'open' AND for_date < current_date - $1::int
      RETURNING id`,
    [days],
  );
  return rows.length;
}
