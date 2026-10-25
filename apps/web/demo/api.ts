// デモ用の「サーバーの代わり」。本物の apps/web/src/api.ts と同じ形で呼べるようにしてある。
//
// 検索・タグ候補・もしかして・共起は、本物と同じ @misenare/search-core を使う。
// 置き換えているのは「データの置き場所」だけ（PostgreSQL → 端末の中の配列）。
// 書いたものはこの画面を閉じると消える。

import {
  analyzeDocument, analyzeQuery, computeNpmi, DEFAULT_PARAMS, normalizeTagName, pairKey,
  rank, SegmenterTokenizer, TagDictionary,
  type CandidateDoc, type CorpusStats, type Field, type TagRelation,
} from '@misenare/search-core';
import {
  AREAS, HANDOVERS, KNOWLEDGE, NOTICES, PRODUCTS, RELATIONS, STORE, TAGS, ago, dateOnly,
  type DemoHandover, type DemoKnowledge, type DemoNotice,
} from './data.ts';

// --- 本物と同じ形の入れ物 -----------------------------------------------------------

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface Me {
  id: string; name: string;
  trustLevel: 'visitor' | 'trusted';
  adminScope: 'none' | 'store' | 'tenant';
  stores: Array<{ id: string; name: string }>;
  staleDays?: number;
}
export interface Hit {
  id: string; title: string; snippet: string; tags: string[];
  updatedAt: string; verifiedAt: string | null; verifiedBy: string | null; linked?: boolean;
}
export interface SearchResult { hits: Hit[]; chips: Array<{ name: string; count: number }>; logId: number }
export interface Knowledge {
  id: string; storeId: string | null; status: 'draft' | 'published' | 'expired'; version: number | null;
  title: string; body: string; tags: string[];
  updatedAt: string; updatedBy: string | null; verifiedAt: string | null; verifiedBy: string | null;
  pendingVersions: number[];
}
export interface Dictionary {
  tags: Array<{ id: string; name: string; reading: string | null; useCount: number }>;
  relations: Array<{ kind: 'synonym' | 'includes' | 'alias'; from_tag_id: string | null; from_text: string | null; to_tag_id: string }>;
  cooccurrence: Record<string, number>;
}
export interface ProductCard {
  id: string; janCode: string; name: string; maker: string | null;
  area: { id: string; name: string } | null; note: string | null; tags: string[]; pending: boolean;
}
export type ScanResult =
  | { status: 'unknown'; janCode: string }
  | { status: 'found'; product: ProductCard; related: Hit[] };

/** デモでは、ログイン状態は常に「入っている」 */
export const session = {
  get token(): string | null { return 'demo'; },
  set token(_v: string | null) { /* デモでは何もしない */ },
  get storeId(): string | null { return STORE.id; },
  set storeId(_v: string | null) { /* デモでは1店舗だけ */ },
};

// --- 端末の中のデータ ---------------------------------------------------------------

const ME: Me = {
  id: 'bb000000-0000-0000-0000-000000000001',
  name: '山本',
  trustLevel: 'trusted',
  adminScope: 'none',
  stores: [STORE],
  // 本物のサーバーと同じ値
  staleDays: 180,
};

const tokenizer = new SegmenterTokenizer();
const knowledge: DemoKnowledge[] = [...KNOWLEDGE];
const notices: DemoNotice[] = NOTICES.map((n) => ({ ...n }));
const handovers: DemoHandover[] = HANDOVERS.map((h) => ({ ...h, events: [...(h.events ?? [])] }));

/** 誰が何をしたかを残す（本物と同じ考え方） */
function recordHandover(h: DemoHandover, action: string, label: string): void {
  h.events = [...(h.events ?? []), { action, label, by: ME.name, at: new Date().toISOString() }];
}
const tags = [...TAGS];
let logId = 1;
/** 見つからなかった検索（本物と同じく、管理画面で見られるようにする） */
const zeroHits = new Map<string, number>();

function ensureTag(name: string): string {
  const normalized = normalizeTagName(name);
  const found = tags.find((t) => t.name === normalized);
  if (found) return found.id;
  const created = { id: `da000000-0000-0000-0000-${String(tags.length).padStart(12, '0')}`, name: normalized, reading: null };
  tags.push(created);
  return created.id;
}

function useCount(tagId: string): number {
  const name = tags.find((t) => t.id === tagId)?.name;
  if (!name) return 0;
  return knowledge.filter((k) => k.tags.includes(name)).length;
}

