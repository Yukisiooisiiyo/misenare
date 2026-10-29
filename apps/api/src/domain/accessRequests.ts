// 会社のアカウントで入れたが、まだ登録されていない人の申請。
//
// 行き止まり（「店長か本部に依頼してください」）をやめて、申請として受ける。
// ここに載るのは、**相手の IdP の署名を通り、確認済みの会社メールアドレスを持ち、
// 登録済みのドメインに属する人**だけ。その会社の人であることは確かで、
// こちらに登録がないだけなので、店長が見て決められる形にする。
//
// 自動で作る（jit_enabled）との違いは、人が見るかどうかだけ。
// 既定はこちら。1万人を先に登録してもらう必要はなく、知らない人も勝手には入れない。

import { maybeOne, one, type Db } from '../db/db.ts';
import { assertStore } from './scope.ts';
import { looksLikeEmail } from '../mail/mailer.ts';
import { assert, DomainError, type Actor, type TrustLevel } from './actor.ts';

/** 待っている申請の上限。これを超えたら新しい申請を受けない */
export const MAX_PENDING = 500;

export type RequestOutcome =
  /** いま受け付けた */
  | { kind: 'created' }
  /** すでに待っている */
  | { kind: 'pending'; attempts: number }
  /** 断られている */
  | { kind: 'rejected' };

/**
 * 申請を受ける（または、すでにある申請を数え直す）。
 * SSO の戻りの中から呼ぶので、会社は決まっている。
 */
export async function recordRequest(
  db: Db,
  input: { tenantId: string; providerId: string; subject: string; email: string; name: string | null },
): Promise<RequestOutcome> {
  const existing = await maybeOne<{ status: string; attempts: number }>(
    db,
    `UPDATE access_requests
        SET attempts = attempts + 1, last_seen_at = now(),
            email = $3, claimed_name = COALESCE($4, claimed_name)
      WHERE provider_id = $1 AND subject = $2
      RETURNING status, attempts`,
    [input.providerId, input.subject, input.email, input.name],
  );
  if (existing) {
    if (existing.status === 'rejected') return { kind: 'rejected' };
    // 承認済みなのにここに来たのは、承認後に利用者が無効にされた場合。
    // 申請を開き直すのではなく、無効の扱い（別の経路）に任せる
    if (existing.status === 'approved') return { kind: 'pending', attempts: existing.attempts };
    return { kind: 'pending', attempts: existing.attempts };
  }

  const waiting = await one<{ count: number }>(
    db, `SELECT count(*)::int AS count FROM access_requests WHERE status = 'pending'`,
  );
  // 溜まりすぎたら受けない。会社のアドレスを持つ人しか来ないので普通は起きないが、
  // 退職者のアカウントが残っている会社では数が出ることがある
  assert(waiting.count < MAX_PENDING, 'conflict',
    '申請が溜まっています。本部にご連絡ください');

  await db.query(
    `INSERT INTO access_requests (tenant_id, provider_id, subject, email, claimed_name)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.tenantId, input.providerId, input.subject, input.email, input.name],
  );
  return { kind: 'created' };
}

export interface AccessRequestView {
  id: string;
  email: string;
  claimedName: string | null;
  attempts: number;
  requestedAt: string;
  lastSeenAt: string;
  /** すでに同じ名前の人がいるか（なりすましの見分けのため） */
  nameTaken: boolean;
}

function requireAdmin(actor: Actor): void {
  assert(actor.adminScope !== 'none', 'forbidden', '申請を見られるのは店長か本部だけです');
}

/** 待っている申請。何度も入ろうとしている人を先に出す（急いでいる人から見られる） */
export async function listRequests(db: Db, actor: Actor): Promise<AccessRequestView[]> {
  requireAdmin(actor);
  const rows = await db.query<{
    id: string; email: string; claimed_name: string | null; attempts: number;
    requested_at: string; last_seen_at: string; name_taken: boolean;
  }>(
    `SELECT r.id, r.email, r.claimed_name, r.attempts,
            r.requested_at::text AS requested_at, r.last_seen_at::text AS last_seen_at,
            EXISTS (
              SELECT 1 FROM users u
               WHERE u.status = 'active' AND r.claimed_name IS NOT NULL AND u.name = r.claimed_name
            ) AS name_taken
       FROM access_requests r
      WHERE r.status = 'pending'
      ORDER BY r.attempts DESC, r.last_seen_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    claimedName: r.claimed_name,
    attempts: r.attempts,
    requestedAt: r.requested_at,
    lastSeenAt: r.last_seen_at,
    nameTaken: r.name_taken,
  }));
}

export interface ApproveInput {
  /** 配属する店舗。店長は自分の店舗にしか配属できない */
  storeId: string;
  /** 名前。相手の IdP が名乗ったものを直せる（似せた名前で入ってくる余地があるため） */
  name?: string;
  trustLevel?: TrustLevel;
}

