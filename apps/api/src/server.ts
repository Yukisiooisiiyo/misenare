// API サーバーの起動。
//   DATABASE_URL  … PostgreSQL の接続文字列（必須）
//   PORT          … 既定 8787
//   DB_DRIVER     … pg（既定。npm install が必要）/ psql（pg を入れられない開発環境向け）
//   MISENARE_DEV_AUTH=1 … 開発用のヘッダー認証を使う（既定は招待QRの端末セッション）
//   TOKENIZER=kuromoji … 形態素解析で分割する（npm install kuromoji が必要。既定は Intl.Segmenter）
//   RATE_LIMIT=db … 試行回数を PostgreSQL で数える（台を増やすとき）
//   METRICS_TOKEN … /metrics を見るための合言葉（本番では必ず設定する）
//   ALERT_WEBHOOK_URL … サーバー側のエラーを知らせる先（Slack 互換）
//   WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS … パスキーを使うなら（ドメインが決まってから）
//   SSO_REDIRECT_URI … 会社のアカウントで入れるようにするなら
//
// 設定の点検は config.ts にある。足りないものは起動のときに声に出し、
// 黙って壊れるもの（本番で開発用の認証、など）では起動しない。
// CONFIG_CHECK=off で点検を飛ばせる（手元で試すときだけ）。

import { checkConfig, formatReport } from './config.ts';
import { chooseTokenizer } from './search/kuromojiTokenizer.ts';
import type { Database } from './db/db.ts';
import { assertRlsEnforced } from './db/safety.ts';
import { createApp } from './http/app.ts';
import { DevHeaderAuthenticator, SessionAuthenticator } from './http/auth.ts';
import { serve } from './http/nodeServer.ts';
import { createSite } from './http/site.ts';
import { Logger } from './http/observe.ts';
import { fileURLToPath } from 'node:url';

// 設定の点検を先に行う。足りないものは、動き出す前に言う
const report = checkConfig();
if (report.findings.length > 0) {
  for (const line of formatReport(report)) console.error(`[設定] ${line}`);
}
if (report.fatal && process.env.CONFIG_CHECK !== 'off') {
  console.error('[設定] 上の × を直してから起動してください（CONFIG_CHECK=off で無視できます）');
  process.exit(78); // EX_CONFIG
}

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
// 行レベルセキュリティを素通りするロール（スーパーユーザーなど）では起動しない
await assertRlsEnforced((sql) => database.raw(sql));
const logger = new Logger();
const app = createApp({
  logger,
  database,
  // MISENARE_DEV_AUTH=1 のときだけ開発用のヘッダー認証（本番環境では作れない）
  auth: process.env.MISENARE_DEV_AUTH === '1' ? new DevHeaderAuthenticator() : new SessionAuthenticator(database),
  tokenizer: await chooseTokenizer(),
});
// Web 版（apps/web をビルドした dist）を /app/ で、API を /api/ で配信する
const webDir = fileURLToPath(new URL('../../web/dist/', import.meta.url));
serve(createSite(app, webDir), port);
logger.info('listening', {
  port,
  rateLimit: process.env.RATE_LIMIT === 'db' ? 'db' : 'memory',
  tokenizer: process.env.TOKENIZER === 'kuromoji' ? 'kuromoji' : 'segmenter',
  photos: process.env.S3_BUCKET ? 's3' : 'local',
  alerts: process.env.ALERT_WEBHOOK_URL ? 'on' : 'off',
  // どの入口が開いているか。出したあとに「パスキーが出てこない」と言われたとき、
  // まずここを見れば分かる
  passkeys: process.env.WEBAUTHN_RP_ID ? 'on' : 'off',
  sso: process.env.SSO_REDIRECT_URI ? 'on' : 'off',
});
