// 紹介サイトの問い合わせフォーム。
//
// ログイン前の、誰でも打てる口。なので
//   ・入力は長さと形を確かめる（そのままメールの本文になる）
//   ・先に DB へ残し、メールはそのあと（送信に失敗しても問い合わせを失わない）
//   ・返信先（Reply-To）に相手のアドレスを入れ、受け取った側がそのまま返信できるようにする
// 回数の制限は呼び出し側（http/app.ts）で掛ける。

import type { Database } from '../db/db.ts';
import { looksLikeEmail, type Mailer } from '../mail/mailer.ts';
import { DomainError } from './actor.ts';

export const CONTACT_LIMITS = { name: 80, company: 120, email: 254, message: 4000 } as const;

export interface ContactInput {
  name: string;
  company: string | null;
  email: string;
  message: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** 形を確かめて、保存できる形にそろえる。だめなら、画面にそのまま出せる言葉で断る */
export function parseContact(body: Record<string, unknown>): ContactInput {
  // 改行は本文だけに許す。名前や会社名に入ると、知らせのメールの見出しが崩れる
  const oneLine = (value: unknown): string => text(value).replace(/\s+/g, ' ');
  const name = oneLine(body.name);
  const company = oneLine(body.company);
  const email = text(body.email);
  const message = text(body.message).replace(/\r\n?/g, '\n');
  if (name === '') throw new DomainError('invalid', 'お名前を入力してください');
  if (name.length > CONTACT_LIMITS.name) throw new DomainError('invalid', `お名前は${CONTACT_LIMITS.name}文字までにしてください`);
  if (company.length > CONTACT_LIMITS.company) throw new DomainError('invalid', `会社・店舗名は${CONTACT_LIMITS.company}文字までにしてください`);
  if (email.length > CONTACT_LIMITS.email || !looksLikeEmail(email)) throw new DomainError('invalid', 'メールアドレスの形を確かめてください');
  if (message === '') throw new DomainError('invalid', 'ご相談内容を入力してください');
  if (message.length > CONTACT_LIMITS.message) throw new DomainError('invalid', `ご相談内容は${CONTACT_LIMITS.message}文字までにしてください`);
  return { name, company: company === '' ? null : company, email, message };
}

/** 知らせの宛先（CONTACT_TO。カンマ区切りで複数可）。決まっていなければ空 */
export function contactRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CONTACT_TO ?? '').split(',').map((x) => x.trim()).filter((x) => looksLikeEmail(x));
}

/**
 * 問い合わせを残して、運営に知らせる。
 * 返すのは「知らせのメールを出せたか」。出せなくても問い合わせは残っているので、呼び出し側は成功として扱う。
 */
export async function submitContact(database: Database, mailer: Mailer, to: string[], input: ContactInput): Promise<{ id: string; mailed: boolean }> {
  const rows = (await database.raw(
    `INSERT INTO contact_inquiries (name, company, email, message) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.name, input.company, input.email, input.message],
  )) as Array<{ id: string }>;
  const id = rows[0]!.id;
  if (to.length === 0) return { id, mailed: false };
  let mailed = false;
  try {
    mailed = await mailer.send({
      to,
      replyTo: input.email,
      subject: `【ツギガミ】お問い合わせ：${input.name}${input.company ? `（${input.company}）` : ''}`,
      text: [
        '紹介サイトのフォームから、お問い合わせが届きました。',
        'このメールにそのまま返信すると、相手に届きます。',
        '',
        `お名前　　　：${input.name}`,
        `会社・店舗名：${input.company ?? '（未記入）'}`,
        `メール　　　：${input.email}`,
        '',
        '―― ご相談内容 ――',
        input.message,
        '',
        `（控えの番号：${id}）`,
      ].join('\n'),
    });
  } catch (err) {
    // 送れなくても、問い合わせは DB に残っている。ここで落として相手に「失敗」と見せない
    console.error('問い合わせの知らせメールを送れませんでした', err);
  }
  if (mailed) await database.raw(`UPDATE contact_inquiries SET mailed = true WHERE id = $1`, [id]);
  return { id, mailed };
}

/** 古い問い合わせを消す（夜間バッチから呼ぶ）。残すのは1年ぶん */
export async function sweepContactInquiries(raw: (sql: string, params?: readonly unknown[]) => Promise<unknown[]>, keepDays = 365): Promise<number> {
  const rows = await raw(
    `DELETE FROM contact_inquiries WHERE created_at < now() - ($1 || ' days')::interval RETURNING id`,
    [String(keepDays)],
  );
  return rows.length;
}
