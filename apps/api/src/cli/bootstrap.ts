// 最初の会社・店舗と、本部の administrator への招待を作る（1社につき1回）。
//   DATABASE_URL=... npx tsx apps/api/src/cli/bootstrap.ts --tenant "テスト電機" --store "本店" --admin "山田"
// 表示された招待トークンを QR コードにしてスマホで読むか、/auth/accept に POST すると端末が登録される。

import { parseArgs } from 'node:util';
import { one } from '../db/db.ts';
import { hashToken, INVITATION_TTL_HOURS, issueToken } from '../domain/users.ts';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    store: { type: 'string' },
    admin: { type: 'string' },
    plan: { type: 'string', default: 'trial' },
  },
});
if (!values.tenant || !values.store || !values.admin) {
  console.error('使い方: bootstrap.ts --tenant <会社名> --store <最初の店舗名> --admin <本部担当者の名前>');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL を設定してください');

const database = process.env.DB_DRIVER === 'psql'
  ? new (await import('../db/psqlDatabase.ts')).PsqlDatabase(url)
  : new (await import('../db/pgDatabase.ts')).PgDatabase(url);
const tenant = (await database.raw(`INSERT INTO tenants (name, plan) VALUES ($1, $2) RETURNING id`, [values.tenant, values.plan]))[0] as { id: string };
const token = issueToken(tenant.id);
const store = await database.withTenant(tenant.id, async (db) => {
  const s = await one<{ id: string }>(db, `INSERT INTO stores (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tenant.id, values.store]);
  await db.query(
    `INSERT INTO invitations (tenant_id, token_hash, store_id, name, trust_level, admin_scope, expires_at)
     VALUES ($1, $2, NULL, $3, 'trusted', 'tenant', now() + make_interval(hours => $4))`,
    [tenant.id, hashToken(token), values.admin, INVITATION_TTL_HOURS],
  );
  return s;
});
await database.close();

console.log(`会社ID   : ${tenant.id}`);
console.log(`店舗ID   : ${store.id}`);
console.log(`招待（${INVITATION_TTL_HOURS}時間有効・1回限り）:`);
console.log(token);
