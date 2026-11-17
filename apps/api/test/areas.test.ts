// 売場（店舗の中の場所の名前）と、商品の一覧・紐づけを外す・履歴の売場の名前。

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import { DomainError } from '../src/domain/actor.ts';
import { createArea, deleteArea, listAreas, MAX_AREA_NAME, renameArea } from '../src/domain/areas.ts';
import { createKnowledge, editKnowledge, getKnowledge } from '../src/domain/knowledge.ts';
import {
  linkKnowledgeToProduct, listProducts, productHistory, registerProduct, scanBarcode, unlinkKnowledgeFromProduct, updateProduct,
} from '../src/domain/products.ts';
import { AREA_BIG, AREA_KITCHEN, freshDatabase, hq, jan, manager, STORE_A, STORE_B, storeBStaff, T, tokenizer, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
const run = <R>(fn: (q: Db) => Promise<R>): Promise<R> => db.withTenant(T, fn);
const rejects = async (p: Promise<unknown>, code: DomainError['code']) => {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code);
};

before(async () => { db = await freshDatabase(); });
after(async () => { await db.close(); });

describe('売場', () => {
  it('その店舗の人ならだれでも一覧を見られる。他店の人には見せない', async () => {
    const list = await run((q) => listAreas(q, visitor, STORE_A));
    assert.deepEqual(list.map((a) => [a.name, a.products]), [['キッチン家電', 0], ['大型家電', 0]]);
    await rejects(run((q) => listAreas(q, storeBStaff, STORE_A)), 'forbidden');
    assert.deepEqual(await run((q) => listAreas(q, storeBStaff, STORE_B)), []);
  });

  it('作れるのは店長と本部。同じ名前は作らず、空や長すぎる名前は断る', async () => {
    await rejects(run((q) => createArea(q, trusted, STORE_A, '修理受付')), 'forbidden');
    await rejects(run((q) => createArea(q, visitor, STORE_A, '修理受付')), 'forbidden');
    const made = await run((q) => createArea(q, manager, STORE_A, '  修理　受付 '));
    assert.ok(made.id);
    assert.ok((await run((q) => listAreas(q, visitor, STORE_A))).some((a) => a.name === '修理 受付'), '前後と途中の空白はそろえる');
    await rejects(run((q) => createArea(q, manager, STORE_A, '修理 受付')), 'conflict');
    await rejects(run((q) => createArea(q, manager, STORE_A, '')), 'invalid');
    await rejects(run((q) => createArea(q, manager, STORE_A, 'あ'.repeat(MAX_AREA_NAME + 1))), 'invalid');
    // 店長は、自分の店舗にだけ作れる。本部はどの店舗にも作れる
    await rejects(run((q) => createArea(q, manager, STORE_B, '入口')), 'forbidden');
    await run((q) => createArea(q, hq, STORE_B, '入口'));
    assert.deepEqual((await run((q) => listAreas(q, storeBStaff, STORE_B))).map((a) => a.name), ['入口']);
  });

  it('名前を変えられる。ほかの売場と同じ名前にはできない', async () => {
    await run((q) => renameArea(q, manager, AREA_BIG, '大型家電（1階）'));
    assert.ok((await run((q) => listAreas(q, visitor, STORE_A))).some((a) => a.name === '大型家電（1階）'));
    await rejects(run((q) => renameArea(q, manager, AREA_BIG, 'キッチン家電')), 'conflict');
    await rejects(run((q) => renameArea(q, trusted, AREA_BIG, '大型')), 'forbidden');
    await rejects(run((q) => renameArea(q, manager, '30000000-0000-0000-0000-00000000dead', '無い')), 'not_found');
    await run((q) => renameArea(q, manager, AREA_BIG, '大型家電'));
  });

  it('消すと、その売場の商品は「売場：未登録」に戻り、ナレッジの売場の印は出なくなる（どちらも消えない）', async () => {
    const area = await run((q) => createArea(q, manager, STORE_A, '期間限定コーナー'));
    const code = jan('490000000777');
    await run((q) => registerProduct(q, trusted, STORE_A, { janCode: code, name: '季節の家電', areaId: area.id, tagNames: ['#季節'] }));
    const k = await run((q) => createKnowledge(q, tokenizer, trusted, { storeId: STORE_A, title: '季節コーナーの並べ方', body: '本文', tagNames: ['#季節'], areaIds: [area.id, AREA_KITCHEN] }));
    assert.deepEqual((await run((q) => getKnowledge(q, visitor, k.id))).areas.map((a) => a.name), ['キッチン家電', '期間限定コーナー']);
    assert.equal((await run((q) => listAreas(q, visitor, STORE_A))).find((a) => a.id === area.id)!.products, 1);

    await rejects(run((q) => deleteArea(q, trusted, area.id)), 'forbidden');
    assert.deepEqual(await run((q) => deleteArea(q, manager, area.id)), { ok: true, products: 1 });
    const scanned = await run((q) => scanBarcode(q, tokenizer, visitor, STORE_A, code));
    assert.ok(scanned.status === 'found' && scanned.product.area === null && scanned.product.name === '季節の家電');
    assert.deepEqual((await run((q) => getKnowledge(q, visitor, k.id))).areas.map((a) => a.name), ['キッチン家電']);
  });

  it('ナレッジを直すときに売場を送らなければ、いまの売場を引き継ぐ。空の配列を送れば外れる', async () => {
    const k = await run((q) => createKnowledge(q, tokenizer, trusted, { storeId: STORE_A, title: '炊飯器の試食', body: '本文', tagNames: ['#炊飯器'], areaIds: [AREA_KITCHEN] }));
    await run((q) => editKnowledge(q, tokenizer, trusted, k.id, { title: '炊飯器の試食', body: '直した', tagNames: ['#炊飯器'] }));
    assert.deepEqual((await run((q) => getKnowledge(q, visitor, k.id))).areas.map((a) => a.name), ['キッチン家電']);
    await run((q) => editKnowledge(q, tokenizer, trusted, k.id, { title: '炊飯器の試食', body: '直した', tagNames: ['#炊飯器'], areaIds: [] }));
    assert.deepEqual((await run((q) => getKnowledge(q, visitor, k.id))).areas, []);
    // 他店の売場や、全店共通のナレッジには付けられない
    const other = await run((q) => listAreas(q, storeBStaff, STORE_B));
    await rejects(run((q) => editKnowledge(q, tokenizer, trusted, k.id, { title: '炊飯器の試食', body: '直した', tagNames: ['#炊飯器'], areaIds: [other[0]!.id] })), 'invalid');
    await rejects(run((q) => createKnowledge(q, tokenizer, hq, { storeId: null, title: '全店の話', body: '本文', tagNames: ['#全店'], areaIds: [AREA_KITCHEN] })), 'invalid');
  });
});

