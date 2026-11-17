// 運営者（ツギガミを提供する側）の管理。会社を作る・直す・止める・消す、契約の控えを書く。
//
// 利用者の権限（Actor）とは別の世界。ここの関数は、会社をまたいで触れる。
//   ・運営者になれるのは、環境変数 OPERATOR_EMAILS に書いたアドレスだけ
//   ・パスワードは、そのアドレスに届く設定リンクから**本人が**決める（コードにも .env にも置かない）
//   ・2段階の確認（認証アプリの6桁）は、本人が管理画面から設定する。設定リンクのメールでは外れない
//   ・ログインは、成功も失敗も operator_logins に残す。失敗が続いたアドレスは、しばらく受け付けない
//   ・操作はすべて operator_log に残す

import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { encodeQr } from '@misenare/qr';
import { matchTotp, newTotpSecret, otpauthUri } from '../auth/totp.ts';
import { secretBoxFromEnv, type SecretBox } from '../crypto/secretBox.ts';
import type { Database } from '../db/db.ts';
import { looksLikeEmail, type Mail, type Mailer } from '../mail/mailer.ts';
import type { Storage } from '../storage/storage.ts';
import { DomainError } from './actor.ts';
import { hashToken, INVITATION_TTL_HOURS, issueToken } from './users.ts';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const OPERATOR_SESSION_HOURS = 12;
export const OPERATOR_SETUP_MINUTES = 30;
export const OPERATOR_PASSWORD_MIN = 10;
/** 試用（trial）と契約（standard）。料金は店舗数にかかわらず一律なので、段階は分けない */
export const PLANS = ['trial', 'standard'] as const;
export type Plan = typeof PLANS[number];

/**
 * ログインの失敗が続いたときに、受け付けを止める数。アドレスごとに数える（接続元を変えても同じ数え）。
 *   ・パスワードの間違い：15分に5回、または1日に20回で、**前に入ったことのないブラウザーから**を止める。
 *     前に入ったことのあるブラウザーは止めない（アドレスを知っているだけの人が、本人を締め出せないように）
 *   ・確認コードの間違い：同じ数で、**すべてのブラウザー**を止める。
 *     ここまで来るのはパスワードを知っている相手なので、本人を待たせてでも止める
 * 数えるのは、最後に入れたとき以降の失敗だけ。
 */
export const LOGIN_LOCK = { windowMinutes: 15, windowLimit: 5, dayLimit: 20 } as const;
/** 前に入ったことのあるブラウザーが、続けてこの回数間違えたら、その印を捨てる（以後は知らないブラウザーの扱い） */
export const DEVICE_FAILURE_LIMIT = 10;
/** ブラウザーの印を覚えておく日数（使うたびに延びる） */
export const DEVICE_DAYS = 365;
/** ログインの記録を残す日数 */
export const LOGIN_KEEP_DAYS = 90;
/** 予備のコードの本数 */
export const RECOVERY_CODE_COUNT = 8;
/** 認証アプリの一覧に出る名前 */
const TOTP_ISSUER = 'Tsugigami';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 80;
const MAX_NOTE = 2000;

export interface Operator { id: string; email: string }

/** ログインしてきた相手の手がかり。記録と知らせに使う */
export interface LoginClient {
  ip: string | null;
  agent: string | null;
  /** ブラウザーが持ってきた印（前に入ったことがあれば付いている） */
  device: string | null;
}

// 認証アプリと分け合う鍵は、DB に入れる前に包む（crypto/secretBox.ts。鍵を決めていなければ、そのまま入る）。
// どの運営者のものかを検印に混ぜるので、別の行に貼り替えても開けない
let box: SecretBox | null = null;
function secretBox(): SecretBox {
  box ??= secretBoxFromEnv();
  return box;
}
/** テスト用：鍵の設定を読み直す */
export function resetOperatorSecretBox(): void { box = null; }
export const totpAad = (operatorId: string): string => `operators.totp_secret:${operatorId}`;

/** 運営者として認めるアドレス（小文字）。決めていなければ、管理画面にはだれも入れない */
export function operatorEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.OPERATOR_EMAILS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => looksLikeEmail(x));
}

function fail(code: DomainError['code'], message: string): never {
  throw new DomainError(code, message);
}

function cleanName(value: unknown, label: string): string {
  const v = typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim() : '';
  if (v === '') fail('invalid', `${label}を入力してください`);
  if (v.length > MAX_NAME) fail('invalid', `${label}は${MAX_NAME}文字までです`);
  return v;
}

function tenantId(value: string): string {
  if (!UUID.test(value)) fail('not_found', '会社が見つかりません');
  return value;
}

// --- パスワード -----------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  // 登録が無いときも同じだけ計算する（かかる時間から、アドレスが運営者かどうかを読ませない）
  const salt = parts.length === 3 ? Buffer.from(parts[1]!, 'base64') : Buffer.alloc(16);
  const want = parts.length === 3 ? Buffer.from(parts[2]!, 'base64') : Buffer.alloc(32);
  const got = await scrypt(password, salt, 32);
  return parts.length === 3 && parts[0] === 'scrypt' && want.length === got.length && timingSafeEqual(want, got);
}

// --- ログイン --------------------------------------------------------------

/**
 * パスワードを決める（決め直す）リンクを、運営者のアドレスへ送る。
 * 運営者でないアドレスには何も送らない。呼び出し側は、どちらでも同じ応答を返す（この関数は投げない）。
 */
export async function requestOperatorSetup(database: Database, mailer: Mailer, appUrl: string, email: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const addr = String(email ?? '').trim().toLowerCase();
  if (!operatorEmails(env).includes(addr)) return;
  const rows = await database.raw(
    `INSERT INTO operators (email) VALUES ($1)
     ON CONFLICT (lower(email)) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
    [addr],
  ) as Array<{ id: string }>;
  const token = randomBytes(32).toString('base64url');
  await database.raw(
    `INSERT INTO operator_tokens (token_hash, operator_id, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [hashToken(token), rows[0]!.id, OPERATOR_SETUP_MINUTES],
  );
  const link = `${appUrl.replace(/\/+$/, '')}/admin/#setup=${encodeURIComponent(token)}`;
  await mailer.send({
    to: [addr],
    subject: '【ツギガミ運営】パスワードの設定',
    text: [
      'ツギガミの運営者用の管理画面で使うパスワードを決めるリンクです。',
      '',
      `下のリンクを開いて、新しいパスワードを入力してください（1回限り・${OPERATOR_SETUP_MINUTES}分以内）。`,
      link,
      '',
      'このメールに心当たりがない場合は、そのまま破棄してください。パスワードは変わりません。',
    ].join('\n'),
  });
}

/** 記録や知らせに入れる前に、外から来た文字を1行・決まった長さにそろえる */
function clip(value: string | null, max: number): string | null {
  if (value === null) return null;
  const v = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return v === '' ? null : v.slice(0, max);
}

function when(): string {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: process.env.MISENARE_TZ?.trim() || 'Asia/Tokyo', dateStyle: 'long', timeStyle: 'short' }).format(new Date());
}

