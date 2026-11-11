import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { appTimeZone, todayIn } from '../src/config.ts';
import { freshDatabase, T } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
before(async () => { db = await freshDatabase(); });
after(async () => { await db.close(); });

describe('日本時間での「今日」', () => {
  it('取引の中の current_date / now() は MISENARE_TZ（既定 Asia/Tokyo）で評価される', async () => {
    const [row] = await db.withTenant(T, (q) =>
      q.query<{ d: string; n: string; tz: string }>(`SELECT current_date::text AS d, now()::text AS n, current_setting('TimeZone') AS tz`));
    assert.equal(row!.tz, 'Asia/Tokyo');
    // サーバーが UTC でも、Intl で出した JST の今日と一致する（0:00〜8:59 JST でもずれない）
    const jst = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
    assert.equal(row!.d, jst);
    assert.match(row!.n, /\+09$/);
  });

  it('設定は取引の中だけ（次の取引にも毎回掛かる）', async () => {
    for (let i = 0; i < 2; i++) {
      const [row] = await db.withTenant(T, (q) => q.query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`));
      assert.equal(row!.tz, 'Asia/Tokyo');
    }
  });

  it('todayIn は UTC の日付ではなく指定タイムゾーンの日付を返す', () => {
    const t = new Date('2026-10-29T16:30:00Z'); // JST では 10/30 01:30
    assert.equal(todayIn('Asia/Tokyo', t), '2026-10-30');
    assert.equal(todayIn('UTC', t), '2026-10-29');
    assert.equal(appTimeZone({ MISENARE_TZ: 'America/New_York' } as NodeJS.ProcessEnv), 'America/New_York');
    assert.equal(appTimeZone({} as NodeJS.ProcessEnv), 'Asia/Tokyo');
    assert.throws(() => appTimeZone({ MISENARE_TZ: 'Asia/Tokio' } as NodeJS.ProcessEnv), /MISENARE_TZ/);
  });
});
