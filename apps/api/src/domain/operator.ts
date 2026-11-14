// 運営者（ツギガミを提供する側）の管理。会社を作る・直す・止める・消す、契約の控えを書く。
//
// 利用者の権限（Actor）とは別の世界。ここの関数は、会社をまたいで触れる。
//   ・運営者になれるのは、環境変数 OPERATOR_EMAILS に書いたアドレスだけ
//   ・パスワードは、そのアドレスに届く設定リンクから**本人が**決める（コードにも .env にも置かない）
//   ・操作はすべて operator_log に残す

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Database } from '../db/db.ts';
import { looksLikeEmail, type Mailer } from '../mail/mailer.ts';
import type { Storage } from '../storage/storage.ts';
import { DomainError } from './actor.ts';
import { hashToken, INVITATION_TTL_HOURS, issueToken } from './users.ts';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const OPERATOR_SESSION_HOURS = 12;
export const OPERATOR_SETUP_MINUTES = 30;
export const OPERATOR_PASSWORD_MIN = 10;
export const PLANS = ['trial', 'lite', 'standard', 'chain'] as const;
export type Plan = typeof PLANS[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 80;
const MAX_NOTE = 2000;

export interface Operator { id: string; email: string }

/** 運営者として認めるアドレス（小文字）。決めていなければ、管理画面にはだれも入れない */
export function operatorEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.OPERATOR_EMAILS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => looksLikeEmail(x));
}

function fail(code: DomainError['code'], message: string): never {
  throw new DomainError(code, message);
}

function cleanName(value: unknown, label: string): string {
  const v = typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim() : '';
  if (v === '') fail('invalid', `${label}を入力してください`);
  if (v.length > MAX_NAME) fail('invalid', `${label}は${MAX_NAME}文字までです`);
  return v;
}

function tenantId(value: string): string {
  if (!UUID.test(value)) fail('not_found', '会社が見つかりません');
  return value;
}

// --- パスワード -----------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  // 登録が無いときも同じだけ計算する（かかる時間から、アドレスが運営者かどうかを読ませない）
  const salt = parts.length === 3 ? Buffer.from(parts[1]!, 'base64') : Buffer.alloc(16);
  const want = parts.length === 3 ? Buffer.from(parts[2]!, 'base64') : Buffer.alloc(32);
  const got = await scrypt(password, salt, 32);
  return parts.length === 3 && parts[0] === 'scrypt' && want.length === got.length && timingSafeEqual(want, got);
}

// --- ログイン --------------------------------------------------------------

/**
 * パスワードを決める（決め直す）リンクを、運営者のアドレスへ送る。
 * 運営者でないアドレスには何も送らない。呼び出し側は、どちらでも同じ応答を返す（この関数は投げない）。
 */
