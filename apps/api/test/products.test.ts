import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import { DomainError } from '../src/domain/actor.ts';
import { createKnowledge } from '../src/domain/knowledge.ts';
import {
  approveProduct,
  approveProductChange,
  deleteProduct,
  isValidJan,
  linkKnowledgeToProduct,
  productHistory,
  registerProduct,
  rejectProductChange,
  scanBarcode,
  updateProduct,
} from '../src/domain/products.ts';
import { AREA_BIG, AREA_KITCHEN, freshDatabase, hq, jan, manager, STORE_A, STORE_B, storeBStaff, T, tokenizer, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
const run = <R>(fn: (q: Db) => Promise<R>): Promise<R> => db.withTenant(T, fn);
const rejects = async (p: Promise<unknown>, code: DomainError['code']) => {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code);
};

const FRIDGE = jan('490123456789');
const VACUUM = jan('490000000001');

let recycleId: string;
let carryId: string;
let modelNoteId: string;

before(async () => {
  db = await freshDatabase();
  recycleId = (await run((q) => createKnowledge(q, tokenizer, trusted, {
    storeId: STORE_A, title: '冷蔵庫のリサイクル料金', body: '家電リサイクル法の対象。引き取り時にリサイクル料金がかかる。', tagNames: ['#冷蔵庫', '#リサイクル'],
  }))).id;
  carryId = (await run((q) => createKnowledge(q, tokenizer, trusted, {
    storeId: STORE_A, title: '大型家電の搬入', body: 'マンションはエレベーターの寸法を事前に確認する。', tagNames: ['#搬入', '#大型家電'],
  }))).id;
  modelNoteId = (await run((q) => createKnowledge(q, tokenizer, trusted, {
    storeId: STORE_A, title: 'GR-W600 の扉の付け替え', body: 'この機種は左右の付け替えができない。', tagNames: ['#冷蔵庫', '#設置'],
  }))).id;
  await run((q) => createKnowledge(q, tokenizer, trusted, {
    storeId: STORE_A, title: 'テレビの修理受付', body: '保証書を確認する。', tagNames: ['#テレビ', '#修理'],
  }));
});
after(async () => { await db.close(); });

describe('JAN', () => {
  it('チェックデジットを検証する', () => {
    assert.equal(isValidJan('4901234567894'), true);
    assert.equal(isValidJan('4901234567890'), false);
    assert.equal(isValidJan('49012345'), false);
    assert.equal(isValidJan(jan('453000000000')), true);
  });
});