function clientLines(client: LoginClient): string[] {
  return [`時刻　　　：${when()}`, `接続元　　：${clip(client.ip, 64) ?? '不明'}`, `ブラウザー：${clip(client.agent, 200) ?? '不明'}`];
}

const adminUrl = (appUrl: string): string => `${appUrl.replace(/\/+$/, '')}/admin/`;

/** このブラウザーを「前に入ったことがある」と覚える。返すのは、ブラウザーに持たせる印（DB にはハッシュだけ） */
async function rememberDevice(database: Database, operatorId: string): Promise<string> {
  const device = randomBytes(32).toString('base64url');
  await database.raw(`INSERT INTO operator_devices (token_hash, operator_id) VALUES ($1, $2)`, [hashToken(device), operatorId]);
  return device;
}

/**
 * 設定リンクでパスワードを決める。決めたら、それまでのログインはすべて切り、覚えていたブラウザーも忘れる。
 *
 * リンクを開けたのは、運営者のメールを読める人。なので、このブラウザーには「前に入ったことがある」印を付ける：
 * だれかにパスワードを間違え続けられて受け付けが止まっていても、本人はここから入り直せる。
 * 2段階の確認は、ここでは外れない（メールを読めるだけの人を、ここで止める）。
 */
export async function setOperatorPassword(database: Database, token: string, password: string, client: LoginClient, appUrl: string): Promise<{ device: string; notice: Mail }> {
  if (typeof password !== 'string' || password.length < OPERATOR_PASSWORD_MIN) fail('invalid', `パスワードは${OPERATOR_PASSWORD_MIN}文字以上にしてください`);
  if (password.length > 200) fail('invalid', 'パスワードが長すぎます');
  const used = await database.raw(
    `UPDATE operator_tokens SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING operator_id`,
    [hashToken(String(token ?? ''))],
  ) as Array<{ operator_id: string }>;
  if (used.length !== 1) fail('not_found', 'このリンクは使えません（期限切れか、使用済みです）。もう一度送り直してください');
  const operatorId = used[0]!.operator_id;
  const rows = await database.raw(
    `UPDATE operators SET password_hash = $2 WHERE id = $1 RETURNING email, totp_enabled_at::text AS totp_enabled_at`,
    [operatorId, await hashPassword(password)],
  ) as Array<{ email: string; totp_enabled_at: string | null }>;
  await database.raw(`DELETE FROM operator_sessions WHERE operator_id = $1`, [operatorId]);
  await database.raw(`DELETE FROM operator_tokens WHERE operator_id = $1`, [operatorId]);
  await database.raw(`DELETE FROM operator_devices WHERE operator_id = $1`, [operatorId]);
  const device = await rememberDevice(database, operatorId);
  await log(database, operatorId, 'パスワードを設定');
  const op = rows[0]!;
  return {
    device,
    notice: {
      to: [op.email],
      subject: '【ツギガミ運営】パスワードが設定されました',
      text: [
        'ツギガミの運営者用の管理画面のパスワードが、設定用のリンクから決め直されました。',
        'それまでのログインは、すべて切れています。',
        '',
        ...clientLines(client),
        '',
        'ご自身の操作でなければ、だれかがこのメールアドレスに届くリンクを開いています。',
        'メールのパスワードを変えたうえで、管理画面の「パスワードの設定・再設定」からもう一度決め直してください。',
        op.totp_enabled_at === null
          ? '2段階の確認をまだ設定していないので、パスワードだけで入れる状態です。管理画面の「安全」から設定できます。'
          : '2段階の確認は設定されたままです。認証アプリのコードが無ければ、入れません。',
        adminUrl(appUrl),
      ].join('\n'),
    },
  };
}

interface OperatorRow {
  id: string; email: string; password_hash: string | null;
  totp_secret: string | null; totp_enabled_at: string | null; totp_last_step: string | number | null;
}

const OPERATOR_COLUMNS = `id, email, password_hash, totp_secret, totp_enabled_at::text AS totp_enabled_at, totp_last_step`;

interface LockCounts { passwordWindow: number; passwordDay: number; codeWindow: number; codeDay: number }

/** そのアドレスへの、最後に入れたとき以降の失敗の数（1日ぶん） */
async function lockCounts(database: Database, email: string): Promise<LockCounts> {
  const rows = await database.raw(
    `SELECT count(*) FILTER (WHERE outcome = 'password' AND NOT known AND at > now() - make_interval(mins => $2))::int AS password_window,
            count(*) FILTER (WHERE outcome = 'password' AND NOT known)::int AS password_day,
            count(*) FILTER (WHERE outcome = 'code' AND at > now() - make_interval(mins => $2))::int AS code_window,
            count(*) FILTER (WHERE outcome = 'code')::int AS code_day
       FROM operator_logins
      WHERE email = $1 AND at > now() - interval '24 hours'
        AND id > coalesce((SELECT max(id) FROM operator_logins WHERE email = $1 AND outcome = 'ok'), 0)`,
    [email, LOGIN_LOCK.windowMinutes],
  ) as Array<{ password_window: number; password_day: number; code_window: number; code_day: number }>;
  const r = rows[0]!;
  return { passwordWindow: Number(r.password_window), passwordDay: Number(r.password_day), codeWindow: Number(r.code_window), codeDay: Number(r.code_day) };
}

const over = (window: number, day: number): boolean => window >= LOGIN_LOCK.windowLimit || day >= LOGIN_LOCK.dayLimit;

/** いま、そのアドレスへのログインを受け付けないか。known は、前に入ったことのあるブラウザーから来たか */
function lockedNow(c: LockCounts, known: boolean): boolean {
  return over(c.codeWindow, c.codeDay) || (!known && over(c.passwordWindow, c.passwordDay));
}

/**
 * 2つ目の確認。認証アプリの6桁か、予備のコード（1回限り）。
 * 6桁は、通した刻みを覚えておき、同じコードを二度は通さない（同時に2つ来ても、通るのは片方だけ）。
 */
