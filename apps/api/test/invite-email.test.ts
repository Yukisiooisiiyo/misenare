import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import type { Mail, Mailer } from '../src/mail/mailer.ts';
import { acceptInvitation, inviteByEmail } from '../src/domain/users.ts';
import { freshDatabase, manager, STORE_A, T } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

describe('招待リンクをメールで送る', () => {
  let db: TestDatabase;
  const run = <R>(fn: (q: Db) => Promise<R>): Promise<R> => db.withTenant(T, fn);
  before(async () => { db = await freshDatabase(); });
  after(async () => { await db.close(); });

  it('宛先に招待リンクを送り、そのリンクで登録できる', async () => {
    const sent: Mail[] = [];
    const mailer: Mailer = { send: async (m) => { sent.push(m); return true; } };
    const r = await run((q) => inviteByEmail(q, manager, mailer, 'https://app.example.com/', {
      storeId: STORE_A, name: '新人バイト', email: 'baito@example.com',
    }));
    assert.equal(r.sent, true);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.to, ['baito@example.com']);
    const m = /#invite=([^\s]+)/.exec(sent[0]!.text);
    assert.ok(m, 'メール本文に招待リンクがある');
    // 末尾のスラッシュが二重にならず、同じリンクで実際に端末登録できる
    assert.ok(sent[0]!.text.includes('https://app.example.com/app/#invite='));
    const token = decodeURIComponent(m![1]!);
    const accepted = await run((q) => acceptInvitation(q, T, token, 'テスト端末'));
    assert.ok(accepted.sessionToken, '送ったリンクで端末登録できる');
  });

  it('メールアドレスの形が違えば招待を作らない', async () => {
    const mailer: Mailer = { send: async () => true };
    await assert.rejects(
      run((q) => inviteByEmail(q, manager, mailer, 'https://app.example.com', { storeId: STORE_A, name: 'x', email: 'not-an-email' })),
      /メールアドレス/,
    );
  });
});
