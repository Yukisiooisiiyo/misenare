// 招待・端末セッション・利用者管理。
//
// 流れ：administrator が招待を作る → トークンを QR コードにして見せる → スタッフの端末が読み取り、
// acceptInvitation でセッショントークンを受け取る → 以後は Authorization: Bearer <token> で API を呼ぶ。

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { maybeOne, one, type Database, type Db } from '../db/db.ts';
import { assert, canAdminister, DomainError, type Actor, type AdminScope, type TrustLevel } from './actor.ts';
import { assertStore } from './scope.ts';
import { looksLikeEmail, type Mailer } from '../mail/mailer.ts';

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
    // 既存の人への招待は、受け取った端末が**その人として**入れる鍵になる。
    // 作った人の手元にも鍵が残るので、「誰の鍵を作れるか」は「誰を管理できるか」と同じにする。
    // 店長が本部の人の鍵を作れると、それを自分で使って本部になれてしまう。
    const u = await maybeOne<{ status: string; admin_scope: AdminScope }>(db, `SELECT status, admin_scope FROM users WHERE id = $1`, [input.userId]);
    assert(u !== undefined, 'not_found', '利用者が見つかりません');
    assert(u.status === 'active', 'conflict', '無効化された利用者です');
    await assertCanManageUser(db, actor, input.userId);
    // 店長・本部の鍵を作り直せるのは本部だけ（店長同士でも、相手になりすませる形は作らない）
    if (u.admin_scope !== 'none') assert(actor.adminScope === 'tenant', 'forbidden', '店長・本部の端末を追加できるのは本部のみです');
  } else {
    assert(typeof input.name === 'string' && input.name.trim().length > 0 && input.name.length <= 40, 'invalid', '名前を1〜40文字で入力してください');
  }
  // userId を指定したときも name は記録に残るので、あれば同じ上限で止める
  if (input.userId && input.name !== undefined) assert(input.name.length <= 40, 'invalid', '名前は40文字以内にしてください');

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

/** 別端末ログイン用URLの有効期限（短め。発行してすぐ使う想定）。 */
export const DEVICE_LINK_TTL_MINUTES = 30;

/**
 * 自分の今のアカウントに、別の端末を一時URLで足すためのワンタイム鍵。
 *
 * 他人を招く createInvitation と違い、**管理者権限は要らない**（自分の端末を増やすだけ）。
 * user_id に自分を入れるので、受け取った端末は「自分として」入る（新しい利用者は作らない）。
 * 本部の人は createInvitation だと自分の端末すら足せない（assertCanManageUser で弾かれる）ので、
 * ここで self 専用の経路を用意する。鍵は短命・1回限り。
 */
export async function createDeviceLink(db: Db, actor: Actor): Promise<{ token: string; expiresAt: string }> {
  const token = issueToken(actor.tenantId);
  const row = await one<{ expires_at: string }>(
    db,
    `INSERT INTO invitations (tenant_id, token_hash, store_id, user_id, name, trust_level, admin_scope, created_by, expires_at)
     VALUES ($1, $2, NULL, $3, NULL, $4, $5, $3, now() + make_interval(mins => $6))
     RETURNING expires_at::text AS expires_at`,
    [actor.tenantId, hashToken(token), actor.userId, actor.trustLevel, actor.adminScope, DEVICE_LINK_TTL_MINUTES],
  );
  return { token, expiresAt: row.expires_at };
}

/** 自分のメールアドレスを登録・変更する。テナント内で一意（DB の users_email_per_tenant で担保）。 */
export async function setMyEmail(db: Db, actor: Actor, email: string): Promise<{ email: string }> {
  const addr = email.trim();
  assert(looksLikeEmail(addr), 'invalid', 'メールアドレスの形が正しくありません');
  try {
    await db.query(`UPDATE users SET email = $2 WHERE id = $1`, [actor.userId, addr]);
  } catch {
    // 一意制約違反：同じメアドが社内の別の人に使われている
    throw new DomainError('conflict', 'このメールアドレスは、社内の別のアカウントで使われています');
  }
  return { email: addr };
}

