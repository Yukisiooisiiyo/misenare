// テスト用：毎回スキーマを作り直し、2店舗・4人の利用者を用意する。
// 接続先は TEST_DATABASE_URL（既定はローカルの misenare_test）。スキーマを毎回消すので、開発用DBを指定しないこと。

import { execFileSync } from 'node:child_process';
import { SegmenterTokenizer } from '@misenare/search-core';
import { migrate } from '../src/cli/migrate.ts';
import type { Database } from '../src/db/db.ts';
import { assertRlsEnforced } from '../src/db/safety.ts';
import { PsqlDatabase } from '../src/db/psqlDatabase.ts';
import type { Actor } from '../src/domain/actor.ts';

/** テストで使う DB。DB_DRIVER=pg なら本番と同じ pg ドライバー、それ以外は psql アダプタ。 */
export type TestDatabase = Database & { raw(sql: string, params?: readonly unknown[]): Promise<unknown[]> };

async function openTestDatabase(url: string): Promise<TestDatabase> {
  if (process.env.DB_DRIVER === 'pg') {
    const { PgDatabase } = await import('../src/db/pgDatabase.ts');
    return new PgDatabase(url);
  }
  return new PsqlDatabase(url);
}

// テスト中はサーバーのログを出さない（TAP の出力に混ざるため）
process.env.MISENARE_LOG ??= 'off';

export const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://misenare:misenare@localhost/misenare_test';
if (!/_test\b/.test(new URL(DATABASE_URL).pathname)) {
  throw new Error(`TEST_DATABASE_URL のデータベース名は _test で終わるものにしてください（スキーマを消すため）: ${DATABASE_URL}`);
}

export const tokenizer = new SegmenterTokenizer();

export const T = '10000000-0000-0000-0000-000000000001';
export const OTHER_T = '10000000-0000-0000-0000-000000000002';
export const STORE_A = '20000000-0000-0000-0000-00000000000a';
export const STORE_B = '20000000-0000-0000-0000-00000000000b';
export const AREA_KITCHEN = '30000000-0000-0000-0000-000000000001';
export const AREA_BIG = '30000000-0000-0000-0000-000000000002';

export const visitor: Actor = { userId: '40000000-0000-0000-0000-000000000001', tenantId: T, storeIds: [STORE_A], trustLevel: 'visitor', adminScope: 'none' };
export const trusted: Actor = { userId: '40000000-0000-0000-0000-000000000002', tenantId: T, storeIds: [STORE_A], trustLevel: 'trusted', adminScope: 'none' };
export const manager: Actor = { userId: '40000000-0000-0000-0000-000000000003', tenantId: T, storeIds: [STORE_A], trustLevel: 'trusted', adminScope: 'store' };
export const hq: Actor = { userId: '40000000-0000-0000-0000-000000000004', tenantId: T, storeIds: [], trustLevel: 'trusted', adminScope: 'tenant' };
export const storeBStaff: Actor = { userId: '40000000-0000-0000-0000-000000000005', tenantId: T, storeIds: [STORE_B], trustLevel: 'trusted', adminScope: 'none' };
export const otherTenant: Actor = { userId: '40000000-0000-0000-0000-000000000009', tenantId: OTHER_T, storeIds: [], trustLevel: 'trusted', adminScope: 'tenant' };

export async function freshDatabase(): Promise<TestDatabase> {
  execFileSync('psql', [DATABASE_URL, '-X', '-q', '-c', 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'], { stdio: 'pipe' });
  migrate(DATABASE_URL);
  const db = await openTestDatabase(DATABASE_URL);
  // スーパーユーザーで接続すると RLS が効かず、他社のデータが見えるテストが「通ってしまう」ので止める
  await assertRlsEnforced((sql) => db.raw(sql));
  await db.raw(`INSERT INTO tenants (id, name) VALUES ($1, 'テスト電機'), ($2, '別の会社')`, [T, OTHER_T]);
  await db.withTenant(T, async (q) => {
    await q.query(`INSERT INTO stores (id, tenant_id, name) VALUES ($1, $3, '本店'), ($2, $3, '駅前店')`, [STORE_A, STORE_B, T]);
    await q.query(
      `INSERT INTO areas (id, tenant_id, store_id, name) VALUES ($1, $3, $4, 'キッチン家電'), ($2, $3, $4, '大型家電')`,
      [AREA_KITCHEN, AREA_BIG, T, STORE_A],
    );
    for (const [a, name] of [[visitor, '新人バイト'], [trusted, 'ベテランパート'], [manager, '店長'], [hq, '本部'], [storeBStaff, '駅前店スタッフ']] as const) {
      await q.query(
        `INSERT INTO users (id, tenant_id, name, trust_level, admin_scope) VALUES ($1, $2, $3, $4, $5)`,
        [a.userId, T, name, a.trustLevel, a.adminScope],
      );
      for (const storeId of a.storeIds) {
        await q.query(`INSERT INTO memberships (tenant_id, user_id, store_id) VALUES ($1, $2, $3)`, [T, a.userId, storeId]);
      }
    }
  });
  await db.withTenant(OTHER_T, (q) =>
    q.query(`INSERT INTO users (id, tenant_id, name, trust_level, admin_scope) VALUES ($1, $2, '他社', 'trusted', 'tenant')`, [otherTenant.userId, OTHER_T]),
  );
  return db;
}

/** 先頭12桁からチェックデジット付きの JAN-13 を作る */
export function jan(first12: string): string {
  const digits = [...first12].map(Number);
  let sum = 0;
  [...digits].reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return first12 + String((10 - (sum % 10)) % 10);
}
