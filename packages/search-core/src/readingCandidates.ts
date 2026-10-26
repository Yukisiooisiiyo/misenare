// 語の読みの候補を、漢字の読みの総当たりで作る。
//
// 狙いは「当てる」ことではなく「**選べるようにする**」こと。
// 人が選ぶなら1位が当たっている必要はなく、候補に入っていればよい。
// だから並べ替えを外しても害がなく、総当たりの弱点（決め手が無い）が消える。
//
// 絞り方は辞書引きではなく、日本語の複合語の規則。根拠は4つだけ：
//
//   1. 音読みどうし・訓読みどうしで揃うのが普通。混ざる（重箱・湯桶読み）のは稀。
//        食洗機 → ショク+セン+キ（音音音）… 普通
//               → ショク+アライ+キ（音訓音）… 重箱読み＝稀
//   2. 漢字だけが並ぶ語は、音読みで揃うほうが多数派（漢語）。
//        室外機 → シツガイキ（○）／ ムロソトハタ（×）
//   3. 送り仮名が付いている漢字は訓読み。しかも送り仮名は読みの末尾と重なる。
//        前出し → マエ+ダシ（「し」が「ダシ」の末尾と重なる）
//   4. 送り仮名が要る形（動詞の語幹）は、複合語の途中に裸では出てこない。
//        据付 → スエ+ツケ（連用形）… 普通
//             → ス+ツ（語幹のまま）… 語にならない
//
// 連濁・促音便は「起きた形」も「起きない形」も両方出す。どちらが正しいかは
// 決めない（下取＝シタドリ／シタトリ）。並べ替えでは起きない形をわずかに上に置く。

import { handakuAfterSokuon, KANJI_READINGS, rendakuForms, sokuonForm } from './kanjiReadings.ts';
import { hiraToKata } from './kana.ts';

/** 総当たりの打ち切り。これを超えないよう、使う読みを順位の低い方から削る。 */
const MAX_COMBINATIONS = 20000;

const isKanji = (ch: string): boolean => /\p{Script=Han}/u.test(ch);

interface Option {
  reading: string;
  type: 'on' | 'kun' | 'kana';
  /** 同じ種類（音／訓）の中での並び順。前のものほどよく使う読み */
  rank: number;
  /** 送り仮名が要る形（動詞・形容詞の語幹）か */
  stem: boolean;
  /** 送り仮名が読みの末尾と重なっていた（引き → ヒキ の「キ」） */
  absorbed: boolean;
  /** 規則で濁らせた形（連濁）か */
  voiced: boolean;
}

interface Part {
  options: Option[];
  /** 直後にかな（送り仮名）が続く漢字か */
  beforeKana: boolean;
}

/** 語を、漢字1文字ずつと、かなのまとまりに分ける */
function split(word: string): Part[] | null {
  const chars = [...word];
  const parts: Part[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (!isKanji(ch)) {
      // かなはそのまま（カタカナに寄せる）。続くかなはまとめる。
      let run = '';
      while (i < chars.length && !isKanji(chars[i]!)) { run += chars[i]!; i++; }
      i--;
      parts.push({
        options: [{ reading: hiraToKata(run), type: 'kana', rank: 0, stem: false, absorbed: false, voiced: false }],
        beforeKana: false,
      });
      continue;
    }
    const entry = KANJI_READINGS.get(ch);
    if (!entry) return null; // 表に無い漢字がある語は、候補を作らない

    // 送り仮名が続くなら、読みにその仮名が含まれている形（ヒキ＋き）は
    // 重ねずに読みだけを採る。重ねると「ヒキキ」になる。
    const next = chars[i + 1];
    const beforeKana = next !== undefined && !isKanji(next);
    let okurigana = '';
    if (beforeKana) {
      let j = i + 1;
      while (j < chars.length && !isKanji(chars[j]!)) { okurigana += chars[j]!; j++; }
      okurigana = hiraToKata(okurigana);
    }

    // 順位は音・訓それぞれの中で付ける。まとめて通し番号にすると、
    // 表が音読みを先に並べているせいで、訓読みが常に不利になる。
    const options: Option[] = [];
    const add = (reading: string, type: 'on' | 'kun', rank: number, stem: boolean): void => {
      const absorbed = okurigana !== '' && reading.endsWith(okurigana) && reading.length > okurigana.length;
      options.push({
        reading: absorbed ? reading.slice(0, -okurigana.length) : reading,
        type, rank, stem, absorbed, voiced: false,
      });
    };
    for (const [rank, reading] of entry.on.entries()) add(reading, 'on', rank, false);
    for (const [rank, k] of entry.kun.entries()) add(k.reading, 'kun', rank, k.stem);
    if (options.length === 0) return null;
    parts.push({ options, beforeKana });
  }
  return parts;
}

