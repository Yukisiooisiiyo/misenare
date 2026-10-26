// 文字列の正規化。索引側と検索側で必ず同じ関数を通す。

import { hiraToKata } from './kana.ts';

/** 全角英数→半角、半角カナ→全角（NFKC）、英字は小文字、空白は1つにまとめる。 */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** タグ名の正規化。先頭の # と前後の空白を外し、内部の空白は詰める。 */
export function normalizeTagName(name: string): string {
  return normalizeText(name).replace(/^#+/, '').replace(/\s+/g, '');
}

/**
 * 型番（KJ-55X85L、NA-LX129CL、MB-F2000 など）を1語として取り出す。
 * 英字と数字の両方を含み、3文字以上で、英数字とハイフンだけからなる塊を型番とみなす。
 * 取り出した部分は空白に置き換えた残りの文字列と一緒に返す。
 */
const MODEL_NUMBER = /[a-z0-9]+(?:-[a-z0-9]+)*/g;

export function extractModelNumbers(normalized: string): { modelNumbers: string[]; rest: string } {
  const modelNumbers: string[] = [];
  const rest = normalized.replace(MODEL_NUMBER, (m) => {
    const isModel = m.length >= 3 && /[a-z]/.test(m) && /[0-9]/.test(m);
    if (!isModel) return m;
    modelNumbers.push(m);
    return ' ';
  });
  return { modelNumbers, rest };
}

/**
 * 検索語の畳み込み。ひらがなをカタカナに寄せる。
 *
 * 「てれび」と「テレビ」を同じ語として扱うための最後の一手で、
 * **索引側と検索側の両方で必ず通すこと**。片方だけに掛けると、
 * 入れたはずのナレッジが当たらなくなる。
 *
 * 漢字とかなの揺れ（冷蔵庫／れいぞうこ）はここでは寄らない。
 * それはタグの読みと別名で受ける。
 */
export function foldTerm(term: string): string {
  return hiraToKata(term);
}
