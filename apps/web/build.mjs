// Web 版を1つの app.js にまとめる。検索コア（@misenare/search-core）もここに含まれ、端末内で動く。
//   node apps/web/build.mjs        … dist/ を作る
//   node apps/web/build.mjs --watch

import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
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

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching apps/web/src …');
} else {
  await build(options);
  console.log(`built ${outdir}/app.js`);
}
