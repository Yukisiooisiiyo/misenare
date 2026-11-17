import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/db.ts';
import type { Mail, Mailer } from '../src/mail/mailer.ts';
import { acceptInvitation, createInvitation, inviteByEmail, updateUser } from '../src/domain/users.ts';
import { freshDatabase, hq, manager, STORE_A, T } from './helpers.ts';
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
  /** メールで招待して、届いたリンクで受け取る */
  async function inviteAndAccept(name: string, email: string) {
    const sent: Mail[] = [];
    const mailer: Mailer = { send: async (m) => { sent.push(m); return true; } };
    await run((q) => inviteByEmail(q, manager, mailer, 'https://app.example.com', { storeId: STORE_A, name, email }));
    const token = decodeURIComponent(/#invite=([^\s]+)/.exec(sent[0]!.text)![1]!);
    return run((q) => acceptInvitation(q, T, token, 'スマホ'));
  }
  const emailOf = async (userId: string) =>
    (await run((q) => q.query<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [userId])))[0]!.email;

  it('同じアドレスに、新しい人としてもう一度メールで招待しても受け取れる（アドレスは先の人のまま）', async () => {
    // 端末をなくした人に、もう一度メールで招待を送る場面。
    // 以前は、アドレスの紐づけが一意制約に当たって取引ごと失敗し、受け取りが 500 になっていた
    const first = await inviteAndAccept('佐藤', 'sato@example.com');
    const second = await inviteAndAccept('佐藤（2台目）', 'sato@example.com');
    assert.ok(second.sessionToken, '2回目の招待も受け取れる');
    assert.notEqual(second.userId, first.userId);
    assert.equal(await emailOf(first.userId), 'sato@example.com', '先の人が使っているあいだは、そちらのまま');
    assert.equal(await emailOf(second.userId), null);
  });

  it('先の人が無効化されていれば、アドレスは新しい人に移る（メールでの入り直しが古いほうへ向かない）', async () => {
    const first = await inviteAndAccept('鈴木', 'suzuki@example.com');
    await run((q) => updateUser(q, manager, first.userId, { status: 'disabled' }));
    const second = await inviteAndAccept('鈴木', 'Suzuki@Example.com');
    assert.equal(await emailOf(first.userId), null);
    assert.equal(await emailOf(second.userId), 'Suzuki@Example.com');
  });

  it('名前に URL や改行を入れた招待は作らない（招待メールを別の用件に仕立てさせない）', async () => {
    const sent: Mail[] = [];
    const mailer: Mailer = { send: async (m) => { sent.push(m); return true; } };
    for (const name of ['https://evil.example/ を開いて', 'evil.example/login へ', 'www.evil.example', '田中\n至急こちらへ']) {
      await assert.rejects(
        run((q) => inviteByEmail(q, manager, mailer, 'https://app.example.com', { storeId: STORE_A, name, email: 'target@example.com' })),
        /URL や改行/,
        name,
      );
      await assert.rejects(run((q) => createInvitation(q, hq, { storeId: STORE_A, name })), /URL や改行/, name);
    }
    assert.equal(sent.length, 0);
    // ふつうの名前は通る（点や括弧、長音、英字）
    for (const name of ['田中 太郎', 'J. Smith', '鈴木（新人）', 'ｻﾄｳ', 'Dr.山田']) {
      assert.ok((await run((q) => createInvitation(q, hq, { storeId: STORE_A, name }))).token, name);
    }
  });
});
