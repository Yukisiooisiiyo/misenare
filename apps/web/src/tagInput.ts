// 入力中の語に対して、既存タグの候補と「もしかして」を出す部品。
// 計算は端末内（search-core の suggestTags）で行い、サーバーには問い合わせない。

import { pairKey, suggestTags, TagDictionary, type SuggestResult, type TagEntry, type TagRelation } from '@misenare/search-core';
import type { Dictionary } from './api.ts';
import { clear, h } from './dom.ts';

export class LocalDictionary {
  readonly dictionary: TagDictionary;
  readonly cooccurrence: Map<string, number>;

  constructor(data: Dictionary) {
    this.dictionary = new TagDictionary(
      data.tags.map((t) => ({ id: t.id, name: t.name, readings: t.readings, useCount: t.useCount })),
      data.relations.flatMap((r): TagRelation[] =>
        r.kind === 'alias'
          ? r.from_text ? [{ kind: 'alias' as const, fromText: r.from_text, toTagId: r.to_tag_id }] : []
          : r.from_tag_id ? [{ kind: r.kind, fromTagId: r.from_tag_id, toTagId: r.to_tag_id }] : [],
      ),
    );
    this.cooccurrence = new Map(Object.entries(data.cooccurrence));
  }

  suggest(input: string, selectedNames: string[]): SuggestResult {
    const selectedTagIds = selectedNames.flatMap((n) => {
      const t = this.dictionary.getByName(n);
      return t ? [t.id] : [];
    });
    return suggestTags({ input, dictionary: this.dictionary, selectedTagIds, cooccurrence: this.cooccurrence, limit: 6 });
  }

  byName(name: string): TagEntry | undefined {
    return this.dictionary.getByName(name);
  }
}

export { pairKey };

export interface PickEvent {
  tag: TagEntry | { name: string; id?: undefined };
  /** 「もしかして」から選んだときの、元の候補タグ */
  maybeFor?: string;
}

/**
 * 候補の一覧を描く。candidates は前方一致、maybe は「もしかして」。
 * allowCreate なら、一致する既存タグが無いときに「新しいタグを作る」を出す。
 */
export function renderSuggestions(
  container: HTMLElement,
  input: string,
  result: SuggestResult,
  onPick: (e: PickEvent) => void,
  allowCreate: boolean,
): void {
  clear(container);
  const key = input.replace(/^[#＃]/, '').trim();
  if (key.length === 0) {
    container.hidden = true;
    return;
  }
  // 同じ意味・上位下位のタグは、別枠ではなく同じ一覧に続けて出す。
  // 「クーラー」と打ったら #クーラー の下に #エアコン が並ぶのが、探す人には一番近い。
  // 打ち間違いの疑いだけは、理由が違うので「もしかして」に残す。
  const reasons: Record<string, string> = { synonym: '同じ意味', includes: 'この中の一つ', parent: 'これを含む', typo: '打ち間違い？' };
  const related = result.maybe.filter((m) => m.reason !== 'typo');
  const typos = result.maybe.filter((m) => m.reason === 'typo');

  const items: HTMLElement[] = [];
  for (const t of result.candidates) {
    items.push(h('li', {},
      h('button', { type: 'button', class: 'suggest-item', onclick: () => onPick({ tag: t }) },
        h('span', { class: 'tag tag-inline' }, `#${t.name}`),
        h('span', { class: 'suggest-count' }, `${t.useCount}件`))));
  }
  for (const m of related) {
    items.push(h('li', {},
      h('button', {
        type: 'button', class: 'suggest-item suggest-related',
        onclick: () => onPick({ tag: m.tag, ...(m.forTagId ? { maybeFor: m.forTagId } : {}) }),
      },
        h('span', { class: 'tag tag-inline' }, `#${m.tag.name}`),
        h('span', { class: 'suggest-count' }, reasons[m.reason] ?? ''))));
  }
  // 新しいタグを作る選択肢は、既存の候補が1つも無いときだけ出す（既存タグを選ぶ方が手数が少ない画面にする）
  if (allowCreate && result.candidates.length === 0) {
    // ひらがなだけの新しいタグは、漢字の既存タグ（#搬入 など）の打ち損じであることが多い
    const kanaOnly = /^[\u3041-\u309f\u30fc]+$/.test(key);
    items.push(h('li', {},
      h('button', { type: 'button', class: 'suggest-item suggest-new', onclick: () => onPick({ tag: { name: key } }) },
        `新しいタグ #${key} を作る`),
      kanaOnly ? h('p', { class: 'suggest-warn' }, '漢字のタグがあるかもしれません。漢字でも入力してみてください。') : null));
  }
  container.append(h('ul', { class: 'suggest-list', role: 'listbox', 'aria-label': 'タグの候補' }, ...items));

  if (typos.length > 0) {
    container.append(
      h('p', { class: 'maybe-label' }, 'もしかして'),
      h('ul', { class: 'suggest-list suggest-maybe' }, ...typos.map((m) =>
        h('li', {},
          h('button', { type: 'button', class: 'suggest-item', onclick: () => onPick({ tag: m.tag, ...(m.forTagId ? { maybeFor: m.forTagId } : {}) }) },
            h('span', { class: 'tag tag-inline' }, `#${m.tag.name}`),
            h('span', { class: 'suggest-count' }, reasons[m.reason] ?? ''))))),
    );
  }
  container.hidden = items.length === 0 && typos.length === 0;
}
