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

// 注記1件に入る量には限りがある。切り捨てると、読む側は
// 「切れた」ことに気づけないまま欠けた表を見ることになるので、
// 長い節は行の切れ目で分け、何分の何かを題に書いて全部出す。
const LIMIT = 3500;
const blocks = text.split(/^## /m).filter((b) => b.trim().length > 0);
for (const block of blocks) {
  const [head, ...rest] = block.split('\n');
  const title = head.trim();
  const lines = rest.join('\n').replace(/```/g, '').trim().split('\n');

  const chunks = [[]];
  let size = 0;
  for (const line of lines) {
    // %0A と %25 で膨らむぶんを見込んで、実際に送る長さで数える
    const cost = line.replace(/%/g, '%25').length + 3;
    if (size + cost > LIMIT && chunks.at(-1).length > 0) { chunks.push([]); size = 0; }
    chunks.at(-1).push(line);
    size += cost;
  }
  for (const [i, chunk] of chunks.entries()) {
    const label = chunks.length > 1 ? `${title}（${i + 1}/${chunks.length}）` : title;
    const esc = chunk.join('\n').replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
    console.log(`::notice title=${label}::${esc}`);
  }
}

// 仕事の要約にも出しておく（人が GitHub で見るとき用）
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n# ${title}\n\n${text}\n`);
}
