// ファイルの中身を GitHub Actions の注記（::notice::）として出す。
//
// 注記は API から読めるので、ログを開かなくても中身が分かる。
// テストの中から直に ::notice:: を出すと、TAP レポーターが行頭に印を付けて
// GitHub に拾われないので、いちどファイルに書いてここで出す。
//
//   使い方: node .github/scripts/notice-file.mjs <ファイル> [題]

import { readFileSync } from 'node:fs';

const path = process.argv[2];
const title = process.argv[3] ?? path;
if (!path) {
  console.error('ファイルを指定してください');
  process.exit(2);
}

let text;
try {
  text = readFileSync(path, 'utf8');
} catch {
  console.log(`::warning title=${title}::${path} がありません（測定が走らなかった可能性）`);
  process.exit(0);
}

// 注記1件は長すぎると切られるので、節ごとに分けて出す
const blocks = text.split(/^## /m).filter((b) => b.trim().length > 0);
for (const block of blocks) {
  const [head, ...rest] = block.split('\n');
  const body = rest.join('\n').replace(/```/g, '').trim();
  const esc = body.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
  console.log(`::notice title=${head.trim()}::${esc.slice(0, 4000)}`);
}

// 仕事の要約にも出しておく（人が GitHub で見るとき用）
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n# ${title}\n\n${text}\n`);
}