/**
 * 総当たりが大きくなりすぎないよう、順位の低い（＝あまり使わない）読みから削る。
 * 削るのは常に「いま一番読みの多い漢字」の最後の1つ。よく使う読みは最後まで残る。
 */
function trim(parts: Part[]): void {
  const size = (): number => parts.reduce((n, p) => n * p.options.length, 1);
  while (size() > MAX_COMBINATIONS) {
    let widest = parts[0]!;
    for (const p of parts) if (p.options.length > widest.options.length) widest = p;
    if (widest.options.length <= 1) return;
    widest.options.pop();
  }
}

/**
 * 組合せの点数。高いほど上に出す。
 * 当てにいく点数ではなく、**人が目で探しやすい順**にするための点数。
 */
function score(chosen: Option[], parts: Part[]): number {
  let s = 0;
  const kanji = chosen.filter((c) => c.type !== 'kana');
  // 送り仮名が付く漢字は訓読みと決まっているので、「揃っているか」の判定からは外す。
  // 真空引き は 真空（音）＋引き（訓）で、混ざっているのが普通の形。
  const free = chosen.filter((c, i) => c.type !== 'kana' && !parts[i]!.beforeKana);

  // 1. 音どうし・訓どうしで揃っているか
  if (free.length > 1) {
    const allSame = free.every((k) => k.type === free[0]!.type);
    s += allSame ? 6 : 0;
    for (let i = 1; i < free.length; i++) if (free[i]!.type !== free[i - 1]!.type) s -= 3;
    // 2. 漢字だけが並ぶ語は、音読みで揃うほうが多数派
    if (allSame && free[0]!.type === 'on') s += 1;
  }
  // 送り仮名の付く漢字まで含めて揃っているなら、和語としての揃いを少し足す
  if (kanji.length > 1 && kanji.every((k) => k.type === kanji[0]!.type)) s += 2;

  for (const [i, part] of parts.entries()) {
    const c = chosen[i]!;
    if (c.type === 'kana') continue;
    if (part.beforeKana) {
      // 3. 送り仮名が付く漢字は訓読み。送り仮名と読みの末尾が重なるのが普通
      s += c.type === 'kun' ? 3 : -3;
      if (c.absorbed) s += 2;
    } else if (kanji.length > 1 && c.stem) {
      // 4. 送り仮名が要る形が、複合語の途中に裸で出てくるのは珍しい
      s -= 2.5;
    }
    // よく使う読みを上に（表の並び順）
    s -= c.rank * 0.6;
    // 濁る形は、濁らない形のすぐ下に置く。どちらも候補には残す。
    if (c.voiced) s -= 0.3;
  }
  return s;
}

/**
 * 読みの候補を、確からしい順に返す。
 * 表に無い漢字が混ざる語では空を返す（そのときは候補を出さず、入力欄だけ見せる）。
 */
export function readingCandidates(word: string, limit = 5): string[] {
  const parts = split(word.trim());
  if (parts === null || parts.length === 0) return [];
  trim(parts);

  const best = new Map<string, number>();
  const chosen: Option[] = [];
  // 前の語の末尾が決まらないと促音便（ハツ＋チュウ → ハッチュウ）を決められないので、
  // 組み立てながら音を変えていく。変えた形も変えない形も残す。
  const walk = (i: number, text: string): void => {
    if (i === parts.length) {
      const s = score(chosen, parts);
      if (!best.has(text) || best.get(text)! < s) best.set(text, s);
      return;
    }
    const part = parts[i]!;
    for (const o of part.options) {
      const forms: Option[] = i === 0
        ? [o]
        : [o, ...rendakuForms(o.reading).map((reading) => ({ ...o, reading, voiced: true }))];
      for (const form of forms) {
        // 促音・撥音のあとのハ行は半濁る（イッ＋ホン → イッポン）
        const handaku = handakuAfterSokuon(text, form.reading);
        const heads = handaku === null ? [form.reading] : [handaku, form.reading];
        for (const head of heads) {
          // 前の語の末尾が詰まる形（促音便）も試す
          const squeezed = sokuonForm(text, head);
          for (const base of squeezed === null ? [text] : [squeezed, text]) {
            chosen.push(form);
            walk(i + 1, base + head);
            chosen.pop();
          }
        }
      }
    }
  };
  walk(0, '');

  return [...best.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([reading]) => reading);
}
