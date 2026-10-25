import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import type { PsqlDatabase } from '../src/db/psqlDatabase.ts';
import { DomainError } from '../src/domain/actor.ts';
import {
  approveVersion,
  createKnowledge,
  editKnowledge,
  getKnowledge,
  listPending,
  listVersions,
  rejectVersion,
  revertToVersion,
} from '../src/domain/knowledge.ts';
import { search, zeroHitQueries } from '../src/domain/search.ts';
import { exportDictionary } from '../src/domain/tags.ts';
import { freshDatabase, hq, manager, otherTenant, STORE_A, STORE_B, storeBStaff, T, tokenizer, trusted, visitor } from './helpers.ts';

let db: PsqlDatabase;
const run = <R>(fn: (q: Db) => Promise<R>): Promise<R> => db.withTenant(T, fn);
const ids = (r: { hits: Array<{ id: string }> }) => r.hits.map((h) => h.id);
const rejects = async (p: Promise<unknown>, code: DomainError['code']) => {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code);
};

before(async () => { db = await freshDatabase(); });
after(async () => { await db.close(); });

describe('投稿と承認（visitor / trusted）', () => {
  it('trusted の投稿は即時公開され、すぐ検索に出る', async () => {
    const k = await run((q) => createKnowledge(q, tokenizer, trusted, {
      storeId: STORE_A, title: 'テレビの修理受付', body: 'メーカー保証期間内なら修理は無料。保証書とレシートを確認する。', tagNames: ['#テレビ', '#修理'],
    }));
    assert.equal(k.published, true);
    const r = await run((q) => search(q, tokenizer, trusted, STORE_A, 'テレビ 修理'));
    assert.deepEqual(ids(r), [k.id]);
    assert.equal(r.hits[0]!.verifiedBy, 'ベテランパート');
  });

  it('visitor の投稿は承認待ちで、承認されるまで検索に出ない。新しいタグも承認待ち', async () => {
    const k = await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '冷蔵庫のリサイクル料金', body: '家電リサイクル法の対象。引き取り時にリサイクル料金と収集運搬料金がかかる。', tagNames: ['#冷蔵庫', '#リサイクル'],
    }));
    assert.equal(k.published, false);
    assert.equal((await run((q) => search(q, tokenizer, trusted, STORE_A, 'リサイクル'))).hits.length, 0);
    const dict = await run((q) => exportDictionary(q));
    assert.ok(!dict.tags.some((t) => t.name === 'リサイクル'), '承認前のタグは辞書に入らない');

    const pending = await run((q) => listPending(q, trusted, STORE_A));
    assert.deepEqual(pending.map((p) => p.id), [k.id]);
    await rejects(run((q) => approveVersion(q, tokenizer, visitor, k.id, 1)), 'forbidden');

    await run((q) => approveVersion(q, tokenizer, trusted, k.id, 1));
    assert.deepEqual(ids(await run((q) => search(q, tokenizer, trusted, STORE_A, 'リサイクル'))), [k.id]);
    const dict2 = await run((q) => exportDictionary(q));
    assert.ok(dict2.tags.some((t) => t.name === 'リサイクル'), '承認と同時にタグも有効になる');
  });

  it('ハッシュタグが1つも無い投稿は受け付けない', async () => {
    await rejects(run((q) => createKnowledge(q, tokenizer, trusted, { storeId: STORE_A, title: 'メモ', body: '本文', tagNames: [] })), 'invalid');
  });

  it('全店共通のナレッジは本部だけが作れ、どの店舗からも検索できる', async () => {
    await rejects(run((q) => createKnowledge(q, tokenizer, manager, { storeId: null, title: '全店共通', body: 'x', tagNames: ['#全店'] })), 'forbidden');
    const k = await run((q) => createKnowledge(q, tokenizer, hq, {
      storeId: null, title: '延長保証の加入条件', body: '購入から30日以内なら加入できる。', tagNames: ['#延長保証'],
    }));
    assert.deepEqual(ids(await run((q) => search(q, tokenizer, storeBStaff, STORE_B, '延長保証'))), [k.id]);
  });
});