describe('バーコードからの検索', () => {
  it('初めて読まれた JAN は unknown を返す', async () => {
    assert.deepEqual(await run((q) => scanBarcode(q, tokenizer, trusted, STORE_A, FRIDGE)), { status: 'unknown', janCode: FRIDGE });
  });

  it('読み取れない JAN は受け付けない', async () => {
    await rejects(run((q) => scanBarcode(q, tokenizer, trusted, STORE_A, '4901234567890')), 'invalid');
  });

  it('その場で登録すると、商品カードと、商品のタグ・名前で探した関連ナレッジが出る', async () => {
    await run((q) => registerProduct(q, trusted, STORE_A, {
      janCode: FRIDGE, name: '東芝 冷凍冷蔵庫 GR-W600', maker: '東芝', areaId: AREA_KITCHEN, tagNames: ['#冷蔵庫', '#大型家電'],
    }));
    const r = await run((q) => scanBarcode(q, tokenizer, trusted, STORE_A, FRIDGE));
    assert.equal(r.status, 'found');
    if (r.status !== 'found') return;
    assert.equal(r.product.area?.name, 'キッチン家電');
    assert.deepEqual([...r.product.tags].sort(), ['冷蔵庫', '大型家電']);
    const related = r.related.map((h) => h.id);
    // 型番が一致するナレッジ、タグが一致するナレッジがどちらも出る。テレビの修理は出ない
    assert.ok(related.includes(modelNoteId), '型番 GR-W600 で一致');
    assert.ok(related.includes(recycleId), '#冷蔵庫 で一致');
    assert.ok(related.includes(carryId), '#大型家電 で一致');
    assert.equal(r.related.length, 3);
    assert.equal(related[0], modelNoteId, 'タグと型番の両方で一致するものが最上位');
  });

  it('直接紐づけたナレッジは最上位に出る', async () => {
    const r0 = await run((q) => scanBarcode(q, tokenizer, trusted, STORE_A, FRIDGE));
    if (r0.status !== 'found') throw new Error('not found');
    await run((q) => linkKnowledgeToProduct(q, trusted, carryId, r0.product.id));
    const r = await run((q) => scanBarcode(q, tokenizer, trusted, STORE_A, FRIDGE));
    if (r.status !== 'found') throw new Error('not found');
    assert.equal(r.related[0]!.id, carryId);
    assert.equal(r.related[0]!.linked, true);
    assert.equal(r.related.filter((h) => h.id === carryId).length, 1, '重複しない');
  });

  it('全店共通のナレッジに商品を紐づけられるのは本部だけ（本文を直せる人と同じ）', async () => {
    const r0 = await run((q) => scanBarcode(q, tokenizer, trusted, STORE_A, FRIDGE));
    if (r0.status !== 'found') throw new Error('not found');
    const shared = await run((q) => createKnowledge(q, tokenizer, hq, { storeId: null, title: '全店の冷蔵庫', body: '本文', tagNames: ['#冷蔵庫'] }));
    await rejects(run((q) => linkKnowledgeToProduct(q, trusted, shared.id, r0.product.id)), 'forbidden');
    await rejects(run((q) => linkKnowledgeToProduct(q, storeBStaff, shared.id, r0.product.id)), 'forbidden');
    await run((q) => linkKnowledgeToProduct(q, hq, shared.id, r0.product.id));
  });
});

