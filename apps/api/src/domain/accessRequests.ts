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
       FROM access_requests WHERE id = $1 AND status = 'pending'`,
    [id],
  );
  if (!row) throw new DomainError('not_found', 'この申請は見つかりません（すでに決まっているかもしれません）');

  const store = await maybeOne<{ id: string }>(db, `SELECT id FROM stores WHERE id = $1`, [input.storeId]);
  assert(store !== null, 'not_found', '店舗が見つかりません');

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
  await db.query(
    `UPDATE access_requests SET status = 'approved', decided_at = now(), decided_by = $2, user_id = $3
      WHERE id = $1`,
    [id, actor.userId, userId],
  );
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