/**
 * 「メールでログインリンクを受け取る」。メアドから本人を引き、その宛先へワンタイムのログインURLを送る。
 *
 * 未ログインから呼ぶので、テナントを跨いでメアド→本人を引く（RLS 外の raw）。
 * **存在を漏らさない**：見つからなくても形が違っても、呼び出し側は常に同じ応答を返す（この関数は投げない）。
 * 実際に送れるのは、メアドが登録済みの本人だけ。鍵は createDeviceLink と同じく短命・1回限り。
 */
export async function sendEmailLogin(database: Database, mailer: Mailer, appUrl: string, email: string): Promise<void> {
  const addr = email.trim().toLowerCase();
  if (!looksLikeEmail(addr)) return;
  const rows = await database.raw(
    `SELECT id, tenant_id, trust_level, admin_scope FROM users WHERE lower(email) = $1 AND status = 'active' LIMIT 1`,
    [addr],
  ) as Array<{ id: string; tenant_id: string; trust_level: TrustLevel; admin_scope: AdminScope }>;
  const u = rows[0];
  if (!u) return; // 登録が無ければ、何も送らない（応答は呼び出し側が常に成功を返す）
  const actor: Actor = { userId: u.id, tenantId: u.tenant_id, storeIds: [], trustLevel: u.trust_level, adminScope: u.admin_scope };
  const { token } = await database.withTenant(u.tenant_id, (db) => createDeviceLink(db, actor));
  const link = `${appUrl.replace(/\/+$/, '')}/app/#invite=${encodeURIComponent(token)}`;
  await mailer.send({
    to: [addr],
    subject: '【ツギガミ】ログイン用リンク',
    text: [
      'ツギガミにログインするためのリンクです。',
      '',
      '下のリンクをこの端末で開くと、そのままログインできます（1回限り・30分以内）。',
      link,
      '',
      'このメールに心当たりがない場合は、そのまま破棄してください。',
    ].join('\n'),
  });
}

/** 招待リンク（マジックリンク）を任意のメールアドレスに送る。QR と同じ招待を、
 *  メールで届けるだけ。パスワードは作らない。権限の確認は createInvitation に任せる。 */
export async function inviteByEmail(
  db: Db,
  actor: Actor,
  mailer: Mailer,
  appUrl: string,
  input: InvitationInput & { email: string },
): Promise<{ sent: boolean; expiresAt: string }> {
  const email = input.email.trim();
  assert(looksLikeEmail(email), 'invalid', 'メールアドレスの形が正しくありません');
  const { invitationId, token, expiresAt } = await createInvitation(db, actor, input);
  // 宛先を控えておき、受け取った本人のメアドとして紐付ける（accept 時）。
  await db.query(`UPDATE invitations SET email = $2 WHERE id = $1`, [invitationId, email]);
  const link = `${appUrl.replace(/\/+$/, '')}/app/#invite=${encodeURIComponent(token)}`;
  const who = input.name?.trim();
  const sent = await mailer.send({
    to: [email],
    subject: '【ツギガミ】店舗ナレッジへのご招待',
    text: [
      `${who ? who + 'さん、' : ''}店舗ナレッジ「ツギガミ」への招待が届きました。`,
      '',
      '下のリンクをスマホで開くと、この端末で使い始められます（1回限り・72時間以内）。',
      link,
      '',
      'このメールに心当たりがない場合は、そのまま破棄してください。リンクは開かなければ無効のままです。',
    ].join('\n'),
  });
  return { sent, expiresAt };
}

/**
 * 招待を受け取る（ログイン前に呼ぶ）。招待は1回限り。
 * 新しい利用者ならここで作り、店舗に所属させる。端末のセッショントークンを返す。
 * db は、トークンから取り出した tenant_id で固定した接続であること。
 */