/**
 * 承認して、利用者を作る。
 *
 * 名前は承認する人が決められる。相手の IdP が名乗った名前をそのまま使うと、
 * 既存の人に似せた名前が一覧に並ぶ。既定は名乗った名前だが、直せるようにしておく。
 *
 * 作ったあと、SSO の結び付け（sso_identities）も張る。張らないと次に入ったとき
 * またメールアドレスで探すことになり、アドレスが変わると結びつかない。
 */
export async function approveRequest(
  db: Db, actor: Actor, id: string, input: ApproveInput,
): Promise<{ userId: string }> {
  requireAdmin(actor);
  if (actor.adminScope === 'store') {
    assert(actor.storeIds.includes(input.storeId), 'forbidden', '自分の店舗にしか配属できません');
  }
  const row = await maybeOne<{
    provider_id: string; subject: string; email: string; claimed_name: string | null; tenant_id: string;
  }>(
    db,
    `SELECT provider_id, subject, email, claimed_name, tenant_id
       FROM access_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`,
    [id],
  );
  if (!row) throw new DomainError('not_found', 'この申請は見つかりません（すでに決まっているかもしれません）');

  // maybeOne は無いとき undefined を返す（null ではない）。一周目でここを直したつもりで直っていなかった
  await assertStore(db, input.storeId);

  const name = (input.name ?? row.claimed_name ?? row.email.split('@')[0]!).trim().slice(0, 60);
  assert(name !== '', 'invalid', '名前を入れてください');

  // 同じアドレスの人がすでにいれば、作らずにその人に結びつける
  const already = await maybeOne<{ id: string }>(
    db, `SELECT id FROM users WHERE lower(email) = lower($1)`, [row.email],
  );
  const userId = already?.id ?? (await one<{ id: string }>(
    db,
    `INSERT INTO users (tenant_id, name, trust_level, employment_type, email)
     VALUES ($1, $2, $3, 'employee', $4) RETURNING id`,
    [row.tenant_id, name, input.trustLevel ?? 'visitor', row.email],
  )).id;

  await db.query(
    `INSERT INTO memberships (tenant_id, user_id, store_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, store_id) DO NOTHING`,
    [row.tenant_id, userId, input.storeId],
  );
  await db.query(
    `INSERT INTO sso_identities (tenant_id, provider_id, subject, user_id, email)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider_id, subject) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [row.tenant_id, row.provider_id, row.subject, userId, row.email],
  );
  // 行ロックで待たされた側がここで pending でなくなっていれば、2重承認なので止める
  const done = await db.query(
    `UPDATE access_requests SET status = 'approved', decided_at = now(), decided_by = $2, user_id = $3
      WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id, actor.userId, userId],
  );
  assert(done.length === 1, 'conflict', 'この申請はすでに処理されています');
  return { userId };
}

/** 断る。消さずに残す（同じ人が入り直してきたときに、また一覧に出さないため） */
export async function rejectRequest(db: Db, actor: Actor, id: string): Promise<{ ok: true }> {
  requireAdmin(actor);
  const row = await maybeOne<{ id: string }>(
    db,
    `UPDATE access_requests SET status = 'rejected', decided_at = now(), decided_by = $2
      WHERE id = $1 AND status = 'pending' RETURNING id`,
    [id, actor.userId],
  );
  if (!row) throw new DomainError('not_found', 'この申請は見つかりません（すでに決まっているかもしれません）');
  return { ok: true };
}

/**
 * ホームに出す数。**店長・本部だけ**に返す（それ以外は 0）。
 *
 * 承認・管理を開かないと申請に気づけないと、申請した人がいつまでも待つことになる。
 * 出勤してすぐ分かるところに出す。
 */
export async function requestBadge(db: Db, actor: Actor): Promise<{ pending: number }> {
  if (actor.adminScope === 'none') return { pending: 0 };
  const row = await one<{ count: number }>(
    db, `SELECT count(*)::int AS count FROM access_requests WHERE status = 'pending'`,
  );
  return { pending: row.count };
}

// --- 本部への知らせ -----------------------------------------------------------

export interface PendingDigest {
  /** 送る先。決まっていなければ null */
  to: string | null;
  pending: number;
  /** 新しい順に、いくつか */
  samples: Array<{ email: string; claimedName: string | null }>;
  /** 最後に知らせた時刻 */
  notifiedAt: string | null;
  /** 知らせたあとに来た申請があるか */
  hasNew: boolean;
}

/** 念押しの間隔。待っている申請があっても、これより短い間隔では送らない */
export const REMINDER_DAYS = 7;

/**
 * 知らせるべきことがあるかを調べる。
 *
 * 毎晩送ると、1件が1か月放置されただけで30通になる。
 * **新しい申請が来たとき**と、**週に1回の念押し**だけにする。
 */
