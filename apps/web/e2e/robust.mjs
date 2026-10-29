// 売場の悪い電波・連打・画面の行き来に対する、画面の頑丈さの確認。smoke.mjs と同じ手順で動かす。
//   1. DATABASE_URL=... npm run seed:demo > <dir>/seed.txt
//   2. DATABASE_URL=... npm run build:web && npm run dev:api     （別のターミナル。招待リンクの宛先と PORT を合わせる）
//   3. node apps/web/e2e/robust.mjs <seed.txt を置いたフォルダ>
// 確かめること：
//   (a) 投稿の送信ボタンを素早く2回押しても、作られるのは1件だけ
//   (b) 詳細・編集・承認管理の応答が遅れて届いても、先に移った別の画面を上書きしない
//   (c) 応答が 401 なら、招待画面へ戻って「セッションが切れました」を出す
//   (d) HTML が返ってきても（店舗 Wi-Fi のログイン画面など）、読めなかったと日本語で出す
import { chromium, devices } from 'playwright';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const S = process.argv[2] ?? '.';
const seed = readFileSync(`${S}/seed.txt`, 'utf8');
const link = (label) => seed.split('\n').find((l) => l.startsWith(label)).split(': ')[1].trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const errors = [];
async function login(label) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ja-JP' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(link(label));
  await page.waitForSelector('.tabbar');
  return page;
}
const api = (page, path) => page.evaluate(async (p) => {
  const r = await fetch(`/api${p}`, { headers: { authorization: `Bearer ${localStorage.getItem('misenare.session')}` } });
  return r.json();
}, path);
let passed = 0;
const ok = (name) => { passed += 1; console.log('ok -', name); };

// --- (a) 二重送信 -------------------------------------------------------------------
{
  const page = await login('ベテラン');
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/stores\/[^/]+\/knowledge$/.test(r.url())) posts.push(r.url()); });
  // 応答を待つ間に2回目を押せる幅を作る
  await page.route(/\/api\/stores\/[^/]+\/knowledge$/, async (route) => {
    if (route.request().method() === 'POST') await sleep(800);
    await route.continue();
  });
  const title = `二重送信の確認 ${Date.now()}`;
  await page.evaluate(() => { location.hash = '#/write'; });
  await page.fill('#title', title);
  await page.fill('#body', 'ボタンを素早く2回押しても、1件しか作られないことの確認。');
  await page.fill('#tag', '二重送信');
  await page.keyboard.press('Enter');
  // 1回目の送信が始まった直後と、その少しあとに、もう一度送信する
  const sent = await page.evaluate(async () => {
    const form = document.querySelector('form.write');
    const button = form.querySelector('button[type="submit"]');
    button.click();
    const disabledAfterFirst = button.disabled;
    button.click();
    form.requestSubmit();
    return { disabledAfterFirst };
  });
  assert.equal(sent.disabledAfterFirst, true, '送信中は送信ボタンが押せなくなる');
  await page.waitForFunction(() => location.hash.startsWith('#/k/') || document.querySelector('.reading-ask'), null, { timeout: 15000 });
  assert.equal(posts.length, 1, `POST は1回だけ（実際 ${posts.length} 回）`);
  const store = await page.evaluate(() => localStorage.getItem('misenare.store'));
  const found = await api(page, `/stores/${store}/search?q=${encodeURIComponent(title)}`);
  const same = found.hits.filter((h) => h.title === title);
  assert.equal(same.length, 1, `同じ題名のナレッジは1件だけ（実際 ${same.length} 件）`);
  ok('(a) 投稿の送信を連打しても1件しか作られない');
  await page.context().close();
}

// --- (b) 遅れて届いた応答で、別の画面に戻らない ----------------------------------------
{
  const page = await login('店長');
  const store = await page.evaluate(() => localStorage.getItem('misenare.store'));
  const hits = (await api(page, `/stores/${store}/search?q=${encodeURIComponent('冷蔵庫')}`)).hits;
  assert.ok(hits.length > 0, 'デモデータに冷蔵庫のナレッジがある');
  const id = hits[0].id;
  // 詳細・編集・承認管理の取得だけを1秒遅らせる
  const slow = async (route) => { await sleep(1000); await route.continue(); };
  await page.route(new RegExp(`/api/knowledge/${id}$`), slow);
  await page.route(/\/api\/stores\/[^/]+\/pending$/, slow);

  for (const [label, hash, gone] of [
    ['詳細', `#/k/${id}`, 'article.knowledge'],
    ['編集', `#/edit/${id}`, 'form.write'],
    ['承認・管理', '#/manage', 'section.manage h1'],
  ]) {
    await page.evaluate(() => { location.hash = '#/home'; });
    await page.waitForSelector('.search-launch');
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.evaluate(() => { location.hash = '#/search'; }); // 応答が来る前に別の画面へ
    await page.waitForSelector('#q');
    await sleep(1800); // 1秒遅れの応答が届くのを待つ
    assert.equal(await page.evaluate(() => location.hash.split('?')[0]), '#/search', `${label}：URL は検索のまま`);
    assert.ok(await page.locator('#q').isVisible(), `${label}：検索の画面が残っている`);
    assert.equal(await page.locator(gone).count(), 0, `${label}：遅れて届いた画面で上書きされない`);
  }
  ok('(b) 詳細・編集・承認管理の遅れた応答で、先に移った画面が上書きされない');
  await page.context().close();
}

// --- (d) JSON でない応答 ----------------------------------------------------------------
// 招待リンクは1回きりなので、(d) と (c) は同じ「新人」の端末で続けて行う
const newcomer = await login('新人');
{
  const page = newcomer;
  await page.route(/\/api\/stores\/[^/]+\/search\?/, (route) => route.fulfill({
    status: 200, contentType: 'text/html', body: '<html><body>店舗Wi-Fiへようこそ</body></html>',
  }));
  await page.evaluate(() => { location.hash = '#/search?q=' + encodeURIComponent('冷蔵庫'); });
  await page.waitForSelector('.results .error');
  const text = await page.locator('.results .error').innerText();
  assert.match(text, /応答を読めませんでした/);
  assert.doesNotMatch(text, /JSON|Unexpected|token/i);
  ok('(d) HTML が返ってきても日本語で知らせる');
}

// --- (c) 401 は招待画面へ（トークンを捨てるので最後） ----------------------------------------
{
  const page = newcomer;
  await page.route(/\/api\/stores\/[^/]+\/notices$/, (route) => route.fulfill({
    status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'ログインしてください' }),
  }));
  await page.evaluate(() => { location.hash = '#/notices'; });
  await page.waitForSelector('#invite');
  assert.match(await page.locator('.error').innerText(), /セッションが切れました/);
  assert.equal(await page.evaluate(() => localStorage.getItem('misenare.session')), null, 'トークンを捨てる');
  await sleep(300);
  assert.ok(await page.locator('#invite').isVisible(), '戻ったあとも招待画面のまま');
  ok('(c) 401 を受けたら招待画面に戻る');
  await page.context().close();
}

await browser.close();
assert.deepEqual(errors, [], `ページ内の例外: ${errors.join(' / ')}`);
console.log(`passed ${passed}/4`);
