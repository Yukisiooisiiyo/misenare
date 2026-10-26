// 語の読みの候補を、漢字の読みの総当たりで作る。
//
// 狙いは「当てる」ことではなく「**選べるようにする**」こと。
// 人が選ぶなら1位が当たっている必要はなく、候補に入っていればよい。
// だから並べ替えを外しても害がなく、総当たりの弱点（決め手が無い）が消える。
//
// 並べ替えの根拠は、日本語の複合語の性質ひとつだけ：
//   **音読みどうし・訓読みどうしで揃うのが普通で、混ざる（重箱読み・湯桶読み）のは稀。**
//   食洗機 → ショク+セン+キ（音音音）… 普通
//          → ショク+アライ+キ（音訓音）… 重箱読み＝稀
// あわせて、送り仮名が付いている漢字は訓読みというしるしとして使う。
//   前出し → マエ+ダシ（訓）… 「し」が訓のしるし
//
// 連濁（トリ→ドリ、フダ→ダ）は、表に濁った形も並べて持たせてある。
// どちらが正しいかを決めようとはしない。両方を候補に出して、人に選んでもらう。

import { KANJI_READINGS } from './kanjiReadings.ts';
import { hiraToKata } from './kana.ts';

/** 組合せが増えすぎたときの打ち切り。これを超える語は候補を出さない。 */
const MAX_COMBINATIONS = 20000;

const isKanji = (ch: string): boolean => /\p{Script=Han}/u.test(ch);

interface Option {
  reading: string;
  type: 'on' | 'kun' | 'kana';
  /** 表に並べた順。前のものほどよく使う読み */
  rank: number;
  /** 濁音で始まる訓読み（連濁した形） */
  voiced: boolean;
  /** 送り仮名が読みの末尾と重なっていた（引き → ヒキ の「キ」） */
  absorbed: boolean;
}

interface Part {
  options: Option[];
  /** 直後にかな（送り仮名）が続く漢字か */
  beforeKana: boolean;
}

// 濁音・半濁音で始まるか。範囲（ガ-ド）で書くと、あいだの清音まで入ってしまうので並べる。
const VOICED = /^[ガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポヴ]/;

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
      parts.push({ options: [{ reading: hiraToKata(run), type: 'kana', rank: 0, voiced: false, absorbed: false }], beforeKana: false });
      continue;
    }
    const entry = KANJI_READINGS[ch];
    if (!entry) return null; // 表に無い漢字がある語は、候補を作らない
    // 順位は音訓をまたいで通しで付ける。表の並び＝よく使う順なので、
    // 「説」なら セツ が トキ より上に来る。
    const merged: Array<{ reading: string; type: 'on' | 'kun' }> = [
      ...entry.on.map((reading) => ({ reading, type: 'on' as const })),
      ...entry.kun.map((reading) => ({ reading, type: 'kun' as const })),
    ];
    if (merged.length === 0) return null;

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
    const options: Option[] = merged.map(({ reading, type }, rank) => {
      const absorbed = okurigana !== '' && reading.endsWith(okurigana) && reading.length > okurigana.length;
      return {
        reading: absorbed ? reading.slice(0, -okurigana.length) : reading,
        type,
        rank,
        voiced: type === 'kun' && VOICED.test(reading),
        absorbed,
      };
    });
    parts.push({ options, beforeKana });
  }
  return parts;
}

/**
 * 組合せの点数。高いほど上に出す。
 * 当てにいく点数ではなく、**人が目で探しやすい順**にするための点数。
 */
function score(chosen: Option[], parts: Part[]): number {
  const kinds = chosen.filter((c) => c.type !== 'kana');
  let s = 0;

  // 音どうし・訓どうしで揃っているか。
  // 送り仮名が付く漢字は訓と決まっているので、揃いの判定からは外す。
  // 「真空引き」は 真空（音）＋引き（訓）で、混ざっているのが普通の形。
  const free = chosen.filter((c, i) => c.type !== 'kana' && !parts[i]!.beforeKana);
  if (free.length > 1) {
    const allSame = free.every((k) => k.type === free[0]!.type);
    s += allSame ? 6 : 0;
    for (let i = 1; i < free.length; i++) if (free[i]!.type !== free[i - 1]!.type) s -= 3;
  }

  // 送り仮名が付く漢字は訓読み。しかも送り仮名は読みの末尾と重なるのが普通
  // （引き → ヒキ の「キ」）。重なっている読みを上に出す。
  for (const [i, part] of parts.entries()) {
    if (!part.beforeKana) continue;
    const c = chosen[i]!;
    if (c.type === 'kun') s += 3;
    else if (c.type === 'on') s -= 3;
    if (c.absorbed) s += 2;
  }

  // 連濁。訓どうしで揃った語の、2つ目以降が濁るのはよくある（した＋とり → したどり）
  if (kinds.length > 1 && kinds.every((k) => k.type === 'kun')) {
    for (const [i, c] of chosen.entries()) if (i > 0 && c.voiced) s += 1.5;
  }

  // よく使う読みを上に（表の並び順）
  for (const c of chosen) s -= c.rank * 0.6;
  return s;
}

/**
 * 読みの候補を、確からしい順に返す。
 * 表に無い漢字が混ざる語や、組合せが多すぎる語では空を返す
 * （そのときは候補を出さず、入力欄だけ見せる）。
 */
export function readingCandidates(word: string, limit = 5): string[] {
  const parts = split(word.trim());
  if (parts === null || parts.length === 0) return [];
  const total = parts.reduce((n, p) => n * p.options.length, 1);
  if (total > MAX_COMBINATIONS) return [];

  const out: Array<{ reading: string; score: number }> = [];
  const chosen: Option[] = [];
  const walk = (i: number): void => {
    if (i === parts.length) {
      out.push({ reading: chosen.map((c) => c.reading).join(''), score: score(chosen, parts) });
      return;
    }
    for (const o of parts[i]!.options) {
      chosen.push(o);
      walk(i + 1);
      chosen.pop();
    }
  };
  walk(0);

  // 同じ読みは1つに（別の組合せが同じ音になることがある）
  const best = new Map<string, number>();
  for (const { reading, score: s } of out) {
    if (!best.has(reading) || best.get(reading)! < s) best.set(reading, s);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([reading]) => reading);
}
