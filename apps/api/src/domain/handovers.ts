// 引き継ぎ（その日の申し送り）。
//
// ナレッジや連絡事項と違って、承認を待たない。visitor も書ける。
// 「次の人に伝える」ことが目的なので、遅れたら意味が無くなるから。
// 片付いていないものは翌日以降も出し続ける（持ち越し）。
//
// 誰がやったかを必ず残す。押し間違いが起きる前提で作っている。
//   ・削除は印を付けるだけで、行は消さない（戻せる）
//   ・書いた・片付けた・やり直した・消した・戻した を1件ずつ記録する

import { maybeOne, one, type Db } from '../db/db.ts';
import { assert, canAccessStore, canModerate, type Actor } from './actor.ts';
import { assertStore } from './scope.ts';

export const MAX_BODY = 1000;
/** 持ち越しをどこまでさかのぼって出すか */
export const CARRY_OVER_DAYS = 14;

export type HandoverAction = 'created' | 'done' | 'reopened' | 'deleted' | 'restored';

export const ACTION_LABEL: Record<HandoverAction, string> = {
  created: '書いた',
  done: '片付けた',
  reopened: 'やり直した',
  deleted: '消した',
  restored: '戻した',
};

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
  deletedBy?: string | null;
  deletedAt?: string | null;
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
  deleted_by_name?: string | null;
  deleted_at?: string | null;
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
    ...(row.deleted_at !== undefined ? { deletedBy: row.deleted_by_name ?? null, deletedAt: row.deleted_at } : {}),
  };
}

/** 誰が何をしたかを1行残す */
async function record(db: Db, actor: Actor, handoverId: string, action: HandoverAction): Promise<void> {
  await db.query(
    `INSERT INTO handover_events (tenant_id, handover_id, action, actor_id) VALUES ($1, $2, $3, $4)`,
    [actor.tenantId, handoverId, action, actor.userId],
  );
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
        AND h.deleted_at IS NULL
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
  await record(db, actor, row.id, 'created');
  return { id: row.id, forDate: row.for_date };
}

async function load(db: Db, id: string) {
  const row = await maybeOne<{ store_id: string; created_by: string; state: string; deleted_at: string | null }>(
    db, `SELECT store_id, created_by, state, deleted_at::text AS deleted_at FROM handovers WHERE id = $1`, [id],
  );
  assert(row !== undefined, 'not_found', '引き継ぎが見つかりません');
  return row;
}

/** 片付いた・やり直す。その店舗の人なら誰でも押せる（見た人が片付ける前提） */
export async function setHandoverState(db: Db, actor: Actor, id: string, state: 'open' | 'done') {
  const row = await load(db, id);
  assert(canAccessStore(actor, row.store_id), 'forbidden', 'この引き継ぎは触れません');
  assert(row.deleted_at === null, 'conflict', 'この引き継ぎは消されています。先に戻してください');
  // 問い合わせごとに値の数が違うので、分けて書く（psql では通っても pg では落ちるため）
  if (state === 'done') {
    await db.query(`UPDATE handovers SET state = 'done', done_by = $2, done_at = now() WHERE id = $1`, [id, actor.userId]);
  } else {
    await db.query(`UPDATE handovers SET state = 'open', done_by = NULL, done_at = NULL WHERE id = $1`, [id]);
  }
  await record(db, actor, id, state === 'done' ? 'done' : 'reopened');
  return { id, state };
}

/**
 * 消せるのは書いた本人と trusted 以上。
 * 行は残したまま印を付けるだけ。押し間違えても戻せるようにするため。
 */
