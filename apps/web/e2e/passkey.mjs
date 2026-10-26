// パスキーの通し確認。**本物のブラウザの WebAuthn API** を通す。
//
// サーバー側の試験（apps/api/test/passkeys.test.ts）は、にせ認証器で署名を作って
// 検証の筋道を確かめている。それでは分からないことが2つある。
//   * ブラウザが受け取れる形の選択肢を返しているか（配列・バイト列の渡し方）
//   * 端末が覚えた鍵を、名前を聞かずに自分から出せるか（residentKey）
// どちらも「サーバーの試験は全部通るのに、実機では入れない」になる種類の穴なので、
// Chrome の仮想認証器（CDP の WebAuthn ドメイン）で端から端まで動かす。
//
//   DATABASE_URL=... npm run seed:demo > seed.txt
//   WEBAUTHN_RP_ID=localhost WEBAUTHN_ORIGINS=http://localhost:8787 DATABASE_URL=... npm run dev:api
//   node apps/web/e2e/passkey.mjs <seed.txt を置いたフォルダ>

import { chromium, devices } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const S = process.argv[2] ?? '.';
mkdirSync(`${S}/shots`, { recursive: true });
const seed = readFileSync(`${S}/seed.txt`, 'utf8');
const link = (label) => seed.split('\n').find((l) => l.startsWith(label)).split(': ')[1].trim();

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ja-JP' });
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

// Chrome に、指紋認証の付いた端末内蔵の認証器があるふりをさせる
const cdp = await ctx.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,        // 名前を聞かずに鍵を出せる端末（パスキーの前提）
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});

const shot = (name) => page.screenshot({ path: `${S}/shots/${name}.png` });
const log = (...a) => console.log(...a);
const fail = (msg) => { errors.push(msg); log('✗', msg); };
const ok = (msg) => log('✓', msg);

// --- 1. 招待で入って、パスキーを作る -----------------------------------------
await page.goto(link('新人'));
await page.waitForSelector('text=鈴木（新人）さん');
ok('招待リンクで入れた');

await page.click('.home-foot a');
await page.waitForSelector('h1:text("この端末の設定")');
await shot('01-device');

await page.click('button:text("この端末にパスキーを作る")');
// 一覧に行が出たことを確かめる（お知らせの吹き出しは数秒で消えるので、当てにしない）
await page.waitForSelector('li.row', { timeout: 20000 });
const names = await page.locator('li.row > span').first().innerText();
ok(`パスキーを作った（${names}）`);
await shot('02-registered');

// 本当に認証器の中に鍵が残っているか、ブラウザ側からも確かめる
const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
if (credentials.length !== 1) fail(`認証器の中の鍵が ${credentials.length} 個`);
else if (!credentials[0].isResidentCredential) fail('鍵が端末に残る形（resident）になっていない');
else if (!credentials[0].userHandle) fail('鍵に持ち主の印（userHandle）が入っていない');
else ok('端末の中に、持ち主の印の付いた鍵が1つ残った');

// --- 2. 端末の登録を失って、パスキーで入り直す --------------------------------
// 「スマホを買い替えた」「アプリのデータを消した」と同じ状態を作る
await page.evaluate(() => window.localStorage.removeItem('misenare.session'));
await page.goto(`${new URL(link('新人')).origin}/app/`);
await page.waitForSelector('button:text("パスキーで入る")');
await shot('03-welcome');
ok('端末の登録を失うと、入口の画面に戻る');

await page.click('button:text("パスキーで入る")');
await page.waitForSelector('text=鈴木（新人）さん', { timeout: 15000 });
ok('パスキーで入り直せた（招待なし）');
await shot('04-signed-in');

const token = await page.evaluate(() => window.localStorage.getItem('misenare.session'));
if (!token) fail('入れたのに端末のセッションが保存されていない');
else ok('新しい端末セッションを受け取った');

// --- 3. 指紋での確認を断ると、入れない ----------------------------------------
await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
await page.evaluate(() => window.localStorage.removeItem('misenare.session'));
await page.goto(`${new URL(link('新人')).origin}/app/`);
await page.click('button:text("パスキーで入る")');
await page.waitForSelector('.error:not([hidden])', { timeout: 15000 });
ok(`指紋での確認を断ると入れない（${(await page.locator('.error').innerText()).slice(0, 40)}）`);
await shot('05-refused');

await browser.close();
if (errors.length > 0) {
  console.error(`\n失敗 ${errors.length} 件:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
log('\nすべて通った');