async function secondFactor(database: Database, op: OperatorRow, code: unknown): Promise<boolean> {
  const text = typeof code === 'string' ? code.replace(/[\s-]/g, '') : '';
  if (op.totp_secret === null || text === '') return false;
  if (/^\d+$/.test(text)) {
    const secret = secretBox().open(op.totp_secret, totpAad(op.id));
    const step = matchTotp(secret, text, Date.now(), op.totp_last_step === null ? null : Number(op.totp_last_step));
    if (step === null) return false;
    const moved = await database.raw(
      `UPDATE operators SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id`,
      [op.id, step],
    );
    return moved.length === 1;
  }
  const used = await database.raw(
    `UPDATE operator_recovery_codes SET used_at = now() WHERE code_hash = $1 AND operator_id = $2 AND used_at IS NULL RETURNING code_hash`,
    [hashToken(text.toLowerCase()), op.id],
  );
  return used.length === 1;
}

/**
 * 失敗を記録したあとに呼ぶ。この失敗で受け付けを止めることになったなら、本人に知らせる文面を返す。
 * パスワードの間違いの知らせは1日に1通まで（打たれ続けても、受信箱を埋めない）。確認コードの間違いは、止めるたびに知らせる。
 */
async function lockNotice(database: Database, op: OperatorRow, email: string, failed: 'password' | 'code', known: boolean, client: LoginClient, appUrl: string): Promise<Mail | null> {
  const c = await lockCounts(database, email);
  const reached = (window: number, day: number): boolean => window === LOGIN_LOCK.windowLimit || day === LOGIN_LOCK.dayLimit;
  if (failed === 'code') {
    if (!reached(c.codeWindow, c.codeDay)) return null;
    return {
      to: [op.email],
      subject: '【ツギガミ運営】確認コードの間違いが続いたので、ログインを止めています',
      text: [
        'ツギガミの運営者用の管理画面で、パスワードは合っていて、確認コード（認証アプリの6桁）の間違いが続きました。',
        `すべてのブラウザーからのログインを、しばらく受け付けません（${LOGIN_LOCK.windowMinutes}分ほど。間違いが1日に${LOGIN_LOCK.dayLimit}回に達すると、最初の間違いから1日のあいだ）。`,
        '',
        ...clientLines(client),
        '',
        'ご自身でなければ、だれかがパスワードを知っています。',
        '管理画面の「パスワードの設定・再設定」から、パスワードを決め直してください。',
        adminUrl(appUrl),
      ].join('\n'),
    };
  }
  if (known || !reached(c.passwordWindow, c.passwordDay)) return null;
  const first = await database.raw(
    `UPDATE operators SET lock_notified_at = now()
      WHERE id = $1 AND (lock_notified_at IS NULL OR lock_notified_at < now() - interval '24 hours') RETURNING id`,
    [op.id],
  );
  if (first.length !== 1) return null;
  return {
    to: [op.email],
    subject: '【ツギガミ運営】ログインの失敗が続いています',
    text: [
      'ツギガミの運営者用の管理画面で、このアドレスへのログインの失敗が続きました。',
      `前に入ったことのないブラウザーからのログインを、しばらく受け付けません（${LOGIN_LOCK.windowMinutes}分ほど。失敗が1日に${LOGIN_LOCK.dayLimit}回に達すると、最初の失敗から1日のあいだ）。`,
      '前に入ったことのあるブラウザーからは、これまでどおり入れます。',
      '',
      ...clientLines(client),
      '',
      'ご自身でなければ、だれかがパスワードを当てようとしています。パスワードが合ったわけではありません。',
      'ご自身が入れなくなったときは、管理画面の「パスワードの設定・再設定」からリンクを受け取り、パスワードを決め直すと、そのブラウザーから入れます。',
      'この知らせは、失敗が続いても1日に1通までしか送りません。',
      adminUrl(appUrl),
    ].join('\n'),
  };
}

export type LoginResult =
  | { ok: true; token: string; email: string; /** ブラウザーに持たせる印 */ device: string; notice: Mail | null }
  | { ok: false; reason: 'invalid' | 'locked'; notice: Mail | null };

/**
 * メアドとパスワード（2段階の確認を設定していれば、確認コードも）で入る。
 *
 * 合わないときは、どれが違ったかを分けない（パスワードだけ当たっているかどうかを、外から確かめさせない）。
 * 運営者でないアドレスでも、同じ数え方・同じ応答にする（どのアドレスが運営者かを、止まり方から読ませない）。
 */
export async function loginOperator(
  database: Database, input: { email: unknown; password: unknown; code?: unknown }, client: LoginClient, appUrl: string, env: NodeJS.ProcessEnv = process.env,
): Promise<LoginResult> {
  const addr = String(input.email ?? '').trim().toLowerCase();
  // 記録に残すのは、アドレスの形をしたものだけ（アドレスの欄にパスワードを打ってしまったものを控えない）
  const countable = looksLikeEmail(addr) && addr.length <= 254;
  const recorded = countable ? addr : '（アドレスの形でない入力）';
  const rows = await database.raw(`SELECT ${OPERATOR_COLUMNS} FROM operators WHERE lower(email) = $1`, [addr]) as OperatorRow[];
  const op = rows[0] !== undefined && operatorEmails(env).includes(addr) ? rows[0] : undefined;
  const deviceHash = client.device ? hashToken(client.device) : null;
  const known = (await database.raw(
    `SELECT 1 FROM operator_devices WHERE token_hash = $1 AND operator_id = $2 AND last_used_at > now() - make_interval(days => $3)`,
    [deviceHash, op?.id ?? null, DEVICE_DAYS],
  )).length === 1;
  const note = (outcome: 'ok' | 'password' | 'code' | 'locked') => database.raw(
    `INSERT INTO operator_logins (email, operator_id, outcome, known, ip, agent) VALUES ($1, $2, $3, $4, $5, $6)`,
    [recorded, op?.id ?? null, outcome, known, clip(client.ip, 64), clip(client.agent, 300)],
  );

  if (countable && lockedNow(await lockCounts(database, recorded), known)) {
    await note('locked');
    return { ok: false, reason: 'locked', notice: null };
  }

  const passwordOk = await verifyPassword(String(input.password ?? ''), op?.password_hash ?? null);
  let failed: 'password' | 'code' | null = null;
  if (!op || !passwordOk) failed = 'password';
  else if (op.totp_enabled_at !== null && !(await secondFactor(database, op, input.code))) failed = 'code';
  if (failed !== null) {
    await note(failed);
    if (known) {
      await database.raw(`UPDATE operator_devices SET failures = failures + 1 WHERE token_hash = $1`, [deviceHash]);
      await database.raw(`DELETE FROM operator_devices WHERE token_hash = $1 AND failures >= $2`, [deviceHash, DEVICE_FAILURE_LIMIT]);
    }
    return { ok: false, reason: 'invalid', notice: op ? await lockNotice(database, op, recorded, failed, known, client, appUrl) : null };
  }

  const token = `op.${randomBytes(32).toString('base64url')}`;
  await database.raw(`DELETE FROM operator_sessions WHERE expires_at <= now()`);
  await database.raw(
    `INSERT INTO operator_sessions (token_hash, operator_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [hashToken(token), op!.id, OPERATOR_SESSION_HOURS],
  );
  let device = client.device ?? '';
  if (known) await database.raw(`UPDATE operator_devices SET last_used_at = now(), failures = 0 WHERE token_hash = $1`, [deviceHash]);
  else device = await rememberDevice(database, op!.id);
  await note('ok');
  const notice: Mail | null = known ? null : {
    to: [op!.email],
    subject: '【ツギガミ運営】新しいブラウザーからログインがありました',
    text: [
      'ツギガミの運営者用の管理画面に、前に入ったことのないブラウザーからログインがありました。',
      '',
      ...clientLines(client),
      '',
      'ご自身であれば、何もしなくて大丈夫です。同じブラウザーから入るあいだは、この知らせは届きません。',
      'ご自身でなければ、管理画面の「パスワードの設定・再設定」からパスワードを決め直してください。いま入っているログインは、すべて切れます。',
      op!.totp_enabled_at === null ? '2段階の確認をまだ設定していなければ、管理画面の「安全」から設定してください。' : null,
      adminUrl(appUrl),
    ].filter((line) => line !== null).join('\n'),
  };
  return { ok: true, token, email: op!.email, device, notice };
}

/** 要求に付いてきたトークンから運営者を確かめる。OPERATOR_EMAILS から外したアドレスは、その場で入れなくなる。 */
export async function verifyOperator(database: Database, token: string | null, env: NodeJS.ProcessEnv = process.env): Promise<Operator | null> {
  if (!token || !token.startsWith('op.')) return null;
  const rows = await database.raw(
    `SELECT o.id, o.email FROM operator_sessions s JOIN operators o ON o.id = s.operator_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  ) as Operator[];
  const op = rows[0];
  return op && operatorEmails(env).includes(op.email.toLowerCase()) ? op : null;
}

