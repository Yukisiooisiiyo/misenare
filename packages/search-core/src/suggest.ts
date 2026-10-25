// 入力中のタグ候補と「もしかして：」。端末にタグ辞書を同期し、この関数を端末内で動かす想定。

import { hiraToKata, toReadingKey } from './kana.ts';
import { foldTerm, normalizeTagName } from './normalize.ts';
import type { TagDictionary, TagEntry } from './tagDictionary.ts';

export interface SuggestInput {
  /** 入力途中の文字列（# の有無は問わない） */
  input: string;
  dictionary: TagDictionary;
  /** すでに選んだタグ。一緒に使われやすいタグを上に出すのに使う */
  selectedTagIds?: string[];
  /** 共起スコア（NPMI, -1〜1）。キーは pairKey(a, b) */
  cooccurrence?: ReadonlyMap<string, number>;
  limit?: number;
}

export type MaybeReason = 'synonym' | 'includes' | 'parent' | 'typo';

export interface SuggestResult {
  candidates: TagEntry[];
  maybe: Array<{ tag: TagEntry; reason: MaybeReason; forTagId?: string }>;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function prefixMatches(tag: TagEntry, key: string, readingKey: string): boolean {
  if (tag.name.startsWith(key)) return true;
  if (readingKey.length === 0) return false;
  if (hiraToKata(tag.name).startsWith(readingKey)) return true;
  return tag.reading != null && tag.reading.startsWith(readingKey);
}

/** 制限付き Damerau–Levenshtein 距離（隣接文字の入れ替えを1と数える）。 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const A = [...a];
  const B = [...b];
  const d: number[][] = Array.from({ length: A.length + 1 }, (_, i) =>
    Array.from({ length: B.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= A.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= B.length; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && A[i - 1] === B[j - 2] && A[i - 2] === B[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[A.length]![B.length]!;
}

export function suggestTags(req: SuggestInput): SuggestResult {
  const dict = req.dictionary;
  const limit = req.limit ?? 8;
  const key = normalizeTagName(req.input);
  if (key.length === 0) return { candidates: [], maybe: [] };
  const readingKey = toReadingKey(key);
  const selected = new Set(req.selectedTagIds ?? []);
  // 別名と読みからの前方一致。打った言葉と出てくるタグの字面が違ってもよい。
  const viaPhrase = dict.phrasePrefixMatches(foldTerm(key));
  for (const id of dict.phrasePrefixMatches(foldTerm(readingKey))) viaPhrase.add(id);

  // 1. 過去に登録されたタグから前方一致で探す
  const affinity = (tag: TagEntry): number => {
    let best = 0;
    for (const s of selected) best = Math.max(best, req.cooccurrence?.get(pairKey(s, tag.id)) ?? 0);
    return best;
  };
  const candidates = [...dict.tags.values()]
    .filter((t) => !selected.has(t.id) && (prefixMatches(t, key, readingKey) || viaPhrase.has(t.id)))
    .map((t) => ({
      t,
      // 完全一致 > 一緒に使われやすさ > 使用回数
      rank: (t.name === key ? 1000 : 0) + affinity(t) * 10 + Math.log1p(t.useCount),
    }))
    .sort((a, b) => b.rank - a.rank || a.t.name.localeCompare(b.t.name))
    .slice(0, limit)
    .map((x) => x.t);

  // 2. もしかして：候補の同義・下位・上位、または1〜2文字違いの既存タグ
  const shown = new Set([...candidates.map((c) => c.id), ...selected]);
  const maybe: SuggestResult['maybe'] = [];
  const push = (id: string, reason: MaybeReason, forTagId?: string) => {
    if (shown.has(id)) return;
    const tag = dict.tags.get(id);
    if (!tag) return;
    shown.add(id);
    maybe.push(forTagId === undefined ? { tag, reason } : { tag, reason, forTagId });
  };
  for (const c of candidates.slice(0, 3)) {
    for (const id of dict.synonymsOf(c.id)) push(id, 'synonym', c.id);
    for (const id of dict.descendantsOf(c.id)) push(id, 'includes', c.id);
    for (const id of dict.parentsOf(c.id)) push(id, 'parent', c.id);
  }
  const exact = candidates.some((c) => c.name === key);
  if (!exact && [...key].length >= 3) {
    const max = [...key].length >= 5 ? 2 : 1;
    const typos = [...dict.tags.values()]
      .map((t) => ({ t, d: editDistance(key, t.name, max) }))
      .filter((x) => x.d <= max)
      .sort((a, b) => a.d - b.d || b.t.useCount - a.t.useCount);
    for (const { t } of typos) push(t.id, 'typo');
  }
  return { candidates, maybe: maybe.slice(0, limit) };
}

/**
 * NPMI（正規化自己相互情報量）。1 に近いほど一緒に使われやすい。
 *   NPMI(a,b) = log(P(a,b) / (P(a)P(b))) / −log P(a,b)
 * total は数えた単位（ナレッジ数や検索回数）、tagCount はタグごとの出現数、pairCount は同時出現数。
 */
export function computeNpmi(
  total: number,
  tagCount: ReadonlyMap<string, number>,
  pairCount: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (total === 0) return out;
  for (const [key, ab] of pairCount) {
    const [a, b] = key.split('|') as [string, string];
    const pa = (tagCount.get(a) ?? 0) / total;
    const pb = (tagCount.get(b) ?? 0) / total;
    const pab = ab / total;
    if (pa === 0 || pb === 0 || pab === 0) continue;
    out.set(key, pab >= 1 ? 1 : Math.log(pab / (pa * pb)) / -Math.log(pab));
  }
  return out;
}