describe('編集と版', () => {
  let id: string;

  it('trusted の編集は新しい版として即時公開され、古い版は過去版として残る', async () => {
    const k = await run((q) => createKnowledge(q, tokenizer, trusted, {
      storeId: STORE_A, title: '搬入の確認事項', body: '玄関の幅を確認する。', tagNames: ['#搬入'],
    }));
    id = k.id;
    await run((q) => editKnowledge(q, tokenizer, trusted, id, {
      title: '搬入の確認事項', body: 'マンションはエレベーターの寸法も確認する。', tagNames: ['#搬入', '#冷蔵庫'],
    }));
    const v = await run((q) => getKnowledge(q, trusted, id));
    assert.equal(v.version, 2);
    assert.deepEqual(v.tags, ['搬入', '冷蔵庫']);
    const versions = await run((q) => listVersions(q, trusted, id));
    assert.deepEqual(versions.map((x) => [x.version, x.state]), [[2, 'published'], [1, 'superseded']]);
    // 索引も新しい版に置き換わる
    assert.deepEqual(ids(await run((q) => search(q, tokenizer, trusted, STORE_A, 'エレベーター'))), [id]);
    assert.equal((await run((q) => search(q, tokenizer, trusted, STORE_A, '玄関'))).hits.length, 0);
  });

  it('visitor の編集は修正案になり、承認されるまで公開中の内容は変わらない', async () => {
    const r = await run((q) => editKnowledge(q, tokenizer, visitor, id, {
      title: '搬入の確認事項', body: 'マンションはエレベーターの寸法も確認する。階段の場合は2名で。', tagNames: ['#搬入'],
    }));
    assert.equal(r.published, false);
    assert.equal((await run((q) => search(q, tokenizer, trusted, STORE_A, '階段'))).hits.length, 0);
    assert.deepEqual((await run((q) => getKnowledge(q, trusted, id))).pendingVersions, [3]);
    await run((q) => approveVersion(q, tokenizer, manager, id, 3));
    assert.deepEqual(ids(await run((q) => search(q, tokenizer, trusted, STORE_A, '階段'))), [id]);
  });

  it('古い修正案は、より新しい版が公開された後には承認できない', async () => {
    const stale = await run((q) => editKnowledge(q, tokenizer, visitor, id, { title: '搬入', body: '古い修正案', tagNames: ['#搬入'] }));
    await run((q) => editKnowledge(q, tokenizer, trusted, id, { title: '搬入の確認事項', body: '最新の内容', tagNames: ['#搬入'] }));
    await rejects(run((q) => approveVersion(q, tokenizer, trusted, id, stale.version)), 'conflict');
    await run((q) => rejectVersion(q, trusted, id, stale.version));
  });

  it('過去版に戻すと、その内容で新しい版が作られる（履歴は消えない）', async () => {
    const r = await run((q) => revertToVersion(q, tokenizer, trusted, id, 1));
    const v = await run((q) => getKnowledge(q, trusted, id));
    assert.equal(v.version, r.version);
    assert.equal(v.body, '玄関の幅を確認する。');
    const versions = await run((q) => listVersions(q, trusted, id));
    assert.equal(versions.length, r.version);
  });
});

describe('検索の範囲と並び順', () => {
  it('他の店舗のナレッジは検索に出ない', async () => {
    const b = await db.withTenant(T, (q) => createKnowledge(q, tokenizer, storeBStaff, {
      storeId: STORE_B, title: '駅前店のテレビ売場', body: 'テレビは2階。', tagNames: ['#テレビ'],
    }));
    const r = await run((q) => search(q, tokenizer, trusted, STORE_A, 'テレビ'));
    assert.ok(!ids(r).includes(b.id));
    await rejects(run((q) => search(q, tokenizer, trusted, STORE_B, 'テレビ')), 'forbidden');
  });

  it('他社のデータは行レベルセキュリティで見えない', async () => {
    const r = await db.withTenant(otherTenant.tenantId, (q) => q.query(`SELECT count(*)::int AS n FROM knowledge`));
    assert.equal(r[0]!.n, 0);
  });

  it('承認済みの同義タグで、#エアコン から #クーラー のナレッジに届く', async () => {
    const k = await run((q) => createKnowledge(q, tokenizer, trusted, {
      storeId: STORE_A, title: 'クーラーの取り付け工事', body: '室外機の置き場所を確認する。', tagNames: ['#クーラー'],
    }));
    await run((q) => createKnowledge(q, tokenizer, trusted, {
      storeId: STORE_A, title: 'エアコンの掃除', body: 'フィルターは2週間に1回。', tagNames: ['#エアコン'],
    }));
    const before = await run((q) => search(q, tokenizer, trusted, STORE_A, '#エアコン'));
    assert.ok(!ids(before).includes(k.id));
    await run((q) => q.query(
      `INSERT INTO tag_relations (tenant_id, kind, from_tag_id, to_tag_id, state)
       SELECT $1, 'synonym', a.id, c.id, 'approved' FROM hashtags a, hashtags c WHERE a.name = 'エアコン' AND c.name = 'クーラー'`,
      [T],
    ));
    const after = await run((q) => search(q, tokenizer, trusted, STORE_A, '#エアコン'));
    assert.ok(ids(after).includes(k.id));
    assert.equal(after.hits[0]!.title, 'エアコンの掃除', '直接タグが付いたものが上');
  });

  it('結果に付いているタグを絞り込みチップとして返す', async () => {
    const r = await run((q) => search(q, tokenizer, trusted, STORE_A, '冷蔵庫'));
    assert.ok(r.chips.some((c) => c.name === 'リサイクル' || c.name === '搬入'));
    assert.ok(!r.chips.some((c) => c.name === '冷蔵庫'), '検索したタグ自身はチップに出さない');
  });

  it('0件だった検索ワードを集計できる', async () => {
    await run((q) => search(q, tokenizer, visitor, STORE_A, '食洗機 分岐水栓'));
    await run((q) => search(q, tokenizer, visitor, STORE_A, '食洗機 分岐水栓'));
    const z = await run((q) => zeroHitQueries(q, trusted, STORE_A));
    assert.deepEqual(z.map((x) => [x.query, x.times]).slice(0, 1), [['食洗機 分岐水栓', 2]]);
  });
});