export async function logoutOperator(database: Database, token: string): Promise<void> {
  await database.raw(`DELETE FROM operator_sessions WHERE token_hash = $1`, [hashToken(token)]);
}

// --- 2段階の確認 ------------------------------------------------------------

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 見分けにくい i・l・o・0・1 は使わない
const RECOVERY_LENGTH = 16;

/** 予備のコードを作り直す（前のものは捨てる）。返すのは画面に見せる形（4文字ごとに区切る） */
async function freshRecoveryCodes(database: Database, operatorId: string): Promise<string[]> {
  await database.raw(`DELETE FROM operator_recovery_codes WHERE operator_id = $1`, [operatorId]);
  const codes: string[] = [];
  while (codes.length < RECOVERY_CODE_COUNT) {
    let code = '';
    for (let i = 0; i < RECOVERY_LENGTH; i++) code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    if (/^\d+$/.test(code)) continue; // 数字だけだと、認証アプリのコードとして読んでしまう
    await database.raw(`INSERT INTO operator_recovery_codes (code_hash, operator_id) VALUES ($1, $2)`, [hashToken(code), operatorId]);
    codes.push(code.replace(/(.{4})(?=.)/g, '$1-'));
  }
  return codes;
}

async function operatorRow(database: Database, operatorId: string): Promise<OperatorRow> {
  const rows = await database.raw(`SELECT ${OPERATOR_COLUMNS} FROM operators WHERE id = $1`, [operatorId]) as OperatorRow[];
  return rows[0] ?? fail('not_found', '運営者が見つかりません');
}

/** 設定を変える前に、もう一度パスワードを確かめる（ログインしたままの画面を触れただけの人に、変えさせない） */
async function requirePassword(row: OperatorRow, password: unknown): Promise<void> {
  if (!(await verifyPassword(typeof password === 'string' ? password : '', row.password_hash))) fail('forbidden', 'パスワードが違います');
}

/**
 * ログインしたあとの画面で、確認コードを確かめる。
 * ここでの間違いも、ログインのときと同じ数えに入れる（画面を触れた人が、ここで6桁を当てに来られないように）。
 */
async function requireCode(database: Database, row: OperatorRow, code: unknown, client: LoginClient): Promise<void> {
  const email = row.email.toLowerCase();
  if (lockedNow(await lockCounts(database, email), true)) fail('conflict', '確認コードの間違いが続いたので、しばらく受け付けません。時間をおいてからやり直してください');
  if (await secondFactor(database, row, code)) return;
  await database.raw(
    `INSERT INTO operator_logins (email, operator_id, outcome, known, ip, agent) VALUES ($1, $2, 'code', true, $3, $4)`,
    [email, row.id, clip(client.ip, 64), clip(client.agent, 300)],
  );
  fail('invalid', 'コードが違います。認証アプリにいま出ている6桁か、まだ使っていない予備のコードを入れてください');
}

function settingsNotice(email: string, what: string, client: LoginClient, appUrl: string): Mail {
  return {
    to: [email],
    subject: `【ツギガミ運営】${what}`,
    text: [
      `ツギガミの運営者用の管理画面で、${what}。`,
      '',
      ...clientLines(client),
      '',
      'ご自身の操作でなければ、管理画面の「パスワードの設定・再設定」からパスワードを決め直してください。いま入っているログインは、すべて切れます。',
      adminUrl(appUrl),
    ].join('\n'),
  };
}

export interface SecurityStatus {
  totp: { enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number };
}

export async function securityStatus(database: Database, op: Operator): Promise<SecurityStatus> {
  const row = await operatorRow(database, op.id);
  const left = await database.raw(`SELECT count(*)::int AS n FROM operator_recovery_codes WHERE operator_id = $1 AND used_at IS NULL`, [op.id]) as Array<{ n: number }>;
  return { totp: { enabled: row.totp_enabled_at !== null, enabledAt: row.totp_enabled_at, recoveryCodesLeft: Number(left[0]!.n) } };
}

/**
 * 2段階の確認の設定を始める。認証アプリと分け合う鍵を作って返す。
 * 認証アプリに出たコードを enableTotp で確かめるまでは、有効にならない（読み取りに失敗したまま締め出されないように）。
 */
export async function startTotp(database: Database, op: Operator, password: unknown): Promise<{ secret: string; uri: string; qr: string[] }> {
  const row = await operatorRow(database, op.id);
  await requirePassword(row, password);
  if (row.totp_enabled_at !== null) fail('conflict', '2段階の確認は、もう設定してあります。認証アプリを替えるときは、いったん外してから設定し直してください');
  const secret = newTotpSecret();
  await database.raw(`UPDATE operators SET totp_secret = $2, totp_last_step = NULL WHERE id = $1 AND totp_enabled_at IS NULL`, [op.id, secretBox().seal(secret, totpAad(op.id))]);
  const uri = otpauthUri(secret, row.email, TOTP_ISSUER);
  return { secret, uri, qr: encodeQr(uri).modules.map((line) => line.map((on) => (on ? '1' : '0')).join('')) };
}