export async function acceptInvitation(db: Db, tenantId: string, token: string, deviceName: string | null) {
  const inv = await maybeOne<{
    id: string; token_hash: string; store_id: string | null; user_id: string | null; name: string | null;
    email: string | null; trust_level: TrustLevel; admin_scope: AdminScope; expired: boolean; used: boolean;
    creator_inactive: boolean;
  }>(
    db,
    `SELECT i.id, i.token_hash, i.store_id, i.user_id, i.name, i.email, i.trust_level, i.admin_scope,
            i.expires_at < now() AS expired, i.used_at IS NOT NULL AS used,
            COALESCE(c.status <> 'active', false) AS creator_inactive
       FROM invitations i LEFT JOIN users c ON c.id = i.created_by
      WHERE i.token_hash = $1 FOR UPDATE OF i`,
    [hashToken(token)],
  );
  if (!inv || !sameHash(inv.token_hash, hashToken(token))) throw new DomainError('not_found', '招待が見つかりません');
  assert(!inv.used, 'conflict', 'この招待はすでに使われています');
  assert(!inv.expired, 'conflict', 'この招待は期限切れです。もう一度発行してもらってください');
  // 無効化された人が出した招待で入れてしまうと、止めたはずの権限が残る（created_by が NULL の初期設定は通す）
  assert(!inv.creator_inactive, 'conflict', 'この招待を作った人は無効化されています。もう一度発行してもらってください');

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
  // 招待メールで来た人は、その宛先を本人のメアドとして控える（復帰のログインリンク送付に使う）。
  // 既にメアドがある人は上書きしない。同じメアドが別の人に使われていれば（一意制約）、黙って見送る。
  if (inv.email) {
    try {
      await db.query(`UPDATE users SET email = $2 WHERE id = $1 AND email IS NULL`, [userId, inv.email]);
    } catch { /* 一意制約などは紐付けを諦めるだけ。ログインは止めない */ }
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

/**
 * 店舗のスタッフ一覧。
 *
 * **同じ名前の人がいるかどうかを一緒に返す。** 会社のアカウント（SSO）で入った人の
 * 名前は相手の IdP が名乗ったものをそのまま使うので、既存の人に似せた名前で
 * 入ってくる余地がある。名前だけを見せていると、店長が見分けられない。
 * メールアドレスと「会社アカウントで入っているか」も出して、照らし合わせられるようにする。
 */
export async function listStoreUsers(db: Db, actor: Actor, storeId: string) {
  assert(canAdminister(actor, storeId), 'forbidden', '利用者の一覧を見られるのは administrator のみです');
  return db.query(
    `SELECT u.id, u.name, u.trust_level, u.admin_scope, u.status, u.email,
            (SELECT max(s.last_used_at)::text FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS last_used_at,
            (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS devices,
            EXISTS (SELECT 1 FROM sso_identities si WHERE si.user_id = u.id) AS via_sso,
            -- この店に、生きている同名の人が2人以上いるか
            count(*) FILTER (WHERE u.status = 'active') OVER (PARTITION BY u.name) > 1 AS same_name
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
  const u = await one<{ id: string; name: string; email: string | null }>(db, `SELECT id, name, email FROM users WHERE id = $1`, [actor.userId]);
  const stores = await db.query<{ id: string; name: string }>(
    actor.adminScope === 'tenant'
      ? `SELECT id, name FROM stores ORDER BY name`
      : `SELECT id, name FROM stores WHERE id = ANY($1::uuid[]) ORDER BY name`,
    actor.adminScope === 'tenant' ? [] : [actor.storeIds],
  );
  // 画面側の「古い」の判定をサーバーと揃えるために配る
  const { STALE_DAYS } = await import('./knowledge.ts');
  return { ...u, trustLevel: actor.trustLevel, adminScope: actor.adminScope, stores, staleDays: STALE_DAYS };
}
