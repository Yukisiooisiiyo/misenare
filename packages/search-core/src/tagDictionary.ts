// タグ辞書：タグ名・別名の最長一致と、同義・包含による展開。

import { foldTerm, normalizeTagName, normalizeText } from './normalize.ts';

export interface TagEntry {
  id: string;
  /** 正規化済みのタグ名（# なし） */
  name: string;
  /**
   * カタカナの読み。**1つとは限らない。**
   * 「下取」は シタドリ とも シタトリ とも打たれる。どちらが正しいかを
   * 決めずに両方持てば、どちらで打っても当たる。
   */
  readings?: readonly string[];
  useCount: number;
}

/** 承認済みのタグ関係だけを渡す。 */
export type TagRelation =
  | { kind: 'synonym'; fromTagId: string; toTagId: string }
  | { kind: 'includes'; fromTagId: string; toTagId: string }
  | { kind: 'alias'; fromText: string; toTagId: string };

export interface ExpandedTag {
  tagId: string;
  weight: number;
  via: 'self' | 'synonym' | 'includes';
}

const ASCII_ALNUM = /[a-z0-9]/;

/**
 * 英数字で始まる・終わる語句は、前後が英数字でないときだけ一致とみなす。
 * タグ #ac が "back" の中に当たらないようにするため。日本語どうしの境目は判定しない。
 */
function atWordBoundary(text: string, start: number, length: number): boolean {
  const first = text[start]!;
  const last = text[start + length - 1]!;
  const before = start > 0 ? text[start - 1]! : '';
  const after = text[start + length] ?? '';
  if (ASCII_ALNUM.test(first) && ASCII_ALNUM.test(before)) return false;
  if (ASCII_ALNUM.test(last) && ASCII_ALNUM.test(after)) return false;
  return true;
}

export class TagDictionary {
  readonly tags: ReadonlyMap<string, TagEntry>;
  private readonly byName = new Map<string, TagEntry>();
  /** 照合する語句（タグ名と別名）→ タグID。先頭1文字で引けるようにまとめる。 */
  private readonly phrasesByHead = new Map<string, Array<{ phrase: string; tagId: string }>>();
  private readonly synonymGroup = new Map<string, Set<string>>();
  private readonly children = new Map<string, Set<string>>();
  private readonly parents = new Map<string, Set<string>>();

  constructor(tags: Iterable<TagEntry>, relations: Iterable<TagRelation> = []) {
    const map = new Map<string, TagEntry>();
    for (const t of tags) {
      const entry = { ...t, name: normalizeTagName(t.name) };
      map.set(entry.id, entry);
      this.byName.set(entry.name, entry);
      this.addPhrase(entry.name, entry.id);
      // 読み（カタカナ）も別名として登録する。「れいぞうこ」で #冷蔵庫 に当たるようにするため。
      // 複数あればすべて登録する。読みは人が確かめたものだけが入っている。
      for (const r of entry.readings ?? []) {
        if (r.length > 0) this.addPhrase(normalizeTagName(r), entry.id);
      }
    }
    this.tags = map;

    // 同義は推移的にまとめる（A=B, B=C なら A=B=C）
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    for (const rel of relations) {
      if (!map.has(rel.toTagId)) continue;
      if (rel.kind === 'alias') {
        this.addPhrase(normalizeText(rel.fromText).replace(/\s+/g, ''), rel.toTagId);
      } else if (rel.kind === 'synonym') {
        if (!map.has(rel.fromTagId)) continue;
        parent.set(find(rel.fromTagId), find(rel.toTagId));
      } else {
        if (!map.has(rel.fromTagId)) continue;
        if (!this.children.has(rel.fromTagId)) this.children.set(rel.fromTagId, new Set());
        this.children.get(rel.fromTagId)!.add(rel.toTagId);
        if (!this.parents.has(rel.toTagId)) this.parents.set(rel.toTagId, new Set());
        this.parents.get(rel.toTagId)!.add(rel.fromTagId);
      }
    }
    const groups = new Map<string, Set<string>>();
    for (const id of map.keys()) {
      const root = find(id);
      if (!groups.has(root)) groups.set(root, new Set());
      groups.get(root)!.add(id);
    }
    for (const group of groups.values()) for (const id of group) this.synonymGroup.set(id, group);

    for (const list of this.phrasesByHead.values()) list.sort((a, b) => b.phrase.length - a.phrase.length);
  }