export async function requestOperatorSetup(database: Database, mailer: Mailer, appUrl: string, email: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const addr = String(email ?? '').trim().toLowerCase();
  if (!operatorEmails(env).includes(addr)) return;
  const rows = await database.raw(
    `INSERT INTO operators (email) VALUES ($1)
     ON CONFLICT (lower(email)) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [addr],
  ) as Array<{ id: string }>;
  const token = randomBytes(32).toString('base64url');
  await database.raw(
    `INSERT INTO operator_tokens (token_hash, operator_id, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [hashToken(token), rows[0]!.id, OPERATOR_SETUP_MINUTES],
  );
  const link = `${appUrl.replace(/\/+$/, '')}/admin/#setup=${encodeURIComponent(token)}`;
  await mailer.send({
    to: [addr],
    subject: '【ツギガミ運営】パスワードの設定',
    text: [
      'ツギガミの運営者用の管理画面で使うパスワードを決めるリンクです。',
      '',
      `下のリンクを開いて、新しいパスワードを入力してください（1回限り・${OPERATOR_SETUP_MINUTES}分以内）。`,
      link,
      '',
      'このメールに心当たりがない場合は、そのまま破棄してください。パスワードは変わりません。',
    ].join('\n'),
  });
}

/** 設定リンクでパスワードを決める。決めたら、それまでのログインはすべて切る。 */
export async function setOperatorPassword(database: Database, token: string, password: string): Promise<void> {
  if (typeof password !== 'string' || password.length < OPERATOR_PASSWORD_MIN) fail('invalid', `パスワードは${OPERATOR_PASSWORD_MIN}文字以上にしてください`);
  if (password.length > 200) fail('invalid', 'パスワードが長すぎます');
  const used = await database.raw(
    `UPDATE operator_tokens SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING operator_id`,
    [hashToken(String(token ?? ''))],
  ) as Array<{ operator_id: string }>;
  if (used.length !== 1) fail('not_found', 'このリンクは使えません（期限切れか、使用済みです）。もう一度送り直してください');
  const operatorId = used[0]!.operator_id;
  await database.raw(`UPDATE operators SET password_hash = $2 WHERE id = $1`, [operatorId, await hashPassword(password)]);
  await database.raw(`DELETE FROM operator_sessions WHERE operator_id = $1`, [operatorId]);
  await database.raw(`DELETE FROM operator_tokens WHERE operator_id = $1`, [operatorId]);
  await log(database, operatorId, 'パスワードを設定');
}

/** メアドとパスワードで入る。合わなければ null（理由は分けない）。 */
export async function loginOperator(database: Database, email: string, password: string, env: NodeJS.ProcessEnv = process.env): Promise<{ token: string; email: string } | null> {
  const addr = String(email ?? '').trim().toLowerCase();
  const rows = await database.raw(`SELECT id, email, password_hash FROM operators WHERE lower(email) = $1`, [addr]) as Array<{ id: string; email: string; password_hash: string | null }>;
  const op = rows[0];
  const ok = await verifyPassword(String(password ?? ''), op?.password_hash ?? null);
  if (!op || !ok || !operatorEmails(env).includes(addr)) return null;
  const token = `op.${randomBytes(32).toString('base64url')}`;
  await database.raw(`DELETE FROM operator_sessions WHERE expires_at <= now()`);
  await database.raw(
    `INSERT INTO operator_sessions (token_hash, operator_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [hashToken(token), op.id, OPERATOR_SESSION_HOURS],
  );
  return { token, email: op.email };
}

/** 要求に付いてきたトークンから運営者を確かめる。OPERATOR_EMAILS から外したアドレスは、その場で入れなくなる。 */
export async function verifyOperator(database: Database, token: string | null, env: NodeJS.ProcessEnv = process.env): Promise<Operator | null> {
  if (!token || !token.startsWith('op.')) return null;
  const rows = await database.raw(
    `SELECT o.id, o.email FROM operator_sessions s JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  ) as Operator[];
  const op = rows[0];
  return op && operatorEmails(env).includes(op.email.toLowerCase()) ? op : null;
}

export async function logoutOperator(database: Database, token: string): Promise<void> {
  await database.raw(`DELETE FROM operator_sessions WHERE token_hash = $1`, [hashToken(token)]);
}

// --- 記録 ------------------------------------------------------------------

async function log(database: Database, operatorId: string, action: string, tenant?: { id: string; name: string }, detail?: string): Promise<void> {
  await database.raw(
    `INSERT INTO operator_log (operator_id, action, tenant_id, tenant_name, detail) VALUES ($1, $2, $3, $4, $5)`,
    [operatorId, action, tenant?.id ?? null, tenant?.name ?? null, detail ?? null],
  );
}

export interface LogEntry { at: string; operator: string | null; action: string; tenantName: string | null; detail: string | null }

export async function recentLog(database: Database, limit = 30): Promise<LogEntry[]> {
  const rows = await database.raw(
    `SELECT l.at::text AS at, o.email AS operator, l.action, l.tenant_name, l.detail
       FROM operator_log l LEFT JOIN operators o ON o.id = l.operator_id
      ORDER BY l.id DESC LIMIT $1`,
    [limit],
  ) as Array<{ at: string; operator: string | null; action: string; tenant_name: string | null; detail: string | null }>;
  return rows.map((r) => ({ at: r.at, operator: r.operator, action: r.action, tenantName: r.tenant_name, detail: r.detail }));
}

// --- 会社 ------------------------------------------------------------------

interface TenantRow {
  id: string; name: string; plan: Plan; status: 'active' | 'suspended'; created_at: string; suspended_at: string | null;
  contracted_stores: number | null; period_end: string | null; billing_note: string | null;
  billing_customer_id: string | null; billing_subscription_id: string | null;
}

export interface TenantSummary {
  id: string; name: string; plan: Plan; status: 'active' | 'suspended'; createdAt: string; suspendedAt: string | null;
  contractedStores: number | null; periodEnd: string | null; billingNote: string | null;
  billingCustomerId: string | null; billingSubscriptionId: string | null;
  stores: number; users: number; knowledge: number;
}

export interface TenantDetail extends TenantSummary {
  storeList: Array<{ id: string; name: string; members: number; knowledge: number }>;
  admins: Array<{ name: string; email: string | null }>;
}

const TENANT_COLUMNS = `id, name, plan, status, created_at::text AS created_at, suspended_at::text AS suspended_at,
  contracted_stores, period_end::text AS period_end, billing_note, billing_customer_id, billing_subscription_id`;

async function tenantRow(database: Database, id: string): Promise<TenantRow> {
  const rows = await database.raw(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`, [tenantId(id)]) as TenantRow[];
  return rows[0] ?? fail('not_found', '会社が見つかりません');
}

async function summarize(database: Database, t: TenantRow): Promise<TenantSummary> {
  // 店舗・利用者・ナレッジは行レベルセキュリティの内側なので、その会社として数える
  const c = await database.withTenant(t.id, (db) => db.query<{ stores: number; users: number; knowledge: number }>(
    `SELECT (SELECT count(*) FROM stores)::int AS stores,
            (SELECT count(*) FROM users WHERE status = 'active')::int AS users,
            (SELECT count(*) FROM knowledge)::int AS knowledge`,
  ));
  return {
    id: t.id, name: t.name, plan: t.plan, status: t.status, createdAt: t.created_at, suspendedAt: t.suspended_at,
    contractedStores: t.contracted_stores, periodEnd: t.period_end, billingNote: t.billing_note,
    billingCustomerId: t.billing_customer_id, billingSubscriptionId: t.billing_subscription_id,
    stores: Number(c[0]!.stores), users: Number(c[0]!.users), knowledge: Number(c[0]!.knowledge),
  };
}

export async function listTenants(database: Database): Promise<TenantSummary[]> {
  const rows = await database.raw(`SELECT ${TENANT_COLUMNS} FROM tenants ORDER BY created_at DESC, name`) as TenantRow[];
  const out: TenantSummary[] = [];
  for (const t of rows) out.push(await summarize(database, t));
  return out;
}

export async function getTenant(database: Database, id: string): Promise<TenantDetail> {
  const t = await tenantRow(database, id);
  const summary = await summarize(database, t);
  const { storeList, admins } = await database.withTenant(t.id, async (db) => ({
    storeList: await db.query<{ id: string; name: string; members: number; knowledge: number }>(
      `SELECT s.id, s.name,
              (SELECT count(*) FROM memberships m WHERE m.store_id = s.id)::int AS members,
              (SELECT count(*) FROM knowledge k WHERE k.store_id = s.id)::int AS knowledge
         FROM stores s ORDER BY s.name`,
    ),
    admins: await db.query<{ name: string; email: string | null }>(
      `SELECT name, email FROM users WHERE admin_scope = 'tenant' AND status = 'active' ORDER BY name`,
    ),
  }));
  return { ...summary, storeList: storeList.map((s) => ({ ...s, members: Number(s.members), knowledge: Number(s.knowledge) })), admins };
}

/** 本部の管理者として入るための招待（1回限り）。画面には URL で見せる。 */
async function adminInvite(database: Database, id: string, name: string, appUrl: string): Promise<{ url: string; hours: number }> {
  const token = issueToken(id);
  await database.withTenant(id, (db) => db.query(
    `INSERT INTO invitations (tenant_id, token_hash, store_id, name, trust_level, admin_scope, expires_at)
     VALUES ($1, $2, NULL, $3, 'trusted', 'tenant', now() + make_interval(hours => $4))`,
    [id, hashToken(token), name, INVITATION_TTL_HOURS],
  ));
  return { url: `${appUrl.replace(/\/+$/, '')}/app/#invite=${encodeURIComponent(token)}`, hours: INVITATION_TTL_HOURS };
}

export interface CreateTenantInput { name?: unknown; storeName?: unknown; adminName?: unknown; plan?: unknown }

/** 会社と最初の店舗を作り、本部の管理者への招待を出す（cli/bootstrap.ts と同じことを画面から）。 */
export async function createTenant(database: Database, op: Operator, input: CreateTenantInput, appUrl: string): Promise<{ id: string; invite: { url: string; hours: number } }> {
  const name = cleanName(input.name, '会社名');
  const storeName = cleanName(input.storeName, '店舗名');
  const adminName = cleanName(input.adminName, '管理者の名前');
  const plan = parsePlan(input.plan ?? 'trial');
  const rows = await database.raw(`INSERT INTO tenants (name, plan) VALUES ($1, $2) RETURNING id`, [name, plan]) as Array<{ id: string }>;
  const id = rows[0]!.id;
  await database.withTenant(id, (db) => db.query(`INSERT INTO stores (tenant_id, name) VALUES ($1, $2)`, [id, storeName]));
  const invite = await adminInvite(database, id, adminName, appUrl);
  await log(database, op.id, '会社を作成', { id, name }, `店舗「${storeName}」・管理者「${adminName}」・${plan}`);
  return { id, invite };
}

export async function issueAdminInvite(database: Database, op: Operator, id: string, adminName: unknown, appUrl: string): Promise<{ url: string; hours: number }> {
  const t = await tenantRow(database, id);
  const name = cleanName(adminName, '管理者の名前');
  const invite = await adminInvite(database, t.id, name, appUrl);
  await log(database, op.id, '管理者の招待を発行', t, `「${name}」`);
  return invite;
}

function parsePlan(value: unknown): Plan {
  return (PLANS as readonly unknown[]).includes(value) ? value as Plan : fail('invalid', 'プランは trial・lite・standard・chain のどれかです');
}

export interface UpdateTenantInput {
  name?: unknown; plan?: unknown; contractedStores?: unknown; periodEnd?: unknown; billingNote?: unknown;
  billingCustomerId?: unknown; billingSubscriptionId?: unknown;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail('invalid', `${label}の形が正しくありません`);
  const v = value.trim();
  if (v.length > max) fail('invalid', `${label}は${max}文字までです`);
  return v === '' ? null : v;
}

/** 名前と契約の控えを書き換える。渡された項目だけを変える。 */
export async function updateTenant(database: Database, op: Operator, id: string, input: UpdateTenantInput): Promise<void> {
  const t = await tenantRow(database, id);
  const next = {
    name: input.name === undefined ? t.name : cleanName(input.name, '会社名'),
    plan: input.plan === undefined ? t.plan : parsePlan(input.plan),
    contractedStores: t.contracted_stores,
    periodEnd: t.period_end,
    billingNote: input.billingNote === undefined ? t.billing_note : optionalText(input.billingNote, 'メモ', MAX_NOTE),
    customer: input.billingCustomerId === undefined ? t.billing_customer_id : optionalText(input.billingCustomerId, '決済の顧客ID', 200),
    subscription: input.billingSubscriptionId === undefined ? t.billing_subscription_id : optionalText(input.billingSubscriptionId, '決済の契約ID', 200),
  };
  if (input.contractedStores !== undefined) {
    const n = input.contractedStores === null || input.contractedStores === '' ? null : Number(input.contractedStores);
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > 100000)) fail('invalid', '契約店舗数は0以上の整数で入力してください');
    next.contractedStores = n;
  }
  if (input.periodEnd !== undefined) {
    const d = input.periodEnd === null || input.periodEnd === '' ? null : String(input.periodEnd);
    if (d !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) fail('invalid', '有効期限は 2027-03-31 の形で入力してください');
    next.periodEnd = d;
  }
  await database.raw(
    `UPDATE tenants SET name = $2, plan = $3, contracted_stores = $4, period_end = $5, billing_note = $6,
            billing_customer_id = $7, billing_subscription_id = $8 WHERE id = $1`,
    [t.id, next.name, next.plan, next.contractedStores, next.periodEnd, next.billingNote, next.customer, next.subscription],
  );
  const changed: string[] = [];
  if (next.name !== t.name) changed.push(`名前「${t.name}」→「${next.name}」`);
  if (next.plan !== t.plan) changed.push(`プラン ${t.plan}→${next.plan}`);
  if (next.contractedStores !== t.contracted_stores) changed.push(`契約店舗数 ${t.contracted_stores ?? '未設定'}→${next.contractedStores ?? '未設定'}`);
  if (next.periodEnd !== t.period_end) changed.push(`有効期限 ${t.period_end ?? '未設定'}→${next.periodEnd ?? '未設定'}`);
  if (next.billingNote !== t.billing_note) changed.push('メモ');
  if (next.customer !== t.billing_customer_id || next.subscription !== t.billing_subscription_id) changed.push('決済のID');
  if (changed.length > 0) await log(database, op.id, '会社を編集', { id: t.id, name: next.name }, changed.join('、'));
}

