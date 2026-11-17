// 運営者の2段階の確認を、サーバーの中から外す。
//
// 認証アプリも予備のコードも無くして、管理画面に入れなくなったときの、最後の戻り道。
// 画面やメールからは外せないようにしてある（メールを読めるだけの人を止めるため）ので、
// サーバーに入れる人が、ここから外す。外すと、その運営者のログインはすべて切れ、操作の記録に残る。
//
//   docker compose run --rm api npx tsx apps/api/src/cli/operator-2fa-off.ts owner@example.com
//
// そのあと、管理画面にパスワードで入り、「安全」から設定し直す。

import { forceDisableTotp } from '../domain/operator.ts';

const email = process.argv[2]?.trim() ?? '';
if (email === '' || email.startsWith('-')) {
  console.error('使い方: operator-2fa-off.ts <運営者のメールアドレス>');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL を設定してください');

const database = process.env.DB_DRIVER === 'psql'
  ? new (await import('../db/psqlDatabase.ts')).PsqlDatabase(url)
  : new (await import('../db/pgDatabase.ts')).PgDatabase(url);
const done = await forceDisableTotp(database, email);
await database.close();
if (!done) {
  console.error(`運営者が見つかりません: ${email}`);
  process.exit(1);
}
console.log(`2段階の確認を外しました: ${email}（ログインはすべて切れています。パスワードで入り、設定し直してください）`);
