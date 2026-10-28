// 会社のアカウントで入る（OpenID Connect）。
//
// 本部の情報システム部が求める入口。社員が1万人いる会社に「招待QRを1人ずつ
// 配ってください」とは言えないし、退職した人の始末も相手の人事システムが持っている。
// 一方、パート・アルバイトは会社のアカウントを持たないことが多いので、
// **招待QRとパスキーは残したまま、社員の入口だけを増やす**。
//
// 流れ（認可コードフロー＋PKCE）：
//   1. 会社のメールアドレスを打つ → ドメインから相手の IdP を決める
//   2. こちらで乱数（state・nonce・PKCE）を作って覚え、相手の画面へ送る
//   3. 相手が戻してきた引換券を ID トークンに替え、署名と中身を確かめる
//   4. こちらの利用者と結びつけ、端末セッションを渡す
//
// 「誰か」を決める手がかりは2つある。**subject（sub）を鍵にする。**
// メールアドレスは変わる（結婚・異動・社名変更）が、sub は相手が変えない印。
// 初回だけ、メールアドレスで既存の利用者を探して結びつける。

import { maybeOne, one, type Database, type Db } from '../db/db.ts';
import { secretBoxFromEnv, type SecretBox } from '../crypto/secretBox.ts';
import { recordRequest } from './accessRequests.ts';
import { assert, DomainError, type Actor } from './actor.ts';
import { hashToken, issueToken } from './users.ts';
import { createPkce, OidcError, randomToken, safeReturnTo, type OidcDirectory } from '../auth/oidc.ts';
import { verifyIdToken, type IdTokenClaims } from '../auth/jwt.ts';

/** 行きと帰りをつなぐ覚えの寿命。相手の画面で手間取る人がいるので少し長めに取る */
export const STATE_TTL_MS = 10 * 60_000;

type Raw = (sql: string, params?: readonly unknown[]) => Promise<unknown[]>;

/**
 * 内緒の鍵を包む箱。読むのも書くのもここを通す。
 *
 * **どの行のものかを検印に混ぜる**ので、他社の行に貼り替えても開けない。
 * 行を決めるのは会社IDと設定ID（どちらも作ったあとは変わらない）。
 */
let box: SecretBox | null = null;
function secretBox(): SecretBox {
  box ??= secretBoxFromEnv();
  return box;
}

/** テスト用：鍵の設定を読み直す */
export function resetSecretBox(): void { box = null; }

const secretAad = (tenantId: string, providerId: string): string =>
  `sso_providers.client_secret:${tenantId}:${providerId}`;

export interface SsoSite {
  /** 相手に伝える戻り先。相手側の設定と1文字でも違うと弾かれる */
  redirectUri: string;
}

/** 環境変数から決める。決めていなければ SSO は使えない */
export function ssoSiteFromEnv(env: NodeJS.ProcessEnv = process.env): SsoSite | null {
  const uri = env.SSO_REDIRECT_URI;
  if (!uri) return null;
  return { redirectUri: uri };
}

interface ProviderRow {
  id: string;
  tenant_id: string;
  issuer: string;
  client_id: string;
  client_secret: string | null;
  jit_enabled: boolean;
  default_store_id: string | null;
  default_trust: 'visitor' | 'trusted';
  disabled_at: string | null;
  /** この設定に通してよいメールアドレスのドメイン */
  domains: string[];
}

/** メールアドレスのドメイン（小文字）。形が違えば null */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  return domain;
}

/** ID トークンのヘッダーから鍵の名前だけ先に読む（鍵を取り直す判断に使う） */
function readKid(token: string): string | undefined {
  const head = token.split('.')[0];
  if (!head) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { kid?: unknown };
    return typeof parsed.kid === 'string' ? parsed.kid : undefined;
  } catch {
    return undefined;
  }
}

export interface StartResult {
  /** 画面がここへ飛ばす */
  authorizeUrl: string;
}

/**
 * 入る前の準備。打たれたメールアドレスから会社を決め、相手の画面の URL を返す。
 *
 * **登録が無いドメインでも、同じ答えを返さない。** ここで「その会社は使えません」と
 * 返すのは、どの会社が導入しているかを外に教えることになるが、入口が分からないと
 * 利用者が詰まる。導入は公表される前提の情報なので、素直に返して案内する。
 */
