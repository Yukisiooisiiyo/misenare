// パスキーの登録と、パスキーでの入り直し。
//
// 招待QRは「最初の1回」のためのもの。機種変更やバックヤードのPCから入り直すたびに
// 店長に発行してもらうのは手間なので、登録しておけば本人が自分で入れるようにする。
//
// 会社（テナント）の見分け方は招待トークンと同じ考え方で、
// 利用者の印（userHandle）を「<会社ID>.<利用者ID>」にしておき、認証器に覚えてもらう。

import { randomBytes } from 'node:crypto';
import { maybeOne, one, type Database, type Db } from '../db/db.ts';
import { assert, DomainError, type Actor } from './actor.ts';
import { base64url, verifyAuthentication, verifyRegistration, type Expectations } from '../auth/webauthn.ts';
import { hashToken, issueToken } from './users.ts';

/** 合言葉の有効時間（ミリ秒） */
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const MAX_CREDENTIALS = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SiteConfig {
  /** 鍵が結びつく相手。ドメイン名（misenare.example.com）。開発中は localhost */
  rpId: string;
  /** 受け付ける出どころ */
  origins: string[];
  /** 画面に出す名前 */
  rpName: string;
  /** 指紋や画面ロックでの確認を必須にするか */
  requireUserVerification: boolean;
}

/** 環境変数から決める。設定が無ければパスキーは使えない */
export function siteConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SiteConfig | null {
  const rpId = env.WEBAUTHN_RP_ID;
  if (!rpId) return null;
  const origins = (env.WEBAUTHN_ORIGINS ?? `https://${rpId}`).split(',').map((s) => s.trim()).filter(Boolean);
  return {
    rpId,
    origins,
    rpName: env.WEBAUTHN_RP_NAME ?? 'ミセナレ',
    requireUserVerification: env.WEBAUTHN_REQUIRE_UV !== '0',
  };
}

/**
 * 利用者の印。会社IDと利用者IDを **16バイトずつ並べた32バイト**。
 *
 * 文字のまま「<会社ID>.<利用者ID>」とつなぐと 73 バイトになり、
 * WebAuthn の上限（64バイト）を超えて端末が登録を断る。
 * にせ認証器では長さを見ていなかったので気づかず、本物のブラウザで
 * 「User handle exceeds 64 bytes」で落ちた。UUID は元が16バイトなので、
 * 数字に戻して並べれば半分以下で収まる。
 */
export function userHandle(tenantId: string, userId: string): Buffer {
  return Buffer.concat([uuidToBytes(tenantId), uuidToBytes(userId)]);
}