export async function pendingDigest(db: Db): Promise<PendingDigest> {
  // tenant_settings は行レベルセキュリティで自社の1行しか見えない。無ければ未設定として扱う
  const tenant = (await maybeOne<{ notify_email: string | null; requests_notified_at: string | null }>(
    db, `SELECT notify_email, requests_notified_at::text AS requests_notified_at FROM tenant_settings`,
  )) ?? { notify_email: null, requests_notified_at: null };
  const rows = await db.query<{ email: string; claimed_name: string | null; requested_at: string }>(
    `SELECT email, claimed_name, requested_at::text AS requested_at
       FROM access_requests WHERE status = 'pending' ORDER BY requested_at DESC`,
  );
  const since = tenant.requests_notified_at === null ? null : new Date(tenant.requests_notified_at).getTime();
  return {
    to: tenant.notify_email,
    pending: rows.length,
    samples: rows.slice(0, 5).map((r) => ({ email: r.email, claimedName: r.claimed_name })),
    notifiedAt: tenant.requests_notified_at,
    hasNew: since === null
      ? rows.length > 0
      : rows.some((r) => new Date(r.requested_at).getTime() > since),
  };
}

export function shouldNotify(digest: PendingDigest, now = Date.now()): boolean {
  if (digest.to === null || digest.pending === 0) return false;
  if (digest.hasNew) return true;
  if (digest.notifiedAt === null) return true;
  const elapsed = now - new Date(digest.notifiedAt).getTime();
  return elapsed >= REMINDER_DAYS * 24 * 60 * 60_000;
}

export async function markNotified(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO tenant_settings (tenant_id, requests_notified_at)
     VALUES (current_setting('app.tenant_id')::uuid, now())
     ON CONFLICT (tenant_id) DO UPDATE SET requests_notified_at = now()`,
  );
}

/**
 * 知らせの文面。
 *
 * 申請者のメールアドレスを載せるのは、受け取った本部が**誰のことか分かる**ようにするため。
 * 載せないと「3件あります」だけになり、アプリを開くまで誰だか分からない。
 * 宛先は会社が自分で決めた窓口で、申請者は同じ会社の人なので、ここで出してよい。
 * ただし出すのは5件までにして、全員の名簿がメールで回ることは避ける。
 */
export function digestMail(digest: PendingDigest, appUrl: string): { subject: string; text: string } {
  const lines = [
    `会社のアカウントで入ろうとしている方が ${digest.pending} 名、承認をお待ちです。`,
    '',
    ...digest.samples.map((s) => `  ・${s.claimedName ?? '（名前なし）'}（${s.email}）`),
    ...(digest.pending > digest.samples.length ? [`  ほか ${digest.pending - digest.samples.length} 名`] : []),
    '',
    'ミセナレの「承認・管理 → 利用の申請」で、名前と配属先を決めて承認してください。',
    `  ${appUrl}/app/#/manage`,
    '',
    '※ 承認するまで、この方はミセナレを使えません。',
    '※ 心当たりのない方が並んでいる場合は、承認せずに「断る」を押してください。',
    '',
    'このメールはミセナレが自動で送っています。返信は不要です。',
    '送り先を変えるには、本部の管理者が「承認・管理 → 会社のアカウント」で設定してください。',
  ];
  return {
    subject: `【ミセナレ】利用の申請が${digest.pending}件あります`,
    text: lines.join('\n'),
  };
}

// --- 知らせの送り先（本部の管理者が決める） -----------------------------------

export interface NotifySettings {
  notifyEmail: string | null;
  /** メールを送れる設定になっているか（なっていなければ、入れても届かない） */
  mailConfigured: boolean;
}

export async function getNotifySettings(db: Db, actor: Actor, mailConfigured: boolean): Promise<NotifySettings> {
  assert(actor.adminScope === 'tenant', 'forbidden', '知らせの送り先を触れるのは本部の管理者だけです');
  const row = await maybeOne<{ notify_email: string | null }>(db, `SELECT notify_email FROM tenant_settings`);
  return { notifyEmail: row?.notify_email ?? null, mailConfigured };
}

/**
 * 送り先を決める。空にすれば知らせを止める。
 *
 * 宛先は1つだけにしている。複数にすると「誰が見るか」が曖昧になり、
 * かえって誰も見なくなる。会社の窓口アドレス（情報システム部など）を1つ預かる形。
 */
export async function setNotifyEmail(db: Db, actor: Actor, value: string | null): Promise<NotifySettings> {
  assert(actor.adminScope === 'tenant', 'forbidden', '知らせの送り先を触れるのは本部の管理者だけです');
  const email = value === null ? null : value.trim();
  if (email !== null && email !== '') {
    assert(looksLikeEmail(email), 'invalid', 'メールアドレスの形が違います');
    assert(email.length <= 200, 'invalid', 'メールアドレスが長すぎます');
  }
  await db.query(
    `INSERT INTO tenant_settings (tenant_id, notify_email) VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO UPDATE SET notify_email = EXCLUDED.notify_email`,
    [actor.tenantId, email === '' ? null : email],
  );
  return { notifyEmail: email === '' ? null : email, mailConfigured: true };
}