describe('商品情報の編集と履歴', () => {
  it('trusted が売場を移動すると即時反映され、履歴に残る', async () => {
    const r = await run((q) => scanBarcode(q, tokenizer, trusted, STORE_A, FRIDGE));
    if (r.status !== 'found') throw new Error('not found');
    await run((q) => updateProduct(q, trusted, STORE_A, r.product.id, { areaId: AREA_BIG, note: '入口側の通路' }));
    const after = await run((q) => scanBarcode(q, tokenizer, trusted, STORE_A, FRIDGE));
    if (after.status !== 'found') throw new Error('not found');
    assert.equal(after.product.area?.name, '大型家電');
    const h = await run((q) => productHistory(q, trusted, STORE_A, r.product.id));
    assert.deepEqual(h.slice(0, 2).map((x) => x.field).sort(), ['area', 'note']);
    assert.equal(h[0]!.edited_by, 'ベテランパート');
  });

  it('visitor の編集は承認待ちになり、承認されると本人の名前で履歴に残る', async () => {
    const r = await run((q) => scanBarcode(q, tokenizer, visitor, STORE_A, FRIDGE));
    if (r.status !== 'found') throw new Error('not found');
    const req = await run((q) => updateProduct(q, visitor, STORE_A, r.product.id, { areaId: AREA_KITCHEN, tagNames: ['#冷蔵庫', '#大型家電', '#新生活'] }));
    assert.equal(req.published, false);
    const unchanged = await run((q) => scanBarcode(q, tokenizer, visitor, STORE_A, FRIDGE));
    if (unchanged.status !== 'found') throw new Error('not found');
    assert.equal(unchanged.product.area?.name, '大型家電', '承認前は変わらない');

    await rejects(run((q) => approveProductChange(q, visitor, req.requestId!)), 'forbidden');
    await run((q) => approveProductChange(q, manager, req.requestId!));
    const changed = await run((q) => scanBarcode(q, tokenizer, visitor, STORE_A, FRIDGE));
    if (changed.status !== 'found') throw new Error('not found');
    assert.equal(changed.product.area?.name, 'キッチン家電');
    assert.ok(changed.product.tags.includes('新生活'));
    const h = await run((q) => productHistory(q, trusted, STORE_A, r.product.id));
    assert.equal(h[0]!.edited_by, '新人バイト');
    await rejects(run((q) => approveProductChange(q, manager, req.requestId!)), 'conflict');
  });

  it('visitor が登録した商品は、本人と承認者にだけ見え、承認後は全員に見える', async () => {
    await run((q) => registerProduct(q, visitor, STORE_A, { janCode: VACUUM, name: 'ロボット掃除機 RX-1', tagNames: ['#ロボット掃除機'] }));
    assert.equal((await run((q) => scanBarcode(q, tokenizer, visitor, STORE_A, VACUUM))).status, 'found');
    const forTrusted = await run((q) => scanBarcode(q, tokenizer, trusted, STORE_A, VACUUM));
    assert.equal(forTrusted.status, 'found', 'trusted は承認者として見える');
    if (forTrusted.status !== 'found') return;
    assert.equal(forTrusted.product.pending, true);
    await run((q) => approveProduct(q, trusted, forTrusted.product.id));
    const approved = await run((q) => scanBarcode(q, tokenizer, visitor, STORE_A, VACUUM));
    assert.equal(approved.status === 'found' && approved.product.pending, false);
  });

  it('同じ JAN は二重に登録できない。商品の削除は administrator のみ', async () => {
    await rejects(run((q) => registerProduct(q, trusted, STORE_A, { janCode: FRIDGE, name: '重複', tagNames: ['#冷蔵庫'] })), 'conflict');
    const r = await run((q) => scanBarcode(q, tokenizer, trusted, STORE_A, VACUUM));
    if (r.status !== 'found') throw new Error('not found');
    await rejects(run((q) => deleteProduct(q, trusted, STORE_A, r.product.id)), 'forbidden');
    // 店長が外せるのは自店舗の売場情報だけ。商品マスタは全店共有なので残る
    assert.deepEqual(await run((q) => deleteProduct(q, manager, STORE_A, r.product.id)), { removed: 'store' });
    assert.equal((await run((q) => scanBarcode(q, tokenizer, trusted, STORE_A, VACUUM))).status, 'found');
    assert.deepEqual(await run((q) => deleteProduct(q, hq, STORE_A, r.product.id)), { removed: 'tenant' });
    assert.equal((await run((q) => scanBarcode(q, tokenizer, trusted, STORE_A, VACUUM))).status, 'unknown');
  });

  it('他店舗の trusted は、別の店舗で登録された承認待ちの商品を見ることも承認することもできない', async () => {
    const code = jan('490000000003');
    await run((q) => registerProduct(q, visitor, STORE_A, { janCode: code, name: '電気ケトル', tagNames: ['#ケトル'] }));
    assert.equal((await run((q) => scanBarcode(q, tokenizer, storeBStaff, STORE_B, code))).status, 'unknown');
    const mine = await run((q) => scanBarcode(q, tokenizer, visitor, STORE_A, code));
    if (mine.status !== 'found') throw new Error('not found');
    await rejects(run((q) => approveProduct(q, storeBStaff, mine.product.id)), 'forbidden');
    await run((q) => approveProduct(q, trusted, mine.product.id));
    assert.equal((await run((q) => scanBarcode(q, tokenizer, storeBStaff, STORE_B, code))).status, 'found');
  });

  it('visitor の商品編集は却下でき、却下後は反映されない', async () => {
    const r = await run((q) => scanBarcode(q, tokenizer, visitor, STORE_A, FRIDGE));
    if (r.status !== 'found') throw new Error('not found');
    const req = await run((q) => updateProduct(q, visitor, STORE_A, r.product.id, { name: 'いたずらの商品名' }));
    await run((q) => rejectProductChange(q, trusted, req.requestId!));
    await rejects(run((q) => approveProductChange(q, trusted, req.requestId!)), 'conflict');
    const after = await run((q) => scanBarcode(q, tokenizer, visitor, STORE_A, FRIDGE));
    assert.equal(after.status === 'found' && after.product.name, '東芝 冷凍冷蔵庫 GR-W600');
  });
});
