// 退避（バックアップ）の様子を、運営者に伝えるところ。
//
// 退避を取るのは別のコンテナ（deploy/backup/backup.sh）で、アプリは結果のファイルを読むだけ。
// 確かめたいのは
//   ・取れている／失敗した／止まっている／まだ1回も取っていない、を取り違えない
//   ・結果のファイルが壊れていても、落ちずに「読めませんでした」と言う（別のコンテナが書いたものを、そのまま信じない）
//   ・運営者の画面からはログインしないと読めない
//   ・取れていなければメールで知らせ、同じことを毎晩は送らず、直ったら次にすぐ知らせる

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runNightly } from '../src/batch/nightly.ts';
import { BACKUP_ALERT_EVERY_DAYS, BACKUP_STALE_HOURS, interpretBackupStatus, readBackupStatus } from '../src/domain/backupStatus.ts';
import { createApp } from '../src/http/app.ts';
import { SessionAuthenticator } from '../src/http/auth.ts';
import { MemoryRateLimiter } from '../src/http/rateLimit.ts';
import type { Mail, Mailer } from '../src/mail/mailer.ts';
import { freshDatabase, tokenizer } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

const NOW = Date.parse('2026-11-18T18:30:00Z');
const hoursAgo = (h: number): string => new Date(NOW - h * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
/** backup.sh が書く形 */
const status = (over: Record<string, unknown> = {}): string => JSON.stringify({
  version: 1, startedAt: hoursAgo(0.51), finishedAt: hoursAgo(0.5), ok: true, error: null, lastSuccessAt: hoursAgo(0.5),
  db: { file: 'misenare-20261118-180001.dump', bytes: 1_300_000, tables: 46 },
  photos: { files: 245, bytes: 52_000_000, copied: 3, removed: 1 },
  kept: 14, oldestKept: 'misenare-20261105-180001.dump', keepDays: 14, photoGraceDays: 30, freeMb: 21_000,
  ...over,
});

describe('退避の結果の読み方', () => {
  it('最後の1回が取れていて新しければ「取れている」', () => {
    const v = interpretBackupStatus(status(), NOW);
    assert.equal(v.state, 'ok');
    assert.equal(v.lastSuccessAt, hoursAgo(0.5));
    assert.deepEqual(v.db, { bytes: 1_300_000, tables: 46 });
    assert.deepEqual(v.photos, { files: 245, bytes: 52_000_000 });
    assert.deepEqual([v.kept, v.keepDays, v.photoGraceDays, v.freeMb, v.error], [14, 14, 30, 21_000, null]);
  });

  it('最後の1回が失敗なら「失敗」。理由と、最後に取れた時刻を伝える', () => {
    const v = interpretBackupStatus(status({ ok: false, error: 'データベースを書き出せませんでした', lastSuccessAt: hoursAgo(24.5), db: { file: null, bytes: 0, tables: 0 } }), NOW);
    assert.equal(v.state, 'failed');
    assert.equal(v.error, 'データベースを書き出せませんでした');
    assert.equal(v.lastSuccessAt, hoursAgo(24.5));
    assert.equal(v.db, null, '取れていないときは、大きさを出さない');
  });

  it(`結果が ${BACKUP_STALE_HOURS} 時間より古ければ、取れていても「止まっている」`, () => {
    assert.equal(interpretBackupStatus(status({ finishedAt: hoursAgo(BACKUP_STALE_HOURS - 1) }), NOW).state, 'ok');
    assert.equal(interpretBackupStatus(status({ finishedAt: hoursAgo(BACKUP_STALE_HOURS + 1) }), NOW).state, 'stale');
    assert.equal(interpretBackupStatus(status({ ok: false, error: 'x', finishedAt: hoursAgo(BACKUP_STALE_HOURS + 1) }), NOW).state, 'stale');
  });

  it('形のおかしいファイルは、そのまま信じない（落ちずに「読めませんでした」と言う）', () => {
    for (const raw of ['', 'not json', '[]', 'null', '{"ok":true}', '{"ok":true,"finishedAt":"きのう"}', '{"ok":true,"finishedAt":"2026-13-45T99:99:99Z"}']) {
      const v = interpretBackupStatus(raw, NOW);
      assert.equal(v.state, 'failed', raw);
      assert.match(v.error ?? '', /読めませんでした/);
    }
    // 中の値が数や文字でなくても、その欄だけを空にする。文の中の制御文字は落とし、長すぎれば切る
    const v = interpretBackupStatus(status({
      ok: false, error: `<script>\u0000\n${'あ'.repeat(500)}`, lastSuccessAt: 12345,
      db: 'x', photos: { files: -1, bytes: 1.5 }, kept: '14', keepDays: 1e300, freeMb: null,
    }), NOW);
    assert.equal(v.state, 'failed');
    assert.equal(v.error!.length, 200);
    assert.doesNotMatch(v.error!, /[\u0000-\u001f]/);
    assert.deepEqual([v.lastSuccessAt, v.db, v.photos, v.kept, v.keepDays, v.freeMb], [null, null, null, null, null, null]);
  });

  it('設定が無ければ off、ファイルがまだ無ければ waiting、大きすぎるファイルは読まない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-status-'));
    try {
      assert.equal((await readBackupStatus({}, NOW)).state, 'off');
      assert.equal((await readBackupStatus({ BACKUP_STATUS_FILE: '  ' }, NOW)).state, 'off');
      const file = join(dir, 'status.json');
      assert.equal((await readBackupStatus({ BACKUP_STATUS_FILE: file }, NOW)).state, 'waiting');
      writeFileSync(file, status());
      assert.equal((await readBackupStatus({ BACKUP_STATUS_FILE: file }, NOW)).state, 'ok');
      writeFileSync(file, `${status().slice(0, -1)},"pad":"${'x'.repeat(20_000)}"}`);
      const big = await readBackupStatus({ BACKUP_STATUS_FILE: file }, NOW);
      assert.equal(big.state, 'failed');
      assert.match(big.error ?? '', /大きすぎます/);
      // 置き場所そのものを読めないとき（フォルダを指している）
      assert.equal((await readBackupStatus({ BACKUP_STATUS_FILE: dir }, NOW)).state, 'failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('退避の様子を運営者に伝える', () => {
  const OP = 'owner@tsugigami.example';
  const PASSWORD = 'test-only-passphrase';
  let db: TestDatabase;
  let dir = '';
  let file = '';
  const env = { OPERATOR_EMAILS: OP, APP_URL: 'https://app.tsugigami.example' } as NodeJS.ProcessEnv;
  const sent: Mail[] = [];
  let deliver = true;
  const mailer: Mailer = { send: async (m) => { if (deliver) sent.push(m); return deliver; } };
  const fresh = (over: Record<string, unknown> = {}): void => {
    const at = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    writeFileSync(file, status({ startedAt: at, finishedAt: at, lastSuccessAt: at, ...over }));
  };
  const night = () => runNightly(db, tokenizer, { mailer, env, appUrl: 'https://app.tsugigami.example' });
  const alerts = async (): Promise<number> => ((await db.raw(`SELECT count(*)::int AS n FROM operator_alerts WHERE kind = 'backup'`)) as Array<{ n: number }>)[0]!.n;

  before(async () => {
    db = await freshDatabase();
    dir = mkdtempSync(join(tmpdir(), 'backup-alert-'));
    file = join(dir, 'status.json');
  });
  after(async () => { rmSync(dir, { recursive: true, force: true }); await db.close(); });

  it('運営者の画面からは、ログインしないと読めない。入れば、いまの様子が読める', async () => {
    const app = createApp({ database: db, auth: new SessionAuthenticator(db), tokenizer, limiter: new MemoryRateLimiter(), operatorMailer: mailer, operatorEnv: env });
    const call = async (method: string, path: string, body?: unknown, token?: string) => {
      const res = await app(new Request(`https://app.tsugigami.example/operator${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-misenare-client-ip': '198.51.100.7', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      await app.settled();
      return res;
    };
    assert.equal((await call('GET', '/backup')).status, 401);
    await call('POST', '/auth/setup', { email: OP });
    const setup = decodeURIComponent(/#setup=(\S+)/.exec(sent.at(-1)!.text)![1]!);
    assert.equal((await call('POST', '/auth/password', { token: setup, password: PASSWORD })).status, 200);
    const token = ((await (await call('POST', '/auth/login', { email: OP, password: PASSWORD })).json()) as { token: string }).token;
    sent.length = 0;

    // 設定が無い台
    assert.equal(((await (await call('GET', '/backup', undefined, token)).json()) as { state: string }).state, 'off');
    // 設定はあるが、まだ1回も取っていない
    env.BACKUP_STATUS_FILE = file;
    assert.equal(((await (await call('GET', '/backup', undefined, token)).json()) as { state: string }).state, 'waiting');
    fresh();
    const ok = (await (await call('GET', '/backup', undefined, token)).json()) as { state: string; db: { bytes: number }; photos: { files: number } };
    assert.deepEqual([ok.state, ok.db.bytes, ok.photos.files], ['ok', 1_300_000, 245]);
    // 退避の置き場所や、ファイルの名前は返さない
    assert.doesNotMatch(JSON.stringify(ok), /\.dump|status\.json|tmp/);
  });

  it('取れているあいだは、メールを送らない', async () => {
    fresh();
    await night();
    assert.equal(sent.length, 0);
    assert.equal(await alerts(), 0);
  });

  it('失敗したら、運営者にメールで知らせる（理由・最後に取れた時刻・確かめ方）', async () => {
    fresh({ ok: false, error: 'ディスクの空きが足りません（残り 120MB。500MB を下回ると、退避を取りません）', lastSuccessAt: '2026-11-17T18:00:05Z', freeMb: 120 });
    await night();
    assert.equal(sent.length, 1);
    const mail = sent[0]!;
    assert.deepEqual(mail.to, [OP]);
    assert.match(mail.subject, /退避（バックアップ）が取れていません/);
    assert.match(mail.text, /ディスクの空きが足りません/);
    assert.match(mail.text, /最後に取れたのは：2026\/11\/18 03:00（日本時間）/);
    assert.match(mail.text, /置き場所の空き：120MB/);
    assert.match(mail.text, /backup\.sh once/);
    assert.match(mail.text, /https:\/\/app\.tsugigami\.example\/admin\/#\/security/);
  });

  it(`同じ状態が続くあいだは、${BACKUP_ALERT_EVERY_DAYS} 日に1通まで`, async () => {
    await night();
    await night();
    assert.equal(sent.length, 1, '次の晩も、その次の晩も送らない');
    await db.raw(`UPDATE operator_alerts SET sent_at = now() - make_interval(days => $1, hours => 1) WHERE kind = 'backup'`, [BACKUP_ALERT_EVERY_DAYS]);
    await night();
    assert.equal(sent.length, 2, `${BACKUP_ALERT_EVERY_DAYS} 日たっても直っていなければ、もう一度送る`);
  });

  it('取れるようになったら覚えを消し、次に起きたときは、すぐ知らせる', async () => {
    fresh();
    await night();
    assert.equal(await alerts(), 0);
    assert.equal(sent.length, 2);
    fresh({ ok: false, error: 'データベースを書き出せませんでした' });
    await night();
    assert.equal(sent.length, 3);
  });

  it('結果が古いまま（仕組みが止まっている）・まだ1回も取っていない、も知らせる', async () => {
    await db.raw(`DELETE FROM operator_alerts`);
    const old = new Date(Date.now() - (BACKUP_STALE_HOURS + 2) * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    writeFileSync(file, status({ startedAt: old, finishedAt: old, lastSuccessAt: old }));
    await night();
    assert.equal(sent.length, 4);
    assert.match(sent[3]!.text, /新しくなっていません/);

    await db.raw(`DELETE FROM operator_alerts`);
    rmSync(file);
    await night();
    assert.equal(sent.length, 5);
    assert.match(sent[4]!.text, /まだ1回も結果を書いていません/);
    assert.match(sent[4]!.text, /最後に取れたのは：まだありません/);
  });

  it('メールを送れなかったら、次の晩にもう一度送る', async () => {
    await db.raw(`DELETE FROM operator_alerts`);
    fresh({ ok: false, error: '写真を写せませんでした（データベースの退避は取れています）' });
    deliver = false;
    await night();
    assert.equal(sent.length, 5);
    assert.equal(await alerts(), 0, '送れなかったのに「送った」と覚えている');
    deliver = true;
    await night();
    assert.equal(sent.length, 6);
  });

  it('設定の無い台と、運営者のアドレスが無い台では、何も送らない', async () => {
    await db.raw(`DELETE FROM operator_alerts`);
    fresh({ ok: false, error: 'x' });
    await runNightly(db, tokenizer, { mailer, env: { OPERATOR_EMAILS: OP }, appUrl: 'https://app.tsugigami.example' });
    await runNightly(db, tokenizer, { mailer, env: { BACKUP_STATUS_FILE: file }, appUrl: 'https://app.tsugigami.example' });
    assert.equal(sent.length, 6);
    assert.equal(await alerts(), 0);
  });
});
