// 連絡事項（お知らせの掲示板）。
//
// ナレッジと分けている理由：
//   ・期間がある（終わったら引っ込む）ので、検索に残り続けると邪魔になる
//   ・「誰が読んだか・確認したか」を記録したい
// 書けるのは trusted 以上。お知らせは承認を待っていると意味が無くなるので、承認は挟まない。

import { maybeOne, one, type Db } from '../db/db.ts';
import { assert, canAccessStore, canAdminister, canModerate, isTrusted, type Actor } from './actor.ts';
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
  audience?: 'all' | 'trusted';
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
  } else if (input.endsAt && !input.startsAt) {
    // 始まりを省くと DB で now() が入る。終わりが過去だと CHECK (ends_at > starts_at) で 500 になるので先に断る
    assert(Date.parse(input.endsAt) > Date.now(), 'invalid', '掲示の終わりは、今より後にしてください');
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
              SELECT count(DISTINCT m.user_id)::int FROM memberships m
               -- 無効化された人は確認しようが無い。数えると永遠に「未確認」で残る
               JOIN users mu ON mu.id = m.user_id AND mu.status = 'active'
               WHERE (n.store_id IS NULL OR m.store_id = n.store_id)
                 AND NOT EXISTS (
                   SELECT 1 FROM notice_reads nr
                    WHERE nr.notice_id = n.id AND nr.user_id = m.user_id AND nr.acked_at IS NOT NULL)
            ) END AS pending_acks
       FROM notices n
       LEFT JOIN users u ON u.id = n.created_by
       LEFT JOIN notice_reads r ON r.notice_id = n.id AND r.user_id = $2
      WHERE (n.store_id = $1 OR n.store_id IS NULL)
        AND n.starts_at <= now()
        AND ($3 OR n.ends_at IS NULL OR n.ends_at > now())
        -- 承認できない人に承認待ちの知らせを見せても、できることが無い
        AND (n.audience = 'all' OR $4)
      ORDER BY (n.priority = 'important') DESC, n.starts_at DESC
      LIMIT 200`,
    [storeId, actor.userId, includeEnded, isTrusted(actor)],
  );
  return rows.map((r) => view(r, isTrusted(actor)));
}

export async function getNotice(db: Db, actor: Actor, id: string): Promise<NoticeView> {
  const row = await maybeOne<NoticeRow>(
    db,
    `SELECT n.id, n.store_id, n.title, n.body, n.priority, n.requires_ack,
            n.starts_at::text AS starts_at, n.ends_at::text AS ends_at,
            u.name AS author, n.created_at::text AS created_at,
            r.read_at::text AS read_at, r.acked_at::text AS acked_at, NULL::int AS pending_acks,
            n.audience
       FROM notices n LEFT JOIN users u ON u.id = n.created_by
       LEFT JOIN notice_reads r ON r.notice_id = n.id AND r.user_id = $2
      WHERE n.id = $1`,
    [id, actor.userId],
  );
  assert(row !== undefined, 'not_found', '連絡事項が見つかりません');
  assert(canAccessStore(actor, row.store_id), 'forbidden', 'この連絡事項は見られません');
  assert(row.audience === 'all' || isTrusted(actor), 'forbidden', 'この連絡事項は見られません');
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
  const row = await maybeOne<{ store_id: string | null; created_by: string | null; kind: string }>(
    db, `SELECT store_id, created_by, kind FROM notices WHERE id = $1`, [id],
  );
  assert(row !== undefined, 'not_found', '連絡事項が見つかりません');
  // ミセナレが自動で出した知らせは人が直せない（直しても次の投稿で書き換わる）
  assert(row.kind === 'manual', 'forbidden', 'この連絡事項はミセナレが自動で出しています');
  assert(canAccessStore(actor, row.store_id), 'forbidden', 'この連絡事項は直せません');
  // 全店共通（store_id が無い）は本部だけ。出すのが本部だけなのと対にする
  if (row.store_id === null) assert(actor.adminScope === 'tenant', 'forbidden', '全店共通の連絡事項は本部のみ直せます');
  // 店舗の連絡事項は、出した人か「その店舗の」administrator。他店の店長は直せない
  assert(row.created_by === actor.userId || canAdminister(actor, row.store_id), 'forbidden', '出した人か administrator だけが直せます');
  return row;
}

export async function updateNotice(db: Db, actor: Actor, id: string, input: NoticeInput) {
  validate(input);
  await assertCanEdit(db, actor, id);
  // 始まりを省いて終わりだけ送られたときは、いまの始まりと比べる（DB の CHECK で 500 にしない）
  if (input.endsAt && !input.startsAt) {
    const cur = await one<{ starts_at: string }>(db, `SELECT starts_at::text AS starts_at FROM notices WHERE id = $1`, [id]);
    assert(Date.parse(input.endsAt) > Date.parse(cur.starts_at), 'invalid', '掲示の終わりは、始まりより後にしてください');
  }
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
  // まだ始まっていない知らせを終えるときは、始まりを少し前に引いてから終える（CHECK: ends_at > starts_at）。
  // 「始まる前に終わった」記録になるが、出さずに済ませたいという意図はそのまま残る
  await db.query(
    `UPDATE notices SET starts_at = least(starts_at, now() - interval '1 second'), ends_at = now(), updated_by = $2, updated_at = now()
      WHERE id = $1`,
    [id, actor.userId],
  );
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
        AND n.starts_at <= now() AND (n.ends_at IS NULL OR n.ends_at > now())
        AND (n.audience = 'all' OR $3)`,
    [storeId, actor.userId, isTrusted(actor)],
  );
  return { unread: Number(row.unread), needsAck: Number(row.needs_ack) };
}