function dictionary(): TagDictionary {
  return new TagDictionary(
    tags.map((t) => ({ id: t.id, name: t.name, reading: t.reading, useCount: useCount(t.id) })),
    RELATIONS.flatMap((r): TagRelation[] =>
      r.kind === 'alias'
        ? r.fromText ? [{ kind: 'alias', fromText: r.fromText, toTagId: r.to }] : []
        : r.from ? [{ kind: r.kind, fromTagId: r.from, toTagId: r.to }] : []),
  );
}

/** 検索のたびに索引を作り直す（データが小さいので、本番の夜間バッチの代わりになる） */
function buildIndex() {
  const dict = dictionary();
  const docs: CandidateDoc[] = [];
  const df = new Map<string, number>();
  let tagLen = 0; let titleLen = 0; let bodyLen = 0;
  for (const k of knowledge) {
    const analyzed = analyzeDocument({ title: k.title, body: k.body, tagNames: k.tags }, { tokenizer, dictionary: dict });
    const tf = new Map<string, Partial<Record<Field, number>>>();
    for (const field of ['tag', 'title', 'body'] as Field[]) {
      for (const [term, n] of analyzed.tf[field]) tf.set(term, { ...tf.get(term), [field]: n });
    }
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    docs.push({ id: k.id, length: analyzed.length, tf });
    tagLen += analyzed.length.tag; titleLen += analyzed.length.title; bodyLen += analyzed.length.body;
  }
  const n = Math.max(1, docs.length);
  const stats: CorpusStats = {
    docCount: docs.length,
    avgLength: { tag: tagLen / n, title: titleLen / n, body: bodyLen / n },
    df,
  };
  return { dict, docs, stats };
}

function hitOf(k: DemoKnowledge): Hit {
  return {
    id: k.id,
    title: k.title,
    snippet: k.body.replace(/\s+/g, ' ').slice(0, 80),
    tags: k.tags,
    updatedAt: k.updatedAt,
    verifiedAt: k.verifiedAt,
    verifiedBy: k.verifiedBy,
  };
}