/** 利用を止める。その会社の利用者は何もできなくなるが、データはそのまま残る。 */
export async function suspendTenant(database: Database, op: Operator, id: string): Promise<void> {
  const t = await tenantRow(database, id);
  if (t.status === 'suspended') return;
  await database.raw(`UPDATE tenants SET status = 'suspended', suspended_at = now() WHERE id = $1`, [t.id]);
  await log(database, op.id, '利用を停止', t);
}

export async function resumeTenant(database: Database, op: Operator, id: string): Promise<void> {
  const t = await tenantRow(database, id);
  if (t.status === 'active') return;
  await database.raw(`UPDATE tenants SET status = 'active', suspended_at = NULL WHERE id = $1`, [t.id]);
  await log(database, op.id, '利用を再開', t);
}

/**
 * 会社を完全に消す。店舗・利用者・ナレッジ・写真まで、すべて消えて元に戻せない。
 * 手が滑らないように、**停止してある会社だけ**・**会社名を打ち込んで一致したときだけ**消す。
 */
export async function deleteTenant(database: Database, storage: Storage, op: Operator, id: string, confirmName: unknown): Promise<void> {
  const t = await tenantRow(database, id);
  if (t.status !== 'suspended') fail('conflict', '先に利用を停止してください。完全に消せるのは、停止してある会社だけです');
  if (typeof confirmName !== 'string' || confirmName.trim() !== t.name) fail('invalid', '確認のために打ち込んだ会社名が一致しません');
  const photos = await database.withTenant(t.id, (db) => db.query<{ storage_key: string }>(`SELECT storage_key FROM knowledge_photos`));
  const gone = await database.raw(`DELETE FROM tenants WHERE id = $1 AND status = 'suspended' RETURNING id`, [t.id]);
  if (gone.length !== 1) fail('conflict', '消せませんでした。画面を読み込み直して、状態を確かめてください');
  await log(database, op.id, '会社を完全に削除', t, `写真 ${photos.length} 枚`);
  // 写真の実体は DB の外にある。行が消えたあとで片付ける（失敗しても、だれにも見えない孤児が残るだけ）
  for (const p of photos) await storage.remove(p.storage_key).catch(() => {});
}

