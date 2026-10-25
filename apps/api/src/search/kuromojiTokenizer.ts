// kuromoji（形態素解析）を使った単語分割。入っているときだけ使う任意の差し替え。
//
// Intl.Segmenter との違い：
//   ・品詞が分かるので、助詞や記号を確実に落とせる
//   ・活用した語を終止形に直せる（「修理した」「修理して」→「修理」）
//   ・読み（カタカナ）が取れるので、「はんにゅう」と打って #搬入 が出せる
//
// 辞書（約15MB）をメモリに読むので、起動に数秒かかる。端末側では使わない（サーバーと夜間バッチだけ）。
//
// 使い方：
//   npm install kuromoji
//   TOKENIZER=kuromoji で API サーバー・夜間バッチを動かす
// 索引は分割のしかたに依存するので、切り替えたあとは夜間バッチで索引を作り直すこと。

import type { Tokenizer } from '@misenare/search-core';

/** kuromoji が返す形態素（必要なところだけ） */
interface Morpheme {
  surface_form: string;
  pos: string;
  basic_form: string;
  reading?: string;
  /** もとの文字列での位置（1始まり）。隣り合っているかを見るのに使う */
  word_position: number;
}

interface KuromojiTokenizer {
  tokenize(text: string): Morpheme[];
}

function isSingleKanji(s: string): boolean {
  return [...s].length === 1 && /\p{Script=Han}/u.test(s);
}

/** 検索語として残す品詞。名詞・動詞・形容詞・副詞と、辞書にない語 */
const KEEP = new Set(['名詞', '動詞', '形容詞', '副詞', '記号未知語', 'カスタム名詞']);
/** 単独では意味を持たない名詞の下位分類 */
const DROP_DETAIL = new Set(['非自立', '接尾', '代名詞', '数']);

export class MorphologicalTokenizer implements Tokenizer {
  constructor(private readonly inner: KuromojiTokenizer) {}

  segment(normalized: string): string[] {
    const out: string[] = [];
    let prevEnd = -1;
    let prevSingleKanji = false;
    for (const m of this.inner.tokenize(normalized)) {
      const [pos, detail] = m.pos.split(',') as [string, string | undefined];
      if (!KEEP.has(pos)) { prevSingleKanji = false; continue; }
      if (pos === '名詞' && detail && DROP_DETAIL.has(detail)) { prevSingleKanji = false; continue; }
      // 活用した語は終止形に直す（「*」は辞書に無い語）
      const word = m.basic_form && m.basic_form !== '*' ? m.basic_form : m.surface_form;
      if (!word) { prevSingleKanji = false; continue; }
      // 辞書にない複合語は漢字1文字ずつに割れる（食洗機 → 食|洗|機）。
      // もとの文字列で続いている漢字1文字どうしは、つなぎ直す。
      const singleKanji = isSingleKanji(m.surface_form);
      if (singleKanji && prevSingleKanji && m.word_position === prevEnd && out.length > 0) {
        out[out.length - 1] += m.surface_form;
      } else {
        out.push(word);
      }
      prevSingleKanji = singleKanji;
      prevEnd = m.word_position + m.surface_form.length;
    }
    return out;
  }

  /** 語のカタカナの読み。辞書に無ければ null */
  reading(word: string): string | null {
    const morphemes = this.inner.tokenize(word);
    if (morphemes.length === 0) return null;
    const parts: string[] = [];
    for (const m of morphemes) {
      if (!m.reading || m.reading === '*') return null;
      parts.push(m.reading);
    }
    return parts.join('');
  }
}

/**
 * kuromoji を読み込んで分割器を作る。
 * 入っていなければ null を返すので、呼ぶ側は Intl.Segmenter に落とせる。
 */
export async function createMorphologicalTokenizer(dicPath?: string): Promise<MorphologicalTokenizer | null> {
  const moduleName = 'kuromoji';
  const kuromoji = await import(moduleName).then((m) => m.default ?? m).catch(() => null);
  if (!kuromoji) return null;
  const path = dicPath ?? process.env.KUROMOJI_DICT ?? 'node_modules/kuromoji/dict';
  const inner = await new Promise<KuromojiTokenizer>((resolve, reject) => {
    kuromoji.builder({ dicPath: path }).build((err: Error | null, t: KuromojiTokenizer) => (err ? reject(err) : resolve(t)));
  });
  return new MorphologicalTokenizer(inner);
}

/**
 * 設定に合わせて分割器を選ぶ。
 * TOKENIZER=kuromoji のときだけ形態素解析を使い、読み込めなければ理由を出して Intl.Segmenter に落とす。
 */
export async function chooseTokenizer(): Promise<Tokenizer> {
  const { SegmenterTokenizer } = await import('@misenare/search-core');
  if (process.env.TOKENIZER !== 'kuromoji') return new SegmenterTokenizer();
  try {
    const t = await createMorphologicalTokenizer();
    if (t) return t;
    console.warn('kuromoji が入っていないので、Intl.Segmenter を使います（npm install kuromoji）');
  } catch (err) {
    console.warn('kuromoji を読み込めませんでした。Intl.Segmenter を使います:', err);
  }
  return new SegmenterTokenizer();
}
