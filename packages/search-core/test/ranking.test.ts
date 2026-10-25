import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeDocument, analyzeQuery, FIELDS, type AnalyzedDocument, type DocumentInput } from '../src/analyzer.ts';
import { rank, type CandidateDoc, type CorpusStats } from '../src/bm25f.ts';
import { deps } from './fixtures.ts';

/** テスト用の小さな索引。本番では postings / knowledge_stats テーブルが同じ役割を持つ。 */
function buildIndex(docs: Record<string, DocumentInput>) {
  const d = deps();
  const analyzed = new Map<string, AnalyzedDocument>();
  for (const [id, doc] of Object.entries(docs)) analyzed.set(id, analyzeDocument(doc, d));

  const df = new Map<string, number>();
  const sum = { tag: 0, title: 0, body: 0 };
  for (const a of analyzed.values()) {
    const seen = new Set<string>();
    for (const f of FIELDS) {
      sum[f] += a.length[f];
      for (const t of a.tf[f].keys()) seen.add(t);
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = analyzed.size;
  const stats: CorpusStats = {
    docCount: n,
    avgLength: { tag: sum.tag / n, title: sum.title / n, body: sum.body / n },
    df,
  };
  const candidates: CandidateDoc[] = [...analyzed].map(([id, a]) => {
    const tf = new Map<string, Partial<Record<(typeof FIELDS)[number], number>>>();
    for (const f of FIELDS) for (const [t, c] of a.tf[f]) tf.set(t, { ...tf.get(t), [f]: c });
    return { id, length: a.length, tf };
  });
  return {
    search: (q: string) => rank(analyzeQuery(q, d).groups, candidates, stats).map((s) => s.id),
    scores: (q: string) => rank(analyzeQuery(q, d).groups, candidates, stats),
  };
}

// 検索と無関係な長い本文（数十行）
const filler = Array.from({ length: 40 }, (_, i) =>
  `手順${i + 1}では、お客様の状況を確認し、伝票に必要事項を記入して控えを渡します。`,
).join('\n');

const corpus: Record<string, DocumentInput> = {
  'tv-repair': {
    title: 'テレビの修理受付',
    body: 'メーカー保証期間内なら修理は無料。保証書とレシートを確認する。',
    tagNames: ['テレビ', '修理'],
  },
  'long-declared': {
    // 冒頭で一度だけ宣言し、その後はテレビ・修理が一度も出てこない長文
    title: '受付の流れ',
    body: `これはテレビの修理なのだけど、\n${filler}`,
    tagNames: [],
  },
  'long-declared-tagged': {
    title: '受付の流れ（タグあり）',
    body: `これはテレビの修理なのだけど、\n${filler}`,
    tagNames: ['テレビ', '修理'],
  },
  'long-unrelated': {
    title: '伝票の書き方',
    body: `${filler}\n冷蔵庫の配送伝票も同じ書き方です。`,
    tagNames: ['配送'],
  },
  'fridge-recycle': {
    title: '冷蔵庫のリサイクル料金',
    body: '家電リサイクル法の対象。引き取り時にリサイクル料金と収集運搬料金がかかる。',
    tagNames: ['冷蔵庫', 'リサイクル'],
  },
  'freezer-carry': {
    title: '大型の冷凍冷蔵庫を搬入するとき',
    body: 'マンションはエレベーターの寸法を事前に確認する。',
    tagNames: ['冷凍冷蔵庫', '搬入'],
  },
  'ext-warranty': {
    title: '長期保証の加入条件',
    body: '購入から30日以内なら加入できる。',
    tagNames: ['長期保証'],
  },
  'ac-install': {
    title: 'クーラーの取り付け工事',
    body: '室外機の置き場所を確認する。',
    tagNames: ['クーラー'],
  },
  'repair-spam': {
    title: '修理',
    body: Array.from({ length: 50 }, () => '修理').join(' '),
    tagNames: [],
  },
};

describe('並び順（BM25F）', () => {
  const index = buildIndex(corpus);

  it('「テレビ 修理」で、タグも本文も一致する短いナレッジが最上位', () => {
    assert.equal(index.search('テレビ 修理')[0], 'tv-repair');
  });

  it('冒頭で一度宣言しただけの長文も取りこぼさない（トークン上限を設けない）', () => {
    assert.ok(index.search('テレビ 修理').includes('long-declared'));
  });

  it('同じ長文でも、書き手がハッシュタグを付けた方が上に来る', () => {
    const order = index.search('テレビ 修理');
    assert.ok(order.indexOf('long-declared-tagged') < order.indexOf('long-declared'));
  });

  it('長いだけの無関係な文書は、関係する短い文書より下に来る', () => {
    const order = index.search('冷蔵庫');
    assert.ok(order.indexOf('fridge-recycle') < order.indexOf('long-unrelated'));
  });

  it('同じ語を50回並べても、点数は頭打ちになる（飽和）', () => {
    const s = index.scores('修理');
    const spam = s.find((x) => x.id === 'repair-spam')!.score;
    const normal = s.find((x) => x.id === 'tv-repair')!.score;
    assert.ok(spam < normal * 2, `spam=${spam} normal=${normal}`);
  });

  it('同義：#延長保証 で #長期保証 のナレッジが出る', () => {
    assert.ok(index.search('#延長保証').includes('ext-warranty'));
  });

  it('同義：#エアコン で #クーラー のナレッジが出る', () => {
    assert.deepEqual(index.search('#エアコン'), ['ac-install']);
  });

  it('包含：#冷蔵庫 で #冷凍冷蔵庫 も出るが、直接 #冷蔵庫 のものが上', () => {
    const order = index.search('#冷蔵庫');
    assert.ok(order.includes('freezer-carry'));
    assert.ok(order.indexOf('fridge-recycle') < order.indexOf('freezer-carry'));
  });

  it('包含は一方向：#冷凍冷蔵庫 で #冷蔵庫 全般のナレッジは出ない', () => {
    const order = index.search('#冷凍冷蔵庫');
    assert.deepEqual(order, ['freezer-carry']);
  });

  it('別名：「テレビ 映らない」で修理のナレッジが出る', () => {
    assert.equal(index.search('テレビ 映らない')[0], 'tv-repair');
  });
});