function uuidToBytes(uuid: string): Buffer {
  if (!UUID.test(uuid)) throw new DomainError('invalid', `ID の形が違います: ${uuid}`);
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 認証器が返してきた印を読む。
 * 文字でつないだ古い形（<会社ID>.<利用者ID>）も受ける。作り直す前に
 * 登録した鍵が、入り直せなくなるのを避けるため。
 */
export function parseUserHandle(handle: Buffer): { tenantId: string; userId: string } | null {
  if (handle.length === 32) {
    return { tenantId: bytesToUuid(handle.subarray(0, 16)), userId: bytesToUuid(handle.subarray(16)) };
  }
  const [tenantId, userId, ...rest] = handle.toString('utf8').split('.');
  if (rest.length > 0 || !tenantId || !userId || !UUID.test(tenantId) || !UUID.test(userId)) return null;
  return { tenantId, userId };
}

// --- 合言葉の置き場 -----------------------------------------------------------------

type Raw = (sql: string, params?: readonly unknown[]) => Promise<unknown[]>;

async function newChallenge(raw: Raw, kind: 'register' | 'login', owner?: { tenantId: string; userId: string }): Promise<string> {
  const challenge = base64url.encode(randomBytes(32));
  await raw(
    `INSERT INTO webauthn_challenges (challenge, kind, tenant_id, user_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [challenge, kind, owner?.tenantId ?? null, owner?.userId ?? null, CHALLENGE_TTL_MS / 1000],
  );
  return challenge;
}

/** 1回しか使えない。取り出したら消す */
async function takeChallenge(raw: Raw, challenge: string, kind: 'register' | 'login') {
  const rows = (await raw(
    `DELETE FROM webauthn_challenges
      WHERE challenge = $1 AND kind = $2 AND expires_at > now()
      RETURNING tenant_id, user_id`,
    [challenge, kind],
  )) as Array<{ tenant_id: string | null; user_id: string | null }>;
  const row = rows[0];
  if (!row) throw new DomainError('conflict', '合言葉が切れています。もう一度やり直してください');
  return row;
}

/** 期限切れの合言葉を捨てる（夜間バッチ） */
export async function sweepChallenges(raw: Raw): Promise<number> {
  const rows = await raw(`DELETE FROM webauthn_challenges WHERE expires_at < now() RETURNING challenge`);
  return rows.length;
}

// --- 登録 ---------------------------------------------------------------------------

export interface RegisterOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  timeout: number;
  attestation: 'none';
  authenticatorSelection: { residentKey: 'required'; userVerification: 'required' | 'preferred' };
  excludeCredentials: Array<{ type: 'public-key'; id: string }>;
}

/**
 * 登録の準備。ログイン済みの端末から呼ぶ。
 *
 * 合言葉もこの取引（トランザクション）の中で書く。接続をまたぐ raw を
 * 取引の中から呼ぶと、psql アダプタでは順番待ちが噛み合わず止まる。
 */
export async function startRegistration(
  db: Db, actor: Actor, site: SiteConfig, displayName: string,
): Promise<RegisterOptions> {
  const raw: Raw = (sql, params) => db.query(sql, params);
  const existing = await db.query<{ credential_id: Buffer }>(
    `SELECT credential_id FROM webauthn_credentials WHERE user_id = $1 AND disabled_at IS NULL`, [actor.userId],
  );
  assert(existing.length < MAX_CREDENTIALS, 'conflict', `パスキーは${MAX_CREDENTIALS}個までです`);
  const challenge = await newChallenge(raw, 'register', { tenantId: actor.tenantId, userId: actor.userId });
  return {
    challenge,
    rp: { id: site.rpId, name: site.rpName },
    user: { id: base64url.encode(userHandle(actor.tenantId, actor.userId)), name: displayName, displayName },
    // ES256 を第一に、RS256 と Ed25519 も受ける
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
      { type: 'public-key', alg: -8 },
    ],
    timeout: CHALLENGE_TTL_MS,
    attestation: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: site.requireUserVerification ? 'required' : 'preferred',
    },
    // 同じ端末に二重登録させない
    excludeCredentials: existing.map((c) => ({ type: 'public-key' as const, id: base64url.encode(toBuffer(c.credential_id)) })),
  };
}

/** pg は bytea を Buffer で返し、psql アダプタは 16進の文字列で返す */
function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') {
    return value.startsWith('\\x') ? Buffer.from(value.slice(2), 'hex') : Buffer.from(value, 'utf8');
  }
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error('bytea を読めません');
}

export async function finishRegistration(
  db: Db, actor: Actor, site: SiteConfig,
  input: { clientDataJSON: string; attestationObject: string; name?: string },
) {
  const raw: Raw = (sql, params) => db.query(sql, params);
  const clientDataJSON = base64url.decode(input.clientDataJSON);
  const challenge = readChallenge(clientDataJSON);
  const owner = await takeChallenge(raw, challenge, 'register');
  assert(owner.user_id === actor.userId, 'forbidden', 'この合言葉はあなたのものではありません');

  const expect: Expectations = {
    type: 'webauthn.create', challenge, origins: site.origins, rpId: site.rpId,
    requireUserVerification: site.requireUserVerification,
  };
  let result;
  try {
    result = verifyRegistration({ clientDataJSON, attestationObject: base64url.decode(input.attestationObject) }, expect);
  } catch (err) {
    throw new DomainError('invalid', err instanceof Error ? err.message : String(err));
  }

  const row = await one<{ id: string }>(
    db,
    `INSERT INTO webauthn_credentials (tenant_id, user_id, credential_id, public_key, algorithm, sign_count, name)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      actor.tenantId, actor.userId, result.credentialId, result.publicKey,
      result.algorithm, result.signCount, (input.name ?? '').slice(0, 60) || null,
    ],
  );
  return { id: row.id };
}

/** clientDataJSON から合言葉だけを先に読む（どの会社のものか決める前に要る） */
function readChallenge(clientDataJSON: Buffer): string {
  try {
    const parsed = JSON.parse(clientDataJSON.toString('utf8')) as { challenge?: unknown };
    if (typeof parsed.challenge !== 'string') throw new Error('no challenge');
    return parsed.challenge;
  } catch {
    throw new DomainError('invalid', 'パスキーの情報を読めませんでした');
  }
}

// --- パスキーで入る -----------------------------------------------------------------

export interface LoginOptions {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: 'required' | 'preferred';
}