export async function deleteHandover(db: Db, actor: Actor, id: string) {
  const row = await load(db, id);
  assert(canAccessStore(actor, row.store_id), 'forbidden', 'この引き継ぎは消せません');
  assert(row.created_by === actor.userId || canModerate(actor, row.store_id), 'forbidden', '書いた人か trusted 以上だけが消せます');
  assert(row.deleted_at === null, 'conflict', 'この引き継ぎはすでに消されています');
  await db.query(`UPDATE handovers SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [id, actor.userId]);
  await record(db, actor, id, 'deleted');
  return { ok: true };
}

/** 消したものを戻す（押し間違いの取り消し） */
export async function restoreHandover(db: Db, actor: Actor, id: string) {
  const row = await load(db, id);
  assert(canAccessStore(actor, row.store_id), 'forbidden', 'この引き継ぎは戻せません');
  assert(row.deleted_at !== null, 'conflict', 'この引き継ぎは消されていません');
  await db.query(`UPDATE handovers SET deleted_at = NULL, deleted_by = NULL WHERE id = $1`, [id]);
  await record(db, actor, id, 'restored');
  return { id, restored: true };
}

/** ホームに出す「今日の引き継ぎで、まだ片付いていない数」 */
export async function handoverBadge(db: Db, actor: Actor, storeId: string): Promise<{ open: number; carriedOver: number }> {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗の引き継ぎは見られません');
  const row = await one<{ open: number; carried: number }>(
    db,
    `SELECT count(*)::int AS open,
            count(*) FILTER (WHERE for_date < current_date)::int AS carried
       FROM handovers
      WHERE store_id = $1 AND state = 'open' AND deleted_at IS NULL AND for_date >= current_date - $2::int`,
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
      WHERE state = 'open' AND deleted_at IS NULL AND for_date < current_date - $1::int
      RETURNING id`,
    [days],
  );
  return rows.length;
}

// --- 履歴 ---------------------------------------------------------------------------

/** 履歴の出し方。actions＝操作された分だけ、all＝書かれたものすべて */
export type HistoryScope = 'actions' | 'all';

export interface HandoverEvent {
  action: HandoverAction;
  /** 画面に出す言い方（片付けた・消した…） */
  label: string;
  by: string | null;
  at: string;
}

export interface HandoverHistoryItem {
  id: string;
  body: string;
  state: 'open' | 'done';
  forDate: string;
  deleted: boolean;
  createdBy: string | null;
  createdAt: string;
  /** 古い順。誰が何をしたか */
  events: HandoverEvent[];
  /** いちばん新しい操作（並び順の基準） */
  lastAction: HandoverEvent;
}

/** 履歴をさかのぼる上限（日数） */
export const HISTORY_DAYS = 90;

/**
 * 引き継ぎの履歴。
 *   actions … 片付けた・消したなど、誰かが手を加えたものだけ（責任の所在を追うとき）
 *   all     … まだ何もされていないものも含めて全部（その日の全体を見るとき）
 * どちらも新しい操作の順に並べ、1件ごとに誰が何をしたかを添える。
 */
export async function handoverHistory(
  db: Db, actor: Actor, storeId: string, scope: HistoryScope = 'actions', days = HISTORY_DAYS,
) {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗の履歴は見られません');
  await assertStore(db, storeId);
  assert(Number.isInteger(days) && days > 0 && days <= 365, 'invalid', '日数は1〜365で指定してください');

  const rows = await db.query<{
    id: string; body: string; state: 'open' | 'done'; for_date: string;
    deleted: boolean; author: string | null; created_at: string;
    action: HandoverAction; actor_name: string | null; at: string;
  }>(
    `SELECT h.id, h.body, h.state, h.for_date::text AS for_date,
            h.deleted_at IS NOT NULL AS deleted,
            au.name AS author, h.created_at::text AS created_at,
            e.action, eu.name AS actor_name, e.at::text AS at
       FROM handovers h
       JOIN users au ON au.id = h.created_by
       JOIN handover_events e ON e.handover_id = h.id
       JOIN users eu ON eu.id = e.actor_id
      WHERE h.store_id = $1
        AND h.created_at >= now() - make_interval(days => $2)
        AND ($3 OR EXISTS (
              SELECT 1 FROM handover_events x
               WHERE x.handover_id = h.id AND x.action <> 'created'))
      ORDER BY h.id, e.at, e.id`,
    [storeId, days, scope === 'all'],
  );

  const byId = new Map<string, HandoverHistoryItem>();
  for (const r of rows) {
    const event: HandoverEvent = { action: r.action, label: ACTION_LABEL[r.action], by: r.actor_name, at: r.at };
    const found = byId.get(r.id);
    if (found) {
      found.events.push(event);
      found.lastAction = event;
      continue;
    }
    byId.set(r.id, {
      id: r.id,
      body: r.body,
      state: r.state,
      forDate: r.for_date,
      deleted: r.deleted,
      createdBy: r.author,
      createdAt: r.created_at,
      events: [event],
      lastAction: event,
    });
  }
  // 新しい操作の順（同じ時刻なら書かれた順）
  return [...byId.values()].sort((a, b) =>
    b.lastAction.at.localeCompare(a.lastAction.at) || b.createdAt.localeCompare(a.createdAt));
}
