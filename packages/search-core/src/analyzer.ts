// 文書と検索文を、同じ規則で検索語に変換する。

import { extractModelNumbers, normalizeTagName, normalizeText } from './normalize.ts';
import type { TagDictionary } from './tagDictionary.ts';
import { filterTerms, type Tokenizer } from './tokenizer.ts';

export const FIELDS = ['tag', 'title', 'body'] as const;
export type Field = (typeof FIELDS)[number];

export interface AnalyzedDocument {
  /** 欄ごとの「語 → 出現回数」 */
  tf: Record<Field, Map<string, number>>;
  /** 欄ごとの語数（長さの補正に使う） */
  length: Record<Field, number>;
}

export interface AnalyzeDeps {
  tokenizer: Tokenizer;
  dictionary: TagDictionary;
}

/**
 * 1つの文字列を検索語の列にする（重複あり＝出現回数を数えるため）。
 * 1. NFKC・小文字化
 * 2. 型番を1語として取り出す
 * 3. タグ名・別名を最長一致で拾い、タグ名として加える（「映らない」→ 修理）
 * 4. 残り全体を単語に区切り、機能語を除く
 *
 * splitTagSpans
 *   true （文書側）: タグに一致した部分も単語に分ける。「保証」だけの検索でも「延長保証」を含む文書に当たる。
 *   false（検索側）: タグに一致した部分は分けない。#冷凍冷蔵庫 の検索が「冷蔵庫」という語経由で
 *                    #冷蔵庫 全般に広がらないようにする（包含は一方向）。
 */
export function analyzeText(text: string, deps: AnalyzeDeps, splitTagSpans = true): string[] {
  return scanText(text, deps, splitTagSpans).terms;
}

/** analyzeText と同じ処理で、文字列の中で認識できたタグ（型番の形のタグも含む）も返す。 */
function scanText(text: string, deps: AnalyzeDeps, splitTagSpans: boolean): { terms: string[]; tagIds: string[] } {
  const normalized = normalizeText(text);
  const { modelNumbers, rest } = extractModelNumbers(normalized);
  // 型番の形をしたタグ（#iphone15 など）は、型番として取り出した後でタグとして認識する
  const modelTagIds = modelNumbers.flatMap((m) => {
    const tag = deps.dictionary.getByName(m);
    return tag ? [tag.id] : [];
  });
  const scan = deps.dictionary.scanPhrases(rest);
  const tagTerms = scan.tagIds.map((id) => deps.dictionary.tags.get(id)!.name);
  const words = filterTerms(deps.tokenizer.segment(scan.rest));
  if (splitTagSpans) {
    // タグに一致した部分も単語に分けて加える。ただしタグ名そのものと同じ語は二重に数えない
    for (const span of scan.spans) {
      const name = deps.dictionary.tags.get(span.tagId)!.name;
      for (const w of filterTerms(deps.tokenizer.segment(span.text))) if (w !== name) words.push(w);
    }
  }
  return { terms: [...modelNumbers, ...tagTerms, ...words], tagIds: [...modelTagIds, ...scan.tagIds] };
}

function count(terms: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of terms) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export interface DocumentInput {
  title: string;
  body: string;
  /** 書き手が付けたハッシュタグ名 */
  tagNames: string[];
}

export function analyzeDocument(doc: DocumentInput, deps: AnalyzeDeps): AnalyzedDocument {
  // タグ欄はタグ名そのものを1語として扱う（「延長保証」を分割しない）
  const tagTerms = [...new Set(doc.tagNames.map(normalizeTagName).filter((n) => n.length > 0))];
  const titleTerms = analyzeText(doc.title, deps);
  const bodyTerms = analyzeText(doc.body, deps);
  return {
    tf: { tag: count(tagTerms), title: count(titleTerms), body: count(bodyTerms) },
    length: { tag: tagTerms.length, title: titleTerms.length, body: bodyTerms.length },
  };
}

/**
 * 検索語のまとまり（概念）。1つのタグから展開した語（#冷蔵庫 → 冷蔵庫・冷凍冷蔵庫）は1つの概念として扱い、
 * 文書ごとに最も点の高い1語だけを数える。同じ概念を二重に数えないため。
 */
export type QueryGroup = ReadonlyMap<string, number>;

export interface AnalyzedQuery {
  groups: QueryGroup[];
  /** すべての検索語 → 重み（ログや一致箇所の表示用） */
  terms: Map<string, number>;
  /** 検索文の中で認識できたタグ（展開前） */
  matchedTagIds: string[];
}

export function analyzeQuery(query: string, deps: AnalyzeDeps, expandedWeight = 0.7): AnalyzedQuery {
  const stripped = query.replace(/[#＃]/g, ' ');
  const scanned = scanText(stripped, deps, false);
  const matchedTagIds = [...new Set(scanned.tagIds)];

  const groups: Map<string, number>[] = [];
  const grouped = new Set<string>();
  for (const tagId of matchedTagIds) {
    const g = new Map<string, number>();
    for (const e of deps.dictionary.expand(tagId, expandedWeight)) {
      const name = deps.dictionary.tags.get(e.tagId)!.name;
      g.set(name, Math.max(g.get(name) ?? 0, e.weight));
      grouped.add(name);
    }
    groups.push(g);
  }
  for (const t of new Set(scanned.terms)) {
    if (!grouped.has(t)) groups.push(new Map([[t, 1]]));
  }

  const terms = new Map<string, number>();
  for (const g of groups) for (const [t, w] of g) terms.set(t, Math.max(terms.get(t) ?? 0, w));
  return { groups, terms, matchedTagIds };
}
