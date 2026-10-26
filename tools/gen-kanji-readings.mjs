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
 * 載せる漢字を絞る。基準は **JIS X 0208 に入っているか**（第1・第2水準、約6300字）。
 *
 * 常用漢字＋人名用漢字（grade 1〜10）だけだと「梱」（開梱）が落ちた。
 * 新聞頻度（freq）を足しても落ちたままだった。梱包は売場で毎日使う言葉なのに、
 * 新聞には出てこないからである。
 * 「日本語の文章に書ける字」という線なら、こういう抜けが起きない。
 *
 * この表はサーバー側で読みの候補を作るのに使う（端末には配らない）。
 * 字数が増えても配信量には響かないので、広い方を採る。
 */
const inJis208 = (block) => /cp_type="jis208"/.test(block);

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
 * **この「.」は落とさずにそのまま残す。**
 *
 * 落とすと「す.える」が「ス」になり、据付＝スエツケ が作れなくなる。
 * 複合語に出てくるのは連用形（すえ、つけ、おろし）で、それは送り仮名から
 * 規則で起こせる。規則は読む側（kanjiReadings.ts）に置く。
 * ここでは出典の形をできるだけそのまま写す。
 *
 * 接頭辞・接尾辞の印である「-」だけは落とす（読みではないため）。
 */
const clean = (reading) => KATA(reading.replace(/-/g, '').trim());

const entries = [];
let kept = 0; let skipped = 0;
for (const block of xml.split('<character>').slice(1)) {
  const literal = /<literal>(.)<\/literal>/u.exec(block)?.[1];
  if (!literal) continue;
  if (!inJis208(block)) { skipped++; continue; }

  const on = [];
  const kun = [];
  for (const m of block.matchAll(/<reading r_type="ja_(on|kun)">([^<]+)<\/reading>/g)) {
    const value = clean(m[2]);
    // 「.」は送り仮名の区切りとして1つだけ許す。それ以外の記号が混じる読みは捨てる。
    if (value === '' || !/^[ァ-ヶー]+(\.[ァ-ヶー]+)?$/.test(value)) continue;
    if (m[1] === 'on' && value.includes('.')) continue;
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
// 収録: JIS X 0208（第1・第2水準）の漢字のうち、読みが載っている ${kept} 字。
// 形: 「漢字:音読み,音読み|訓読み,訓読み」を「;」でつないだ1本の文字列。
//     オブジェクトのリテラルで持つより小さい。
//     訓読みは送り仮名を「.」で区切ったまま（カワ.ク、ス.エル）。
//     連用形（スエ、オロシ）は読む側が送り仮名から規則で起こす。

/** 生成日: ${new Date().toISOString().slice(0, 10)} */
export const KANJI_READINGS_RAW = '${entries.join(';')}';
`;

await writeFile(OUT, body, 'utf8');
console.error(`出力: ${OUT}（${(body.length / 1024).toFixed(0)}KB）`);
