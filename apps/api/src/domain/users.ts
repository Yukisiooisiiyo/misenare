// 招待・端末セッション・利用者管理。
//
// 流れ：administrator が招待を作る → トークンを QR コードにして見せる → スタッフの端末が読み取り、
// acceptInvitation でセッショントークンを受け取る → 以後は Authorization: Bearer <token> で API を呼ぶ。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { maybeOne, one, type Db } from '../db/db.ts';
import { assert, canAdminister, DomainError, type Actor, type AdminScope, type TrustLevel } from './actor.ts';
import { assertStore } from './scope.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const INVITATION_TTL_HOURS = 72;
/** この期間使われなかった端末セッションは無効にする */
export const SESSION_IDLE_DAYS = 180;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 「<tenant_id>.<ランダム>」形式のトークンを作る */
export function issueToken(tenantId: string): string {
  return `${tenantId}.${randomBytes(32).toString('base64url')}`;
}

/** トークンから tenant_id を取り出す。形式が違えば null。 */
export function parseToken(token: string): { tenantId: string } | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const tenantId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!UUID.test(tenantId) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  return { tenantId };
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface InvitationInput {
  storeId: string | null;
  /** 新しい利用者の表示名（userId を指定しないとき必須） */
  name?: string;
  /** 既存の利用者の端末を追加する（機種変更など） */
  userId?: string;
  trustLevel?: TrustLevel;
  adminScope?: AdminScope;
}

/**
 * 招待を作る。
 * 店長（admin_scope = store）は自店舗への招待だけを作れ、administrator の権限は付けられない。
 * 本部（tenant）は全店舗への招待と、店長・本部の権限付きの招待を作れる。
 */
export async function createInvitation(db: Db, actor: Actor, input: InvitationInput) {
  const adminScope = input.adminScope ?? 'none';
  const trustLevel = input.trustLevel ?? 'visitor';
  if (input.storeId !== null) {
    assert(canAdminister(actor, input.storeId), 'forbidden', '招待を作れるのは administrator のみです');
    await assertStore(db, input.storeId);
  } else {
    assert(actor.adminScope === 'tenant', 'forbidden', '店舗に属さない招待（本部）は本部のみ作れます');
  }
  if (adminScope !== 'none') assert(actor.adminScope === 'tenant', 'forbidden', '店長・本部の権限を付けられるのは本部のみです');
  assert(adminScope !== 'store' || input.storeId !== null, 'invalid', '店長の招待には店舗を指定してください');

  if (input.userId) {
    const u = await maybeOne<{ status: string }>(db, `SELECT status FROM users WHERE id = $1`, [input.userId]);
    assert(u !== undefined, 'not_found', '利用者が見つかりません');
    assert(u.status === 'active', 'conflict', '無効化された利用者です');
    if (actor.adminScope !== 'tenant') {
      const m = await maybeOne(db, `SELECT 1 FROM memberships WHERE user_id = $1 AND store_id = ANY($2::uuid[])`, [input.userId, actor.storeIds]);
      assert(m !== undefined, 'forbidden', '自店舗の利用者ではありません');
    }
  } else {
    assert(typeof input.name === 'string' && input.name.trim().length > 0 && input.name.length <= 40, 'invalid', '名前を1〜40文字で入力してください');
  }

  const token = issueToken(actor.tenantId);
  const row = await one<{ id: string; expires_at: string }>(
    db,
    `INSERT INTO invitations (tenant_id, token_hash, store_id, user_id, name, trust_level, admin_scope, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(hours => $9))
     RETURNING id, expires_at::text AS expires_at`,
    [actor.tenantId, hashToken(token), input.storeId, input.userId ?? null, input.name?.trim() ?? null, trustLevel, adminScope, actor.userId, INVITATION_TTL_HOURS],
  );
  return { invitationId: row.id, token, expiresAt: row.expires_at };
}

/**
 * 招待を受け取る（ログイン前に呼ぶ）。招待は1回限り。
 * 新しい利用者ならここで作り、店舗に所属させる。端末のセッショントークンを返す。
 * db は、トークンから取り出した tenant_id で固定した接続であること。
 */
