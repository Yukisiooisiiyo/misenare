// 形態素解析器の読みを「案として見せてよいか」で3つに分ける。
//
// なぜ分けるか：読みはタグの別名として登録され、「れいぞうこ」で #冷蔵庫 に
// 当たる経路になる。**間違った読みを黙って登録すると、検索の土台に嘘が混ざる。**
// かといって何も見せないと、確認する人が毎回打つことになる。
//
// 測定（apps/api/test/readingBench.test.ts、売場語 107 語）で外したのは、
// 辞書に無い複合語を漢字1文字に割って読んだものだけだった。
//   食洗機 → 食/洗/機 → ショクアライキ（正しくは ショクセンキ）
//   開梱   → 開/梱   → ヒラキコリ    （正しくは カイコン）
// 「漢字1文字の自立語に割れていない」で絞ると、見せた 101 語の正解率が
// 100%（取りこぼし2語）になった。当たらない語では黙り、空欄で尋ねる。
//
// この判断は、夜間バッチ（案を貯める）と、タグを作った直後の確認（その場で尋ねる）の
// 両方で使う。2か所に書くと必ず食い違うので、ここに1つだけ置く。

import type { Tokenizer } from './tokenizer.ts';

export type ReadingSuggestion =
  /** 読みが見出しと同じ（カタカナ語）。確かめるまでもないので、そのまま登録してよい */
  | { kind: 'settled'; reading: string }
  /** 案として見せてよい。入力欄に入れて、人が直せる形で出す */
  | { kind: 'proposal'; reading: string }
  /** 信用できない。入力欄は空にして尋ねる（読みの候補は別に出す） */
  | { kind: 'silent' };

export function suggestReading(tokenizer: Tokenizer, name: string): ReadingSuggestion {
  if (!tokenizer.reading) return { kind: 'silent' };
  const guess = tokenizer.guessReading?.(name);
  const reading = guess ? guess.reading : tokenizer.reading(name);
  if (!reading) return { kind: 'silent' };
  if (reading === name) return { kind: 'settled', reading };
  // 漢字1文字の自立語に割れている＝辞書に無い複合語。読みを外しやすいので案にしない。
  if (guess && guess.loneKanjiFree > 0) return { kind: 'silent' };
  return { kind: 'proposal', reading };
}
