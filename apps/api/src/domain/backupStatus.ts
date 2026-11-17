// 退避（バックアップ）の結果を読んで、運営者に伝える。
//
// 退避を取るのは compose の backup サービス（deploy/backup/backup.sh）で、アプリは取らない。
// アプリがするのは2つ：
//   * backup サービスが書いた小さな結果のファイル（BACKUP_STATUS_FILE）を読んで、運営者の画面に出す
//   * 取れていない状態が続いたら、夜間バッチから運営者にメールで知らせる
// 退避そのもの（DB の書き出しと写真の写し）は、アプリからは見えない場所にある。
//
// なぜ要るか：取っているつもりの退避が、いつの間にか止まっていた、がいちばん多い失い方だから。
// 仕組みを置くだけでなく、止まったら人に届くところまでを1つにする。

import { readFile } from 'node:fs/promises';
import type { Mail } from '../mail/mailer.ts';
import { operatorEmails } from './operator.ts';

/** 毎晩1回取るので、これより長く結果が更新されなければ、仕組みそのものが止まっているとみなす */
export const BACKUP_STALE_HOURS = 36;
/** 取れていない知らせは、直るまで何日に1通か */
export const BACKUP_ALERT_EVERY_DAYS = 7;
/** 結果のファイルの大きさ。ふつうは数百バイト。これを超えるものは読まない */
const MAX_STATUS_BYTES = 16 * 1024;

/**
 *   off     … この台では退避の結果を読む設定になっていない（BACKUP_STATUS_FILE が無い）
 *   waiting … 設定はあるが、まだ1回も結果が書かれていない
 *   ok      … 最後の1回が取れていて、新しい
 *   failed  … 最後の1回が失敗した
 *   stale   … 結果が古い（退避の仕組みが止まっている）
 */
export type BackupState = 'off' | 'waiting' | 'ok' | 'failed' | 'stale';

export interface BackupView {
  state: BackupState;
  /** 最後に走った時刻 */
  lastRunAt: string | null;
  /** 最後に取れた時刻 */
  lastSuccessAt: string | null;
  /** 失敗したときの理由（backup.sh が決めた文） */
  error: string | null;
  db: { bytes: number; tables: number } | null;
  photos: { files: number; bytes: number } | null;
  /** 残してある退避の数と、残す日数 */
  kept: number | null;
  keepDays: number | null;
  /** 元から消えた写真を、写しの側に残す日数 */
  photoGraceDays: number | null;
  /** 置き場所の空き（MB） */
  freeMb: number | null;
}

const EMPTY: Omit<BackupView, 'state'> = {
  lastRunAt: null, lastSuccessAt: null, error: null, db: null, photos: null, kept: null, keepDays: null, photoGraceDays: null, freeMb: null,
};

// ファイルは別のコンテナが書いたもの。形を確かめてから使う（そのまま画面やメールに流さない）
const time = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v !== '' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null);
const record = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** 結果のファイルの中身から、画面に出す形を作る */
export function interpretBackupStatus(raw: string, now: number = Date.now()): BackupView {
  let parsed: Record<string, unknown> | null = null;
  try { parsed = record(JSON.parse(raw)); } catch { /* 下でまとめて扱う */ }
  const lastRunAt = time(parsed?.finishedAt);
  if (!parsed || lastRunAt === null) return { ...EMPTY, state: 'failed', error: '退避の結果を読めませんでした（ファイルの形が正しくありません）' };

  const db = record(parsed.db);
  const photos = record(parsed.photos);
  const dbBytes = count(db?.bytes);
  const dbTables = count(db?.tables);
  const photoFiles = count(photos?.files);
  const photoBytes = count(photos?.bytes);
  const ok = parsed.ok === true;
  const old = now - Date.parse(lastRunAt) > BACKUP_STALE_HOURS * 3600_000;
  return {
    state: old ? 'stale' : ok ? 'ok' : 'failed',
    lastRunAt,
    lastSuccessAt: time(parsed.lastSuccessAt),
    error: ok ? null : text(parsed.error, 200) ?? '退避に失敗しました',
    db: ok && dbBytes !== null && dbTables !== null ? { bytes: dbBytes, tables: dbTables } : null,
    photos: photoFiles !== null && photoBytes !== null ? { files: photoFiles, bytes: photoBytes } : null,
    kept: count(parsed.kept),
    keepDays: count(parsed.keepDays),
    photoGraceDays: count(parsed.photoGraceDays),
    freeMb: count(parsed.freeMb),
  };
}