// --- 店舗 ------------------------------------------------------------------

export async function addStore(database: Database, op: Operator, id: string, name: unknown): Promise<{ id: string }> {
  const t = await tenantRow(database, id);
  const storeName = cleanName(name, '店舗名');
  const rows = await database.withTenant(t.id, (db) => db.query<{ id: string }>(`INSERT INTO stores (tenant_id, name) VALUES ($1, $2) RETURNING id`, [t.id, storeName]));
  await log(database, op.id, '店舗を追加', t, `「${storeName}」`);
  return { id: rows[0]!.id };
}

export async function renameStore(database: Database, op: Operator, id: string, storeId: string, name: unknown): Promise<void> {
  const t = await tenantRow(database, id);
  const storeName = cleanName(name, '店舗名');
  if (!UUID.test(storeId)) fail('not_found', '店舗が見つかりません');
  const rows = await database.withTenant(t.id, (db) => db.query<{ id: string }>(`UPDATE stores SET name = $2 WHERE id = $1 RETURNING id`, [storeId, storeName]));
  if (rows.length !== 1) fail('not_found', '店舗が見つかりません');
  await log(database, op.id, '店舗名を変更', t, `「${storeName}」`);
}

/**
 * 店舗を消す。消すと、その店舗のナレッジや連絡も一緒に消えるので、
 * **だれも所属しておらず、ナレッジも無い店舗だけ**消せるようにする（最後の1店舗は消せない）。
 */
