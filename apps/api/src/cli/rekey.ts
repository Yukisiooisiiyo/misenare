// 内緒の値を、いまの鍵で包み直す。
//
// 使うのは2つの場面：
//   1. はじめて鍵を決めたとき（それまで平の形で入っていたものを包む）
//   2. 鍵を入れ替えるとき（古い鍵で開けて、新しい鍵で包み直す）
//
// 止めずに替える順番：
//   a. 新しい鍵を MISENARE_SECRET_KEYS に**足す**（古いものは残す）
//   b. MISENARE_SECRET_KEY_ID を新しい鍵に向けて、アプリを入れ替える
//   c. これを流す
//   d. 古い鍵を MISENARE_SECRET_KEYS から外して、アプリを入れ替える
//
// 何も包み直す必要がなければ、何も書かない。何度流しても同じ結果になる。
//
//   DATABASE_URL=… MISENARE_SECRET_KEYS=… npx tsx apps/api/src/cli/rekey.ts [--dry-run]

import { isSealed, secretBoxFromEnv, sealedWith } from '../crypto/secretBox.ts';
import type { Database } from '../db/db.ts';

const dryRun = process.argv.includes('--dry-run');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL を設定してください');

const box = secretBoxFromEnv();
if (!box.configured) {
  console.error('MISENARE_SECRET_KEYS を決めてください（包み直す鍵がありません）');
  process.exit(78);
}

const database: Database = process.env.DB_DRIVER === 'psql'
  ? new (await import('../db/psqlDatabase.ts')).PsqlDatabase(url)
  : new (await import('../db/pgDatabase.ts')).PgDatabase(url);

const { assertRlsEnforced } = await import('../db/safety.ts');
await assertRlsEnforced((sql) => database.raw(sql));

const tenants = (await database.raw(`SELECT id FROM tenants ORDER BY created_at`)) as Array<{ id: string }>;
let looked = 0;
let changed = 0;

for (const { id: tenantId } of tenants) {
  await database.withTenant(tenantId, async (db) => {
    const rows = await db.query<{ id: string; client_secret: string }>(
      `SELECT id, client_secret FROM sso_providers WHERE client_secret IS NOT NULL`,
    );
    for (const row of rows) {
      looked++;
      const aad = `sso_providers.client_secret:${tenantId}:${row.id}`;
      const already = sealedWith(row.client_secret);
      if (already === box.keyId) continue; // もう今の鍵で包まれている
      const plaintext = box.open(row.client_secret, aad);
      const sealed = box.seal(plaintext, aad);
      const what = isSealed(row.client_secret) ? `${already} → ${box.keyId}` : `平の形 → ${box.keyId}`;
      console.log(`${dryRun ? '（やらない）' : '包み直す'} sso_providers ${row.id}（${what}）`);
      if (!dryRun) {
        await db.query(`UPDATE sso_providers SET client_secret = $2 WHERE id = $1`, [row.id, sealed]);
      }
      changed++;
    }
  });
}

console.log(`見た ${looked} 件 / ${dryRun ? '包み直すべき' : '包み直した'} ${changed} 件`);
await database.close();
