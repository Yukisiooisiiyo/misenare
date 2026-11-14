// 画面の導線の棚卸し。見た目（CSS）を変える前と後で走らせ、押せるものが1つも減っていない・隠れていないことを確かめる。
//
//   1. DATABASE_URL=... npm run seed:demo > seed.txt      （毎回、空の DB に入れ直す）
//   2. DATABASE_URL=... MISENARE_DEV_AUTH= npm run dev:api （別のターミナル）
//   3. node apps/web/e2e/flows.mjs http://localhost:8787 <seed.txt のあるフォルダ> <出力先>
//   4. 変更の前後で出力先を分けて走らせ、node apps/web/e2e/flows.mjs --diff <前> <後>
//
// 見るもの：新人（visitor）と店長（管理者）と、入る前の画面。各画面の a / button / input / select / textarea / summary を全部拾い、
//   ・見えているか（大きさがある・visibility・opacity）
//   ・押せるか（真ん中の点に、別の要素がかぶさっていないか）
//   ・文字が地の色から読めるか（コントラスト比。地に画像があるときは目安）
// を記録する。値を変える操作（公開・削除など）は押さない。

import { chromium, devices } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

if (process.argv[2] === '--diff') {
  const load = (d) => JSON.parse(readFileSync(`${d}/flows.json`, 'utf8'));
  const [a, b] = [load(process.argv[3]), load(process.argv[4])];
  let bad = 0;
  const say = (m) => { bad++; console.log(m); };
  for (const screen of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const A = a[screen], B = b[screen];
    if (!A || !B) { say(`× 画面が片方にしかない: ${screen}`); continue; }
    const index = (list) => { const m = new Map(); for (const it of list) { const k = it.key; m.set(k, [...(m.get(k) ?? []), it]); } return m; };
    const ia = index(A), ib = index(B);
    for (const [k, itemsA] of ia) {
      const itemsB = ib.get(k) ?? [];
      if (itemsB.length < itemsA.length) say(`× 消えた [${screen}] ${k}（${itemsA.length} → ${itemsB.length}）`);
      itemsA.forEach((x, i) => {
        const y = itemsB[i];
        if (!y) return;
        if (x.visible && !y.visible) say(`× 見えなくなった [${screen}] ${k}`);
        if (x.reachable && !y.reachable) say(`× 押せなくなった [${screen}] ${k}（かぶさっている: ${y.coveredBy}）`);
        if (x.visible && y.visible && (y.h < Math.min(x.h, 44) - 2 || y.w < Math.min(x.w, 44) - 2)) say(`× 小さくなった [${screen}] ${k}（${x.w}x${x.h} → ${y.w}x${y.h}）`);
        if (y.visible && y.contrast !== null && y.contrast < 4.5 && (x.contrast === null || y.contrast < x.contrast - 0.3)) say(`△ 読みにくくなった [${screen}] ${k}（${x.contrast} → ${y.contrast}）`);
      });
    }
    for (const k of ib.keys()) if (!ia.has(k)) console.log(`・増えた [${screen}] ${k}`);
  }
  const total = Object.values(b).reduce((n, l) => n + l.length, 0);
  console.log(bad === 0 ? `○ ${Object.keys(b).length} 画面・${total} 個の押せるものが、すべて前と同じく見えて押せます` : `${bad} 件の違いがあります`);
  process.exit(bad === 0 ? 0 : 1);
}

const [base, seedDir, out] = process.argv.slice(2);
mkdirSync(`${out}/shots`, { recursive: true });
const seed = readFileSync(`${seedDir}/seed.txt`, 'utf8');
const line = (label) => seed.split('\n').find((l) => l.startsWith(label)).split(': ').slice(1).join(': ').trim();
const local = (url) => url.replace(/^https?:\/\/[^/]+/, base);
const browser = await chromium.launch();
const result = {};
const errors = [];

