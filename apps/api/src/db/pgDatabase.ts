// 本番用：node-postgres（pg）による実装。`npm install pg @types/pg` が必要。

import pg from 'pg';
import type { Database, Db } from './db.ts';

type Pool = InstanceType<typeof pg.Pool>;

export class PgDatabase implements Database {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const db: Db = {
      query: async <R>(sql: string, params?: readonly unknown[]) =>
        (await client.query(sql, params as unknown[] | undefined)).rows as R[],
    };
    try {
      await client.query('BEGIN');
      // 第3引数 true：このトランザクションの中だけ有効
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(db);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
