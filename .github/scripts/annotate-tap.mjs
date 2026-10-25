// TAP 出力から失敗したテストを拾い、GitHub Actions の注釈（::error::）にする。
// 注釈は API からも読めるので、ログを開かなくても失敗の内容が分かる。

import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2] ?? 'test-output.tap', 'utf8').split('\n');
let count = 0;
for (let i = 0; i < lines.length && count < 20; i++) {
  const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
  if (!m) continue;
  // 直後の YAML ブロックから error と location を拾う
  const detail = [];
  let location = '';
  for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
    const l = lines[j];
    if (/^\s*\.\.\.\s*$/.test(l)) break;
    if (/location:/.test(l)) location = l.split("location: ")[1]?.replace(/'/g, '') ?? '';
    if (/(error|expected|actual|message|code):/.test(l) || /^\s{8,}\S/.test(l)) detail.push(l.trim());
  }
  if (detail.length === 0) continue; // 親のスイートの "not ok" は飛ばす
  const msg = `${m[1]} @ ${location}\n${detail.slice(0, 15).join('\n')}`.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
  console.log(`::error title=test failed::${msg}`);
  count++;
}
if (count === 0) {
  const tail = lines.filter((l) => l.trim()).slice(-25).join('\n').replace(/%/g, '%25').replace(/\n/g, '%0A');
  console.log(`::error title=test failed (tail)::${tail}`);
}