async function collect(page, name) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(350);
  await page.evaluate(() => { for (const d of document.querySelectorAll('details')) d.open = true; });
  await page.waitForTimeout(250);
  result[name] = await page.evaluate(() => {
    const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim().replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>').replace(/\d+/g, '#').slice(0, 48);
    const rgb = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].split(/[, /]+/).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const items = [];
    for (const el of document.querySelectorAll('a[href], button, input, select, textarea, summary')) {
      if (el.closest('.credits')) continue;
      const cs = getComputedStyle(el);
      const label = el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.id || el.getAttribute('name') || '';
      const href = el.getAttribute('href');
      const key = `${el.tagName.toLowerCase()}${el.type && el.tagName !== 'A' ? `[${el.type}]` : ''} 「${norm(label)}」${href ? ` → ${norm(href)}` : ''}${el.id ? ` #${el.id}` : ''}`;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const visible = r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.2;
      let reachable = false, coveredBy = '';
      if (visible) {
        const hit = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1));
        reachable = !!hit && (el.contains(hit) || hit.contains(el) || (hit.closest('label')?.contains(el) ?? false));
        if (!reachable && hit) coveredBy = `${hit.tagName.toLowerCase()}.${hit.className}`;
      }
      const fg = rgb(cs.color), bg = bgOf(el);
      const contrast = fg ? Math.round(((Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05)) * 10) / 10 : null;
      items.push({ key, visible, reachable, coveredBy, w: Math.round(r.width), h: Math.round(r.height), contrast });
    }
    scrollTo(0, 0);
    return items;
  });
  await page.screenshot({ path: `${out}/shots/${name}.png`, fullPage: true });
  console.log(`${name}: ${result[name].length}`);
}

async function phone() {
  // FLOWS_SCHEME=dark で、暗い画面（端末の設定）でも同じ棚卸しができる
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ja-JP', colorScheme: process.env.FLOWS_SCHEME === 'dark' ? 'dark' : 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  return page;
}
const to = async (page, hash, wait) => {
  await page.goto(page.url().replace(/#.*/, '') + hash);
  if (wait) await page.waitForSelector(wait, { timeout: 8000 });
};

// 入る前の画面
const w = await phone();
await w.goto(`${base}/app/`);
await w.waitForSelector('.welcome');
await collect(w, '00 入る前');

for (const [role, label] of [['新人', '新人'], ['店長', '店長']]) {
  const p = await phone();
  await p.goto(local(line(label)));
  await p.waitForSelector('.tabbar');
  await collect(p, `${role} 01 ホーム`);
  await to(p, '#/notices', '.scope-tab, .notices, .handover-form');
  await collect(p, `${role} 02 連絡`);
  const scopes = await p.locator('.scope-tab').count();
  for (let i = 0; i < scopes; i++) {
    await p.locator('.scope-tab').nth(i).click();
    await collect(p, `${role} 02 連絡 切り替え${i + 1}`);
  }
  await to(p, '#/search', '#q');
  await collect(p, `${role} 03 探す`);
  await p.fill('#q', '#冷');
  await p.waitForSelector('.suggest-item');
  await collect(p, `${role} 03 探す 候補`);
  await to(p, `#/search?q=${encodeURIComponent('冷蔵庫')}`, '.hit');
  await collect(p, `${role} 04 探した結果`);
  await to(p, `#/search?q=${encodeURIComponent('ガスコンロ')}`, '.empty');
  await collect(p, `${role} 04 見つからない`);
  await to(p, `#/search?q=${encodeURIComponent('冷蔵庫')}`, '.hit');
  const kHref = await p.locator('.hit').first().getAttribute('href');
  await to(p, kHref, 'article.knowledge h1');
  await collect(p, `${role} 05 ナレッジ`);
  await to(p, kHref.replace('/k/', '/edit/'), '#title');
  await collect(p, `${role} 06 編集`);
  await to(p, '#/write', '#title');
  await p.fill('#title', '冷蔵庫の搬入で玄関を通らないとき');
  await p.fill('#body', 'マンションの冷凍冷蔵庫の搬入は、窓からの吊り上げになることがある。配送センターに相談する。');
  await p.waitForSelector('.proposals .tag').catch(() => {});
  await collect(p, `${role} 07 書く`);
  await to(p, '#/scan', '#jan');
  await collect(p, `${role} 08 バーコード`);
  await p.fill('#jan', line('冷蔵庫のJAN'));
  await p.click('.search-bar button');
  await p.waitForSelector('.product-name');
  await collect(p, `${role} 08 バーコード 商品`);
  await p.fill('#jan', '4901234567894');
  await p.click('.search-bar button');
  await p.waitForSelector('#pname');
  await collect(p, `${role} 08 バーコード 未登録`);
  await to(p, '#/device', '.page');
  await collect(p, `${role} 09 この端末`);
  await to(p, '#/manage');
  await collect(p, `${role} 10 承認・管理`);
  await p.context().close();
}
await browser.close();
writeFileSync(`${out}/flows.json`, JSON.stringify(result, null, 1));
if (errors.length) { console.log('ページのエラー:', errors); process.exit(1); }
