// 連絡事項と引き継ぎ。

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ackNotice, createNotice, deleteNotice, endNotice, getNotice,
  listNotices, markRead, noticeBadge, noticeReaders, updateNotice,
} from '../src/domain/notices.ts';
import {
  addHandover, closeStaleHandovers, deleteHandover, handoverBadge, listHandovers, setHandoverState,
} from '../src/domain/handovers.ts';
import { freshDatabase, hq, manager, STORE_A, STORE_B, storeBStaff, T, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
before(async () => { db = await freshDatabase(); });
after(async () => { await db.close(); });

const run = <T>(fn: (q: Parameters<Parameters<TestDatabase['withTenant']>[1]>[0]) => Promise<T>) => db.withTenant(T, fn);

describe('連絡事項', () => {
  it('trusted 以上が出せて、その店舗の人みんなが見られる', async () => {
    const { id } = await run((q) => createNotice(q, manager, STORE_A, {
      title: '年末年始の営業時間', body: '12/31 は 18 時まで。1/1 は休み。',
    }));
    await run(async (q) => {
      const mine = await listNotices(q, visitor, STORE_A);
      assert.equal(mine.length, 1);
      assert.equal(mine[0]!.id, id);
      assert.equal(mine[0]!.title, '年末年始の営業時間');
      assert.equal(mine[0]!.createdBy, '店長');
      assert.equal(mine[0]!.readAt, null, 'まだ読んでいない');
      // 他店舗には出ない
      assert.deepEqual(await listNotices(q, storeBStaff, STORE_B), []);
    });
  });

  it('visitor は出せない', async () => {
    await run(async (q) => {
      await assert.rejects(createNotice(q, visitor, STORE_A, { title: 'x', body: 'y' }), /trusted 以上/);
    });
  });

  it('全店共通は本部だけが出せて、どの店舗でも見られる', async () => {
    await run(async (q) => {
      await assert.rejects(createNotice(q, manager, null, { title: 'x', body: 'y' }), /本部のみ/);
      await createNotice(q, hq, null, { title: '値札の付け替え', body: '全店で 4/1 から。' });
      assert.ok((await listNotices(q, visitor, STORE_A)).some((n) => n.title === '値札の付け替え'));
      assert.ok((await listNotices(q, storeBStaff, STORE_B)).some((n) => n.title === '値札の付け替え'));
    });
  });

  it('開くと「読んだ」が残り、未読の数が減る', async () => {
    const { id } = await run((q) => createNotice(q, manager, STORE_A, { title: '掃除当番', body: '今週は A 班。' }));
    await run(async (q) => {
      const before = await noticeBadge(q, visitor, STORE_A);
      await markRead(q, visitor, id);
      const after = await noticeBadge(q, visitor, STORE_A);
      assert.equal(after.unread, before.unread - 1);
      const notice = await getNotice(q, visitor, id);
      assert.ok(notice.readAt);
      // 2回開いても最初の日時のまま
      await markRead(q, visitor, id);
      assert.equal((await getNotice(q, visitor, id)).readAt, notice.readAt);
    });
  });

  it('確認が要るお知らせは、押すまで数に残る', async () => {
    const { id } = await run((q) => createNotice(q, manager, STORE_A, {
      title: '新しいレジの使い方', body: '動画を見てから確認を押してください。', requiresAck: true, priority: 'important',
    }));
    await run(async (q) => {
      const badge = await noticeBadge(q, visitor, STORE_A);
      assert.ok(badge.needsAck >= 1);
      await ackNotice(q, visitor, id);
      assert.ok((await noticeBadge(q, visitor, STORE_A)).needsAck < badge.needsAck);
      assert.ok((await getNotice(q, visitor, id)).ackedAt);
      // 確認の要らないお知らせには押せない
      const plain = await createNotice(q, manager, STORE_A, { title: 'ふつうの連絡', body: '本文' });
      await assert.rejects(ackNotice(q, visitor, plain.id), /確認は要りません/);
    });
  });

  it('誰が確認して誰がまだかを、trusted 以上が見られる', async () => {
    const { id } = await run((q) => createNotice(q, manager, STORE_A, {
      title: '衛生チェック', body: '読んだら確認を。', requiresAck: true,
    }));
    await run(async (q) => {
      await ackNotice(q, trusted, id);
      const readers = await noticeReaders(q, manager, id);
      const acked = readers.filter((r) => r.acked_at !== null).map((r) => r.name);
      assert.deepEqual(acked, ['ベテランパート']);
      assert.ok(readers.some((r) => r.name === '新人バイト' && r.acked_at === null), 'まだの人も出る');
      assert.equal(readers[0]!.acked_at, null, 'まだの人が先に並ぶ');
      await assert.rejects(noticeReaders(q, visitor, id), /権限がありません/);
    });
  });

  it('掲示の期間が切れたものは出さない（記録は残る）', async () => {
    const { id } = await run((q) => createNotice(q, manager, STORE_A, { title: '週末のセール', body: '土日のみ。' }));
    await run(async (q) => {
      await endNotice(q, manager, id);
      assert.ok(!(await listNotices(q, visitor, STORE_A)).some((n) => n.id === id));
      assert.ok((await listNotices(q, visitor, STORE_A, true)).some((n) => n.id === id), '過去のぶんも見られる');
    });
  });

  it('先の日付で出すと、その日まで出ない', async () => {
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
    const { id } = await run((q) => createNotice(q, manager, STORE_A, {
      title: '来月から', body: '本文', startsAt: tomorrow,
    }));
    await run(async (q) => {
      assert.ok(!(await listNotices(q, visitor, STORE_A)).some((n) => n.id === id));
    });
  });

  it('直せるのは出した人と administrator だけ', async () => {
    const { id } = await run((q) => createNotice(q, trusted, STORE_A, { title: '元の件名', body: '本文' }));
    await run(async (q) => {
      await assert.rejects(updateNotice(q, visitor, id, { title: 'いたずら', body: '本文' }), /出した人か administrator/);
      await updateNotice(q, trusted, id, { title: '直した件名', body: '本文' });
      assert.equal((await getNotice(q, trusted, id)).title, '直した件名');
      await updateNotice(q, manager, id, { title: '店長が直した', body: '本文' });
      await deleteNotice(q, manager, id);
      await assert.rejects(getNotice(q, manager, id), /見つかりません/);
    });
  });

  it('おかしな入力は断る', async () => {
    await run(async (q) => {
      await assert.rejects(createNotice(q, manager, STORE_A, { title: '', body: '本文' }), /件名/);
      await assert.rejects(createNotice(q, manager, STORE_A, { title: 'x', body: '' }), /本文/);
      await assert.rejects(createNotice(q, manager, STORE_A, { title: 'x'.repeat(200), body: '本文' }), /件名/);
      await assert.rejects(createNotice(q, manager, STORE_A, {
        title: 'x', body: '本文', startsAt: '2026-05-01T00:00:00Z', endsAt: '2026-04-01T00:00:00Z',
      }), /終わりは、始まりより後/);
    });
  });
});

describe('引き継ぎ', () => {
  const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 10);

  it('visitor も書けて、その店舗の人みんなが見られる', async () => {
    const { id } = await run((q) => addHandover(q, visitor, STORE_A, '冷蔵庫の在庫が1台になりました。発注済み。'));
    await run(async (q) => {
      const list = await listHandovers(q, trusted, STORE_A);
      const found = list.find((h) => h.id === id)!;
      assert.equal(found.body, '冷蔵庫の在庫が1台になりました。発注済み。');
      assert.equal(found.createdBy, '新人バイト');
      assert.equal(found.state, 'open');
      assert.equal(found.carriedOver, false);
      await assert.rejects(addHandover(q, storeBStaff, STORE_A, 'よその店'), /書けません/);
      await assert.rejects(listHandovers(q, storeBStaff, STORE_A), /見られません/);
    });
  });

  it('片付いていないものは次の日に持ち越す', async () => {
    const { id } = await run((q) => addHandover(q, trusted, STORE_A, '昨日の忘れ物を預かっています', yesterday));
    await run(async (q) => {
      const list = await listHandovers(q, visitor, STORE_A);
      const found = list.find((h) => h.id === id)!;
      assert.equal(found.carriedOver, true, '前の日のものとして出る');
      assert.equal(found.forDate, yesterday);
      const badge = await handoverBadge(q, visitor, STORE_A);
      assert.ok(badge.carriedOver >= 1);
    });
  });

  it('片付けると持ち越されなくなり、やり直しもできる', async () => {
    const { id } = await run((q) => addHandover(q, visitor, STORE_A, 'レジのテープを補充する', yesterday));
    await run(async (q) => {
      await setHandoverState(q, trusted, id, 'done');
      assert.ok(!(await listHandovers(q, visitor, STORE_A)).some((h) => h.id === id), '昨日の片付いたものは出さない');
      const done = (await listHandovers(q, visitor, STORE_A, yesterday)).find((h) => h.id === id)!;
      assert.equal(done.state, 'done');
      assert.equal(done.doneBy, 'ベテランパート');
      await setHandoverState(q, visitor, id, 'open');
      assert.ok((await listHandovers(q, visitor, STORE_A)).some((h) => h.id === id), 'やり直すとまた出る');
    });
  });

  it('消せるのは書いた本人と trusted 以上', async () => {
    const mine = await run((q) => addHandover(q, visitor, STORE_A, '自分のメモ'));
    const others = await run((q) => addHandover(q, trusted, STORE_A, 'ベテランのメモ'));
    await run(async (q) => {
      await assert.rejects(deleteHandover(q, visitor, others.id), /書いた人か trusted 以上/);
      await deleteHandover(q, visitor, mine.id);
      await deleteHandover(q, manager, others.id);
    });
  });

  it('古いまま残ったものは、夜間バッチが閉じる', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString().slice(0, 10);
    const { id } = await run((q) => addHandover(q, visitor, STORE_A, 'ずっと前の申し送り', old));
    await run(async (q) => {
      assert.ok(!(await listHandovers(q, visitor, STORE_A)).some((h) => h.id === id), '持ち越しの期間より前は出さない');
      const closed = await closeStaleHandovers(q);
      assert.ok(closed >= 1);
      const row = await q.query<{ state: string }>(`SELECT state FROM handovers WHERE id = $1`, [id]);
      assert.equal(row[0]!.state, 'done');
    });
  });

  it('おかしな入力は断る', async () => {
    await run(async (q) => {
      await assert.rejects(addHandover(q, visitor, STORE_A, '   '), /1〜1000文字/);
      await assert.rejects(addHandover(q, visitor, STORE_A, 'x'.repeat(1001)), /1〜1000文字/);
      await assert.rejects(addHandover(q, visitor, STORE_A, 'x', '2026/01/01'), /YYYY-MM-DD/);
      await assert.rejects(listHandovers(q, visitor, STORE_A, 'きのう'), /YYYY-MM-DD/);
    });
  });
});