/** 入る前の準備。誰かは分からないまま呼ぶ */
export async function startLogin(raw: Raw, site: SiteConfig): Promise<LoginOptions> {
  return {
    challenge: await newChallenge(raw, 'login'),
    rpId: site.rpId,
    timeout: CHALLENGE_TTL_MS,
    userVerification: site.requireUserVerification ? 'required' : 'preferred',
  };
}

export interface LoginInput {
  /** 端末が返した鍵の名前（assertion.id） */
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  /** 認証器が覚えている「<会社ID>.<利用者ID>」 */
  userHandle: string;
  deviceName?: string;
}

/**
 * パスキーで入る。端末セッションを作って返す（招待を受け取ったときと同じ形）。
 * 会社は userHandle から決まるので、行レベルセキュリティを効かせたまま照合できる。
 */
export async function loginWithPasskey(
  database: Database, site: SiteConfig, input: LoginInput,
): Promise<{ sessionToken: string; userId: string }> {
  const clientDataJSON = base64url.decode(input.clientDataJSON);
  const challenge = readChallenge(clientDataJSON);
  await takeChallenge((sql, params) => database.raw(sql, params), challenge, 'login');

  const handle = parseUserHandle(base64url.decode(input.userHandle));
  if (!handle) throw new DomainError('invalid', 'パスキーの持ち主が分かりませんでした');

  // 複製の疑いで止めるときは、取引（トランザクション）の外で書く。
  // 中で書いて例外を投げると、巻き戻されて止まらないため。
  const outcome = await database.withTenant(handle.tenantId, async (db) => {
    const credentialId = base64url.decode(input.credentialId);
    const stored = await maybeOne<{
      id: string; user_id: string; public_key: unknown; sign_count: string | number; status: string;
    }>(
      db,
      `SELECT c.id, c.user_id, c.public_key, c.sign_count, u.status
         FROM webauthn_credentials c JOIN users u ON u.id = c.user_id
        WHERE c.credential_id = $1 AND c.disabled_at IS NULL`,
      [credentialId],
    );
    if (!stored || stored.user_id !== handle.userId) throw new DomainError('not_found', 'このパスキーは登録されていません');
    assert(stored.status === 'active', 'forbidden', 'この利用者は無効化されています');

    const expect: Expectations = {
      type: 'webauthn.get', challenge, origins: site.origins, rpId: site.rpId,
      requireUserVerification: site.requireUserVerification,
    };
    let result;
    try {
      result = verifyAuthentication(
        {
          clientDataJSON,
          authenticatorData: base64url.decode(input.authenticatorData),
          signature: base64url.decode(input.signature),
        },
        { publicKey: toBuffer(stored.public_key), signCount: Number(stored.sign_count) },
        expect,
      );
    } catch (err) {
      throw new DomainError('forbidden', err instanceof Error ? err.message : String(err));
    }

    if (result.cloneWarning) return { clonedId: stored.id } as const;

    await db.query(
      `UPDATE webauthn_credentials SET sign_count = $2, last_used_at = now() WHERE id = $1`,
      [stored.id, result.signCount],
    );
    const sessionToken = issueToken(handle.tenantId);
    await db.query(
      `INSERT INTO sessions (tenant_id, user_id, token_hash, device_name) VALUES ($1, $2, $3, $4)`,
      [handle.tenantId, handle.userId, hashToken(sessionToken), input.deviceName?.slice(0, 60) ?? null],
    );
    return { sessionToken, userId: handle.userId } as const;
  });

  if ('clonedId' in outcome) {
    await database.withTenant(handle.tenantId, (db) =>
      db.query(`UPDATE webauthn_credentials SET disabled_at = now() WHERE id = $1`, [outcome.clonedId]));
    throw new DomainError('forbidden', 'このパスキーは使えなくなりました。店長に招待をもう一度発行してもらってください');
  }
  return outcome;
}

// --- 持っているパスキーの管理 -------------------------------------------------------

export async function listPasskeys(db: Db, actor: Actor) {
  return db.query<{ id: string; name: string | null; created_at: string; last_used_at: string | null; disabled: boolean }>(
    `SELECT id, name, created_at::text AS created_at, last_used_at::text AS last_used_at,
            disabled_at IS NOT NULL AS disabled
       FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at`,
    [actor.userId],
  );
}

export async function deletePasskey(db: Db, actor: Actor, id: string) {
  const rows = await db.query<{ id: string }>(
    `DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2 RETURNING id`, [id, actor.userId],
  );
  assert(rows.length === 1, 'not_found', 'そのパスキーは見つかりません');
  return { ok: true };
}