  /**
   * 照合用の語句を1つ登録する。
   * 鍵はカナに畳んでおく（foldTerm）。照合する文字列も同じように畳むので、
   * 「てれび」でも「テレビ」でも同じ語句に当たる。
   */
  private addPhrase(rawPhrase: string, tagId: string): void {
    const phrase = foldTerm(rawPhrase);
    if (phrase.length === 0) return;
    const head = phrase[0]!;
    if (!this.phrasesByHead.has(head)) this.phrasesByHead.set(head, []);
    this.phrasesByHead.get(head)!.push({ phrase, tagId });
  }

  getByName(name: string): TagEntry | undefined {
    return this.byName.get(normalizeTagName(name));
  }

  /**
   * 正規化済みの文字列から、タグ名・別名を左から最長一致で拾う。
   * 例：「冷凍冷蔵庫の搬入」→ 冷凍冷蔵庫（「冷蔵庫」より長い方を優先）
   */
  matchPhrases(normalized: string): string[] {
    return this.scanPhrases(normalized).tagIds;
  }

  /**
   * matchPhrases と同じ照合をし、一致しなかった部分（rest）も返す。
   * 一致した部分は空白に置き換えるので、rest をそのまま単語分割に回せる。
   */
  scanPhrases(normalized: string): { tagIds: string[]; rest: string; spans: Array<{ tagId: string; text: string }> } {
    const tagIds: string[] = [];
    const spans: Array<{ tagId: string; text: string }> = [];
    // 照合はカナに畳んだ写しに対して行い、取り出す文字列は元のまま使う。
    // foldTerm は1文字を1文字に写すので、両者の位置はずれない。
    const folded = foldTerm(normalized);
    let rest = '';
    let i = 0;
    while (i < normalized.length) {
      const ch = folded[i]!;
      const candidates = this.phrasesByHead.get(ch);
      const hit = candidates?.find((c) => folded.startsWith(c.phrase, i) && atWordBoundary(folded, i, c.phrase.length));
      if (hit) {
        tagIds.push(hit.tagId);
        // 元の表記で返す。単語に分け直すときに、書かれたとおりの文字を渡すため。
        spans.push({ tagId: hit.tagId, text: normalized.slice(i, i + hit.phrase.length) });
        rest += ' ';
        i += hit.phrase.length;
      } else {
        rest += normalized[i]!;
        i += 1;
      }
    }
    return { tagIds, rest, spans };
  }

  /**
   * 別名・読みも含めた前方一致。入力途中の語から候補のタグを返す。
   * 「取付」→ #設置、「れいぞ」→ #冷蔵庫 のように、打っている言葉と
   * 出てくるタグの字面が違ってもよい。鍵は呼ぶ側でカナに畳んでおく。
   */
  phrasePrefixMatches(foldedKey: string): Set<string> {
    const out = new Set<string>();
    if (foldedKey.length === 0) return out;
    // 前方一致なら先頭の文字は必ず同じなので、その束だけ見れば足りる
    for (const { phrase, tagId } of this.phrasesByHead.get(foldedKey[0]!) ?? []) {
      if (phrase.startsWith(foldedKey)) out.add(tagId);
    }
    return out;
  }

  /** 同義（推移的） */
  synonymsOf(tagId: string): string[] {
    return [...(this.synonymGroup.get(tagId) ?? [])].filter((id) => id !== tagId);
  }

  /** 包含で下位にあるタグ（推移的）。#冷蔵庫 → #冷凍冷蔵庫 → … */
  descendantsOf(tagId: string): string[] {
    const out = new Set<string>();
    const queue = [tagId, ...this.synonymsOf(tagId)];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const child of this.children.get(cur) ?? []) {
        if (out.has(child) || child === tagId) continue;
        out.add(child);
        queue.push(child, ...this.synonymsOf(child));
      }
    }
    return [...out];
  }

  /** 直接の上位タグ。「もしかして」で上位の概念を出すときに使う。 */
  parentsOf(tagId: string): string[] {
    return [...(this.parents.get(tagId) ?? [])];
  }

  /**
   * 検索時の展開。自分自身は重み1、同義と下位（包含）は expandedWeight。
   * #冷凍冷蔵庫 で検索しても上位の #冷蔵庫 全般は出さない（一方向）。
   */
  expand(tagId: string, expandedWeight = 0.7): ExpandedTag[] {
    const out = new Map<string, ExpandedTag>();
    out.set(tagId, { tagId, weight: 1, via: 'self' });
    for (const id of this.synonymsOf(tagId)) {
      if (!out.has(id)) out.set(id, { tagId: id, weight: expandedWeight, via: 'synonym' });
    }
    for (const id of this.descendantsOf(tagId)) {
      if (!out.has(id)) out.set(id, { tagId: id, weight: expandedWeight, via: 'includes' });
    }
    return [...out.values()];
  }
}
