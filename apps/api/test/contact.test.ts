// 紹介サイトの問い合わせフォーム。
//
// 誰でも打てる口なので、確かめたいのは
//   ・変な入力を残さない／メールの見出しに改行を持ち込ませない
//   ・メールが送れなくても問い合わせを失わない
//   ・連打と機械を止める

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parseContact, submitContact, sweepContactInquiries } from '../src/domain/contact.ts';
import { createApp } from '../src/http/app.ts';
import { DevHeaderAuthenticator } from '../src/http/auth.ts';
import { MemoryRateLimiter } from '../src/http/rateLimit.ts';
import { compose, type Mail, type Mailer } from '../src/mail/mailer.ts';
import { freshDatabase, tokenizer } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

const good = { name: '山田 花子', company: 'やまだ電器 駅前店', email: 'hanako@example.com', message: '3店舗で試したいです。\n費用を教えてください。' };
const collector = (): { mailer: Mailer; sent: Mail[] } => {
  const sent: Mail[] = [];
  return { sent, mailer: { send: async (m) => { sent.push(m); return true; } } };
};

describe('問い合わせの形の確かめ', () => {
  it('前後の空白を落とし、会社名が空なら null にする', () => {
    const c = parseContact({ ...good, name: '  山田 花子 ', company: '  ' });
    assert.equal(c.name, '山田 花子');
    assert.equal(c.company, null);
  });

  it('名前と会社名の改行は空白にする（メールの見出しを崩させない）。本文の改行は残す', () => {
    const c = parseContact({ ...good, name: '山田\r\nBcc: x@example.com', message: '一行目\r\n二行目' });
    assert.equal(c.name, '山田 Bcc: x@example.com');
    assert.equal(c.message, '一行目\n二行目');
  });

  it('足りない・長すぎる・アドレスの形でないものは、画面に出せる言葉で断る', () => {
    assert.throws(() => parseContact({ ...good, name: '' }), /お名前/);
    assert.throws(() => parseContact({ ...good, name: 'あ'.repeat(81) }), /80文字/);
    assert.throws(() => parseContact({ ...good, email: 'hanako' }), /メールアドレス/);
    assert.throws(() => parseContact({ ...good, email: 'a@example.com\nBcc: b@example.com' }), /メールアドレス/);
    assert.throws(() => parseContact({ ...good, message: '   ' }), /ご相談内容/);
    assert.throws(() => parseContact({ ...good, message: 'あ'.repeat(4001) }), /4000文字/);
    assert.throws(() => parseContact({ name: 1, email: null } as Record<string, unknown>), /お名前/);
  });
});

describe('問い合わせを残して知らせる', () => {
  let db: TestDatabase;
  before(async () => { db = await freshDatabase(); });
  after(async () => { await db.close(); });
  const rows = () => db.raw(`SELECT name, company, email, message, mailed FROM contact_inquiries ORDER BY created_at`) as Promise<Array<{ name: string; company: string | null; email: string; message: string; mailed: boolean }>>;

  it('DB に残し、宛先へメールを出す。返信先は相手のアドレス', async () => {
    const { mailer, sent } = collector();
    const r = await submitContact(db, mailer, ['owner@example.com'], parseContact(good));
    assert.equal(r.mailed, true);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.to, ['owner@example.com']);
    assert.equal(sent[0]!.replyTo, 'hanako@example.com');
    assert.match(sent[0]!.subject, /山田 花子（やまだ電器 駅前店）/);
    assert.match(sent[0]!.text, /費用を教えてください。/);
    const saved = await rows();
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.mailed, true);
    assert.equal(saved[0]!.email, 'hanako@example.com');
  });

  it('宛先が無い・メールが落ちる、どちらでも問い合わせは残る（mailed は false）', async () => {
    const none = collector();
    assert.equal((await submitContact(db, none.mailer, [], parseContact({ ...good, name: '宛先なし' }))).mailed, false);
    assert.equal(none.sent.length, 0);
    const broken: Mailer = { send: async () => { throw new Error('SMTP が落ちている'); } };
    assert.equal((await submitContact(db, broken, ['owner@example.com'], parseContact({ ...good, name: '送信失敗' }))).mailed, false);
    const saved = await rows();
    assert.deepEqual(saved.filter((x) => !x.mailed).map((x) => x.name), ['宛先なし', '送信失敗']);
  });

  it('1年たったものは片付ける', async () => {
    await db.raw(`UPDATE contact_inquiries SET created_at = now() - interval '400 days' WHERE name = '宛先なし'`);
    assert.equal(await sweepContactInquiries((sql, params) => db.raw(sql, params)), 1);
    assert.ok(!(await rows()).some((x) => x.name === '宛先なし'));
  });

  it('返信先は、メールのヘッダーに1通ぶんだけ入る', () => {
    const raw = compose({ from: 'Tsugigami <info@example.com>', to: ['owner@example.com'], subject: '件名', text: '本文', replyTo: 'hanako@example.com' });
    assert.match(raw, /\r\nReply-To: hanako@example\.com\r\n/);
  });
});

describe('POST /contact', () => {
  let db: TestDatabase;
  let sent: Mail[];
  let app: (req: Request) => Promise<Response>;
  const saved = process.env.CONTACT_TO;
  before(async () => {
    db = await freshDatabase();
    process.env.CONTACT_TO = 'owner@example.com';
    const c = collector();
    sent = c.sent;
    app = createApp({ database: db, auth: new DevHeaderAuthenticator(), tokenizer, limiter: new MemoryRateLimiter(), contactMailer: c.mailer });
  });
  after(async () => {
    if (saved === undefined) delete process.env.CONTACT_TO; else process.env.CONTACT_TO = saved;
    await db.close();
  });
  const post = (body: unknown, ip = '203.0.113.1') => app(new Request('http://tsugigami.example/contact', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-misenare-client-ip': ip }, body: JSON.stringify(body),
  }));
  const count = async () => Number(((await db.raw(`SELECT count(*) AS n FROM contact_inquiries`)) as Array<{ n: string }>)[0]!.n);

  it('ログインしていなくても送れて、残って、知らせが出る', async () => {
    const res = await post(good);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
    assert.equal(await count(), 1);
    assert.equal(sent.length, 1);
  });

  it('形がだめなら 400 と、画面に出せる言葉', async () => {
    const res = await post({ ...good, email: 'x' }, '203.0.113.2');
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { message: string }).message, /メールアドレス/);
    assert.equal(await count(), 1);
  });

  it('見えない欄が埋まっていたら、受け取ったふりをして何も残さない', async () => {
    const res = await post({ ...good, website: 'https://spam.example' }, '203.0.113.3');
    assert.equal(res.status, 200);
    assert.equal(await count(), 1);
    assert.equal(sent.length, 1);
  });

  it('同じ接続元からは1時間に5回まで', async () => {
    const ip = '203.0.113.9';
    for (let i = 0; i < 5; i++) assert.equal((await post({ ...good, name: `連打${i}` }, ip)).status, 200);
    assert.equal((await post(good, ip)).status, 429);
    assert.equal((await post(good, '203.0.113.10')).status, 200, '別の接続元は巻き添えにしない');
  });
});
