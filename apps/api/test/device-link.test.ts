import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import { acceptInvitation, createDeviceLink } from '../src/domain/users.ts';
import { freshDatabase, hq, T, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

describe('別端末ログイン用URLの発行', () => {
  let db: TestDatabase;
  const run = <R>(fn: (q: Db) => Promise<R>): Promise<R> => db.withTenant(T, fn);
  before(async () => { db = await freshDatabase(); });
  after(async () => { await db.close(); });

  it('一般メンバーでも自分用の鍵を作れ、そのリンクで「同じ自分」として入れる', async () => {
    const { token } = await run((q) => createDeviceLink(q, visitor));
    const accepted = await run((q) => acceptInvitation(q, T, token, '2台目'));
    assert.ok(accepted.sessionToken, 'セッションが作られる');
    assert.equal(accepted.userId, visitor.userId, '新しい利用者を作らず、自分として入る');
  });

  it('本部（管理者）でも自分用の鍵を作れる（他人招待の経路では自分すら弾かれるため）', async () => {
    const { token } = await run((q) => createDeviceLink(q, hq));
    const accepted = await run((q) => acceptInvitation(q, T, token, 'PC'));
    assert.equal(accepted.userId, hq.userId);
  });

  it('1回使うと無効になる', async () => {
    const { token } = await run((q) => createDeviceLink(q, visitor));
    await run((q) => acceptInvitation(q, T, token, '1回目'));
    await assert.rejects(run((q) => acceptInvitation(q, T, token, '2回目')));
  });
});