/** 認証アプリに出たコードを確かめて、有効にする。予備のコードを返す（見せるのはこの1回だけ）。 */
export async function enableTotp(database: Database, op: Operator, code: unknown, client: LoginClient, appUrl: string): Promise<{ recoveryCodes: string[]; notice: Mail }> {
  const row = await operatorRow(database, op.id);
  if (row.totp_enabled_at !== null) fail('conflict', '2段階の確認は、もう設定してあります');
  if (row.totp_secret === null) fail('conflict', '先に「設定を始める」を押してください');
  const text = typeof code === 'string' ? code : '';
  const step = matchTotp(secretBox().open(row.totp_secret, totpAad(op.id)), text, Date.now());
  if (step === null) fail('invalid', 'コードが違います。認証アプリにいま出ている6桁を入れてください');
  const done = await database.raw(
    `UPDATE operators SET totp_enabled_at = now(), totp_last_step = $2 WHERE id = $1 AND totp_enabled_at IS NULL RETURNING id`,
    [op.id, step],
  );
  if (done.length !== 1) fail('conflict', '2段階の確認は、もう設定してあります');
  const recoveryCodes = await freshRecoveryCodes(database, op.id);
  await log(database, op.id, '2段階の確認を設定');
  return { recoveryCodes, notice: settingsNotice(row.email, '2段階の確認が設定されました', client, appUrl) };
}

/**
 * 2段階の確認を外す。パスワードと、いまのコード（か予備のコード）の両方が要る。
 * 設定の途中（まだ有効にしていない）なら、作りかけの鍵を捨てるだけ。
 */
export async function disableTotp(database: Database, op: Operator, password: unknown, code: unknown, client: LoginClient, appUrl: string): Promise<{ notice: Mail | null }> {
  const row = await operatorRow(database, op.id);
  await requirePassword(row, password);
  if (row.totp_enabled_at === null) {
    await database.raw(`UPDATE operators SET totp_secret = NULL, totp_last_step = NULL WHERE id = $1 AND totp_enabled_at IS NULL`, [op.id]);
    return { notice: null };
  }
  await requireCode(database, row, code, client);
  await database.raw(`UPDATE operators SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1`, [op.id]);
  await database.raw(`DELETE FROM operator_recovery_codes WHERE operator_id = $1`, [op.id]);
  await log(database, op.id, '2段階の確認を解除');
  return { notice: settingsNotice(row.email, '2段階の確認が外されました', client, appUrl) };
}

/** 予備のコードを作り直す（前のものは使えなくなる）。 */
export async function regenerateRecoveryCodes(database: Database, op: Operator, password: unknown, code: unknown, client: LoginClient, appUrl: string): Promise<{ recoveryCodes: string[]; notice: Mail }> {
  const row = await operatorRow(database, op.id);
  await requirePassword(row, password);
  if (row.totp_enabled_at === null) fail('conflict', '2段階の確認を設定していません');
  await requireCode(database, row, code, client);
  const recoveryCodes = await freshRecoveryCodes(database, op.id);
  await log(database, op.id, '予備のコードを作り直し');
  return { recoveryCodes, notice: settingsNotice(row.email, '予備のコードが作り直されました', client, appUrl) };
}

/**
 * 認証アプリも予備のコードも無くしたときの、最後の戻り道。サーバーの中から流す（cli/operator-2fa-off.ts）。
 * 画面やメールからは、ここには来られない。
 */
export async function forceDisableTotp(database: Database, email: string): Promise<boolean> {
  const rows = await database.raw(
    `UPDATE operators SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE lower(email) = $1 RETURNING id`,
    [email.trim().toLowerCase()],
  ) as Array<{ id: string }>;
  if (rows.length !== 1) return false;
  const id = rows[0]!.id;
  await database.raw(`DELETE FROM operator_recovery_codes WHERE operator_id = $1`, [id]);
  await database.raw(`DELETE FROM operator_sessions WHERE operator_id = $1`, [id]);
  await log(database, id, '2段階の確認を解除', undefined, 'サーバーの中から（cli）');
  return true;
}

// --- 記録 ------------------------------------------------------------------

async function log(database: Database, operatorId: string, action: string, tenant?: { id: string; name: string }, detail?: string): Promise<void> {
  await database.raw(
    `INSERT INTO operator_log (operator_id, action, tenant_id, tenant_name, detail) VALUES ($1, $2, $3, $4, $5)`,
    [operatorId, action, tenant?.id ?? null, tenant?.name ?? null, detail ?? null],
  );
}

export interface LogEntry { id: number; at: string; operator: string | null; action: string; tenantName: string | null; detail: string | null }

const PAGE = 30;

