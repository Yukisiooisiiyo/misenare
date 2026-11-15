// ブックマーク・引き継ぎのラベル・個人メモ。
//
// 確かめたいのは
//   ・ブックマークの数は書いた本人にしか見えない。自分のものには付けられない
//   ・ラベルは店がその場で作れて、候補に出る。付けなくても今までどおり
//   ・個人メモは本人にしか読めない・触れない。「今日だけ」は翌日に出なくなり、夜間に消える

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { addBookmark, listBookmarks, removeBookmark } from '../src/domain/bookmarks.ts';
import { addHandover, cleanLabels, handoverLabels, listHandovers } from '../src/domain/handovers.ts';
import { createKnowledge, getKnowledge } from '../src/domain/knowledge.ts';
import { addMemo, deleteMemo, listMemos, sweepTodayMemos, updateMemo } from '../src/domain/memos.ts';
import { createApp } from '../src/http/app.ts';
import { DevHeaderAuthenticator } from '../src/http/auth.ts';
import { MemoryRateLimiter } from '../src/http/rateLimit.ts';
import { freshDatabase, hq, manager, STORE_A, STORE_B, storeBStaff, T, tokenizer, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

describe('ブックマーク', () => {
  let db: TestDatabase;
  let k = '';
  let pending = '';
  before(async () => {
    db = await freshDatabase();
    await db.withTenant(T, async (q) => {
      k = (await createKnowledge(q, tokenizer, trusted, { storeId: STORE_A, title: '領収書の宛名', body: 'メモを見て打つ', tagNames: ['レジ'] })).id;
      pending = (await createKnowledge(q, tokenizer, visitor, { storeId: STORE_A, title: '承認待ち', body: 'まだ', tagNames: ['レジ'] })).id;
    });
  });
  after(async () => { await db.close(); });

  it('ほかの人が書いたものに付けられる。自分のもの・未公開のもの・ほかの店のものには付けられない', async () => {
    await db.withTenant(T, async (q) => {
      assert.deepEqual(await addBookmark(q, visitor, k), { bookmarked: true });
      await addBookmark(q, visitor, k); // 2回押しても1つ
      await addBookmark(q, manager, k);
      await assert.rejects(addBookmark(q, trusted, k), /自分が書いた/);
      await assert.rejects(addBookmark(q, manager, pending), /公開中/);
      await assert.rejects(addBookmark(q, storeBStaff, k), /閲覧できません/);
    });
  });

  it('数は書いた本人にだけ返る。ほかの人には、自分が付けたかどうかだけ', async () => {
    await db.withTenant(T, async (q) => {
      const author = await getKnowledge(q, trusted, k);
      assert.equal(author.bookmarkCount, 2);
      assert.equal(author.canBookmark, false);
      const reader = await getKnowledge(q, visitor, k);
      assert.equal(reader.bookmarked, true);
      assert.equal(reader.canBookmark, true);
      assert.equal('bookmarkCount' in reader, false, '書いた本人以外には数の項目ごと出さない');
      const boss = await getKnowledge(q, hq, k);
      assert.equal('bookmarkCount' in boss, false, '本部にも見せない');
      assert.equal(boss.bookmarked, false);
    });
  });

  it('自分のブックマークの一覧に出る。外すと消える', async () => {
    await db.withTenant(T, async (q) => {
      const mine = await listBookmarks(q, visitor, STORE_A);
      assert.deepEqual(mine.map((b) => [b.id, b.title, b.tags]), [[k, '領収書の宛名', ['レジ']]]);
      assert.deepEqual(await listBookmarks(q, trusted, STORE_A), []);
      assert.deepEqual(await removeBookmark(q, visitor, k), { bookmarked: false });
      assert.deepEqual(await listBookmarks(q, visitor, STORE_A), []);
      assert.equal((await getKnowledge(q, trusted, k)).bookmarkCount, 1);
    });
  });
});

describe('引き継ぎのラベル', () => {
  let db: TestDatabase;
  before(async () => { db = await freshDatabase(); });
  after(async () => { await db.close(); });

  it('整える：# と空白を落とし、同じものは1つに。長すぎ・多すぎは断る', () => {
    assert.deepEqual(cleanLabels([' #落とし物 ', '＃お客様対応', '落とし物', '', '  ']), ['落とし物', 'お客様対応']);
    assert.deepEqual(cleanLabels(undefined), []);
    assert.throws(() => cleanLabels(['あ'.repeat(21)]), /20文字/);
    assert.throws(() => cleanLabels(['a', 'b', 'c', 'd', 'e', 'f']), /5個/);
    assert.throws(() => cleanLabels('落とし物'), /形/);
    assert.throws(() => cleanLabels([1]), /形/);
  });

  it('付けて書ける。付けなければ今までどおり（空）。候補はよく使う順で、店ごと', async () => {
    await db.withTenant(T, async (q) => {
      await addHandover(q, visitor, STORE_A, '傘の忘れ物があります', undefined, ['落とし物']);
      await addHandover(q, trusted, STORE_A, '高橋様から折り返しの電話待ち', undefined, ['お客様対応', '電話']);
      await addHandover(q, trusted, STORE_A, '佐藤様の取り置き', undefined, ['#お客様対応']);
      await addHandover(q, manager, STORE_A, 'レシート用紙を発注');
      await addHandover(q, storeBStaff, STORE_B, '駅前店だけの話', undefined, ['駅前']);
      const list = await listHandovers(q, visitor, STORE_A);
      assert.deepEqual(list.map((h) => h.labels), [['落とし物'], ['お客様対応', '電話'], ['お客様対応'], []]);
      const labels = await handoverLabels(q, visitor, STORE_A);
      assert.equal(labels[0], 'お客様対応');
      assert.deepEqual([...labels].sort(), ['お客様対応', '落とし物', '電話'].sort());
      assert.deepEqual(await handoverLabels(q, storeBStaff, STORE_B), ['駅前']);
      await assert.rejects(handoverLabels(q, storeBStaff, STORE_A), /見られません/);
    });
  });
});

describe('個人メモ', () => {
  let db: TestDatabase;
  before(async () => { db = await freshDatabase(); });
  after(async () => { await db.close(); });

  it('書いた本人にしか見えない。店長にも本部にも出ない', async () => {
    await db.withTenant(T, async (q) => {
      const a = await addMemo(q, visitor, { body: ' 会員番号 1234-5678 ' }, '2026-11-15');
      assert.equal(a.kind, 'today');
      assert.equal(a.body, '会員番号 1234-5678');
      await addMemo(q, visitor, { body: '値引きの相談は店長を呼ぶ', kind: 'keep' }, '2026-11-15');
      assert.equal((await listMemos(q, visitor, '2026-11-15')).length, 2);
      assert.deepEqual(await listMemos(q, manager, '2026-11-15'), []);
      assert.deepEqual(await listMemos(q, hq, '2026-11-15'), []);
    });
  });

  it('他人のメモは、書き換えも削除もできない（あることも教えない）', async () => {
    await db.withTenant(T, async (q) => {
      const [memo] = await listMemos(q, visitor, '2026-11-15');
      await assert.rejects(updateMemo(q, manager, memo!.id, { body: '覗いた' }), /見つかりません/);
      await assert.rejects(deleteMemo(q, hq, memo!.id), /見つかりません/);
      assert.equal((await listMemos(q, visitor, '2026-11-15')).length, 2);
    });
  });

  it('済みにする・書き換える・「残す」に移す', async () => {
    await db.withTenant(T, async (q) => {
      const today = (await listMemos(q, visitor, '2026-11-15')).find((m) => m.kind === 'today')!;
      assert.equal((await updateMemo(q, visitor, today.id, { done: true })).done, true);
      assert.equal((await updateMemo(q, visitor, today.id, { body: '会員番号は伝えた' })).done, true, '書き換えても済みのまま');
      assert.equal((await updateMemo(q, visitor, today.id, { done: false })).done, false);
      await assert.rejects(updateMemo(q, visitor, today.id, { body: '' }), /1〜2000文字/);
      await assert.rejects(updateMemo(q, visitor, today.id, { kind: 'forever' }), /種類/);
      await assert.rejects(addMemo(q, visitor, { body: 'あ'.repeat(2001) }), /2000文字/);
    });
  });

  it('「今日だけ」は翌日に出なくなり、夜間に消える。「残す」は残る', async () => {
    await db.withTenant(T, async (q) => {
      const next = await listMemos(q, visitor, '2026-11-16');
      assert.deepEqual(next.map((m) => m.kind), ['keep']);
      assert.equal(await sweepTodayMemos(q, '2026-11-15'), 0, '当日は消さない');
      assert.equal(await sweepTodayMemos(q, '2026-11-16'), 1);
      const left = await q.query<{ kind: string }>(`SELECT kind FROM personal_memos`);
      assert.deepEqual(left.map((r) => r.kind), ['keep']);
    });
  });

  it('「残す」を「今日だけ」に移したら、その日から数え直す', async () => {
    await db.withTenant(T, async (q) => {
      const [keep] = await listMemos(q, visitor, '2026-11-20');
      await updateMemo(q, visitor, keep!.id, { kind: 'today' }, '2026-11-20');
      assert.equal((await listMemos(q, visitor, '2026-11-20')).length, 1);
      assert.equal((await listMemos(q, visitor, '2026-11-21')).length, 0);
      await deleteMemo(q, visitor, keep!.id);
    });
  });

  it('API からも、自分のメモだけが返る', async () => {
    const app = createApp({ database: db, auth: new DevHeaderAuthenticator(), tokenizer, limiter: new MemoryRateLimiter() });
    const as = (userId: string, method: string, path: string, body?: unknown) => app(new Request(`http://app.example${path}`, {
      method, headers: { 'x-dev-tenant-id': T, 'x-dev-user-id': userId, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const made = await as(visitor.userId, 'POST', '/memos', { body: 'レジ2番の用紙を替える', kind: 'today' });
    assert.equal(made.status, 201);
    const id = ((await made.json()) as { id: string }).id;
    assert.equal(((await (await as(visitor.userId, 'GET', '/memos')).json()) as unknown[]).length, 1);
    assert.equal(((await (await as(manager.userId, 'GET', '/memos')).json()) as unknown[]).length, 0);
    assert.equal((await as(manager.userId, 'PATCH', `/memos/${id}`, { done: true })).status, 404);
    assert.equal((await as(visitor.userId, 'PATCH', `/memos/${id}`, { done: true })).status, 200);
    assert.equal((await as(visitor.userId, 'DELETE', `/memos/${id}`)).status, 200);
    const labels = await as(visitor.userId, 'GET', `/stores/${STORE_A}/handover-labels`);
    assert.equal(labels.status, 200);
  });
});
