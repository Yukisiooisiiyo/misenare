// API サーバーの起動。
//   DATABASE_URL  … PostgreSQL の接続文字列（必須）
//   PORT          … 既定 8787
//   DB_DRIVER     … pg（既定。npm install が必要）/ psql（pg を入れられない開発環境向け）
//   MISENARE_DEV_AUTH=1 … 開発用のヘッダー認証を使う（既定は招待QRの端末セッション）

import { SegmenterTokenizer } from '@misenare/search-core';
import type { Database } from './db/db.ts';
import { createApp } from './http/app.ts';
import { DevHeaderAuthenticator, SessionAuthenticator } from './http/auth.ts';
import { serve } from './http/nodeServer.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL を設定してください');
const port = Number(process.env.PORT ?? 8787);

async function openDatabase(): Promise<Database> {
  if (process.env.DB_DRIVER === 'psql') {
    const { PsqlDatabase } = await import('./db/psqlDatabase.ts');
    return new PsqlDatabase(url!);
  }
  const { PgDatabase } = await import('./db/pgDatabase.ts');
  return new PgDatabase(url!);
}

const database = await openDatabase();
const app = createApp({
  database,
  // MISENARE_DEV_AUTH=1 のときだけ開発用のヘッダー認証（本番環境では作れない）
  auth: process.env.MISENARE_DEV_AUTH === '1' ? new DevHeaderAuthenticator() : new SessionAuthenticator(database),
  tokenizer: new SegmenterTokenizer(),
});
serve(app, port);
console.log(`misenare api listening on http://localhost:${port}`);
