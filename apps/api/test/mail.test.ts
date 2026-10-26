// メールの送信。にせのメールサーバーを相手に、話し方と組み立てを確かめる。
//
// なぜここを自分で書いて、ここまで試験するか：
// Slack を使っていない会社が多いのでメールが要るが、メールは**届かなくても
// 例外にならない**。化けた件名、途中で切れた本文、暗号化しないままの合言葉——
// どれも「送ったつもり」で終わる。ここで押さえておかないと、現場で気づけない。

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { compose, encodeHeader, looksLikeEmail, mailerFromEnv, SmtpMailer } from '../src/mail/mailer.ts';
import { sendSmtp, smtpFromEnv, stuff } from '../src/mail/smtp.ts';
import { fakeSmtp, type FakeSmtp } from './smtpHelper.ts';

let server: FakeSmtp | null = null;
before(async () => { server = await fakeSmtp(); });
after(async () => { await server?.close(); });

/**
 * にせのメールサーバーは、その場で証明書を作るのに openssl を使う。
 * 無い環境では立てられないので、その試験だけ飛ばす。
 *
 * **describe の skip には書けない。** describe が読まれる時点では before が
 * まだ走っておらず、server は必ず null なので、判定が効かない（見張り役の指摘）。
 * 試験の中で判断する。
 */
function needServer(t: { skip(reason?: string): void }): FakeSmtp | null {
  if (server === null) t.skip('openssl が無いので、にせのメールサーバーを立てられません');
  return server;
}

const config = (over: Record<string, unknown> = {}) => ({
  host: 'localhost', port: server!.port, secure: false, ca: server!.ca, timeoutMs: 8000, ...over,
});

/** 本文（base64）を読み戻す */
function bodyOf(data: string): string {
  const base64 = data.split(/\n\s*\n/).slice(1).join('').replace(/\s/g, '');
  return Buffer.from(base64, 'base64').toString('utf8');
}

describe('メールの組み立て', () => {
  it('日本語の件名は、化けない形に直す', () => {
    const encoded = encodeHeader('【ミセナレ】利用の申請が3件あります');
    assert.ok(encoded.startsWith('=?UTF-8?B?'), encoded);
    // 折り返した断片をつないで戻せる
    const decoded = encoded.split(/\r\n /).map((part) => {
      const m = /^=\?UTF-8\?B\?(.*)\?=$/.exec(part.trim())!;
      return Buffer.from(m[1]!, 'base64').toString('utf8');
    }).join('');
    assert.equal(decoded, '【ミセナレ】利用の申請が3件あります');
  });

  it('英数字だけの件名は、そのまま', () => {
    assert.equal(encodeHeader('Misenare: 3 requests'), 'Misenare: 3 requests');
  });

  it('自動の知らせなので、不在通知を呼ばない印を付ける', () => {
    const message = compose({ from: 'a@example.com', to: ['b@example.com'], subject: 'x', text: 'y' });
    assert.ok(message.includes('Auto-Submitted: auto-generated'));
    assert.ok(message.includes('X-Auto-Response-Suppress: All'));
  });

  it('本文の「.」だけの行を増やす（増やさないと本文が途中で切れる）', () => {
    assert.equal(stuff('まえ\n.\nあと'), 'まえ\r\n..\r\nあと');
    assert.equal(stuff('...'), '....');
  });

  it('メールアドレスの形を、ゆるく確かめる', () => {
    assert.ok(looksLikeEmail('tanaka@kdenki.example.co.jp'));
    assert.ok(!looksLikeEmail('tanaka'));
    assert.ok(!looksLikeEmail('tanaka@example'));
    assert.ok(!looksLikeEmail('a b@example.com'));
  });
});

