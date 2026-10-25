// 認証。リクエストから「誰か」を特定し、DB から権限（trust_level など）を読み込む。
//
// 本番：SessionAuthenticator（招待QRで登録した端末のセッショントークン。Authorization: Bearer <token>）
// 開発：DevHeaderAuthenticator（ヘッダーで利用者を指定。本番環境では作れない）
// パスキーやチェーン向けの SSO は、この Authenticator を足す形で後から追加する。

import { maybeOne, type Database } from '../db/db.ts';
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

  async identify(req: Request): Promise<Identity | null> {
    const header = req.headers.get('authorization') ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) return null;
    const token = m[1]!;
    const parsed = parseToken(token);
    if (!parsed) return null;
    const s = await this.database.withTenant(parsed.tenantId, (db) => verifySession(db, token));
    return s ? { tenantId: parsed.tenantId, userId: s.userId, sessionId: s.sessionId } : null;
  }
}

export interface Authenticator {
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

  async identify(req: Request): Promise<Identity | null> {
    const tenantId = req.headers.get('x-dev-tenant-id') ?? '';
    const userId = req.headers.get('x-dev-user-id') ?? '';
    if (!UUID.test(tenantId) || !UUID.test(userId)) return null;
    return { tenantId, userId };
  }
}

/** 有効な利用者なら Actor を返す。無効化された利用者は null。 */
export async function loadActor(database: Database, id: Identity): Promise<Actor | null> {
  return database.withTenant(id.tenantId, async (db) => {
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
  });
}