export async function removeStore(database: Database, op: Operator, id: string, storeId: string): Promise<void> {
  const t = await tenantRow(database, id);
  if (!UUID.test(storeId)) fail('not_found', '店舗が見つかりません');
  const name = await database.withTenant(t.id, async (db) => {
    const rows = await db.query<{ name: string; members: number; knowledge: number; total: number }>(
      `SELECT s.name,
              (SELECT count(*) FROM memberships m WHERE m.store_id = s.id)::int AS members,
              (SELECT count(*) FROM knowledge k WHERE k.store_id = s.id)::int AS knowledge,
              (SELECT count(*) FROM stores)::int AS total
         FROM stores s WHERE s.id = $1`,
      [storeId],
    );
    const s = rows[0] ?? fail('not_found', '店舗が見つかりません');
    if (Number(s.total) <= 1) fail('conflict', '最後の1店舗は消せません。会社ごと消す場合は、停止してから完全削除してください');
    if (Number(s.members) > 0 || Number(s.knowledge) > 0) fail('conflict', `この店舗には利用者が${s.members}人、ナレッジが${s.knowledge}件あります。空の店舗だけ消せます`);
    await db.query(`DELETE FROM stores WHERE id = $1`, [storeId]);
    return s.name;
  });
  await log(database, op.id, '店舗を削除', t, `「${name}」`);
}
