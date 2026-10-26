// 単語分割。本番では kuromoji.js や Lindera に差し替えられるよう、インターフェースで受ける。

/** 読みと、その読みをどれだけ信用してよいかの手がかり */
export interface ReadingGuess {
  reading: string;
  /** 形態素の数。1 なら辞書にその語がそのまま載っている */
  morphemes: number;
  /** 漢字1文字に割れた形態素の数 */
  loneKanji: number;
  /** そのうち接尾辞でないもの。ここが多いと読みを外しやすい */
  loneKanjiFree: number;
}

export interface Tokenizer {
  /** 正規化済みの文字列を単語に区切る。助詞などの除外はこの後で行う。 */
  segment(normalized: string): string[];
  /**
   * 語のカタカナの読み（任意）。kuromoji などの形態素解析器なら返せる。
   * タグの読み（hashtags.reading）を埋めるのに使い、「はんにゅう」と打って #搬入 が出るようになる。
   * Intl.Segmenter では読みが取れないので実装しない。
   */
  reading?(word: string): string | null;
  /** 読みと確からしさ。返せる実装（kuromoji）だけが持つ */
  guessReading?(word: string): ReadingGuess | null;
}

/**
 * Node.js 標準の Intl.Segmenter（ICU 辞書）による分割。外部ライブラリ不要。
 * 品詞や読みは取れないため、助詞・助動詞は下の除外リストで落とす。
 */
export class SegmenterTokenizer implements Tokenizer {
  private readonly segmenter = new Intl.Segmenter('ja', { granularity: 'word' });

  segment(normalized: string): string[] {
    const out: string[] = [];
    let prevEnd = -1;
    let prevSingleKanji = false;
    for (const s of this.segmenter.segment(normalized)) {
      if (!s.isWordLike) { prevSingleKanji = false; continue; }
      const singleKanji = isSingleKanji(s.segment);
      // 辞書にない語は漢字1文字ずつに割れる（食洗機 → 食|洗|機）。隣り合う漢字1文字はつなぎ直す。
      if (singleKanji && prevSingleKanji && s.index === prevEnd && out.length > 0) {
        out[out.length - 1] += s.segment;
      } else {
        out.push(s.segment);
      }
      prevSingleKanji = singleKanji;
      prevEnd = s.index + s.segment.length;
    }
    return out;
  }
}

function isSingleKanji(s: string): boolean {
  return [...s].length === 1 && /\p{Script=Han}/u.test(s);
}

// 検索の役に立たない語。名詞以外の機能語と、どの文書にも出る形式名詞。
const STOPWORDS = new Set([
  'の', 'は', 'が', 'を', 'に', 'へ', 'と', 'で', 'や', 'も', 'か', 'な', 'ね', 'よ', 'わ', 'から',
  'まで', 'より', 'など', 'なら', 'って', 'だけ', 'ので', 'のに', 'けど', 'けれど', 'でも',
  'です', 'ます', 'でし', 'まし', 'だっ', 'だ', 'た', 'て', 'ない', 'なく', 'ある', 'あり', 'いる',
  'する', 'し', 'され', 'れる', 'られ', 'こと', 'もの', 'ため', 'とき', 'ところ',
  'これ', 'それ', 'あれ', 'この', 'その', 'あの', 'ここ', 'そこ', 'どこ', '場合', 'よう', 'くださ',
  'ください', 'お', 'ご',
]);

const HIRAGANA_ONLY = /^[ぁ-ゟ]+$/;
const PUNCT_ONLY = /^[\p{P}\p{S}]+$/u;

/** 分割結果から、検索語として使わないものを除く。 */
export function filterTerms(segments: string[]): string[] {
  return segments.filter((t) => {
    if (t.length === 0 || PUNCT_ONLY.test(t)) return false;
    if (STOPWORDS.has(t)) return false;
    // ひらがな1文字（活用語尾の断片など）は除外。2文字以上のひらがな語（いくら 等）は残す。
    if (HIRAGANA_ONLY.test(t) && t.length === 1) return false;
    return true;
  });
}