// --- 承認待ちの知らせ（ミセナレが自動で出す） ---------------------------------

/** 知らせに題名を出す件数。全部並べると長くなり、下書きの題名がずらりと残る */
const APPROVAL_SAMPLES = 3;

/**
 * 承認待ちの件数を、連絡事項に反映する。
 *
 * **メールではなく連絡事項にした理由：現場の人はメールアドレスを持っていない。**
 * 招待QRで入った人に email は入らず（domain/users.ts）、入るのは会社アカウント（SSO）で
 * 入った人だけ。承認するベテランの大半はQRで入るので、メールでは届かない。
 * 毎日開くアプリの中に出すのが、唯一確実に届く場所。
 *
 * 投稿のたびに知らせを増やすと、連絡事項が承認依頼で埋まって本来の連絡が沈む。
 * だから**店舗につき1件**を置いて件数を書き換える。承認待ちが無くなれば消す。
 *
 * 件数が増えたときだけ既読を消して、未読に戻す。
 * 減ったとき（誰かが承認したとき）に未読へ戻すと、承認するたび全員に赤い印が付く。
 */
export async function syncApprovalNotice(db: Db, tenantId: string, storeId: string | null): Promise<void> {
  const [count] = await db.query<{ n: number; titles: string[] | null }>(
    `SELECT count(*)::int AS n,
            (array_agg(v.title ORDER BY v.edited_at DESC))[1:${APPROVAL_SAMPLES}] AS titles
       FROM knowledge_versions v
       JOIN knowledge k ON k.id = v.knowledge_id
      WHERE v.state = 'pending' AND k.store_id IS NOT DISTINCT FROM $1`,
    [storeId],
  );
  const pending = Number(count?.n ?? 0);

  if (pending === 0) {
    await db.query(
      `DELETE FROM notices WHERE kind = 'approvals' AND store_id IS NOT DISTINCT FROM $1`,
      [storeId],
    );
    return;
  }

  const titles = count?.titles ?? [];
  const title = `承認待ちが${pending}件あります`;
  const body = [
    ...titles.map((t) => `・${t}`),
    ...(pending > titles.length ? [`ほか ${pending - titles.length} 件`] : []),
    '',
    '「承認・管理 → 承認待ち」で、内容を見て公開してください。',
    '承認するまで、この下書きは検索に出ません。',
    '',
    '間違いを見つけたときは、却下するだけでなく書いた人に伝えてください。',
    'そのほうが、次から精度が上がります。',
  ].join('\n');

  // 1文で「無ければ作る、あれば書き換える」。SELECT してから INSERT だと、2人が同時に投稿したとき
  // 両方が「無い」を見て INSERT し、片方が一意索引（notices_one_approvals）で落ちて投稿ごと巻き戻る。
  // RETURNING の副問合せは文の始まりの状態を見るので、前の題名（＝前の件数）がそこから取れる
  const [row] = await db.query<{ id: string; previous: string | null }>(
    `INSERT INTO notices (tenant_id, store_id, title, body, priority, requires_ack, kind, audience, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'normal', false, 'approvals', 'trusted', NULL, NULL)
     ON CONFLICT (tenant_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE kind = 'approvals'
     DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, updated_at = now()
     RETURNING id, (SELECT n.title FROM notices n WHERE n.id = notices.id) AS previous`,
    [tenantId, storeId, title, body],
  );
  const before = Number(/(\d+)/.exec(row?.previous ?? '')?.[1] ?? 0);
  // 増えたときだけ未読に戻す。減ったとき（誰かが承認したとき）に戻すと、
  // 承認するたびに全員へ赤い印が付く
  if (row && pending > before) {
    await db.query(`DELETE FROM notice_reads WHERE notice_id = $1`, [row.id]);
  }
}