/** before より前を読むための番号。形が違えば、最初から */
function cursor(before: unknown): number | null {
  const n = typeof before === 'string' && /^\d{1,15}$/.test(before) ? Number(before) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 操作の記録を、新しい順に30件。next があれば、それを before に渡すと続きが読める */
export async function recentLog(database: Database, before?: unknown): Promise<{ entries: LogEntry[]; next: number | null }> {
  const rows = await database.raw(
    `SELECT l.id, l.at::text AS at, o.email AS operator, l.action, l.tenant_name, l.detail
       FROM operator_log l LEFT JOIN operators o ON o.id = l.operator_id
      WHERE ($1::bigint IS NULL OR l.id < $1)
      ORDER BY l.id DESC LIMIT $2`,
    [cursor(before), PAGE + 1],
  ) as Array<{ id: string | number; at: string; operator: string | null; action: string; tenant_name: string | null; detail: string | null }>;
  const entries = rows.slice(0, PAGE).map((r) => ({ id: Number(r.id), at: r.at, operator: r.operator, action: r.action, tenantName: r.tenant_name, detail: r.detail }));
  return { entries, next: rows.length > PAGE ? entries.at(-1)!.id : null };
}

export interface LoginEntry {
  id: number; at: string; email: string; outcome: 'ok' | 'password' | 'code' | 'locked';
  known: boolean; ip: string | null; agent: string | null;
}

/** ログインの記録（成功も失敗も）を、新しい順に30件 */
export async function recentLogins(database: Database, before?: unknown): Promise<{ entries: LoginEntry[]; next: number | null }> {
  const rows = await database.raw(
    `SELECT id, at::text AS at, email, outcome, known, ip, agent FROM operator_logins
      WHERE ($1::bigint IS NULL OR id < $1) ORDER BY id DESC LIMIT $2`,
    [cursor(before), PAGE + 1],
  ) as Array<Omit<LoginEntry, 'id'> & { id: string | number }>;
  const entries = rows.slice(0, PAGE).map((r) => ({ ...r, id: Number(r.id) }));
  return { entries, next: rows.length > PAGE ? entries.at(-1)!.id : null };
}

/** 古い記録を片付ける（夜間バッチから呼ぶ）。ログインの記録は90日、使われなくなったブラウザーの印は1年 */
export async function sweepOperatorRecords(raw: (sql: string, params?: readonly unknown[]) => Promise<unknown[]>): Promise<number> {
  const logins = await raw(`DELETE FROM operator_logins WHERE at < now() - make_interval(days => $1) RETURNING id`, [LOGIN_KEEP_DAYS]);
  await raw(`DELETE FROM operator_devices WHERE last_used_at < now() - make_interval(days => $1)`, [DEVICE_DAYS]);
  await raw(`DELETE FROM operator_sessions WHERE expires_at <= now()`);
  await raw(`DELETE FROM operator_tokens WHERE expires_at <= now() - interval '1 day'`);
  return logins.length;
}

// --- 問い合わせ --------------------------------------------------------------

export interface Inquiry { id: string; at: string; name: string; company: string | null; email: string; message: string; mailed: boolean }

/**
 * 紹介サイトのフォームから届いた問い合わせを、新しい順に30件。
 * 届いたときにメールでも知らせているが、メールを送れなかったもの（mailed = false）は、ここでしか読めない。
 */
export async function listInquiries(database: Database, before?: unknown): Promise<{ inquiries: Inquiry[]; next: string | null; unmailed: number }> {
  // 続きの目印は、前の応答の最後の時刻（DB が出した形のまま）。DB に読ませるので、形だけ確かめる
  const at = typeof before === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/.test(before) ? before : null;
  const rows = await database.raw(
    `SELECT id, created_at::text AS at, name, company, email, message, mailed FROM contact_inquiries
      WHERE ($1::timestamptz IS NULL OR created_at < $1) ORDER BY created_at DESC, id LIMIT $2`,
    [at, PAGE + 1],
  ) as Inquiry[];
  const inquiries = rows.slice(0, PAGE);
  const unmailed = await database.raw(`SELECT count(*)::int AS n FROM contact_inquiries WHERE NOT mailed`) as Array<{ n: number }>;
  return { inquiries, next: rows.length > PAGE ? inquiries.at(-1)!.at : null, unmailed: Number(unmailed[0]!.n) };
}

// --- 会社 ------------------------------------------------------------------

interface TenantRow {
  id: string; name: string; plan: Plan; status: 'active' | 'suspended'; created_at: string; suspended_at: string | null;
  contracted_stores: number | null; period_end: string | null; billing_note: string | null;
  billing_customer_id: string | null; billing_subscription_id: string | null;
}

export interface TenantSummary {
  id: string; name: string; plan: Plan; status: 'active' | 'suspended'; createdAt: string; suspendedAt: string | null;
  contractedStores: number | null; periodEnd: string | null; billingNote: string | null;
  billingCustomerId: string | null; billingSubscriptionId: string | null;
  stores: number; users: number; knowledge: number;
}

export interface TenantDetail extends TenantSummary {
  storeList: Array<{ id: string; name: string; members: number; knowledge: number }>;
  admins: Array<{ name: string; email: string | null }>;
}

const TENANT_COLUMNS = `id, name, plan, status, created_at::text AS created_at, suspended_at::text AS suspended_at,
  contracted_stores, period_end::text AS period_end, billing_note, billing_customer_id, billing_subscription_id`;

async function tenantRow(database: Database, id: string): Promise<TenantRow> {
  const rows = await database.raw(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`, [tenantId(id)]) as TenantRow[];
  return rows[0] ?? fail('not_found', '会社が見つかりません');
}

async function summarize(database: Database, t: TenantRow): Promise<TenantSummary> {
  // 店舗・利用者・ナレッジは行レベルセキュリティの内側なので、その会社として数える
  const c = await database.withTenant(t.id, (db) => db.query<{ stores: number; users: number; knowledge: number }>(
    `SELECT (SELECT count(*) FROM stores)::int AS stores,
            (SELECT count(*) FROM users WHERE status = 'active')::int AS users,
            (SELECT count(*) FROM knowledge)::int AS knowledge`,
  ));
  return {
    id: t.id, name: t.name, plan: t.plan, status: t.status, createdAt: t.created_at, suspendedAt: t.suspended_at,
    contractedStores: t.contracted_stores, periodEnd: t.period_end, billingNote: t.billing_note,
    billingCustomerId: t.billing_customer_id, billingSubscriptionId: t.billing_subscription_id,
    stores: Number(c[0]!.stores), users: Number(c[0]!.users), knowledge: Number(c[0]!.knowledge),
  };
}

export async function listTenants(database: Database): Promise<TenantSummary[]> {
  const rows = await database.raw(`SELECT ${TENANT_COLUMNS} FROM tenants ORDER BY created_at DESC, name`) as TenantRow[];
  const out: TenantSummary[] = [];
  for (const t of rows) out.push(await summarize(database, t));
  return out;
}

export async function getTenant(database: Database, id: string): Promise<TenantDetail> {
  const t = await tenantRow(database, id);
  const summary = await summarize(database, t);
  const { storeList, admins } = await database.withTenant(t.id, async (db) => ({
    storeList: await db.query<{ id: string; name: string; members: number; knowledge: number }>(
      `SELECT s.id, s.name,
              (SELECT count(*) FROM memberships m WHERE m.store_id = s.id)::int AS members,
              (SELECT count(*) FROM knowledge k WHERE k.store_id = s.id)::int AS knowledge
         FROM stores s ORDER BY s.name`,
    ),
    admins: await db.query<{ name: string; email: string | null }>(
      `SELECT name, email FROM users WHERE admin_scope = 'tenant' AND status = 'active' ORDER BY name`,
    ),
  }));
  return { ...summary, storeList: storeList.map((s) => ({ ...s, members: Number(s.members), knowledge: Number(s.knowledge) })), admins };
}

export interface TenantUser {
  id: string; name: string; adminScope: 'none' | 'store' | 'tenant'; trustLevel: 'visitor' | 'trusted'; status: 'active' | 'disabled';
  stores: string[]; devices: number; lastUsedAt: string | null;
}

/**
 * その会社の利用者の一覧（止めた人も含む）。
 * メールアドレスは出さない：運営者が要るのは「だれを止めるか」で、連絡先ではない（本部の管理者のものだけ、会社の画面に出している）。
 */
export async function listTenantUsers(database: Database, id: string): Promise<TenantUser[]> {
  const t = await tenantRow(database, id);
  const rows = await database.withTenant(t.id, (db) => db.query<{
    id: string; name: string; admin_scope: TenantUser['adminScope']; trust_level: TenantUser['trustLevel']; status: TenantUser['status'];
    stores: string[]; devices: number; last_used_at: string | null;
  }>(
    `SELECT u.id, u.name, u.admin_scope, u.trust_level, u.status,
            coalesce((SELECT array_agg(s.name ORDER BY s.name) FROM memberships m JOIN stores s ON s.id = m.store_id WHERE m.user_id = u.id), '{}') AS stores,
            (SELECT count(*)::int FROM sessions x WHERE x.user_id = u.id AND x.revoked_at IS NULL) AS devices,
            (SELECT max(x.last_used_at)::text FROM sessions x WHERE x.user_id = u.id AND x.revoked_at IS NULL) AS last_used_at
       FROM users u
      ORDER BY (u.status = 'active') DESC, CASE u.admin_scope WHEN 'tenant' THEN 0 WHEN 'store' THEN 1 ELSE 2 END, u.name, u.id`,
  ));
  return rows.map((r) => ({
    id: r.id, name: r.name, adminScope: r.admin_scope, trustLevel: r.trust_level, status: r.status,
    stores: r.stores, devices: Number(r.devices), lastUsedAt: r.last_used_at,
  }));
}

/**
 * 利用者を止める・戻す。止めると、その人の端末はすべて使えなくなる（アプリの中で本部が「無効にする」のと同じ）。
 * 本部の人が辞めたあとに残った、会社の中からはだれも止められない、というときのための口。
 */
export async function setTenantUserStatus(database: Database, op: Operator, id: string, userId: string, status: unknown): Promise<void> {
  const t = await tenantRow(database, id);
  if (!UUID.test(userId)) fail('not_found', '利用者が見つかりません');
  if (status !== 'active' && status !== 'disabled') fail('invalid', '状態は active か disabled です');
  const name = await database.withTenant(t.id, async (db) => {
    const rows = await db.query<{ name: string; status: string }>(`SELECT name, status FROM users WHERE id = $1`, [userId]);
    const u = rows[0] ?? fail('not_found', '利用者が見つかりません');
    if (u.status === status) return null;
    await db.query(`UPDATE users SET status = $2 WHERE id = $1`, [userId, status]);
    if (status === 'disabled') await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    return u.name;
  });
  if (name !== null) await log(database, op.id, status === 'disabled' ? '利用者を停止' : '利用者を再開', t, `「${name}」`);
}

/** 本部の管理者として入るための招待（1回限り）。画面には URL で見せる。 */
async function adminInvite(database: Database, id: string, name: string, appUrl: string): Promise<{ url: string; hours: number }> {
  const token = issueToken(id);
  await database.withTenant(id, (db) => db.query(
    `INSERT INTO invitations (tenant_id, token_hash, store_id, name, trust_level, admin_scope, expires_at)
     VALUES ($1, $2, NULL, $3, 'trusted', 'tenant', now() + make_interval(hours => $4))`,
    [id, hashToken(token), name, INVITATION_TTL_HOURS],
  ));
  return { url: `${appUrl.replace(/\/+$/, '')}/app/#invite=${encodeURIComponent(token)}`, hours: INVITATION_TTL_HOURS };
}

export interface CreateTenantInput { name?: unknown; storeName?: unknown; adminName?: unknown; plan?: unknown }

/** 会社と最初の店舗を作り、本部の管理者への招待を出す（cli/bootstrap.ts と同じことを画面から）。 */
export async function createTenant(database: Database, op: Operator, input: CreateTenantInput, appUrl: string): Promise<{ id: string; invite: { url: string; hours: number } }> {
  const name = cleanName(input.name, '会社名');
  const storeName = cleanName(input.storeName, '店舗名');
  const adminName = cleanName(input.adminName, '管理者の名前');
  const plan = parsePlan(input.plan ?? 'trial');
  const rows = await database.raw(`INSERT INTO tenants (name, plan) VALUES ($1, $2) RETURNING id`, [name, plan]) as Array<{ id: string }>;
  const id = rows[0]!.id;
  await database.withTenant(id, (db) => db.query(`INSERT INTO stores (tenant_id, name) VALUES ($1, $2)`, [id, storeName]));
  const invite = await adminInvite(database, id, adminName, appUrl);
  await log(database, op.id, '会社を作成', { id, name }, `店舗「${storeName}」・管理者「${adminName}」・${plan}`);
  return { id, invite };
}

export async function issueAdminInvite(database: Database, op: Operator, id: string, adminName: unknown, appUrl: string): Promise<{ url: string; hours: number }> {
  const t = await tenantRow(database, id);
  const name = cleanName(adminName, '管理者の名前');
  const invite = await adminInvite(database, t.id, name, appUrl);
  await log(database, op.id, '管理者の招待を発行', t, `「${name}」`);
  return invite;
}

function parsePlan(value: unknown): Plan {
  return (PLANS as readonly unknown[]).includes(value) ? value as Plan : fail('invalid', 'プランは trial（試用）か standard（契約）です');
}

export interface UpdateTenantInput {
  name?: unknown; plan?: unknown; contractedStores?: unknown; periodEnd?: unknown; billingNote?: unknown;
  billingCustomerId?: unknown; billingSubscriptionId?: unknown;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail('invalid', `${label}の形が正しくありません`);
  const v = value.trim();
  if (v.length > max) fail('invalid', `${label}は${max}文字までです`);
  return v === '' ? null : v;
}

/** 名前と契約の控えを書き換える。渡された項目だけを変える。 */
export async function updateTenant(database: Database, op: Operator, id: string, input: UpdateTenantInput): Promise<void> {
  const t = await tenantRow(database, id);
  const next = {
    name: input.name === undefined ? t.name : cleanName(input.name, '会社名'),
    plan: input.plan === undefined ? t.plan : parsePlan(input.plan),
    contractedStores: t.contracted_stores,
    periodEnd: t.period_end,
    billingNote: input.billingNote === undefined ? t.billing_note : optionalText(input.billingNote, 'メモ', MAX_NOTE),
    customer: input.billingCustomerId === undefined ? t.billing_customer_id : optionalText(input.billingCustomerId, '決済の顧客ID', 200),
    subscription: input.billingSubscriptionId === undefined ? t.billing_subscription_id : optionalText(input.billingSubscriptionId, '決済の契約ID', 200),
  };
  if (input.contractedStores !== undefined) {
    const n = input.contractedStores === null || input.contractedStores === '' ? null : Number(input.contractedStores);
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > 100000)) fail('invalid', '契約店舗数は0以上の整数で入力してください');
    next.contractedStores = n;
  }
  if (input.periodEnd !== undefined) {
    const d = input.periodEnd === null || input.periodEnd === '' ? null : String(input.periodEnd);
    if (d !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) fail('invalid', '有効期限は 2027-03-31 の形で入力してください');
    next.periodEnd = d;
  }
  await database.raw(
    `UPDATE tenants SET name = $2, plan = $3, contracted_stores = $4, period_end = $5, billing_note = $6,
            billing_customer_id = $7, billing_subscription_id = $8 WHERE id = $1`,
    [t.id, next.name, next.plan, next.contractedStores, next.periodEnd, next.billingNote, next.customer, next.subscription],
  );
  const changed: string[] = [];
  if (next.name !== t.name) changed.push(`名前「${t.name}」→「${next.name}」`);
  if (next.plan !== t.plan) changed.push(`プラン ${t.plan}→${next.plan}`);
  if (next.contractedStores !== t.contracted_stores) changed.push(`契約店舗数 ${t.contracted_stores ?? '未設定'}→${next.contractedStores ?? '未設定'}`);
  if (next.periodEnd !== t.period_end) changed.push(`有効期限 ${t.period_end ?? '未設定'}→${next.periodEnd ?? '未設定'}`);
  if (next.billingNote !== t.billing_note) changed.push('メモ');
  if (next.customer !== t.billing_customer_id || next.subscription !== t.billing_subscription_id) changed.push('決済のID');
  if (changed.length > 0) await log(database, op.id, '会社を編集', { id: t.id, name: next.name }, changed.join('、'));
}

