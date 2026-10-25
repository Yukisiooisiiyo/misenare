// ブラウザでの通し確認（スマホの画面サイズ）。デモデータを入れたサーバーに対して実行する。
//   1. DATABASE_URL=... npm run seed:demo > seed.txt
//   2. DATABASE_URL=... npm run dev:api        （別のターミナル）
//   3. npx playwright install chromium         （初回のみ）
//   4. node apps/web/e2e/smoke.mjs <seed.txt と screenshots を置くフォルダ>
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
const S = process.argv[2] ?? '.';
mkdirSync(`${S}/shots`, { recursive: true });
const seed = readFileSync(`${S}/seed.txt`, 'utf8');
const link = (label) => seed.split('\n').find((l) => l.startsWith(label)).split(': ')[1].trim();
const jan = seed.split('\n').find((l) => l.startsWith('冷蔵庫のJAN')).split(': ')[1].trim();
const browser = await chromium.launch();
const errors = [];
async function phone() {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ja-JP' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', async (r) => { if (r.status() === 400) errors.push('400 ' + r.request().method() + ' ' + r.url() + ' ' + (r.request().postData() ?? '') + ' -> ' + (await r.text().catch(() => ''))); });
  return page;
}
const shot = (p, name) => p.screenshot({ path: `${S}/shots/${name}.png` });
const log = (...a) => console.log(...a);
const searchFor = async (p, q) => {
  await p.fill('#q', q);
  await p.keyboard.press('Enter');
  await p.waitForFunction((q) => document.querySelector('.results')?.dataset.query === q, q.trim());
  return p.locator('.hit-title').allInnerTexts();
};

// 新人（visitor）
const p = await phone();
await p.goto(link('新人'));
await p.waitForSelector('text=鈴木（新人）さん');
await shot(p, '01-home');
await p.click('a.search-launch');
await p.fill('#q', '#冷');
await p.waitForSelector('.suggest-item');
await shot(p, '02-suggest-kana');
log('suggest for #冷:', await p.locator('.suggest-list').first().innerText());
await p.click('.suggest-item >> nth=0');
await p.waitForSelector('.hit');
await shot(p, '03-results');
log('results for', await p.inputValue('#q'), '=>', await p.locator('.hit-title').allInnerTexts());
log('chips:', await p.locator('.chips .tag').allInnerTexts());
await p.fill('#q', '#エアコン');
await p.waitForTimeout(300);
await p.locator('#q').dispatchEvent('input');
await p.waitForSelector('.maybe-label');
await shot(p, '04-maybe');
log('maybe:', await p.locator('.suggest-maybe').innerText());
log('results for #エアコン =>', await searchFor(p, '#エアコン'));
log('results for テレビ 映らない =>', await searchFor(p, 'テレビ 映らない'));
log('results for 延長保証 =>', await searchFor(p, '#延長保証'));
await p.click('.hit >> nth=0');
await p.waitForSelector('article.knowledge h1');
await shot(p, '05-detail');
await p.fill('#q', '').catch(() => {});
await p.goto(p.url().replace(/#.*/, '#/search?q=' + encodeURIComponent('食洗機 ホース')));
await p.waitForSelector('.hit, .empty');
await p.goto(p.url().replace(/#.*/, '#/search?q=' + encodeURIComponent('ガスコンロ')));
await p.waitForSelector('.empty');
await shot(p, '06-empty');
// 書く
await p.click('a.tab >> text=書く');
await p.fill('#title', '冷蔵庫の搬入で玄関を通らないとき');
await p.fill('#body', 'マンションの冷凍冷蔵庫の搬入は、窓からの吊り上げになることがある。配送センターに相談する。');
await p.waitForSelector('.proposals .tag');
log('proposals:', await p.locator('.proposals .tag').allInnerTexts());
await p.click('.proposals .tag >> nth=0');
await p.fill('#tag', 'はんにゅ');
await p.waitForSelector('.suggest-warn');
await shot(p, '07a-kana-warning');
await p.fill('#tag', '配');
await p.locator('#tag').dispatchEvent('input');
await p.waitForSelector('#tag ~ .suggest .suggest-item');
await shot(p, '07-write');
await p.click('.suggest .suggest-item >> nth=0');
log('selected tags:', await p.locator('.write .tag-row').first().innerText());
await p.click('button[type=submit]');
await p.waitForSelector('text=承認待ちです');
await shot(p, '08-pending');
// バーコード
await p.goto(p.url().replace(/#.*/, '#/scan'));
await p.fill('#jan', jan);
await p.click('.search-bar button');
await p.waitForSelector('.product-name');
await shot(p, '09-scan');
log('product:', await p.locator('.product-name').innerText(), '| related:', await p.locator('.hit-title').allInnerTexts());
await p.fill('#jan', '4901234567894');
await p.click('.search-bar button');
await p.waitForSelector('#pname');
await shot(p, '10-scan-unknown');

// 店長：承認
const m = await phone();
await m.goto(link('店長'));
await m.waitForSelector('text=佐藤店長さん');
await m.click('text=承認・管理');
await m.waitForSelector('text=承認待ち（1件）');
await shot(m, '11-manage');
await m.click('text=公開する');
await m.waitForSelector('text=公開しました');
await m.click('button:has-text("招待リンクを作る")').catch(() => {});
await m.fill('#iname', '高橋');
await m.click('button:has-text("招待リンクを作る")');
await m.waitForSelector('.invite-link');
await shot(m, '12-invite');
// 公開後、新人の検索に出る
await p.goto(p.url().replace(/#.*/, '#/search?q=' + encodeURIComponent('吊り上げ')));
await p.waitForSelector('.hit');
log('after approval =>', await p.locator('.hit-title').allInnerTexts());
log('console errors:', errors);
await browser.close();