/** 退避の結果を読む。設定が無ければ off、ファイルがまだ無ければ waiting */
export async function readBackupStatus(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): Promise<BackupView> {
  const file = env.BACKUP_STATUS_FILE?.trim();
  if (!file) return { ...EMPTY, state: 'off' };
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY, state: 'waiting' };
    return { ...EMPTY, state: 'failed', error: '退避の結果を読めませんでした' };
  }
  if (raw.byteLength > MAX_STATUS_BYTES) return { ...EMPTY, state: 'failed', error: '退避の結果を読めませんでした（ファイルが大きすぎます）' };
  return interpretBackupStatus(raw.toString('utf8'), now);
}

type Raw = (sql: string, params?: readonly unknown[]) => Promise<unknown[]>;

const jst = (iso: string | null): string => (iso === null ? 'まだありません' : `${new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(iso))}（日本時間）`);

/**
 * 退避が取れていないことを、運営者に知らせるメールを作る（夜間バッチから呼ぶ）。
 * 知らせるのは「取れていない」ときだけ。同じ状態が続くあいだは BACKUP_ALERT_EVERY_DAYS 日に1通までにし、
 * 取れるようになったら覚えを消す（次に起きたら、すぐ知らせる）。知らせないときは null。
 */
export async function backupAlert(
  raw: Raw, view: BackupView, appUrl: string, env: NodeJS.ProcessEnv = process.env,
): Promise<Mail | null> {
  if (view.state === 'off') return null;
  if (view.state === 'ok') {
    await raw(`DELETE FROM operator_alerts WHERE kind = 'backup'`);
    return null;
  }
  const to = operatorEmails(env);
  if (to.length === 0) return null;
  // 送る番を取れたときだけ送る（前に送ってから日が浅ければ、行は変わらず、何も返らない）
  const turn = await raw(
    `INSERT INTO operator_alerts AS a (kind, sent_at) VALUES ('backup', now())
     ON CONFLICT (kind) DO UPDATE SET sent_at = now()
       WHERE a.sent_at < now() - make_interval(days => $1)
     RETURNING kind`,
    [BACKUP_ALERT_EVERY_DAYS],
  );
  if (turn.length !== 1) return null;

  const what = view.state === 'waiting' ? '退避の仕組みが、まだ1回も結果を書いていません（backup サービスが動いていないかもしれません）。'
    : view.state === 'stale' ? `退避の結果が ${BACKUP_STALE_HOURS} 時間より前のまま、新しくなっていません（backup サービスが止まっているかもしれません）。`
    : `最後の退避が取れませんでした。理由：${view.error ?? '分かりません'}`;
  return {
    to,
    subject: '【ツギガミ運営】退避（バックアップ）が取れていません',
    text: [
      'ツギガミのデータベースと写真の退避（バックアップ）が、取れていません。',
      '',
      what,
      `最後に走ったのは：${jst(view.lastRunAt)}`,
      `最後に取れたのは：${jst(view.lastSuccessAt)}`,
      ...(view.freeMb === null ? [] : [`置き場所の空き：${view.freeMb}MB`]),
      '',
      'このままだと、操作の誤りや故障のときに戻せるのは、最後に取れた時点までです。',
      'サーバーの中で、次を確かめてください（くわしくは運用の手引き docs/deploy.md の 15 章）。',
      '  cd /opt/misenare/deploy',
      '  sudo docker compose ps backup',
      '  sudo docker compose logs --tail 30 backup',
      '  sudo docker compose exec -T backup bash /opt/backup/backup.sh once',
      '',
      `いまの状態は、管理画面の「安全」でも見られます。${appUrl.replace(/\/+$/, '')}/admin/#/security`,
      `この知らせは、取れるようになるまで ${BACKUP_ALERT_EVERY_DAYS} 日に1通だけ送ります。`,
    ].join('\n'),
  };
}
