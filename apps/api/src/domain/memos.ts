// 個人メモ。**書いた本人だけ**が読める。店長にも本部にも、どの画面からも見えない。
//
//   today … 今日だけのメモ（お客様の会員番号の控え、今日のやること）。翌日には出なくなり、夜間バッチが消す
//   keep  … 自分で消すまで残るメモ（ナレッジにするほどではない・ほかの人には見せたくない覚え書き）
//
// どの問い合わせにも user_id = 自分 を付ける（会社の区切りは行レベルセキュリティ、人の区切りはここ）。

import { appTimeZone, todayIn } from '../config.ts';
import { maybeOne, one, type Db } from '../db/db.ts';
import { assert, type Actor } from './actor.ts';

export const MEMO_MAX_BODY = 2000;
export const MEMO_MAX_COUNT = 200;
export type MemoKind = 'today' | 'keep';

export interface MemoView {
  id: string;
  kind: MemoKind;
  body: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

interface MemoRow { id: string; kind: MemoKind; body: string; done_at: string | null; created_at: string; updated_at: string }

const COLUMNS = `id, kind, body, done_at::text AS done_at, created_at::text AS created_at, updated_at::text AS updated_at`;

function view(r: MemoRow): MemoView {
  return { id: r.id, kind: r.kind, body: r.body, done: r.done_at !== null, createdAt: r.created_at, updatedAt: r.updated_at };
}

function cleanBody(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  assert(text.length > 0 && text.length <= MEMO_MAX_BODY, 'invalid', `メモは1〜${MEMO_MAX_BODY}文字で書いてください`);
  return text;
}

function parseKind(value: unknown): MemoKind {
  assert(value === 'today' || value === 'keep', 'invalid', 'メモの種類は「今日だけ」か「残す」です');
  return value;
}

/** 自分のメモ。「今日だけ」は今日書いたものだけを出す（夜間バッチが走る前でも、日付が変われば出さない） */
export async function listMemos(db: Db, actor: Actor, today: string = todayIn(appTimeZone())): Promise<MemoView[]> {
  const rows = await db.query<MemoRow>(
    `SELECT ${COLUMNS} FROM personal_memos
      WHERE user_id = $1 AND (kind = 'keep' OR for_date >= $2::date)
      ORDER BY (done_at IS NOT NULL), created_at DESC`,
    [actor.userId, today],
  );
  return rows.map(view);
}

export async function addMemo(db: Db, actor: Actor, input: { body?: unknown; kind?: unknown }, today: string = todayIn(appTimeZone())): Promise<MemoView> {
  const body = cleanBody(input.body);
  const kind = parseKind(input.kind ?? 'today');
  const count = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM personal_memos WHERE user_id = $1`, [actor.userId]);
  assert(Number(count.n) < MEMO_MAX_COUNT, 'conflict', `メモは${MEMO_MAX_COUNT}件までです。要らないものを消してから書いてください`);
  const row = await one<MemoRow>(
    db,
    `INSERT INTO personal_memos (tenant_id, user_id, kind, body, for_date) VALUES ($1, $2, $3, $4, $5::date) RETURNING ${COLUMNS}`,
    [actor.tenantId, actor.userId, kind, body, today],
  );
  return view(row);
}

/** 書き換える・済みにする・「今日だけ」と「残す」を入れ替える。渡された項目だけを変える */
export async function updateMemo(db: Db, actor: Actor, id: string, patch: { body?: unknown; kind?: unknown; done?: unknown }, today: string = todayIn(appTimeZone())): Promise<MemoView> {
  const current = await maybeOne<MemoRow>(db, `SELECT ${COLUMNS} FROM personal_memos WHERE id = $1 AND user_id = $2`, [id, actor.userId]);
  // 他人のメモは「無い」と答える（あることも教えない）
  assert(current !== undefined, 'not_found', 'メモが見つかりません');
  const body = patch.body === undefined ? current.body : cleanBody(patch.body);
  const kind = patch.kind === undefined ? current.kind : parseKind(patch.kind);
  assert(patch.done === undefined || typeof patch.done === 'boolean', 'invalid', 'done は true か false です');
  const done = patch.done === undefined ? current.done_at !== null : patch.done;
  const row = await one<MemoRow>(
    db,
    `UPDATE personal_memos
        SET body = $3, kind = $4,
            done_at = CASE WHEN $5::boolean THEN coalesce(done_at, now()) ELSE NULL END,
            -- 「今日だけ」に戻したら、今日から数え直す（昨日のメモを戻した瞬間に消えないように）
            for_date = CASE WHEN $4 = 'today' AND kind <> 'today' THEN $6::date ELSE for_date END,
            updated_at = now()
      WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
    [id, actor.userId, body, kind, done, today],
  );
  return view(row);
}

export async function deleteMemo(db: Db, actor: Actor, id: string): Promise<{ deleted: true }> {
  const rows = await db.query<{ id: string }>(`DELETE FROM personal_memos WHERE id = $1 AND user_id = $2 RETURNING id`, [id, actor.userId]);
  assert(rows.length === 1, 'not_found', 'メモが見つかりません');
  return { deleted: true };
}

/** 夜間バッチ用：過ぎた「今日だけ」のメモを消す。消した件数を返す */
export async function sweepTodayMemos(db: Db, today: string = todayIn(appTimeZone())): Promise<number> {
  const rows = await db.query<{ id: string }>(`DELETE FROM personal_memos WHERE kind = 'today' AND for_date < $1::date RETURNING id`, [today]);
  return rows.length;
}
