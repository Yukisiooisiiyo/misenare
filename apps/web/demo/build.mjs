// デモ版（ブラウザだけで動く版）を1枚の HTML にまとめる。
// サーバーの代わりに demo/api.ts を使うよう、読み込み先だけ差し替える。

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const web = fileURLToPath(new URL('..', import.meta.url));
const out = `${here}dist`;
mkdirSync(out, { recursive: true });

// src の中の「./api.ts」を demo/api.ts に向けるプラグイン
const useDemoApi = {
  name: 'demo-api',
  setup(b) {
    b.onResolve({ filter: /(^|\/)api\.ts$/ }, (args) => {
      if (args.importer.includes('/demo/')) return null;
      return { path: `${here}api.ts` };
    });
  },
};

const result = await build({
  entryPoints: [`${web}/src/main.ts`],
  bundle: true,
  format: 'esm',
  target: ['es2022', 'safari16'],
  minify: true,
  // 既定では日本語が \uXXXX に展開され、1文字6バイトになる。
  // UTF-8 のまま出せば3バイト。画面の文字がほとんど日本語なので、ここが一番効く。
  charset: 'utf8',
  write: false,
  plugins: [useDemoApi],
});
const js = result.outputFiles[0].text;
const css = readFileSync(`${web}/public/styles.css`, 'utf8');
const html = readFileSync(`${web}/public/index.html`, 'utf8');

// index.html の <link>/<script> を中身に置き換える
const banner = `<div class="demo-bar">お試し版：書いたものはこの端末の中だけに残り、閉じると消えます</div>`;
const extraCss = `
.demo-bar {
  position: sticky; top: 0; z-index: 20; padding: 7px 12px;
  background: var(--pending, #9a5b00); color: #fff; font-size: 12px; text-align: center; line-height: 1.4;
}`;

// 公開時に <!doctype><html><head><body> が付くので、中身だけを書き出す
const page = [
  '<title>ミセナレ お試し版</title>',
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=BIZ+UDPGothic:wght@400;700&display=swap">',
  `<style>\n${css}\n${extraCss}\n</style>`,
  banner,
  '<div id="app"></div>',
  '<noscript>ミセナレを使うには JavaScript を有効にしてください。</noscript>',
  `<script type="module">\n${js}\n</script>`,
].join('\n');
void html;

writeFileSync(`${out}/index.html`, page);
console.log(`built ${out}/index.html (${(page.length / 1024).toFixed(0)}KB)`);
