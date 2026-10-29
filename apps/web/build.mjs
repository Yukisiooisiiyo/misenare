// Web 版を1つの app.js にまとめる。検索コア（@misenare/search-core）もここに含まれ、端末内で動く。
//   node apps/web/build.mjs        … dist/ を作る
//   node apps/web/build.mjs --watch

import { build, context } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const outdir = `${here}dist`;
mkdirSync(outdir, { recursive: true });
cpSync(`${here}public`, outdir, { recursive: true });

const options = {
  entryPoints: [`${here}src/main.ts`],
  outfile: `${outdir}/app.js`,
  bundle: true,
  format: 'esm',
  target: ['es2022', 'safari16'],
  minify: !process.argv.includes('--watch'),
  // 既定では日本語が \uXXXX に展開され、1文字6バイトになる。
  // UTF-8 のまま出せば3バイト。画面の文字がほとんど日本語なので、ここが一番効く。
  charset: 'utf8',
  sourcemap: true,
  legalComments: 'none',
};

/**
 * app.js / styles.css を内容のハッシュ付きの名前（app.1a2b3c4d.js）でも出し、index.html をその名前に向ける。
 * ハッシュ付きの名前は中身が変われば名前も変わるので、サーバーが1年キャッシュしてよい（site.ts）。
 * 元の名前も残す（古い index.html を持った端末が壊れないように）。
 */
function hashAssets() {
  // 前のビルドのハッシュ付きファイルが溜まらないようにする
  for (const f of readdirSync(outdir)) {
    if (/^(app|styles)\.[0-9a-f]{8}\.(js|css|js\.map)$/.test(f)) rmSync(`${outdir}/${f}`);
  }
  let html = readFileSync(`${outdir}/index.html`, 'utf8');
  for (const [name, stem, ext] of [['app.js', 'app', 'js'], ['styles.css', 'styles', 'css']]) {
    const body = readFileSync(`${outdir}/${name}`);
    const hashed = `${stem}.${createHash('sha256').update(body).digest('hex').slice(0, 8)}.${ext}`;
    writeFileSync(`${outdir}/${hashed}`, body);
    html = html.replace(`"${name}"`, `"${hashed}"`);
  }
  writeFileSync(`${outdir}/index.html`, html);
}

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching apps/web/src …');
} else {
  await build(options);
  hashAssets();
  console.log(`built ${outdir}/app.js`);
}