/** 利用を止める。その会社の利用者は何もできなくなるが、データはそのまま残る。 */
export async function suspendTenant(database: Database, op: Operator, id: string): Promise<void> {
  const t = await tenantRow(database, id);
  if (t.status === 'suspended') return;
  await database.raw(`UPDATE tenants SET status = 'suspended', suspended_at = now() WHERE id = $1`, [t.id]);
  await log(database, op.id, '利用を停止', t);
}

export async function resumeTenant(database: Database, op: Operator, id: string): Promise<void> {
  const t = await tenantRow(database, id);
  if (t.status === 'active') return;
  await database.raw(`UPDATE tenants SET status = 'active', suspended_at = NULL WHERE id = $1`, [t.id]);
  await log(database, op.id, '利用を再開', t);
}

/**
 * 会社を完全に消す。店舗・利用者・ナレッジ・写真まで、すべて消えて元に戻せない。
 * 手が滑らないように、**停止してある会社だけ**・**会社名を打ち込んで一致したときだけ**消す。
 */
export async function deleteTenant(database: Database, storage: Storage, op: Operator, id: string, confirmName: unknown): Promise<void> {
  const t = await tenantRow(database, id);
  if (t.status !== 'suspended') fail('conflict', '先に利用を停止してください。完全に消せるのは、停止してある会社だけです');
  if (typeof confirmName !== 'string' || confirmName.trim() !== t.name) fail('invalid', '確認のために打ち込んだ会社名が一致しません');
  const photos = await database.withTenant(t.id, (db) => db.query<{ storage_key: string }>(`SELECT storage_key FROM knowledge_photos`));
  const gone = await database.raw(`DELETE FROM tenants WHERE id = $1 AND status = 'suspended' RETURNING id`, [t.id]);
  if (gone.length !== 1) fail('conflict', '消せませんでした。画面を読み込み直して、状態を確かめてください');
  await log(database, op.id, '会社を完全に削除', t, `写真 ${photos.length} 枚`);
  // 写真の実体は DB の外にある。行が消えたあとで片付ける（失敗しても、だれにも見えない孤児が残るだけ）
  for (const p of photos) await storage.remove(p.storage_key).catch(() => {});
}