describe('SMTP のやり取り', () => {
  it('暗号化に上げて、認証して、送る', async (t) => {
    if (!needServer(t)) return;
    const before = server!.received.length;
    await sendSmtp(config({ user: 'misenare', pass: 'ひみつ' }), {
      from: 'misenare@example.com',
      to: ['tencho@kdenki.example.co.jp'],
      message: compose({
        from: 'misenare@example.com', to: ['tencho@kdenki.example.co.jp'],
        subject: '【ミセナレ】利用の申請が3件あります',
        text: '田中 太郎さんほか2名が、会社のアカウントで入ろうとしています。\n承認・管理 → 利用の申請 で決めてください。',
      }),
    });
    const got = server!.received[before]!;
    assert.equal(got.encrypted, true, '暗号化されていない接続で送っている');
    assert.deepEqual(got.auth, { user: 'misenare', pass: 'ひみつ' });
    assert.equal(got.from, 'misenare@example.com');
    assert.deepEqual(got.to, ['tencho@kdenki.example.co.jp']);
    // 暗号化のあと、名乗り直している（決まり）
    assert.deepEqual(got.commands.filter((c) => c === 'EHLO').length, 2);
    assert.ok(bodyOf(got.data).includes('田中 太郎さんほか2名'), bodyOf(got.data));
    assert.ok(got.data.includes('=?UTF-8?B?'), '件名が生のままになっている');
  });

  it('認証を使わない相手にも送れる', async (t) => {
    if (!needServer(t)) return;
    const before = server!.received.length;
    await sendSmtp(config(), {
      from: 'a@example.com', to: ['b@example.com'],
      message: compose({ from: 'a@example.com', to: ['b@example.com'], subject: 'x', text: 'y' }),
    });
    assert.equal(server!.received[before]!.auth, null);
  });

  it('暗号化できない相手には、既定では送らない', async (t) => {
    if (!needServer(t)) return;
    const plain = await fakeSmtp({ capabilities: ['AUTH PLAIN'] });
    assert.ok(plain, 'にせのメールサーバーを立てられませんでした');
    try {
      const envelope = {
        from: 'a@example.com', to: ['b@example.com'],
        message: compose({ from: 'a@example.com', to: ['b@example.com'], subject: 'x', text: 'y' }),
      };
      await assert.rejects(
        sendSmtp({ host: 'localhost', port: plain.port, secure: false, timeoutMs: 8000 }, envelope),
        /暗号化に対応していません/,
      );
      assert.equal(plain.received.length, 0, '暗号化しないまま送ってしまった');
      // 社内のサーバー向けに、明示したときだけ許す
      await sendSmtp(
        { host: 'localhost', port: plain.port, secure: false, allowPlaintext: true, timeoutMs: 8000 },
        envelope,
      );
      assert.equal(plain.received.length, 1);
      assert.equal(plain.received[0]!.encrypted, false);
    } finally {
      await plain.close();
    }
  });

  it('断られたら、理由を添えて失敗する', async (t) => {
    if (!needServer(t)) return;
    server!.refuse('RCPT', '550 5.1.1 そのような宛先はありません');
    await assert.rejects(
      sendSmtp(config(), {
        from: 'a@example.com', to: ['nobody@example.com'],
        message: compose({ from: 'a@example.com', to: ['nobody@example.com'], subject: 'x', text: 'y' }),
      }),
      /そのような宛先はありません/,
    );
  });

  it('認証を断られたら、送らずに失敗する', async (t) => {
    if (!needServer(t)) return;
    const before = server!.received.length;
    server!.refuse('AUTH', '535 5.7.8 合言葉が違います');
    await assert.rejects(
      sendSmtp(config({ user: 'a', pass: 'ちがう' }), {
        from: 'a@example.com', to: ['b@example.com'],
        message: compose({ from: 'a@example.com', to: ['b@example.com'], subject: 'x', text: 'y' }),
      }),
      /合言葉が違います/,
    );
    assert.equal(server!.received.length, before);
  });
});

describe('送り口の組み立て', () => {
  it('設定が無ければ、送らないが壊れない', async () => {
    const mailer = mailerFromEnv({});
    assert.equal(await mailer.send({ to: ['a@example.com'], subject: 'x', text: 'y' }), false);
  });

  it('SMTP_HOST だけで MAIL_FROM が無ければ、送らない', async () => {
    const mailer = mailerFromEnv({ SMTP_HOST: 'smtp.example.com' });
    assert.equal(await mailer.send({ to: ['a@example.com'], subject: 'x', text: 'y' }), false);
  });

  it('宛先の形が全部おかしければ、送らない', async (t) => {
    if (!needServer(t)) return;
    const mailer = new SmtpMailer(config(), 'misenare@example.com');
    assert.equal(await mailer.send({ to: ['ただの文字'], subject: 'x', text: 'y' }), false);
  });

  it('番号から、暗号化の仕方を決める（465 は直接 TLS、587 は STARTTLS）', () => {
    assert.equal(smtpFromEnv({ SMTP_HOST: 'a', SMTP_PORT: '465' })?.secure, true);
    assert.equal(smtpFromEnv({ SMTP_HOST: 'a', SMTP_PORT: '587' })?.secure, false);
    assert.equal(smtpFromEnv({ SMTP_HOST: 'a' })?.port, 587, '既定は 587');
    assert.equal(smtpFromEnv({})?.secure, undefined, '設定が無ければ null');
  });
});

describe('ヘッダーへの差し込み', () => {
  it('件名に改行を入れられても、別のヘッダーにならない', () => {
    // ここが抜けると、Bcc を足して知らない宛先に送らせられる。
    // 長い件名は「改行＋空白」で折り返すのが決まりなので、改行そのものは出る。
    // 危ないのは「改行のあとが空白でない」形（そこから別のヘッダーが始まる）。
    const folded = (value: string): boolean => {
      for (let i = value.indexOf('\n'); i >= 0; i = value.indexOf('\n', i + 1)) {
        const next = value[i + 1];
        if (next !== ' ' && next !== '\t') return false;
      }
      return true;
    };
    const nasty = encodeHeader('ふつうの件名\r\nBcc: warui@example.com');
    assert.ok(folded(nasty), nasty);
    assert.ok(!nasty.includes('Bcc'), '中身がそのまま出ている');
    const ascii = encodeHeader('subject\r\nBcc: warui@example.com');
    assert.equal(ascii, 'subject Bcc: warui@example.com');
    assert.ok(folded(ascii));
  });

  it('宛先に改行の入ったものは、そもそも送らない', () => {
    assert.equal(looksLikeEmail('a@example.com\r\nBcc: warui@example.com'), false);
  });
});
