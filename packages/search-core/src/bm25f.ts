// BM25F：欄（タグ・タイトル・本文）ごとに重みと長さ補正を変える BM25。
//
//   score(d, q) = Σ_概念g  max_{t∈g}  qw(t) · idf(t) · f̃(t,d)·(k1+1) / (f̃(t,d) + k1)
//   f̃(t, d)    = Σ_c  w_c · f_c(t,d) / (1 − b_c + b_c · |d_c| / avg_c)
//   idf(t)     = ln(1 + (N − df(t) + 0.5) / (df(t) + 0.5))
//
// ・同じ語が何度出ても f̃/(f̃+k1) で頭打ちになる（飽和）
// ・平均より長い欄ほど1語あたりの点数が下がる（長さ補正）
// ・qw(t) は検索語の重み。同義・包含で展開した語は 0.7 など

import { FIELDS, type Field } from './analyzer.ts';

export interface Bm25fParams {
  k1: number;
  fieldWeight: Record<Field, number>;
  b: Record<Field, number>;
}

/** 仕様書の初期値。パイロットで調整する。 */
export const DEFAULT_PARAMS: Bm25fParams = {
  k1: 1.2,
  fieldWeight: { tag: 3, title: 2, body: 1 },
  b: { tag: 0.75, title: 0.75, body: 0.75 },
};

export interface CorpusStats {
  /** 検索対象のナレッジ数 */
  docCount: number;
  /** 欄ごとの平均語数 */
  avgLength: Record<Field, number>;
  /** 語 → その語をどこかの欄に含むナレッジ数 */
  df: ReadonlyMap<string, number>;
}

export interface CandidateDoc {
  id: string;
  length: Record<Field, number>;
  /** 語 → 欄ごとの出現回数（検索語に関係する語だけでよい） */
  tf: ReadonlyMap<string, Partial<Record<Field, number>>>;
}

export interface ScoredDoc {
  id: string;
  score: number;
  /** 一致した検索語（説明表示やログ用） */
  matchedTerms: string[];
}

export function idf(docCount: number, df: number): number {
  return Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
}

/** 1語ぶんの点数（重み qw をかける前）。一致しなければ 0。idfTerm の IDF を使う。 */
function termScore(term: string, idfTerm: string, doc: CandidateDoc, stats: CorpusStats, params: Bm25fParams): number {
  const perField = doc.tf.get(term);
  if (!perField) return 0;
  let ft = 0;
  for (const field of FIELDS) {
    const f = perField[field] ?? 0;
    if (f === 0) continue;
    const avg = stats.avgLength[field] || 1;
    const norm = 1 - params.b[field] + params.b[field] * (doc.length[field] / avg);
    ft += (params.fieldWeight[field] * f) / norm;
  }
  if (ft === 0) return 0;
  const df = stats.df.get(idfTerm) ?? 1;
  return idf(stats.docCount, df) * ((ft * (params.k1 + 1)) / (ft + params.k1));
}

/**
 * groups は検索語のまとまり（概念）。まとまりごとに、文書内で最も点の高い1語だけを足す。
 * 例：#冷蔵庫 →（冷蔵庫 ×1, 冷凍冷蔵庫 ×0.7）は1つの概念なので、両方に一致しても1回だけ数える。
 * まとまりの先頭の語（検索した元のタグ）の IDF を全員に使う。展開先の方が珍しい語でも、
 * 「元のタグが直接付いたナレッジが上」という順序が崩れないようにするため。
 */
export function scoreDocument(
  groups: ReadonlyArray<ReadonlyMap<string, number>>,
  doc: CandidateDoc,
  stats: CorpusStats,
  params: Bm25fParams = DEFAULT_PARAMS,
): ScoredDoc {
  let score = 0;
  const matchedTerms: string[] = [];
  for (const group of groups) {
    let best = 0;
    let bestTerm: string | undefined;
    const idfTerm = group.keys().next().value;
    if (idfTerm === undefined) continue;
    for (const [term, qw] of group) {
      const s = qw * termScore(term, idfTerm, doc, stats, params);
      if (s > best) { best = s; bestTerm = term; }
    }
    if (bestTerm !== undefined) {
      score += best;
      matchedTerms.push(bestTerm);
    }
  }
  return { id: doc.id, score, matchedTerms };
}

/**
 * 候補を採点して並べる。同点の並びは tieBreak（例：最終確認日の新しい順）で決める。
 * スコア 0（どの検索語にも一致しない）は除く。
 */
export function rank(
  groups: ReadonlyArray<ReadonlyMap<string, number>>,
  docs: Iterable<CandidateDoc>,
  stats: CorpusStats,
  options: { params?: Bm25fParams; tieBreak?: (a: string, b: string) => number; limit?: number } = {},
): ScoredDoc[] {
  const scored: ScoredDoc[] = [];
  for (const d of docs) {
    const s = scoreDocument(groups, d, stats, options.params);
    if (s.score > 0) scored.push(s);
  }
  scored.sort((a, b) => {
    const diff = b.score - a.score;
    if (Math.abs(diff) > 1e-9) return diff;
    return options.tieBreak ? options.tieBreak(a.id, b.id) : a.id.localeCompare(b.id);
  });
  return options.limit === undefined ? scored : scored.slice(0, options.limit);
}