export async function startSso(
  database: Database, directory: OidcDirectory, site: SsoSite,
  input: { email: string; returnTo?: unknown },
): Promise<StartResult> {
  const domain = emailDomain(input.email);
  if (!domain) throw new DomainError('invalid', 'メールアドレスの形が違います');

  const raw: Raw = (sql, params) => database.raw(sql, params);
  // **確かめ済みのドメインだけを使う。** 確かめていないドメインを使うと、
  // 先に登録した会社が、そのドメインの人の行き先を決められてしまう
  // （本物に似せた入力欄に送って合言葉を取る、という筋が通ってしまう）。
  const found = await maybeOneRaw<{ tenant_id: string; provider_id: string }>(
    raw,
    `SELECT tenant_id, provider_id FROM sso_domains WHERE domain = $1 AND verified_at IS NOT NULL`,
    [domain],
  );
  if (!found) {
    throw new DomainError('not_found', `${domain} の会社アカウントでの入り方は、まだ用意されていません。招待のQRコードをお使いください`);
  }

  const provider = await database.withTenant(found.tenant_id, (db) => loadProvider(db, found.provider_id));
  const discovery = await directory.describe(provider.issuer);
  // PKCE に対応していない相手は断る。引換券を盗まれたときに止める手立てが無くなる
  const methods = discovery.code_challenge_methods_supported;
  if (methods !== undefined && !methods.includes('S256')) {
    throw new DomainError('invalid', '相手の設定が PKCE（S256）に対応していません。情報システム部にご確認ください');
  }

  const pkce = createPkce();
  const state = randomToken();
  const nonce = randomToken();
  await raw(
    `INSERT INTO sso_states (state, provider_id, tenant_id, code_verifier, nonce, return_to, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
    [state, provider.id, provider.tenant_id, pkce.verifier, nonce, safeReturnTo(input.returnTo), STATE_TTL_MS / 1000],
  );

  const url = new URL(discovery.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: provider.client_id,
    redirect_uri: site.redirectUri,
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    // 相手の画面でアカウントを選ぶ手間を減らす（相手が無視してもよい手がかり）
    login_hint: input.email,
  })) url.searchParams.set(key, value);
  return { authorizeUrl: url.toString() };
}

export interface FinishResult {
  sessionToken: string;
  userId: string;
  /** 入った後に戻す画面。無ければホーム */
  returnTo: string | null;
}

/**
 * 相手から戻ってきたところ。引換券を確かめて、端末セッションを渡す。
 *
 * 覚え（state）は1回しか使えない。取り出したら消す。
 */
export async function finishSso(
  database: Database, directory: OidcDirectory, site: SsoSite,
  input: { code: string; state: string; deviceName?: string },
): Promise<FinishResult> {
  const raw: Raw = (sql, params) => database.raw(sql, params);
  const memo = await maybeOneRaw<{
    provider_id: string; tenant_id: string; code_verifier: string; nonce: string; return_to: string | null;
  }>(
    raw,
    `DELETE FROM sso_states WHERE state = $1 AND expires_at > now()
      RETURNING provider_id, tenant_id, code_verifier, nonce, return_to`,
    [input.state],
  );
  if (!memo) throw new DomainError('conflict', '時間が経ちすぎました。もう一度やり直してください');

  const provider = await database.withTenant(memo.tenant_id, (db) => loadProvider(db, memo.provider_id));

  let idToken: string;
  try {
    const exchanged = await directory.exchange({
      issuer: provider.issuer,
      clientId: provider.client_id,
      clientSecret: provider.client_secret === null
        ? null
        : secretBox().open(provider.client_secret, secretAad(provider.tenant_id, provider.id)),
      code: input.code,
      codeVerifier: memo.code_verifier,
      redirectUri: site.redirectUri,
    });
    idToken = exchanged.idToken;
  } catch (err) {
    throw new DomainError('forbidden', err instanceof OidcError ? err.message : String(err));
  }

  let claims: IdTokenClaims;
  try {
    const keys = await directory.signingKeys(provider.issuer, readKid(idToken));
    claims = verifyIdToken(idToken, keys, {
      issuer: provider.issuer, audience: provider.client_id, nonce: memo.nonce,
    });
  } catch (err) {
    throw new DomainError('forbidden', err instanceof Error ? err.message : String(err));
  }

  const outcome = await database.withTenant(memo.tenant_id, async (db) => {
    const resolved = await resolveUser(db, provider, claims);
    // 申請として受けるぶんは、**取引（トランザクション）の外で書く**。
    // 中で書いてから例外を投げると巻き戻され、申請が残らない。
    // （パスキーで複製を止めるときと同じ理由。試験では「申請を出しました」と
    //  出るのに一覧が空、という形で出た）
    if (resolved.kind === 'request') return resolved;
    const sessionToken = issueToken(memo.tenant_id);
    await db.query(
      `INSERT INTO sessions (tenant_id, user_id, token_hash, device_name) VALUES ($1, $2, $3, $4)`,
      [memo.tenant_id, resolved.userId, hashToken(sessionToken), input.deviceName?.slice(0, 60) ?? null],
    );
    return { kind: 'session' as const, sessionToken, userId: resolved.userId };
  });

  if (outcome.kind === 'session') {
    return { sessionToken: outcome.sessionToken, userId: outcome.userId, returnTo: memo.return_to };
  }

  const recorded = await database.withTenant(memo.tenant_id, (db) => recordRequest(db, {
    tenantId: provider.tenant_id,
    providerId: provider.id,
    subject: claims.sub,
    email: outcome.email,
    name: outcome.name,
  }));
  if (recorded.kind === 'rejected') {
    throw new DomainError('forbidden', 'この申請は断られています。店長か本部にご確認ください');
  }
  throw new DomainError('forbidden', recorded.kind === 'created'
    ? '利用の申請を出しました。店長が承認すると使えるようになります'
    : 'まだ承認されていません。店長にご確認ください');
}

/**
 * ID トークンの持ち主を、こちらの利用者に結びつける。
 *
 *   1. すでに結びついていれば、その人（sub が鍵）
 *   2. まだなら、**確認済みの**メールアドレスで既存の利用者を探して結びつける
 *   3. それも無ければ、設定が許していれば作る。許していなければ断る
 *
 * 2 でメールアドレスの確認（email_verified）を要るものにしているのは、
 * 確認されていないアドレスを名乗れると、既存の店長に化けられるため。
 *
 * **新しく結びつけるときは、ID トークンのメールアドレスのドメインも確かめる。**
 * 入口で打たれたアドレスは手がかりにすぎず、本当に誰かを決めるのは ID トークンの中身。
 * 入口のドメインだけを見ていると、会社のアドレスを打って相手の画面では別の
 * アカウント（個人の Google など）で入り、そのまま通ってしまう。
 * 相手が1社専用の IdP なら発行元の固定で足りるが、複数の会社を受ける IdP も
 * あるので、こちらでも線を引く。
 */
type Resolution =
  | { kind: 'user'; userId: string }
  /** 登録が無い。申請として受ける（書くのは取引の外） */
  | { kind: 'request'; email: string; name: string | null };

async function resolveUser(db: Db, provider: ProviderRow, claims: IdTokenClaims): Promise<Resolution> {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
  const linked = await maybeOne<{ user_id: string }>(
    db,
    `UPDATE sso_identities SET last_used_at = now(), email = COALESCE($3, email)
      WHERE provider_id = $1 AND subject = $2 RETURNING user_id`,
    [provider.id, claims.sub, email],
  );
  if (linked) {
    const status = await maybeOne<{ status: string }>(db, `SELECT status FROM users WHERE id = $1`, [linked.user_id]);
    assert(status?.status === 'active', 'forbidden', 'この利用者は無効化されています');
    return { kind: 'user', userId: linked.user_id };
  }

  const verified = claims.email_verified === true;
  const inCompany = email !== null && provider.domains.includes(emailDomain(email) ?? '');
  if (email !== null && verified && !inCompany) {
    throw new DomainError('forbidden',
      `${email} は、この会社のアカウントとして登録されていません。会社のメールアドレスでお試しください`);
  }
  if (email && verified) {
    const existing = await maybeOne<{ id: string; status: string }>(
      db, `SELECT id, status FROM users WHERE lower(email) = $1`, [email],
    );
    if (existing) {
      assert(existing.status === 'active', 'forbidden', 'この利用者は無効化されています');
      await link(db, provider, claims.sub, existing.id, email);
      return { kind: 'user', userId: existing.id };
    }
  }

  const claimedName = typeof claims.name === 'string' && claims.name.trim() !== ''
    ? claims.name.trim().slice(0, 60)
    : null;

  if (!provider.jit_enabled) {
    // 行き止まりにしない。ここまで来た人は「その会社の人であることは確か」なので、
    // 申請として受けて、店長が見て決められるようにする。
    if (email === null || !verified) {
      throw new DomainError('forbidden',
        'このアカウントはまだ登録されていません。店長か本部に、利用者の登録を依頼してください');
    }
    return { kind: 'request', email, name: claimedName };
  }
  assert(provider.default_store_id !== null, 'invalid', '自動登録の配属先が決まっていません。本部にご確認ください');
  if (email === null || !verified) {
    throw new DomainError('forbidden', '会社のメールアドレスが確認できませんでした');
  }

  const name = claimedName ?? email.split('@')[0]!.slice(0, 60);
  const created = await one<{ id: string }>(
    db,
    `INSERT INTO users (tenant_id, name, trust_level, employment_type, email)
     VALUES ($1, $2, $3, 'employee', $4) RETURNING id`,
    [provider.tenant_id, name, provider.default_trust, email],
  );
  await db.query(
    `INSERT INTO memberships (tenant_id, user_id, store_id) VALUES ($1, $2, $3)`,
    [provider.tenant_id, created.id, provider.default_store_id],
  );
  await link(db, provider, claims.sub, created.id, email);
  return { kind: 'user', userId: created.id };
}

async function link(db: Db, provider: ProviderRow, subject: string, userId: string, email: string | null): Promise<void> {
  await db.query(
    `INSERT INTO sso_identities (tenant_id, provider_id, subject, user_id, email, last_used_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [provider.tenant_id, provider.id, subject, userId, email],
  );
}

async function loadProvider(db: Db, id: string): Promise<ProviderRow> {
  const row = await maybeOne<ProviderRow>(
    db,
    `SELECT p.id, p.tenant_id, p.issuer, p.client_id, p.client_secret, p.jit_enabled,
            p.default_store_id, p.default_trust, p.disabled_at::text AS disabled_at,
            COALESCE((SELECT array_agg(d.domain) FROM sso_domains d WHERE d.provider_id = p.id), '{}') AS domains
       FROM sso_providers p WHERE p.id = $1`,
    [id],
  );
  if (!row) throw new DomainError('not_found', '会社アカウントの設定が見つかりません');
  assert(row.disabled_at === null, 'forbidden', 'この会社アカウントでの入り方は止められています');
  return row;
}

/** 会社が決まる前に引くので、行レベルセキュリティの外（raw）で1行だけ取る */
async function maybeOneRaw<T>(raw: Raw, sql: string, params: readonly unknown[]): Promise<T | null> {
  const rows = await raw(sql, params);
  return (rows[0] as T | undefined) ?? null;
}

// --- 設定の管理（本部の管理者） -------------------------------------------------

export interface ProviderInput {
  issuer: string;
  clientId: string;
  clientSecret?: string | null;
  /** このドメインのメールアドレスを、この設定に通す */
  domains: string[];
  jitEnabled?: boolean;
  defaultStoreId?: string | null;
  defaultTrust?: 'visitor' | 'trusted';
}

export interface DomainView {
  domain: string;
  /** DNS に印を置けたか。置けるまで、このドメインは入口で使われない */
  verified: boolean;
  /** DNS に置いてもらう印 */
  token: string;
}

export interface ProviderView {
  id: string;
  issuer: string;
  clientId: string;
  /** 内緒の鍵そのものは返さない。入っているかどうかだけ */
  hasSecret: boolean;
  domains: DomainView[];
  jitEnabled: boolean;
  defaultStoreId: string | null;
  defaultTrust: 'visitor' | 'trusted';
  disabled: boolean;
}

function requireTenantAdmin(actor: Actor): void {
  assert(actor.adminScope === 'tenant', 'forbidden', '会社アカウントの設定を触れるのは本部の管理者だけです');
}

export async function listProviders(db: Db, actor: Actor): Promise<ProviderView[]> {
  requireTenantAdmin(actor);
  const rows = await db.query<ProviderRow & { domain_rows: string | null }>(
    `SELECT p.id, p.tenant_id, p.issuer, p.client_id, p.client_secret, p.jit_enabled,
            p.default_store_id, p.default_trust, p.disabled_at::text AS disabled_at,
            (SELECT json_agg(json_build_object(
                      'domain', d.domain,
                      'verified', d.verified_at IS NOT NULL,
                      'token', d.verify_token) ORDER BY d.domain)::text
               FROM sso_domains d WHERE d.provider_id = p.id) AS domain_rows
       FROM sso_providers p ORDER BY p.created_at`,
  );
  return rows.map((r) => {
    const domains = (r.domain_rows === null ? [] : JSON.parse(r.domain_rows)) as DomainView[];
    return {
      id: r.id,
      issuer: r.issuer,
      clientId: r.client_id,
      hasSecret: r.client_secret !== null,
      domains,
      jitEnabled: r.jit_enabled,
      defaultStoreId: r.default_store_id,
      defaultTrust: r.default_trust,
      disabled: r.disabled_at !== null,
    };
  });
}

/**
 * 設定を足す。
 *
 * 発行元は **https で始まり、問い合わせも断片も付かない形**に限る。
 * ここが自由だと、社内の別のサーバーに引換券を取りに行かせられる。
 */
export async function addProvider(db: Db, actor: Actor, input: ProviderInput): Promise<ProviderView> {
  requireTenantAdmin(actor);
  const issuer = input.issuer.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new DomainError('invalid', '発行元（issuer）の形が違います');
  }
  assert(parsed.protocol === 'https:', 'invalid', '発行元は https で始まる必要があります');
  assert(parsed.search === '' && parsed.hash === '', 'invalid', '発行元に ? や # は付けられません');
  assert(input.clientId.trim() !== '', 'invalid', 'client_id が必要です');

  const domains = [...new Set(input.domains.map((d) => d.trim().toLowerCase()).filter((d) => d !== ''))];
  assert(domains.length > 0, 'invalid', '会社のメールアドレスのドメインを1つ以上決めてください');
  for (const d of domains) {
    assert(/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d), 'invalid', `ドメインの形が違います: ${d}`);
  }
  if (input.jitEnabled) {
    assert(input.defaultStoreId != null, 'invalid', '自動登録を使うなら、配属先の店舗を決めてください');
  }

  // 内緒の鍵は、どの行のものかを検印に混ぜて包む。行の ID は作ってから決まるので、
  // いちど空で作り、ID が分かってから包んで入れる（同じ取引の中なので外からは見えない）。
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO sso_providers (tenant_id, issuer, client_id, client_secret, jit_enabled, default_store_id, default_trust)
     VALUES ($1, $2, $3, NULL, $4, $5, $6) RETURNING id`,
    [
      actor.tenantId, issuer, input.clientId.trim(),
      input.jitEnabled === true, input.defaultStoreId ?? null, input.defaultTrust ?? 'visitor',
    ],
  );
  const secret = input.clientSecret?.trim() || null;
  if (secret !== null) {
    await db.query(
      `UPDATE sso_providers SET client_secret = $2 WHERE id = $1`,
      [row.id, secretBox().seal(secret, secretAad(actor.tenantId, row.id))],
    );
  }
  for (const domain of domains) {
    // ドメインは世界で1つの会社にしか割り当てられない（打ったアドレスから会社を決めるため）
    const taken = await maybeOne<{ tenant_id: string }>(
      db, `SELECT tenant_id FROM sso_domains WHERE domain = $1`, [domain],
    );
    if (taken) throw new DomainError('conflict', `${domain} はすでに登録されています`);
    await db.query(
      `INSERT INTO sso_domains (domain, tenant_id, provider_id) VALUES ($1, $2, $3)`,
      [domain, actor.tenantId, row.id],
    );
  }
  const all = await listProviders(db, actor);
  return all.find((p) => p.id === row.id)!;
}

/** 止める（消さない）。消すと、結びついた人が誰だったか追えなくなる */
export async function disableProvider(db: Db, actor: Actor, id: string): Promise<{ ok: true }> {
  requireTenantAdmin(actor);
  const row = await maybeOne<{ id: string }>(
    db, `UPDATE sso_providers SET disabled_at = now() WHERE id = $1 RETURNING id`, [id],
  );
  if (!row) throw new DomainError('not_found', '会社アカウントの設定が見つかりません');
  // 入口も閉じる（止めた設定のドメインで入ろうとした人を、入口で案内するため）
  await db.query(`DELETE FROM sso_domains WHERE provider_id = $1`, [id]);
  return { ok: true };
}

/** 期限切れの覚えを捨てる（夜間バッチ） */
export async function sweepSsoStates(raw: Raw): Promise<number> {
  const rows = await raw(`DELETE FROM sso_states WHERE expires_at < now() RETURNING state`);
  return rows.length;
}

// --- つなぎを確かめる ---------------------------------------------------------

export interface ConnectionCheck {
  ok: boolean;
  /** 人が読む結果。順に並べる */
  steps: Array<{ ok: boolean; label: string; detail?: string }>;
  /** 確かめられなかったこと（これは自分で入ってみるしかない） */
  remaining: string[];
}

/**
 * 入れた設定で、相手に本当につながるかを確かめる。
 *
 * **確かめられるのは発行元までで、client_id と内緒の鍵が正しいかは分からない。**
 * それを確かめる唯一の方法は、本部の人が自分で一度入ってみること。
 * 分からないことは「確かめられなかったこと」として正直に返す。
 * 「つながりました」だけ出すと、入れる気になって当日に詰まる。
 *
 * 行き先はすべて safeFetch を通る（社内のアドレスや付け替えは、そこで止まる）。
 * ここを足すことで外に取りに行く入口が1つ増えるので、
 * **呼べるのは本部の管理者だけ**にし、回数も止めている（RULES.ssoLogin と同じ口）。
 */
export async function checkConnection(
  directory: OidcDirectory, actor: Actor, issuer: string,
): Promise<ConnectionCheck> {
  assert(actor.adminScope === 'tenant', 'forbidden', 'つなぎを確かめられるのは本部の管理者だけです');
  const steps: ConnectionCheck['steps'] = [];
  const base = issuer.trim().replace(/\/+$/, '');

  // 1. 形。ここで止まるなら打ち間違い
  try {
    const url = new URL(base);
    assert(url.protocol === 'https:', 'invalid', '発行元は https で始まる必要があります');
    assert(url.search === '' && url.hash === '', 'invalid', '発行元に ? や # は付けられません');
    steps.push({ ok: true, label: '発行元の形' });
  } catch (err) {
    steps.push({ ok: false, label: '発行元の形', detail: err instanceof Error ? err.message : String(err) });
    return { ok: false, steps, remaining: [] };
  }

  // 2. 相手に届くか・名乗る発行元が一致するか・行き先が安全か（describe が全部見る）
  let discovery;
  try {
    discovery = await directory.describe(base);
    steps.push({ ok: true, label: '相手の設定を読めた' });
    steps.push({ ok: true, label: '相手が名乗る発行元が、入れた値と一致した' });
  } catch (err) {
    steps.push({
      ok: false,
      label: '相手の設定を読めた',
      detail: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, steps, remaining: [] };
  }

  // 3. PKCE。対応していない相手は、こちらが受けない
  const methods = discovery.code_challenge_methods_supported;
  if (methods === undefined) {
    steps.push({ ok: true, label: 'PKCE（S256）', detail: '相手が対応を公表していません。入るときに試されます' });
  } else if (methods.includes('S256')) {
    steps.push({ ok: true, label: 'PKCE（S256）' });
  } else {
    steps.push({ ok: false, label: 'PKCE（S256）', detail: `相手が対応していません（${methods.join('、')}）` });
  }

  // 4. 鍵。署名を確かめるのに要る
  try {
    const keys = await directory.signingKeys(base);
    const usable = keys.filter((k) => k.kty === 'RSA' || k.kty === 'EC');
    assert(usable.length > 0, 'invalid', '使える鍵がありません');
    steps.push({ ok: true, label: `署名の鍵を読めた（${usable.length}本）` });
  } catch (err) {
    steps.push({ ok: false, label: '署名の鍵を読めた', detail: err instanceof Error ? err.message : String(err) });
  }

  return {
    ok: steps.every((s) => s.ok),
    steps,
    remaining: [
      'client_id と内緒の鍵が正しいか（引換券の交換は、実際に入るときにしか起きません）',
      '相手側に、戻り先（SSO_REDIRECT_URI）が登録されているか',
      'どの社員にこのアプリを使わせるか（相手側の割り当て）',
    ],
  };
}

// --- ドメインの持ち主であることを確かめる -------------------------------------

/** DNS に印を置く場所。この下に TXT で印を置いてもらう */
export const VERIFY_PREFIX = '_misenare-verify';
/** 確かめに行く間隔の下限（連打で DNS を叩かないため） */
export const VERIFY_COOLDOWN_MS = 30_000;

export interface DomainCheck {
  domain: string;
  verified: boolean;
  /** 置いてもらう場所と値 */
  record: { name: string; type: 'TXT'; value: string };
  detail?: string;
}

/** TXT を引く口。試験では差し替える */
export type ResolveTxt = (name: string) => Promise<string[][]>;

/**
 * ドメインの持ち主であることを確かめる。
 *
 * `_misenare-verify.<ドメイン>` に TXT で `misenare-verify=<印>` を置いてもらい、
 * それを引いて一致すれば、そのドメインの DNS を触れる人＝持ち主だと見なす。
 * Google や Microsoft と同じやり方。
 *
 * **DNS を引くのは safeFetch の対象外**（HTTP で取りに行くわけではないので、
 * 社内のアドレスを指されても、こちらは何もつなぎに行かない）。
 */
export async function verifyDomain(
  db: Db, actor: Actor, domain: string, resolveTxt: ResolveTxt,
): Promise<DomainCheck> {
  requireTenantAdmin(actor);
  const name = domain.trim().toLowerCase();
  // sso_domains はログイン前に引く表なので行レベルセキュリティが無い。ここで自社に絞る。
  // 絞らないと、他社が登録したドメインの印（verify_token）を読めて、確認日時も書き換えられる
  const row = await maybeOne<{ verify_token: string; verified_at: string | null; checked_at: string | null }>(
    db,
    `SELECT verify_token, verified_at::text AS verified_at, checked_at::text AS checked_at
       FROM sso_domains WHERE domain = $1 AND tenant_id = $2`,
    [name, actor.tenantId],
  );
  if (!row) throw new DomainError('not_found', `${name} は登録されていません`);
  const record = { name: `${VERIFY_PREFIX}.${name}`, type: 'TXT' as const, value: `misenare-verify=${row.verify_token}` };
  if (row.verified_at !== null) return { domain: name, verified: true, record };

  if (row.checked_at !== null && Date.now() - new Date(row.checked_at).getTime() < VERIFY_COOLDOWN_MS) {
    return { domain: name, verified: false, record, detail: '少し待ってからもう一度お試しください（DNS は反映に時間がかかります）' };
  }
  await db.query(`UPDATE sso_domains SET checked_at = now() WHERE domain = $1 AND tenant_id = $2`, [name, actor.tenantId]);

  let records: string[][];
  try {
    records = await resolveTxt(record.name);
  } catch (err) {
    return {
      domain: name, verified: false, record,
      detail: `${record.name} の TXT を引けませんでした（${err instanceof Error ? err.message : String(err)}）。`
        + '置いた直後なら、反映を待ってからもう一度お試しください',
    };
  }
  // TXT は長い値が分割されて返るので、つないでから比べる
  const found = records.map((parts) => parts.join('')).map((v) => v.trim());
  if (!found.includes(record.value)) {
    return {
      domain: name, verified: false, record,
      detail: found.length === 0 ? '印が見つかりません' : `見つかったのは別の値です（${found.slice(0, 3).join('、')}）`,
    };
  }
  await db.query(`UPDATE sso_domains SET verified_at = now() WHERE domain = $1 AND tenant_id = $2`, [name, actor.tenantId]);
  return { domain: name, verified: true, record };
}
