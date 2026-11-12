import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import type { Mail, Mailer } from '../src/mail/mailer.ts';
import { acceptInvitation, inviteByEmail, sendEmailLogin, setMyEmail } from '../src/domain/users.ts';
import { freshDatabase, manager, STORE_A, T, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

describe('メールでログインリンク／メアド登録', () => {
  let db: TestDatabase;
  const run = <R>(fn: (q: Db) => Promise<R>): Promise<R> => db.withTenant(T, fn);
  const collector = (): { mailer: Mailer; sent: Mail[] } => {
    const sent: Mail[] = [];
    return { sent, mailer: { send: async (m) => { sent.push(m); return true; } } };
  };
  before(async () => { db = await freshDatabase(); });
  after(async () => { await db.close(); });

  it('メアド登録→そのメアドにログインリンクが届き、同じ本人として入れる（大小無視）', async () => {
    await run((q) => setMyEmail(q, visitor, 'baito@example.com'));
    const { mailer, sent } = collector();
    await sendEmailLogin(db, mailer, 'https://app.example.com/', 'BAITO@Example.com');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.to, ['baito@example.com']);
    const m = /#invite=([^\s]+)/.exec(sent[0]!.text);
    assert.ok(m, 'ログインリンクが入っている');
    const accepted = await run((q) => acceptInvitation(q, T, decodeURIComponent(m![1]!), 'PC'));
    assert.equal(accepted.userId, visitor.userId, '新しい利用者を作らず、自分として入る');
  });

  it('登録の無いメアドには何も送らない（存在を漏らさない）', async () => {
    const { mailer, sent } = collector();
    await sendEmailLogin(db, mailer, 'https://app.example.com', 'nobody@example.com');
    assert.equal(sent.length, 0);
  });

  it('同じメアドは社内の別アカウントには登録できない', async () => {
    await run((q) => setMyEmail(q, trusted, 'dup@example.com'));
    await assert.rejects(run((q) => setMyEmail(q, manager, 'dup@example.com')), /別のアカウント/);
  });

  it('招待メールで入ると、その宛先が本人のメアドとして紐付く', async () => {
    const { mailer } = collector();
    const inv = await run((q) => inviteByEmail(q, manager, mailer, 'https://app.example.com', {
      storeId: STORE_A, name: '新人', email: 'newcomer@example.com',
    }));
    assert.equal(inv.sent, true);
    // 届いたリンクで受け入れ → 作られた利用者に email が入っている
    const { mailer: m2, sent } = collector();
    await run((q) => inviteByEmail(q, manager, m2, 'https://app.example.com', {
      storeId: STORE_A, name: '新人2', email: 'nc2@example.com',
    }));
    const token = decodeURIComponent(/#invite=([^\s]+)/.exec(sent[0]!.text)![1]!);
    const accepted = await run((q) => acceptInvitation(q, T, token, 'スマホ'));
    const row = await run((q) => q.query<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [accepted.userId]));
    assert.equal(row[0]!.email, 'nc2@example.com');
  });
});
