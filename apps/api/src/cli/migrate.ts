// マイグレーションを番号順に適用する。適用済みのものは schema_migrations に記録して飛ばす。
//   DATABASE_URL=... npx tsx apps/api/src/cli/migrate.ts
// psql コマンドを使う（各ファイルは自分で BEGIN / COMMIT する）。

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../db/migrations/', import.meta.url));

function psql(url: string, args: string[]): string {
  return execFileSync('psql', [url, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function migrate(url: string, log: (msg: string) => void = () => {}): string[] {
  psql(url, ['-c', 'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())']);
  const applied = new Set(psql(url, ['-c', 'SELECT name FROM schema_migrations']).split('\n').filter(Boolean));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    log(`applying ${f}`);
    // ファイルの適用と「適用した」の記録を、同じ接続・同じトランザクション（-1）で行う。
    // 別々にすると、途中で失敗したとき ADD COLUMN だけが残って記録が無く、
    // やり直しが「column already exists」で止まる（BEGIN/COMMIT を書き忘れたファイルがあった）
    psql(url, ['-1', '-f', `${MIGRATIONS_DIR}${f}`, '-c', `INSERT INTO schema_migrations (name) VALUES ('${f.replace(/'/g, "''")}')`]);
    done.push(f);
  }
  return done;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL を設定してください');
  const done = migrate(url, console.log);
  console.log(done.length === 0 ? 'すでに最新です' : `${done.length} 件適用しました`);
}
