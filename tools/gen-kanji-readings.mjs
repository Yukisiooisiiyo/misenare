// 漢字1文字ごとの読みの表を、KANJIDIC2 から作る。
//
// なぜ生成するか：手で書くと必ず穴が残る（実際、乾燥機の「乾」「燥」で詰まった）。
// 出典を1つに決めて、機械に作らせて、定期的に取り直す。
//
// 出典：KANJIDIC2（電子辞書研究開発グループ EDRDG）
//   https://www.edrdg.org/kanjidic/kanjidic2.xml.gz
//   ライセンス：Creative Commons Attribution-ShareAlike 4.0 (CC BY-SA 4.0)
//   https://www.edrdg.org/edrdg/license.html
//   * 商用利用に制限はない。自社のコードを公開する必要もない。
//   * ただし **ここで作ったファイルは CC BY-SA 4.0 で配布する**（ShareAlike）。
//     だから生成物は1ファイルに閉じ、冒頭にライセンスを書く。
//   * 出典の表示と、定期的な更新が要る。更新は .github/workflows/kanji-readings.yml。
//
// 別の出典に替えたくなったら（たとえば常用漢字表＝告示なのでパブリックドメイン）、
// この台本だけを差し替えればよい。出力の形は変えないこと。
//
//   使い方: node tools/gen-kanji-readings.mjs [出力先]

import { writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const SOURCE = 'https://www.edrdg.org/kanjidic/kanjidic2.xml.gz';
const OUT = process.argv[2] ?? 'packages/search-core/src/kanjiReadings.generated.ts';

/**
 * 載せる漢字を絞る。
 * grade が付いているもの＝常用漢字（1〜8）と人名用漢字（9〜10）。
 * それ以外は売場の言葉には出てこないし、入れると表が太って候補も荒れる。
 */
const KEEP_GRADES = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);

console.error(`取得: ${SOURCE}`);
const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`取得できません: ${res.status} ${res.statusText}`);
const xml = gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8');
console.error(`展開: ${(xml.length / 1e6).toFixed(1)}MB`);

const KATA = (s) => [...s].map((c) => {
  const code = c.codePointAt(0);
  return code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : c;
}).join('');

/**
 * 訓読みは「かわ.く」のように、送り仮名を「.」で区切って書いてある。
 * 欲しいのは漢字そのものの読み（かわ）なので、「.」から後ろを落とす。
 * 接頭辞・接尾辞の印である「-」も落とす。
 */
const stem = (reading) => KATA(reading.split('.')[0].replace(/-/g, '').trim());

const entries = [];
let kept = 0; let skipped = 0;
for (const block of xml.split('<character>').slice(1)) {
  const literal = /<literal>(.)<\/literal>/u.exec(block)?.[1];
  if (!literal) continue;
  const grade = /<grade>(\d+)<\/grade>/.exec(block)?.[1];
  if (grade === undefined || !KEEP_GRADES.has(grade)) { skipped++; continue; }

  const on = [];
  const kun = [];
  for (const m of block.matchAll(/<reading r_type="ja_(on|kun)">([^<]+)<\/reading>/g)) {
    const value = stem(m[2]);
    if (value === '' || !/^[ァ-ヶー]+$/.test(value)) continue;
    const list = m[1] === 'on' ? on : kun;
    if (!list.includes(value)) list.push(value);
  }
  if (on.length === 0 && kun.length === 0) { skipped++; continue; }
  entries.push(`${literal}:${on.join(',')}|${kun.join(',')}`);
  kept++;
}
entries.sort();
console.error(`採用 ${kept} 字 / 見送り ${skipped} 字`);
if (kept < 2000) throw new Error(`字数が少なすぎます（${kept}）。出典の形が変わった可能性があります`);

const body = `// === 自動生成。手で書き換えないこと ===
//
// 作り方: node tools/gen-kanji-readings.mjs
// 取り直し: .github/workflows/kanji-readings.yml（月1回）
//
// 出典: KANJIDIC2 — 電子辞書研究開発グループ (EDRDG)
//   https://www.edrdg.org/kanjidic/kanjidic2.xml.gz
//
// このファイルの内容は KANJIDIC2 から作った派生物であり、
// **Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)**
// で提供されます。
//   https://creativecommons.org/licenses/by-sa/4.0/
//   https://www.edrdg.org/edrdg/license.html
// 著作権は EDRDG および James William Breen 氏が保持しています。
//
// 収録: 常用漢字・人名用漢字 ${kept} 字。
// 形: 「漢字:音読み,音読み|訓読み,訓読み」を「;」でつないだ1本の文字列。
//     オブジェクトのリテラルで持つより小さく、端末に送る量が減る。
//     訓読みは送り仮名（「かわ.く」の「く」）を落とした、漢字そのものの読み。

/** 生成日: ${new Date().toISOString().slice(0, 10)} */
export const KANJI_READINGS_RAW = '${entries.join(';')}';
`;

await writeFile(OUT, body, 'utf8');
console.error(`出力: ${OUT}（${(body.length / 1024).toFixed(0)}KB）`);