function exportDictionary(): Dictionary {
  const counts = new Map(tags.map((t) => [t.id, useCount(t.id)]));
  const pairs = new Map<string, number>();
  for (const k of knowledge) {
    const ids = k.tags.map(ensureTag).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = pairKey(ids[i]!, ids[j]!);
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  const npmi = computeNpmi(Math.max(1, knowledge.length), counts, pairs);
  return {
    tags: tags.map((t) => ({ id: t.id, name: t.name, reading: t.reading, useCount: counts.get(t.id) ?? 0 })),
    relations: RELATIONS.map((r) => ({ kind: r.kind, from_tag_id: r.from, from_text: r.fromText, to_tag_id: r.to })),
    cooccurrence: Object.fromEntries([...npmi].filter(([, v]) => v > 0).map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
  };
}

// --- 経路ごとの応答 -----------------------------------------------------------------

const uuid = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? `d${Date.now()}${Math.random()}`).replace(/[^0-9a-f-]/g, '0');

function search(query: string): SearchResult {
  const { dict, docs, stats } = buildIndex();
  const analyzed = analyzeQuery(query, { tokenizer, dictionary: dict });
  const verified = new Map(knowledge.map((k) => [k.id, k.verifiedAt ?? '']));
  const ranked = rank(analyzed.groups, docs, stats, {
    limit: 20,
    tieBreak: (a, b) => (verified.get(b) ?? '').localeCompare(verified.get(a) ?? ''),
  });
  const byId = new Map(knowledge.map((k) => [k.id, k]));
  const hits = ranked.flatMap((r) => {
    const k = byId.get(r.id);
    return k ? [hitOf(k)] : [];
  });
  const counts = new Map<string, number>();
  for (const h of hits) for (const t of h.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const queried = new Set(analyzed.matchedTagIds.map((id) => tags.find((t) => t.id === id)?.name));
  const chips = [...counts]
    .filter(([name]) => !queried.has(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));
  if (hits.length === 0) {
    const key = query.trim();
    if (key) zeroHits.set(key, (zeroHits.get(key) ?? 0) + 1);
  }
  return { hits, chips, logId: logId++ };
}

function badges() {
  return {
    notices: {
      unread: notices.filter((n) => !n.readAt).length,
      needsAck: notices.filter((n) => n.requiresAck && !n.ackedAt).length,
    },
    handovers: {
      open: handovers.filter((h) => h.state === 'open').length,
      carriedOver: handovers.filter((h) => h.state === 'open' && h.forDate < dateOnly(0)).length,
    },
  };
}

/** デモでは触れない機能を、画面が壊れない形で断る */
function notInDemo(): never {
  throw new ApiError(400, 'デモではこの操作はできません。本物の環境でお試しください。');
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  // 本物のサーバーらしく、少しだけ待つ
  await new Promise((r) => setTimeout(r, 40));
  const [rawPath, queryString] = path.split('?') as [string, string | undefined];
  const params = new URLSearchParams(queryString ?? '');
  const parts = rawPath.split('/').filter(Boolean);
  const b = (body ?? {}) as Record<string, unknown>;

  // --- 自分と辞書 ---
  if (method === 'GET' && rawPath === '/me') return ME as T;
  if (method === 'GET' && parts[0] === 'stores' && parts[2] === 'tags') return exportDictionary() as T;
  if (method === 'GET' && parts[0] === 'stores' && parts[2] === 'badges') return badges() as T;

  // --- 探す ---
  if (method === 'GET' && parts[0] === 'stores' && parts[2] === 'search') {
    return search(params.get('q') ?? '') as T;
  }
  if (method === 'POST' && parts[0] === 'search-logs') return { ok: true } as T;

  // --- ナレッジ ---
  if (parts[0] === 'knowledge' && parts.length === 2) {
    const k = knowledge.find((x) => x.id === parts[1]);
    if (!k) throw new ApiError(404, 'ナレッジが見つかりません');
    if (method === 'GET') {
      return {
        id: k.id, storeId: k.storeId, status: 'published', version: 1,
        title: k.title, body: k.body, tags: k.tags,
        updatedAt: k.updatedAt, updatedBy: k.updatedBy,
        verifiedAt: k.verifiedAt, verifiedBy: k.verifiedBy, pendingVersions: [],
      } as T;
    }
    if (method === 'PUT') {
      k.title = String(b.title ?? k.title);
      k.body = String(b.body ?? k.body);
      k.tags = (b.tagNames as string[] ?? k.tags).map(normalizeTagName);
      k.updatedAt = new Date().toISOString();
      k.updatedBy = ME.name;
      k.verifiedAt = k.updatedAt;
      k.verifiedBy = ME.name;
      for (const name of k.tags) ensureTag(name);
      return { id: k.id, version: 1, published: true } as T;
    }
  }
  if (method === 'GET' && parts[0] === 'knowledge' && parts[2] === 'photos') return [] as T;
  if (method === 'POST' && parts[0] === 'knowledge' && parts[2] === 'photos') notInDemo();
  if (method === 'POST' && parts[0] === 'stores' && parts[2] === 'knowledge') {
    const created: DemoKnowledge = {
      id: uuid(),
      storeId: STORE.id,
      title: String(b.title ?? ''),
      body: String(b.body ?? ''),
      tags: ((b.tagNames as string[]) ?? []).map(normalizeTagName),
      updatedAt: new Date().toISOString(),
      updatedBy: ME.name,
      verifiedAt: new Date().toISOString(),
      verifiedBy: ME.name,
    };
    for (const name of created.tags) ensureTag(name);
    knowledge.push(created);
    return { id: created.id, version: 1, published: true } as T;
  }
  if (method === 'POST' && parts[0] === 'knowledge' && parts[2] === 'verify') {
    const k = knowledge.find((x) => x.id === parts[1]);
    if (k) { k.verifiedAt = new Date().toISOString(); k.verifiedBy = ME.name; }
    return { ok: true } as T;
  }

  // --- バーコード ---
  if (method === 'GET' && parts[0] === 'stores' && parts[2] === 'barcode') {
    const jan = parts[3] ?? '';
    const product = PRODUCTS.find((p) => p.janCode === jan);
    if (!product) return { status: 'unknown', janCode: jan } as T;
    const linked = knowledge.filter((k) => product.knowledgeIds.includes(k.id)).map((k) => ({ ...hitOf(k), linked: true }));
    const byTag = search(product.tags.map((t) => `#${t}`).join(' ')).hits.filter((h) => !product.knowledgeIds.includes(h.id));
    const { knowledgeIds: _ignored, ...card } = product;
    return { status: 'found', product: { ...card, pending: false }, related: [...linked, ...byTag] } as T;
  }
  if (method === 'POST' && parts[0] === 'stores' && parts[2] === 'products') notInDemo();

  // --- 連絡事項 ---
  if (method === 'GET' && parts[0] === 'stores' && parts[2] === 'notices') {
    return notices.map((n) => ({
      id: n.id, storeId: n.storeId, title: n.title, body: n.body,
      priority: n.priority, requiresAck: n.requiresAck, startsAt: n.createdAt, endsAt: n.endsAt,
      createdBy: n.createdBy, createdAt: n.createdAt, readAt: n.readAt, ackedAt: n.ackedAt,
      ...(n.requiresAck ? { pendingAcks: n.pendingAcks } : {}),
    })) as T;
  }
  if (method === 'POST' && parts[0] === 'stores' && parts[2] === 'notices') {
    notices.unshift({
      id: uuid(), storeId: STORE.id,
      title: String(b.title ?? ''), body: String(b.body ?? ''),
      priority: b.priority === 'important' ? 'important' : 'normal',
      requiresAck: Boolean(b.requiresAck),
      endsAt: (b.endsAt as string | null) ?? null,
      createdBy: ME.name, createdAt: new Date().toISOString(),
      readAt: new Date().toISOString(), ackedAt: null, pendingAcks: 3,
    });
    notices.sort((a, c) => Number(c.priority === 'important') - Number(a.priority === 'important'));
    return { id: notices[0]!.id } as T;
  }
  if (method === 'POST' && parts[0] === 'notices' && parts[2] === 'read') {
    const n = notices.find((x) => x.id === parts[1]);
    if (n && !n.readAt) n.readAt = new Date().toISOString();
    return { ok: true } as T;
  }
  if (method === 'POST' && parts[0] === 'notices' && parts[2] === 'ack') {
    const n = notices.find((x) => x.id === parts[1]);
    if (!n) throw new ApiError(404, '連絡事項が見つかりません');
    n.ackedAt = new Date().toISOString();
    n.readAt = n.readAt ?? n.ackedAt;
    n.pendingAcks = Math.max(0, n.pendingAcks - 1);
    return { ackedAt: n.ackedAt } as T;
  }

  // --- 引き継ぎ ---
  if (method === 'GET' && parts[0] === 'stores' && parts[2] === 'handovers' && parts[3] === 'history') {
    const scope = params.get('scope') === 'all' ? 'all' : 'actions';
    return handovers
      .filter((h) => scope === 'all' || (h.events ?? []).some((e) => e.action !== 'created'))
      .map((h) => {
        const events = h.events ?? [];
        return {
          id: h.id, body: h.body, state: h.state, forDate: h.forDate, deleted: Boolean(h.deleted),
          createdBy: h.createdBy, createdAt: h.createdAt,
          events, lastAction: events[events.length - 1] ?? { action: 'created', label: '書いた', by: h.createdBy, at: h.createdAt },
        };
      })
      .sort((a, c) => c.lastAction.at.localeCompare(a.lastAction.at) || c.createdAt.localeCompare(a.createdAt)) as T;
  }
  if (method === 'GET' && parts[0] === 'stores' && parts[2] === 'handovers') {
    const today = dateOnly(0);
    return handovers
      .filter((h) => !h.deleted)
      .filter((h) => h.forDate === today || h.state === 'open')
      .map((h) => ({ ...h, carriedOver: h.forDate < today }))
      .sort((a, c) => Number(a.state === 'done') - Number(c.state === 'done') || a.forDate.localeCompare(c.forDate)) as T;
  }
  if (method === 'POST' && parts[0] === 'stores' && parts[2] === 'handovers') {
    const text = String(b.body ?? '').trim();
    if (!text) throw new ApiError(400, '引き継ぎを書いてください');
    const now = new Date().toISOString();
    handovers.push({
      id: uuid(), body: text, state: 'open', forDate: dateOnly(0),
      createdBy: ME.name, createdAt: now, doneBy: null, doneAt: null,
      events: [{ action: 'created', label: '書いた', by: ME.name, at: now }],
    });
    return { id: handovers.at(-1)!.id, forDate: dateOnly(0) } as T;
  }
  if (method === 'POST' && parts[0] === 'handovers') {
    const h = handovers.find((x) => x.id === parts[1]);
    if (!h) throw new ApiError(404, '引き継ぎが見つかりません');
    if (parts[2] === 'done') {
      h.state = 'done'; h.doneBy = ME.name; h.doneAt = new Date().toISOString();
      recordHandover(h, 'done', '片付けた');
    }
    if (parts[2] === 'reopen') {
      h.state = 'open'; h.doneBy = null; h.doneAt = null;
      recordHandover(h, 'reopened', 'やり直した');
    }
    if (parts[2] === 'restore') {
      h.deleted = false;
      recordHandover(h, 'restored', '戻した');
      return { id: h.id, restored: true } as T;
    }
    return { id: h.id, state: h.state } as T;
  }
  if (method === 'DELETE' && parts[0] === 'handovers') {
    // 本物と同じく、消さずに印を付けるだけ（戻せる）
    const h = handovers.find((x) => x.id === parts[1]);
    if (!h) throw new ApiError(404, '引き継ぎが見つかりません');
    h.deleted = true;
    recordHandover(h, 'deleted', '消した');
    return { ok: true } as T;
  }

  // --- 承認・管理 ---
  // 半年以上、更新も確認もされていないもの（本物の listStale と同じ判定）
  if (method === 'GET' && parts[0] === 'stores' && parts[2] === 'stale') {
    const half = Date.now() - 180 * 24 * 3600_000;
    return knowledge
      .filter((k) => Math.max(Date.parse(k.updatedAt), Date.parse(k.verifiedAt ?? k.updatedAt)) < half)
      .sort((a, c) => (a.verifiedAt ?? '').localeCompare(c.verifiedAt ?? ''))
      .map((k) => ({ id: k.id, title: k.title, verified_at: k.verifiedAt })) as T;
  }
  if (method === 'GET' && parts[0] === 'stores' && parts[2] === 'zero-hits') {
    return [...zeroHits].sort((a, c) => c[1] - a[1]).map(([query, times]) => ({ query, times })) as T;
  }
  // 承認待ちは、デモでは全員 trusted なので本当に0件（すぐ公開される）
  if (method === 'GET' && parts[0] === 'stores' && ['pending', 'pending-products', 'imports', 'users'].includes(parts[2] ?? '')) {
    return (parts[2] === 'pending-products' ? { products: [], changes: [] } : []) as T;
  }
  if (method === 'GET' && rawPath.startsWith('/tag-readings')) {
    return readingProposals as T;
  }
  if (method === 'POST' && parts[0] === 'tag-readings') {
    const i = readingProposals.findIndex((r) => r.id === parts[1]);
    if (i >= 0) {
      const name = readingProposals[i]!.name;
      readingProposals.splice(i, 1);
      const reading = typeof body?.reading === 'string' ? body.reading : null;
      // 本物と同じで、確かめた読みだけがタグに入る
      const tag = tags.find((t) => t.name === name);
      if (tag) tag.reading = reading;
    }
    return { ok: true } as T;
  }
  if (method === 'GET' && rawPath.startsWith('/tag-relations')) {
    const state = params.get('state');
    if (state !== 'approved') return [] as T;
    return RELATIONS.map((r, i) => ({
      id: `r${i}`, kind: r.kind,
      from_tag: r.from ? tags.find((t) => t.id === r.from)?.name ?? null : null,
      from_text: r.fromText, to_tag: tags.find((t) => t.id === r.to)?.name ?? '',
      source: 'manual', evidence: 1,
    })) as T;
  }

  // 招待はQRコードの見た目を試せるよう、形だけ返す（使っても入れない）
  if (method === 'POST' && rawPath === '/invitations') {
    const random = Array.from({ length: 43 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[Math.floor(Math.random() * 64)]).join('');
    return { token: `00000000-0000-4000-8000-000000000000.${random}`, expiresAt: ago(-3) } as T;
  }

  throw new ApiError(400, 'デモではこの操作はできません。本物の環境でお試しください。');
}

/**
 * 読みの確認待ち。機械が出した案という設定で、**わざと1つ間違えてある**
 * （下取り → シタトリ）。直して登録できることを触って確かめられるようにするため。
 */
const readingProposals: Array<{ id: string; name: string; proposed: string; useCount: number }> = [
  { id: 'da000000-0000-0000-0000-000000000003', name: '引き取り', proposed: 'ヒキトリ', useCount: 3 },
  { id: 'da000000-0000-0000-0000-000000000014', name: '設置', proposed: 'セッチ', useCount: 2 },
  { id: 'ea000000-0000-0000-0000-000000000001', name: '下取り', proposed: 'シタトリ', useCount: 1 },
];

/** 画面から参照する、デモの印 */
export const IS_DEMO = true;
export { AREAS, ago };
