// メールの組み立てと送り口。
//
// 日本語を送るので、ヘッダーと本文の決まりを守る必要がある。
//   件名  … そのまま書くと化ける。RFC 2047 の形（=?UTF-8?B?…?=）にする
//   本文  … UTF-8 のまま流すと、古い中継で壊れることがある。base64 にする
// ここを自分で書いているのは、送信業者に縛られないため（smtp.ts の冒頭に理由）。

import { sendSmtp, smtpFromEnv, type SmtpConfig } from './smtp.ts';

export interface Mail {
  to: string[];
  subject: string;
  /** 本文（ふつうの文字列。改行はそのまま） */
  text: string;
}

export interface Mailer {
  /** 送れたら true。送り先が決まっていなければ false（例外にはしない） */
  send(mail: Mail): Promise<boolean>;
}

/**
 * 件名などのヘッダーに日本語を入れる形。ASCII だけならそのまま。
 *
 * 改行は先に落とす。ヘッダーに改行を入れられると、そこから別のヘッダーを
 * 差し込める（Bcc を足して、知らない宛先に送らせる）。
 * いまの呼び出し元に人の入力は入らないが、1行で塞げるので塞いでおく。
 */
export function encodeHeader(value: string): string {
  value = value.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  // 1行が長くなりすぎないよう、適当な長さで区切って並べる
  const chunks: string[] = [];
  let current = '';
  for (const ch of value) {
    if (Buffer.byteLength(current + ch, 'utf8') > 36) { chunks.push(current); current = ''; }
    current += ch;
  }
  if (current !== '') chunks.push(current);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** メールアドレスの形。打ち間違いを早めに止めるための、ゆるい確かめ */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@,;:<>"]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(value.trim());
}

/** base64 を76文字ごとに折る（決まり） */
function wrap(base64: string): string {
  return (base64.match(/.{1,76}/g) ?? []).join('\r\n');
}

export interface ComposeInput extends Mail {
  from: string;
  /** 返信先。差出人と違うときだけ */
  replyTo?: string | undefined;
  /** 同じ知らせを二重に出さないための印（相手の受信箱でまとまる） */
  messageId?: string | undefined;
  date?: Date;
}

export function compose(input: ComposeInput): string {
  const date = (input.date ?? new Date()).toUTCString().replace('GMT', '+0000');
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
    ...(input.replyTo ? [`Reply-To: ${input.replyTo}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${date}`,
    ...(input.messageId ? [`Message-ID: <${input.messageId}>`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    // 自動の知らせなので、不在通知や自動返信を呼ばない
    'Auto-Submitted: auto-generated',
    'X-Auto-Response-Suppress: All',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${wrap(Buffer.from(input.text, 'utf8').toString('base64'))}`;
}

export class SmtpMailer implements Mailer {
  constructor(
    private readonly config: SmtpConfig,
    private readonly from: string,
    private readonly replyTo?: string | undefined,
  ) {}

  async send(mail: Mail): Promise<boolean> {
    const to = mail.to.map((t) => t.trim()).filter((t) => looksLikeEmail(t));
    if (to.length === 0) return false;
    await sendSmtp(this.config, {
      from: this.from,
      to,
      message: compose({
        ...mail, to, from: this.from, replyTo: this.replyTo,
        messageId: `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@misenare`,
      }),
    });
    return true;
  }
}

/** 送り先が決まっていないときの口。黙って捨てるが、何も壊さない */
export const noMailer: Mailer = { send: async () => false };

/**
 * 環境変数から送り口を決める。
 * SMTP_HOST と MAIL_FROM の両方が決まっていなければ、メールは送らない。
 */
export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  const config = smtpFromEnv(env);
  const from = env.MAIL_FROM;
  if (!config || !from) return noMailer;
  return new SmtpMailer(config, from, env.MAIL_REPLY_TO);
}
