// API サーバーの起動。
//   DATABASE_URL  … PostgreSQL の接続文字列（必須）
//   PORT          … 既定 8787
//   DB_DRIVER     … pg（既定。npm install が必要）/ psql（pg を入れられない開発環境向け）
//   MISENARE_DEV_AUTH=1 … 開発用のヘッダー認証を使う（既定は招待QRの端末セッション）
//   TOKENIZER=kuromoji … 形態素解析で分割する（npm install kuromoji が必要。既定は Intl.Segmenter）
//   MISENARE_WORKERS … API のプロセス数（既定 1）。2 以上なら node:cluster で束ねる。
//                      辞書のキャッシュと記憶の中の試行回数はプロセスごとになる（docs/deploy.md の 12）
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
import { Alerts, Logger } from './http/observe.ts';
import cluster from 'node:cluster';
import { fileURLToPath } from 'node:url';

// 設定の点検を先に行う。足りないものは、動き出す前に言う
// （ワーカーでも同じ点検は通るが、同じ指摘を台数ぶん繰り返さないよう、言うのは親だけ）
const report = checkConfig();
if (report.findings.length > 0 && !cluster.isWorker) {
  for (const line of formatReport(report)) console.error(`[設定] ${line}`);
}
if (report.fatal && process.env.CONFIG_CHECK !== 'off') {
  console.error('[設定] 上の × を直してから起動してください（CONFIG_CHECK=off で無視できます）');
  process.exit(78); // EX_CONFIG
}

// プロセス全体の最後の受け皿。親（cluster の見張り）でもワーカーでも効くよう、分かれ道より前に置く。
// どちらも付けないと、Node は何も記録せずに（スタックを標準エラーに出すだけで）落ちる。
const logger = new Logger();
const alerts = new Alerts();
const describe = (err: unknown): { error: string; stack?: string | undefined } =>
  err instanceof Error ? { error: err.message, stack: err.stack } : { error: String(err) };

process.on('unhandledRejection', (reason) => {
  // 1 件の待たれていない失敗でプロセスを止めない。記録して知らせるだけで続ける
  logger.error('unhandledRejection', describe(reason));
  void alerts.notify('unhandledRejection', `misenare: unhandledRejection\n${describe(reason).error}`);
});
let dying = false;
process.on('uncaughtException', (err) => {
  // どこまで壊れているか分からないので続けない。記録と通知の時間を 1 秒だけとり、
  // 終了コード 1 で落として restart policy（docker の restart / cluster の立て直し）に任せる
  logger.error('uncaughtException', describe(err));
  if (dying) return;
  dying = true;
  void alerts.notify('uncaughtException', `misenare: uncaughtException\n${describe(err).error}`);
  setTimeout(() => process.exit(1), 1000);
});

// 1台の 4 OCPU を使い切るために、同じ serve() を回すプロセスを複数立てる。
// 親は点検のあと子を立てて見張るだけで、DB には触れない。落ちた子は立て直す。
const workers = Math.max(1, Math.floor(Number(process.env.MISENARE_WORKERS ?? 1)) || 1);
if (workers >= 2 && cluster.isPrimary) {
  let stopping = false;
  const spawn = (): void => { cluster.fork(); };
  for (let i = 0; i < workers; i++) spawn();
  cluster.on('exit', (worker, code, signal) => {
    if (stopping) return;
    console.error(`[cluster] worker ${worker.process.pid} が止まりました（code=${code} signal=${signal}）。立て直します`);
    // DB が落ちているなどで起動のたびに死ぬとき、休みなく立て直すと CPU を食い潰すので1秒あける
    setTimeout(spawn, 1000);
  });
  const stop = (): void => {
    stopping = true;
    for (const w of Object.values(cluster.workers ?? {})) w?.kill('SIGTERM');
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // 子が全員いなくなるまで親は動かし続ける。ここから下（DB を開いて serve する部分）は子だけが通る
  await new Promise<void>((resolve) => cluster.on('exit', () => { if (stopping && Object.keys(cluster.workers ?? {}).length === 0) resolve(); }));
  process.exit(0);
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
  // アイドル接続の切断（DB の再起動など）は記録して続ける。接続はプールが作り直す
  return new PgDatabase(url!, (err) => logger.error('pg pool idle client error', describe(err)));
}

const database = await openDatabase();
// 行レベルセキュリティを素通りするロール（スーパーユーザーなど）では起動しない
await assertRlsEnforced((sql) => database.raw(sql));
const app = createApp({
  logger,
  alerts,
  database,
  // MISENARE_DEV_AUTH=1 のときだけ開発用のヘッダー認証（本番環境では作れない）
  auth: process.env.MISENARE_DEV_AUTH === '1' ? new DevHeaderAuthenticator() : new SessionAuthenticator(database),
  tokenizer: await chooseTokenizer(),
});
// Web 版（apps/web をビルドした dist）を /app/ で、API を /api/ で配信する
const webDir = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const server = serve(createSite(app, webDir), port);
// ポートが使用中（EADDRINUSE）などで待ち受けられないとき。リスナが無いと uncaughtException になるので、
// 理由が分かる形で記録し、終了コード 1 で落とす（立て直しは restart policy に任せる）
server.on('error', (err) => {
  logger.error('server error', describe(err));
  process.exit(1);
});
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