export async function acceptInvitation(db: Db, tenantId: string, token: string, deviceName: string | null) {
  const inv = await maybeOne<{
    id: string; token_hash: string; store_id: string | null; user_id: string | null; name: string | null;
    trust_level: TrustLevel; admin_scope: AdminScope; expired: boolean; used: boolean;
  }>(
    db,
    `SELECT id, token_hash, store_id, user_id, name, trust_level, admin_scope,
            expires_at < now() AS expired, used_at IS NOT NULL AS used
       FROM invitations WHERE token_hash = $1 FOR UPDATE`,
    [hashToken(token)],
  );
  if (!inv || !sameHash(inv.token_hash, hashToken(token))) throw new DomainError('not_found', '招待が見つかりません');
  assert(!inv.used, 'conflict', 'この招待はすでに使われています');
  assert(!inv.expired, 'conflict', 'この招待は期限切れです。もう一度発行してもらってください');

  let userId = inv.user_id;
  if (userId === null) {
    const u = await one<{ id: string }>(
      db,
      `INSERT INTO users (tenant_id, name, trust_level, admin_scope) VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, inv.name, inv.trust_level, inv.admin_scope],
    );
    userId = u.id;
  } else {
    const u = await maybeOne<{ status: string }>(db, `SELECT status FROM users WHERE id = $1`, [userId]);
    assert(u?.status === 'active', 'conflict', 'この利用者は無効化されています');
  }
  if (inv.store_id !== null) {
    await db.query(
      `INSERT INTO memberships (tenant_id, user_id, store_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [tenantId, userId, inv.store_id],
    );
  }
  await db.query(`UPDATE invitations SET used_at = now(), used_by = $2 WHERE id = $1`, [inv.id, userId]);

  const sessionToken = issueToken(tenantId);
  await db.query(
    `INSERT INTO sessions (tenant_id, user_id, token_hash, device_name) VALUES ($1, $2, $3, $4)`,
    [tenantId, userId, hashToken(sessionToken), deviceName?.slice(0, 60) ?? null],
  );
  return { sessionToken, userId };
}

/** セッショントークンを照合する。有効なら利用者IDを返し、最終利用日時を更新する。 */
export async function verifySession(db: Db, token: string): Promise<{ userId: string; sessionId: string } | null> {
  const s = await maybeOne<{ id: string; user_id: string; token_hash: string; idle: boolean }>(
    db,
    `SELECT s.id, s.user_id, s.token_hash, s.last_used_at < now() - make_interval(days => $2) AS idle
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND u.status = 'active'`,
    [hashToken(token), SESSION_IDLE_DAYS],
  );
  if (!s || !sameHash(s.token_hash, hashToken(token)) || s.idle) return null;
  // 毎回書き込まないよう、1時間以上空いたときだけ更新する
  await db.query(`UPDATE sessions SET last_used_at = now() WHERE id = $1 AND last_used_at < now() - interval '1 hour'`, [s.id]);
  return { userId: s.user_id, sessionId: s.id };
}

export async function revokeSession(db: Db, actor: Actor, sessionId: string) {
  const s = await maybeOne<{ user_id: string }>(db, `SELECT user_id FROM sessions WHERE id = $1`, [sessionId]);
  assert(s !== undefined, 'not_found', '端末が見つかりません');
  if (s.user_id !== actor.userId) await assertCanManageUser(db, actor, s.user_id);
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
}

/** その利用者を管理できるか：本部は全員、店長は自店舗に所属する人（本部の人は除く） */
async function assertCanManageUser(db: Db, actor: Actor, userId: string) {
  if (actor.adminScope === 'tenant') return;
  assert(actor.adminScope === 'store', 'forbidden', '利用者を管理できるのは administrator のみです');
  const target = await maybeOne<{ admin_scope: AdminScope }>(db, `SELECT admin_scope FROM users WHERE id = $1`, [userId]);
  assert(target !== undefined, 'not_found', '利用者が見つかりません');
  assert(target.admin_scope !== 'tenant', 'forbidden', '本部の利用者は管理できません');
  const m = await maybeOne(db, `SELECT 1 FROM memberships WHERE user_id = $1 AND store_id = ANY($2::uuid[])`, [userId, actor.storeIds]);
  assert(m !== undefined, 'forbidden', '自店舗の利用者ではありません');
}

export async function listStoreUsers(db: Db, actor: Actor, storeId: string) {
  assert(canAdminister(actor, storeId), 'forbidden', '利用者の一覧を見られるのは administrator のみです');
  return db.query(
    `SELECT u.id, u.name, u.trust_level, u.admin_scope, u.status,
            (SELECT max(s.last_used_at)::text FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS last_used_at,
            (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS devices
       FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE m.store_id = $1
      ORDER BY u.trust_level DESC, u.name`,
    [storeId],
  );
}

export interface UserPatch {
  trustLevel?: TrustLevel;
  adminScope?: AdminScope;
  status?: 'active' | 'disabled';
}

/**
 * trusted の付与・解除、無効化。無効化するとその人の端末セッションもすべて失効する。
 * 店長・本部の権限を変えられるのは本部だけ。自分自身の権限は変えられない（締め出し防止）。
 */
export async function updateUser(db: Db, actor: Actor, userId: string, patch: UserPatch) {
  assert(userId !== actor.userId, 'forbidden', '自分自身の権限は変更できません');
  await assertCanManageUser(db, actor, userId);
  if (patch.adminScope !== undefined) assert(actor.adminScope === 'tenant', 'forbidden', '店長・本部の権限を変えられるのは本部のみです');
  if (patch.trustLevel !== undefined) {
    await db.query(`UPDATE users SET trust_level = $2 WHERE id = $1`, [userId, patch.trustLevel]);
  }
  if (patch.adminScope !== undefined) {
    await db.query(`UPDATE users SET admin_scope = $2 WHERE id = $1`, [userId, patch.adminScope]);
  }
  if (patch.status !== undefined) {
    await db.query(`UPDATE users SET status = $2 WHERE id = $1`, [userId, patch.status]);
    if (patch.status === 'disabled') {
      await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    }
  }
  return one(db, `SELECT id, name, trust_level, admin_scope, status FROM users WHERE id = $1`, [userId]);
}

export async function me(db: Db, actor: Actor) {
  const u = await one<{ id: string; name: string }>(db, `SELECT id, name FROM users WHERE id = $1`, [actor.userId]);
  const stores = await db.query<{ id: string; name: string }>(
    actor.adminScope === 'tenant'
      ? `SELECT id, name FROM stores ORDER BY name`
      : `SELECT id, name FROM stores WHERE id = ANY($1::uuid[]) ORDER BY name`,
    actor.adminScope === 'tenant' ? [] : [actor.storeIds],
  );
  return { ...u, trustLevel: actor.trustLevel, adminScope: actor.adminScope, stores };
}
