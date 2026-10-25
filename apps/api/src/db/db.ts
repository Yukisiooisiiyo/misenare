// データベースの抽象。SQL は $1, $2 … のプレースホルダで書く（pg と同じ）。

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

export interface Database {
  /**
   * テナントを固定した接続で fn を実行する。
   * 本番（pg）では BEGIN … COMMIT の中で `app.tenant_id` を設定し、行レベルセキュリティを効かせる。
   */
  withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function one<T>(db: Db, sql: string, params?: readonly unknown[]): Promise<T> {
  const rows = await db.query<T>(sql, params);
  if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}: ${sql.slice(0, 80)}`);
  return rows[0]!;
}

export async function maybeOne<T>(db: Db, sql: string, params?: readonly unknown[]): Promise<T | undefined> {
  const rows = await db.query<T>(sql, params);
  return rows[0];
}
