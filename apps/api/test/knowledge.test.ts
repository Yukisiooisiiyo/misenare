import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import { DomainError } from '../src/domain/actor.ts';
import {
  approveVersion,
  createKnowledge,
  editKnowledge,
  getKnowledge,
  listPending,
  listVersions,
  deleteKnowledge,
  rejectVersion,
  revertToVersion,
} from '../src/domain/knowledge.ts';
import { addBookmark } from '../src/domain/bookmarks.ts';
import { finishPhotoUpload, listPhotos, receivePhoto, startPhotoUpload } from '../src/domain/photos.ts';
import { LocalStorage } from '../src/storage/storage.ts';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSearchFeedback, search, zeroHitQueries } from '../src/domain/search.ts';
import { exportDictionary, invalidateDictionary } from '../src/domain/tags.ts';
import { freshDatabase, hq, manager, otherTenant, STORE_A, STORE_B, storeBStaff, T, tokenizer, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
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
    assert.ok(!Number.isNaN(Date.parse(r.hits[0]!.updatedAt.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'))), '最終更新日を返す');
  });

  it('visitor の投稿は承認待ちで、承認されるまで検索に出ない。新しいタグも承認待ち', async () => {
    const k = await run((q) => createKnowledge(q, tokenizer, visitor, {
      storeId: STORE_A, title: '冷蔵庫のリサイクル料金', body: '家電リサイクル法の対象。引き取り時にリサイクル料金と収集運搬料金がかかる。', tagNames: ['#冷蔵庫', '#リサイクル'],
    }));
    assert.equal(k.published, false);
    assert.equal((await run((q) => search(q, tokenizer, trusted, STORE_A, 'リサイクル'))).hits.length, 0);
    const dict = await run((q) => exportDictionary(q, trusted, STORE_A));
    assert.ok(!dict.tags.some((t) => t.name === 'リサイクル'), '承認前のタグは辞書に入らない');

    const pending = await run((q) => listPending(q, trusted, STORE_A));
    assert.deepEqual(pending.map((p) => p.id), [k.id]);
    await rejects(run((q) => approveVersion(q, tokenizer, visitor, k.id, 1)), 'forbidden');

    await run((q) => approveVersion(q, tokenizer, trusted, k.id, 1));
    assert.deepEqual(ids(await run((q) => search(q, tokenizer, trusted, STORE_A, 'リサイクル'))), [k.id]);
    const dict2 = await run((q) => exportDictionary(q, trusted, STORE_A));
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
    const pend = (await run((q) => getKnowledge(q, trusted, id))).pendingEdits;
    assert.deepEqual(pend.map((p) => p.version), [3]);
    assert.equal(pend[0]!.editedBy, '新人バイト');
    await run((q) => approveVersion(q, tokenizer, manager, id, 3));
    assert.deepEqual(ids(await run((q) => search(q, tokenizer, trusted, STORE_A, '階段'))), [id]);
  });

  it('古い修正案は、より新しい版が公開された後には承認できない', async () => {
    const stale = await run((q) => editKnowledge(q, tokenizer, visitor, id, { title: '搬入', body: '古い修正案', tagNames: ['#搬入'] }));
    await run((q) => editKnowledge(q, tokenizer, trusted, id, { title: '搬入の確認事項', body: '最新の内容', tagNames: ['#搬入'] }));
    await rejects(run((q) => approveVersion(q, tokenizer, trusted, id, stale.version)), 'conflict');
    // 新しい版の公開と同時に、古い修正案は過去版になり、承認待ちの一覧から消える
    const pending = await run((q) => listPending(q, trusted, STORE_A));
    assert.ok(!pending.some((p) => p.id === id));
  });

  it('visitor の修正案は却下できる', async () => {
    const r = await run((q) => editKnowledge(q, tokenizer, visitor, id, { title: '搬入', body: '却下される案', tagNames: ['#搬入'] }));
    await run((q) => rejectVersion(q, trusted, id, r.version));
    await rejects(run((q) => rejectVersion(q, trusted, id, r.version)), 'conflict');
  });

  it('visitor は期限を使って、承認なしに公開中のナレッジを隠せない', async () => {
    await run((q) => editKnowledge(q, tokenizer, visitor, id, {
      title: '搬入の確認事項', body: '最新の内容', tagNames: ['#搬入'], expiresAt: '2000-01-01T00:00:00Z',
    }));
    assert.deepEqual(ids(await run((q) => search(q, tokenizer, trusted, STORE_A, '#搬入'))), [id]);
  });

  // 承認待ちは**全員に見せる**。隠すと、同じところを2人が別々に直して、
  // 承認のときに片方が黙って消える（approvals.test.ts の「2人が同時に直したとき」）。
  // 却下された案だけは、書いた本人と承認できる人に限る。
  it('承認待ちの案は全員が読めるが、却下された案は本人と承認者だけ', async () => {
    const stranger = { ...visitor, userId: '40000000-0000-0000-0000-000000000002', trustLevel: 'visitor' as const };
    const forStranger = await run((q) => listVersions(q, stranger, id));
    assert.ok(forStranger.some((v) => v.state === 'pending'), '承認待ちは他人にも見える');
    assert.ok(forStranger.every((v) => v.state !== 'rejected'), '却下された案は見えない');
    const forOwner = await run((q) => listVersions(q, visitor, id));
    assert.ok(forOwner.some((v) => v.state === 'rejected'), '書いた本人には見える');
  });

  it('一度も公開されていない投稿の版は、書いた本人と承認者にしか見えない（getKnowledge と同じ）', async () => {
    const draft = await run((q) => createKnowledge(q, tokenizer, visitor, { storeId: STORE_A, title: '下書き', body: '誰にも見せない本文', tagNames: ['#下書き'] }));
    const stranger = { ...visitor, userId: '40000000-0000-0000-0000-000000000002', trustLevel: 'visitor' as const };
    await rejects(run((q) => listVersions(q, stranger, draft.id)), 'forbidden');
    assert.ok((await run((q) => listVersions(q, visitor, draft.id))).length === 1, '本人は見える');
    assert.ok((await run((q) => listVersions(q, trusted, draft.id))).length === 1, '承認者は見える');
  });

  it('承認待ち・却下の案には「戻す」で公開できない', async () => {
    const pend = (await run((q) => listVersions(q, trusted, id))).find((v) => v.state === 'pending')!;
    await rejects(run((q) => revertToVersion(q, tokenizer, trusted, id, pend.version)), 'conflict');
  });

  it('最終更新日は内容を変えた日、確認日は「今も正しい」とした日で、別々に返す', async () => {
    await run((q) => q.query(`UPDATE knowledge_versions SET edited_at = now() - interval '400 days' WHERE knowledge_id = $1 AND state = 'published'`, [id]));
    const before = await run((q) => getKnowledge(q, trusted, id));
    assert.ok(Date.now() - Date.parse(before.updatedAt.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')) > 399 * 86_400_000);
    assert.equal(before.updatedBy, 'ベテランパート');
    const hit = (await run((q) => search(q, tokenizer, trusted, STORE_A, '#搬入'))).hits.find((h) => h.id === id)!;
    assert.equal(hit.updatedAt, before.updatedAt);
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

  it('入れない店舗のナレッジを、開いた記録に結びつけられない', async () => {
    const b = await db.withTenant(T, (q) => createKnowledge(q, tokenizer, storeBStaff, {
      storeId: STORE_B, title: '駅前店の鍵の保管', body: '事務所の金庫。', tagNames: ['#鍵'],
    }));
    // 自社のナレッジなので存在確認は通るが、STORE_A の人は STORE_B に入れない
    await rejects(run((q) => recordSearchFeedback(q, trusted, 1, { openedKnowledgeId: b.id })), 'forbidden');
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
    // SQL で直接書いたので、辞書のキャッシュは自分で捨てる（画面の操作なら承認の関数が捨てる）
    invalidateDictionary(T);
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

  it('記録しない検索（入力中のライブ検索）は 0件ワードに残さない', async () => {
    // record:false は打ちかけの語なので、ログID も付けず集計にも出さない
    const r = await run((q) => search(q, tokenizer, visitor, STORE_A, 'ぜったいにでてこない語', { record: false }));
    assert.equal(r.logId, null, '記録しない検索はログIDを返さない');
    const z = await run((q) => zeroHitQueries(q, trusted, STORE_A));
    assert.ok(!z.some((x) => x.query === 'ぜったいにでてこない語'), '記録しない検索は0件ワードに出ない');
  });
});

describe('「古い」の日数は1か所で決める', () => {
  it('一覧・夜間バッチ・画面の注意書きが、同じ日数と同じ見方をする', async () => {
    const { STALE_DAYS, listStale, verifyKnowledge } = await import('../src/domain/knowledge.ts');
    assert.equal(STALE_DAYS, 180);
    const k = await db.withTenant(T, (q) =>
      createKnowledge(q, tokenizer, trusted, { storeId: STORE_A, title: '日数の確認', body: '本文', tagNames: ['#日数'] }));

    await db.withTenant(T, async (q) => {
      // 確認だけ古い（内容は今日直した）＝ まだ古くない
      await q.query(`UPDATE knowledge SET verified_at = now() - interval '${STALE_DAYS + 20} days' WHERE id = $1`, [k.id]);
      assert.ok(!(await listStale(q, manager, STORE_A)).some((x) => x.id === k.id), '更新が新しければ出さない');

      // 更新も確認も古い ＝ 古い
      await q.query(`UPDATE knowledge_versions SET edited_at = now() - interval '${STALE_DAYS + 20} days' WHERE knowledge_id = $1`, [k.id]);
      assert.ok((await listStale(q, manager, STORE_A)).some((x) => x.id === k.id));

      // 境目の手前では出さない
      await q.query(`UPDATE knowledge SET verified_at = now() - interval '${STALE_DAYS - 2} days' WHERE id = $1`, [k.id]);
      assert.ok(!(await listStale(q, manager, STORE_A)).some((x) => x.id === k.id));

      // 「今も正しい」を押せば外れる
      await q.query(`UPDATE knowledge SET verified_at = now() - interval '${STALE_DAYS + 20} days' WHERE id = $1`, [k.id]);
      assert.ok((await listStale(q, manager, STORE_A)).some((x) => x.id === k.id));
      await verifyKnowledge(q, manager, k.id);
      assert.ok(!(await listStale(q, manager, STORE_A)).some((x) => x.id === k.id));
    });
  });

  it('画面にも同じ日数を配る（/me の staleDays）', async () => {
    const { me } = await import('../src/domain/users.ts');
    const { STALE_DAYS } = await import('../src/domain/knowledge.ts');
    const who = await db.withTenant(T, (q) => me(q, trusted));
    assert.equal(who.staleDays, STALE_DAYS);
  });
});

describe('ナレッジを消す', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  let storage: LocalStorage;
  let dir: string;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'misenare-delete-')); storage = new LocalStorage(dir); });
  const post = (actor: typeof trusted, title: string, storeId: string | null = STORE_A) =>
    run((q) => createKnowledge(q, tokenizer, actor, { storeId, title, body: 'お客様の電話番号 090-0000-0000（書いてはいけなかった）', tagNames: ['#消す'] }));
  const gone = async (id: string) => {
    for (const who of [visitor, trusted, manager, hq]) await rejects(run((q) => getKnowledge(q, who, id)), 'not_found');
    assert.equal((await run((q) => q.query(`SELECT 1 FROM knowledge_versions WHERE knowledge_id = $1`, [id]))).length, 0, '過去の版も残らない');
  };

  it('店長は、自店舗のナレッジを消せる。過去の版・写真・ブックマークも一緒に消える', async () => {
    const k = await post(trusted, '個人情報を書いてしまった');
    await run((q) => editKnowledge(q, tokenizer, trusted, k.id, { title: '個人情報を書いてしまった', body: '直した本文', tagNames: ['#消す'], baseVersion: 1 }));
    const photo = await run(async (q) => {
      const plan = await startPhotoUpload(q, storage, trusted, k.id, { contentType: 'image/jpeg', bytes: JPEG.byteLength });
      await receivePhoto(q, storage, trusted, plan.photoId, JPEG, 'image/jpeg');
      await finishPhotoUpload(q, storage, trusted, plan.photoId);
      return plan.photoId;
    });
    await run((q) => addBookmark(q, visitor, k.id));
    await readFile(join(dir, T, k.id, `${photo}.jpg`));
    // 直しただけでは、前の版が履歴に残る（だから消す口が要る）
    const versions = await run((q) => listVersions(q, visitor, k.id));
    assert.ok(versions.some((v) => v.body.includes('090-0000-0000')));

    assert.equal((await run((q) => getKnowledge(q, manager, k.id))).canDelete, true);
    assert.deepEqual(await run((q) => deleteKnowledge(q, storage, manager, k.id)), { ok: true });
    await gone(k.id);
    await rejects(run((q) => listPhotos(q, storage, manager, k.id)), 'not_found');
    await assert.rejects(readFile(join(dir, T, k.id, `${photo}.jpg`)), /ENOENT/, '写真の実体も消える');
    assert.equal((await run((q) => q.query(`SELECT 1 FROM knowledge_bookmarks WHERE knowledge_id = $1`, [k.id]))).length, 0);
    assert.deepEqual(ids(await run((q) => search(q, tokenizer, trusted, STORE_A, '#消す'))), [], '検索にも出ない');
  });

  it('書いた本人は、公開から間もなく、ほかの人の手が入っていないものなら自分で消せる', async () => {
    const k = await post(trusted, 'すぐ気づいた書き間違い');
    assert.equal((await run((q) => getKnowledge(q, trusted, k.id))).canDelete, true);
    assert.equal((await run((q) => getKnowledge(q, visitor, k.id))).canDelete, false, 'ほかの人には消せない');
    await rejects(run((q) => deleteKnowledge(q, storage, visitor, k.id)), 'forbidden');
    await run((q) => deleteKnowledge(q, storage, trusted, k.id));
    await gone(k.id);
  });

  it('時間が経ったもの・ほかの人が直したものは、書いた本人でも消せない（店長・本部だけ）', async () => {
    const old = await post(trusted, '前からあるナレッジ');
    await run((q) => q.query(`UPDATE knowledge SET created_at = now() - interval '2 days' WHERE id = $1`, [old.id]));
    assert.equal((await run((q) => getKnowledge(q, trusted, old.id))).canDelete, false);
    await rejects(run((q) => deleteKnowledge(q, storage, trusted, old.id)), 'forbidden');

    const shared = await post(trusted, 'みんなで直したナレッジ');
    await run((q) => editKnowledge(q, tokenizer, manager, shared.id, { title: 'みんなで直したナレッジ', body: '店長が直した', tagNames: ['#消す'], baseVersion: 1 }));
    await rejects(run((q) => deleteKnowledge(q, storage, trusted, shared.id)), 'forbidden');

    // 店長と本部は消せる
    await run((q) => deleteKnowledge(q, storage, manager, old.id));
    await run((q) => deleteKnowledge(q, storage, hq, shared.id));
    await gone(old.id);
    await gone(shared.id);
  });

  it('新人は、まだ公開されていない自分の投稿を取り下げられる（却下されたものも）', async () => {
    const waiting = await post(visitor, '承認待ちの投稿');
    assert.equal((await run((q) => getKnowledge(q, visitor, waiting.id))).canDelete, true);
    await run((q) => deleteKnowledge(q, storage, visitor, waiting.id));
    await gone(waiting.id);

    const rejected = await post(visitor, '却下された投稿');
    await run((q) => rejectVersion(q, trusted, rejected.id, 1));
    await run((q) => q.query(`UPDATE knowledge SET created_at = now() - interval '30 days' WHERE id = $1`, [rejected.id]));
    await run((q) => deleteKnowledge(q, storage, visitor, rejected.id));
    await gone(rejected.id);
  });

  it('全店共通は本部だけ。他店舗の店長・他社からは消せない', async () => {
    const all = await post(hq, '全店共通のナレッジ', null);
    await rejects(run((q) => deleteKnowledge(q, storage, manager, all.id)), 'forbidden');
    assert.equal((await run((q) => getKnowledge(q, manager, all.id))).canDelete, false);

    const b = await run((q) => createKnowledge(q, tokenizer, storeBStaff, { storeId: STORE_B, title: '駅前店のナレッジ', body: '本文', tagNames: ['#消す'] }));
    await rejects(run((q) => deleteKnowledge(q, storage, manager, b.id)), 'forbidden');
    await rejects(db.withTenant(otherTenant.tenantId, (q) => deleteKnowledge(q, storage, otherTenant, b.id)), 'not_found');
    assert.equal((await run((q) => getKnowledge(q, storeBStaff, b.id))).title, '駅前店のナレッジ', '消えていない');

    await run((q) => deleteKnowledge(q, storage, hq, all.id));
    await gone(all.id);
  });
});