// --- 店舗 ------------------------------------------------------------------

export async function addStore(database: Database, op: Operator, id: string, name: unknown): Promise<{ id: string }> {
  const t = await tenantRow(database, id);
  const storeName = cleanName(name, '店舗名');
  const rows = await database.withTenant(t.id, (db) => db.query<{ id: string }>(`INSERT INTO stores (tenant_id, name) VALUES ($1, $2) RETURNING id`, [t.id, storeName]));
  await log(database, op.id, '店舗を追加', t, `「${storeName}」`);
  return { id: rows[0]!.id };
}

export async function renameStore(database: Database, op: Operator, id: string, storeId: string, name: unknown): Promise<void> {
  const t = await tenantRow(database, id);
  const storeName = cleanName(name, '店舗名');
  if (!UUID.test(storeId)) fail('not_found', '店舗が見つかりません');
  const rows = await database.withTenant(t.id, (db) => db.query<{ id: string }>(`UPDATE stores SET name = $2 WHERE id = $1 RETURNING id`, [storeId, storeName]));
  if (rows.length !== 1) fail('not_found', '店舗が見つかりません');
  await log(database, op.id, '店舗名を変更', t, `「${storeName}」`);
}

/**
 * 店舗を消す。消すと、その店舗のナレッジや連絡も一緒に消えるので、
 * **だれも所属しておらず、ナレッジも無い店舗だけ**消せるようにする（最後の1店舗は消せない）。
 */
export async function removeStore(database: Database, op: Operator, id: string, storeId: string): Promise<void> {
  const t = await tenantRow(database, id);
  if (!UUID.test(storeId)) fail('not_found', '店舗が見つかりません');
  const name = await database.withTenant(t.id, async (db) => {
    const rows = await db.query<{ name: string; members: number; knowledge: number; total: number }>(
      `SELECT s.name,
              (SELECT count(*) FROM memberships m WHERE m.store_id = s.id)::int AS members,
              (SELECT count(*) FROM knowledge k WHERE k.store_id = s.id)::int AS knowledge,
              (SELECT count(*) FROM stores)::int AS total
         FROM stores s WHERE s.id = $1`,
      [storeId],
    );
    const s = rows[0] ?? fail('not_found', '店舗が見つかりません');
    if (Number(s.total) <= 1) fail('conflict', '最後の1店舗は消せません。会社ごと消す場合は、停止してから完全削除してください');
    if (Number(s.members) > 0 || Number(s.knowledge) > 0) fail('conflict', `この店舗には利用者が${s.members}人、ナレッジが${s.knowledge}件あります。空の店舗だけ消せます`);
    await db.query(`DELETE FROM stores WHERE id = $1`, [storeId]);
    return s.name;
  });
  await log(database, op.id, '店舗を削除', t, `「${name}」`);
}
