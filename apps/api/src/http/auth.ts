// 認証。リクエストから「誰か」を特定し、DB から権限（trust_level など）を読み込む。
//
// 本番：SessionAuthenticator（招待QRで登録した端末のセッショントークン。Authorization: Bearer <token>）
// 開発：DevHeaderAuthenticator（ヘッダーで利用者を指定。本番環境では作れない）
// パスキーやチェーン向けの SSO は、この Authenticator を足す形で後から追加する。

import { maybeOne, type Database, type Db } from '../db/db.ts';
import type { Actor } from '../domain/actor.ts';
import { parseToken, verifySession } from '../domain/users.ts';

export interface Identity {
  userId: string;
  tenantId: string;
  /** 端末セッションで認証した場合のセッションID（ログアウト用） */
  sessionId?: string;
}

/** 招待QRで登録した端末のセッショントークンで認証する。 */
export class SessionAuthenticator implements Authenticator {
  constructor(private readonly database: Database) {}

  private bearer(req: Request): { token: string; tenantId: string } | null {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
    if (!m) return null;
    const parsed = parseToken(m[1]!);
    return parsed ? { token: m[1]!, tenantId: parsed.tenantId } : null;
  }

  tenantOf(req: Request): string | null {
    return this.bearer(req)?.tenantId ?? null;
  }

  async identifyIn(db: Db, req: Request): Promise<Identity | null> {
    const b = this.bearer(req);
    if (!b) return null;
    const s = await verifySession(db, b.token);
    return s ? { tenantId: b.tenantId, userId: s.userId, sessionId: s.sessionId } : null;
  }

  async identify(req: Request): Promise<Identity | null> {
    const tenantId = this.tenantOf(req);
    if (!tenantId) return null;
    return this.database.withTenant(tenantId, (db) => this.identifyIn(db, req));
  }
}

export interface Authenticator {
  /**
   * DB に触れずに、このリクエストのテナントだけを先に決める（分からなければ null）。
   * 呼び出し側は、このテナントで取引を1回だけ開き、その中で identifyIn → 権限の読み込み → ハンドラを流す。
   * 1リクエストで BEGIN / set_config / COMMIT を3回繰り返さないため。
   */
  tenantOf(req: Request): string | null;
  /** tenantOf のテナントで開いた取引（db）の中で、利用者を確かめる */
  identifyIn(db: Db, req: Request): Promise<Identity | null>;
  /** 取引を自分で開く版（取引の外から単独で確かめたいとき） */
  identify(req: Request): Promise<Identity | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 開発用：X-Dev-Tenant-Id と X-Dev-User-Id ヘッダーをそのまま信じる。本番では使えない。 */
export class DevHeaderAuthenticator implements Authenticator {
  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DevHeaderAuthenticator は本番環境では使えません。本番用の認証を実装してください。');
    }
  }

  tenantOf(req: Request): string | null {
    const tenantId = req.headers.get('x-dev-tenant-id') ?? '';
    return UUID.test(tenantId) && UUID.test(req.headers.get('x-dev-user-id') ?? '') ? tenantId : null;
  }

  /** ヘッダーを読むだけで DB は使わない（db は Authenticator と口をそろえるための引数） */
  async identifyIn(_db: Db | undefined, req: Request): Promise<Identity | null> {
    const tenantId = this.tenantOf(req);
    return tenantId ? { tenantId, userId: req.headers.get('x-dev-user-id')! } : null;
  }

  identify(req: Request): Promise<Identity | null> {
    return this.identifyIn(undefined, req);
  }
}

/** 有効な利用者なら Actor を返す。無効化された利用者は null。 */
export async function loadActor(database: Database, id: Identity): Promise<Actor | null> {
  return database.withTenant(id.tenantId, (db) => loadActorIn(db, id));
}

/** loadActor の「取引の中で動く版」（handleRequest が開いた1回の取引を使い回す） */
export async function loadActorIn(db: Db, id: Identity): Promise<Actor | null> {
  const u = await maybeOne<{ trust_level: Actor['trustLevel']; admin_scope: Actor['adminScope']; status: string }>(
    db,
    `SELECT trust_level, admin_scope, status FROM users WHERE id = $1`,
    [id.userId],
  );
  if (!u || u.status !== 'active') return null;
  const stores = await db.query<{ store_id: string }>(`SELECT store_id FROM memberships WHERE user_id = $1`, [id.userId]);
  return {
    userId: id.userId,
    tenantId: id.tenantId,
    storeIds: stores.map((s) => s.store_id),
    trustLevel: u.trust_level,
    adminScope: u.admin_scope,
  };
}