describe('商品の一覧・紐づけ・履歴', () => {
  const A = jan('490000000101');
  const B = jan('490000000102');
  const C = jan('490000000103');
  let a = '';

  before(async () => {
    a = (await run((q) => registerProduct(q, trusted, STORE_A, { janCode: A, name: 'ドラム式洗濯機 TW-100', maker: 'サンプル電機', areaId: AREA_BIG, tagNames: ['#洗濯機'] }))).id;
    await run((q) => registerProduct(q, trusted, STORE_A, { janCode: B, name: '冷蔵庫 RF_500%', maker: 'ミセナレ製作所', tagNames: ['#冷蔵庫'] }));
    // 新人が登録したものは承認待ち
    await run((q) => registerProduct(q, visitor, STORE_A, { janCode: C, name: '承認待ちの掃除機', tagNames: ['#掃除機'] }));
  });

  it('登録済みの商品を名前順で一覧でき、この店舗の売場が付く。承認待ちは出さない', async () => {
    const { items, next } = await run((q) => listProducts(q, visitor, STORE_A));
    const mine = items.filter((p) => [A, B, C].includes(p.janCode));
    assert.deepEqual(mine.map((p) => [p.name, p.maker, p.area]), [
      ['ドラム式洗濯機 TW-100', 'サンプル電機', '大型家電'], ['冷蔵庫 RF_500%', 'ミセナレ製作所', null],
    ]);
    assert.equal(next, null);
    // 別の店舗から見ると、商品は同じで、売場はその店舗のもの（未登録）
    const fromB = await run((q) => listProducts(q, storeBStaff, STORE_B));
    assert.equal(fromB.items.find((p) => p.janCode === A)!.area, null);
    await rejects(run((q) => listProducts(q, storeBStaff, STORE_A)), 'forbidden');
  });

  it('商品名・メーカー名の一部と、JAN の頭から絞れる。記号は文字として探す', async () => {
    const names = async (q: string) => (await run((d) => listProducts(d, visitor, STORE_A, { q }))).items.map((p) => p.name);
    assert.deepEqual(await names('洗濯'), ['ドラム式洗濯機 TW-100']);
    assert.deepEqual(await names('tw-100'), ['ドラム式洗濯機 TW-100'], '大文字小文字は区別しない');
    assert.deepEqual(await names('ミセナレ'), ['冷蔵庫 RF_500%']);
    assert.deepEqual(await names(A.slice(0, 12)), ['ドラム式洗濯機 TW-100']);
    assert.deepEqual(await names(A.slice(0, 10)), ['ドラム式洗濯機 TW-100', '冷蔵庫 RF_500%'], '頭の10桁が同じ2つ');
    assert.deepEqual(await names(A.slice(3, 12)), [], 'JAN は、途中からは探さない');
    assert.deepEqual(await names('%'), ['冷蔵庫 RF_500%'], '% は「何でも」ではなく、% という文字');
    assert.deepEqual(await names('RF_5'), ['冷蔵庫 RF_500%']);
    assert.deepEqual(await names('RFx5'), [], '_ は「どの1文字でも」ではない');
    assert.deepEqual(await names('どこにも無い名前'), []);
  });

  it('50件ずつで、続きを読める', async () => {
    await run(async (q) => {
      for (let i = 0; i < 55; i++) {
        await q.query(
          `INSERT INTO products (tenant_id, jan_code, name, state, origin_store_id, created_by) VALUES ($1, $2, $3, 'active', $4, $5)`,
          [T, jan(`4911111${String(i).padStart(5, '0')}`), `量産の商品 ${String(i).padStart(2, '0')}`, STORE_A, trusted.userId],
        );
      }
    });
    const page1 = await run((q) => listProducts(q, visitor, STORE_A, { q: '量産の商品' }));
    assert.equal(page1.items.length, 50);
    assert.equal(page1.next, 50);
    const page2 = await run((q) => listProducts(q, visitor, STORE_A, { q: '量産の商品', offset: page1.next! }));
    assert.deepEqual(page2.items.map((p) => p.name), ['量産の商品 50', '量産の商品 51', '量産の商品 52', '量産の商品 53', '量産の商品 54']);
    assert.equal(page2.next, null);
  });

  it('ナレッジとの紐づけを外せる。外せるのは、紐づけられる人と同じ', async () => {
    const k = await run((q) => createKnowledge(q, tokenizer, trusted, { storeId: STORE_A, title: '洗濯機の搬入', body: '本文', tagNames: ['#搬入経路'] }));
    await run((q) => linkKnowledgeToProduct(q, trusted, k.id, a));
    const linked = async () => {
      const r = await run((q) => scanBarcode(q, tokenizer, visitor, STORE_A, A));
      return r.status === 'found' ? r.related.filter((h) => h.linked).map((h) => h.id) : [];
    };
    assert.deepEqual(await linked(), [k.id]);
    await rejects(run((q) => unlinkKnowledgeFromProduct(q, visitor, k.id, a)), 'forbidden');
    await rejects(run((q) => unlinkKnowledgeFromProduct(q, storeBStaff, k.id, a)), 'forbidden');
    await run((q) => unlinkKnowledgeFromProduct(q, trusted, k.id, a));
    assert.deepEqual(await linked(), []);
    await run((q) => unlinkKnowledgeFromProduct(q, trusted, k.id, a)); // 2回目も落ちない
    // 全店共通のナレッジは、本部だけ
    const all = await run((q) => createKnowledge(q, tokenizer, hq, { storeId: null, title: '全店の搬入ルール', body: '本文', tagNames: ['#搬入経路'] }));
    await run((q) => linkKnowledgeToProduct(q, hq, all.id, a));
    await rejects(run((q) => unlinkKnowledgeFromProduct(q, manager, all.id, a)), 'forbidden');
    await run((q) => unlinkKnowledgeFromProduct(q, hq, all.id, a));
    await rejects(run((q) => unlinkKnowledgeFromProduct(q, trusted, '50000000-0000-0000-0000-00000000dead', a)), 'not_found');
  });

  it('履歴の売場は、名前で読める（消した売場は名前なし）', async () => {
    const temp = await run((q) => createArea(q, manager, STORE_A, '仮の置き場'));
    await run((q) => updateProduct(q, trusted, STORE_A, a, { areaId: temp.id }));
    await run((q) => updateProduct(q, trusted, STORE_A, a, { areaId: AREA_KITCHEN }));
    await run((q) => deleteArea(q, manager, temp.id));
    const rows = (await run((q) => productHistory(q, visitor, STORE_A, a))).filter((r) => r.field === 'area');
    assert.deepEqual(rows.map((r) => [r.before_name, r.after_name]), [[null, 'キッチン家電'], ['大型家電', null]]);
  });
});
