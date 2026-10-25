import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import { DomainError } from '../src/domain/actor.ts';
import { createKnowledge } from '../src/domain/knowledge.ts';
import { search } from '../src/domain/search.ts';
import { decideRelation, listRelations, mergeTags, proposeRelation } from '../src/domain/tagAdmin.ts';
import { exportDictionary } from '../src/domain/tags.ts';
import { freshDatabase, manager, STORE_A, STORE_B, storeBStaff, T, tokenizer, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
const run = <R>(fn: (q: Db) => Promise<R>): Promise<R> => db.withTenant(T, fn);
const rejects = async (p: Promise<unknown>, code: DomainError['code']) => {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code);
};
const ids = (r: { hits: Array<{ id: string }> }) => r.hits.map((h) => h.id);

let warrantyId: string;
let typoId: string;

before(async () => {
  db = await freshDatabase();
  warrantyId = (await run((q) => createKnowledge(q, tokenizer, trusted, {
    storeId: STORE_A, title: '長期保証の加入条件', body: '購入から30日以内なら加入できる。', tagNames: ['#長期保証', '#レジ'],
  }))).id;
  typoId = (await run((q) => createKnowledge(q, tokenizer, trusted, {
    storeId: STORE_A, title: '保証書の再発行', body: 'レシートがあれば再発行できる。', tagNames: ['#長期保障'],
  }))).id;
  await run((q) => createKnowledge(q, tokenizer, trusted, {
    storeId: STORE_A, title: '延長保証の説明', body: 'メーカー保証に加えて最長5年。', tagNames: ['#延長保証', '#レジ'],
  }));
  await run((q) => createKnowledge(q, tokenizer, storeBStaff, {
    storeId: STORE_B, title: '駅前店だけの社内ルール', body: '駐輪場の案内。', tagNames: ['#駐輪場'],
  }));
});
after(async () => { await db.close(); });

describe('タグの関係', () => {
  it('visitor の提案は候補になり、trusted が承認すると検索に効く', async () => {
    const r = await run((q) => proposeRelation(q, visitor, { kind: 'synonym', fromTag: '#延長保証', toTag: '#長期保証' }));
    assert.equal(r.state, 'candidate');
    assert.ok(!ids(await run((q) => search(q, tokenizer, trusted, STORE_A, '#延長保証'))).includes(warrantyId));
    const cands = await run((q) => listRelations(q, trusted, 'candidate'));
    assert.equal(cands.length, 1);
    await rejects(run((q) => decideRelation(q, visitor, r.id, 'approved')), 'forbidden');
    await run((q) => decideRelation(q, trusted, r.id, 'approved'));
    assert.ok(ids(await run((q) => search(q, tokenizer, trusted, STORE_A, '#延長保証'))).includes(warrantyId));
  });

  it('同じ関係を逆向きに提案しても重複せず、根拠の件数が増える', async () => {
    await run((q) => proposeRelation(q, visitor, { kind: 'synonym', fromTag: '長期保証', toTag: '延長保証' }));
    const approved = await run((q) => listRelations(q, trusted, 'approved'));
    assert.equal(approved.length, 1);
    assert.equal(approved[0]!.evidence, 2);
  });

  it('包含は循環させられない', async () => {
    await run((q) => proposeRelation(q, trusted, { kind: 'includes', fromTag: 'レジ', toTag: '延長保証' }));
    await rejects(run((q) => proposeRelation(q, trusted, { kind: 'includes', fromTag: '延長保証', toTag: 'レジ' })), 'conflict');
  });

  it('別名（単語 → タグ）を登録すると、話し言葉で検索できる', async () => {
    assert.equal((await run((q) => search(q, tokenizer, trusted, STORE_A, 'ずっと安心'))).hits.length, 0);
    await run((q) => proposeRelation(q, trusted, { kind: 'alias', fromText: 'ずっと安心', toTag: '長期保証' }));
    assert.ok(ids(await run((q) => search(q, tokenizer, trusted, STORE_A, 'ずっと安心'))).includes(warrantyId));
  });

  it('存在しないタグには関係を作れない', async () => {
    await rejects(run((q) => proposeRelation(q, trusted, { kind: 'synonym', fromTag: '存在しない', toTag: '長期保証' })), 'not_found');
  });
});

describe('タグの統合', () => {
  it('administrator だけが統合でき、統合元のナレッジは統合先のタグで検索される', async () => {
    await rejects(run((q) => mergeTags(q, tokenizer, trusted, '長期保障', '長期保証')), 'forbidden');
    const r = await run((q) => mergeTags(q, tokenizer, manager, '長期保障', '長期保証'));
    assert.equal(r.reindexed, 1);
    assert.ok(ids(await run((q) => search(q, tokenizer, trusted, STORE_A, '#長期保証'))).includes(typoId));
  });

  it('統合元のタグ名で投稿・検索しても、統合先として扱われる', async () => {
    assert.ok(ids(await run((q) => search(q, tokenizer, trusted, STORE_A, '#長期保障'))).includes(typoId));
    const k = await run((q) => createKnowledge(q, tokenizer, trusted, {
      storeId: STORE_A, title: '保証の延長手続き', body: '店頭で受け付ける。', tagNames: ['#長期保障'],
    }));
    const tagged = await run((q) => q.query<{ name: string }>(
      `SELECT h.name FROM knowledge_tags kt JOIN hashtags h ON h.id = kt.hashtag_id WHERE kt.knowledge_id = $1`, [k.id],
    ));
    assert.deepEqual(tagged.map((t) => t.name), ['長期保証']);
  });
});

describe('端末向けのタグ辞書', () => {
  it('その店舗から見えるナレッジのタグだけを返す（他店舗だけのタグは返さない）', async () => {
    const a = await run((q) => exportDictionary(q, trusted, STORE_A));
    const names = a.tags.map((t) => t.name);
    assert.ok(names.includes('長期保証'));
    assert.ok(!names.includes('駐輪場'));
    assert.ok(!names.includes('長期保障'), '統合済みのタグは返さない');
    const b = await run((q) => exportDictionary(q, storeBStaff, STORE_B));
    assert.deepEqual(b.tags.map((t) => t.name), ['駐輪場']);
    await rejects(run((q) => exportDictionary(q, trusted, STORE_B)), 'forbidden');
  });

  it('関係も、見えるタグどうしのものだけを返す', async () => {
    const b = await run((q) => exportDictionary(q, storeBStaff, STORE_B));
    assert.equal(b.relations.length, 0);
  });
});
