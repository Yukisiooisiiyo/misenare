// 試行回数の制限。記憶の中で数えるものと、PostgreSQL で共有するものを同じ条件で確かめる。

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  clientKey,
  CLIENT_IP_HEADER,
  DatabaseRateLimiter,
  MemoryRateLimiter,
  sweepRateLimits,
  windows,
  type Limiter,
  type RateRule,
} from '../src/http/rateLimit.ts';
import { freshDatabase } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
before(async () => { db = await freshDatabase(); });
after(async () => { await db.close(); });

const RULE: RateRule = { limit: 5, windowMs: 60_000 };

/** 2つの実装を同じ手順にかける */
function behaves(name: string, make: (now: () => number) => Limiter): void {
  describe(name, () => {
    it('上限まで通し、超えたら止める', async () => {
      let now = 1_000_000_000_000;
      const limiter = make(() => now);
      const key = `${name}:A`;
      for (let i = 0; i < RULE.limit; i++) {
        assert.equal(await limiter.take(key, RULE), true, `${i + 1}回目は通るはず`);
      }
      assert.equal(await limiter.take(key, RULE), false, '上限を超えたら止める');
      assert.equal(await limiter.blocked(key, RULE), true);
    });

    it('別の接続元は止めない', async () => {
      let now = 1_000_000_000_000;
      const limiter = make(() => now);
      for (let i = 0; i < RULE.limit; i++) await limiter.take(`${name}:B`, RULE);
      assert.equal(await limiter.take(`${name}:C`, RULE), true);
    });

    it('時間がたてば戻る', async () => {
      let now = 1_000_000_000_000;
      const limiter = make(() => now);
      const key = `${name}:D`;
      for (let i = 0; i < RULE.limit; i++) await limiter.take(key, RULE);
      assert.equal(await limiter.take(key, RULE), false);
      now += RULE.windowMs * 2;
      assert.equal(await limiter.take(key, RULE), true, '窓を2つ分またげば通る');
    });

    it('窓の切れ目で、上限の2倍を通さない', async () => {
      // 窓の後半に上限まで使い、窓が変わった直後に続けて試す
      let now = Math.floor(1_000_000_000_000 / RULE.windowMs) * RULE.windowMs + RULE.windowMs * 0.9;
      const limiter = make(() => now);
      const key = `${name}:E`;
      for (let i = 0; i < RULE.limit; i++) assert.equal(await limiter.take(key, RULE), true);
      now += RULE.windowMs * 0.2; // 次の窓に入ったばかり
      assert.equal(await limiter.take(key, RULE), false, '前の窓の分を引き継いで止める');
    });
  });
}

behaves('記憶の中', (now) => new MemoryRateLimiter(now));
behaves('PostgreSQL で共有', (now) => new DatabaseRateLimiter((sql, params) => db.raw(sql, params), now));

describe('PostgreSQL で共有するときの、もう少し細かい話', () => {
  it('台が別でも、同じ記録を見て1つの上限になる', async () => {
    let now = 1_000_000_000_000;
    const machineA = new DatabaseRateLimiter((sql, params) => db.raw(sql, params), () => now);
    const machineB = new DatabaseRateLimiter((sql, params) => db.raw(sql, params), () => now);
    const key = 'shared:F';
    for (let i = 0; i < 3; i++) assert.equal(await machineA.take(key, RULE), true);
    for (let i = 0; i < 2; i++) assert.equal(await machineB.take(key, RULE), true);
    assert.equal(await machineB.take(key, RULE), false, '合計5回で止まる');
    assert.equal(await machineA.take(key, RULE), false);
  });

  it('同時に来ても上限を超えない', async () => {
    const limiter = new DatabaseRateLimiter((sql, params) => db.raw(sql, params));
    const key = `race:${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.take(key, RULE)));
    assert.equal(results.filter(Boolean).length, RULE.limit, '通るのはちょうど上限の回数');
  });

  it('古い窓は片付けられる', async () => {
    await db.raw(
      `INSERT INTO rate_limits (key, window_start, count) VALUES ('old', now() - interval '3 hours', 9)
       ON CONFLICT DO NOTHING`,
    );
    const swept = await sweepRateLimits((sql, params) => db.raw(sql, params), 1);
    assert.ok(swept >= 1);
    const left = await db.raw(`SELECT 1 FROM rate_limits WHERE key = 'old'`);
    assert.equal(left.length, 0);
  });

  it('会社に属さないので、行レベルセキュリティは付けない（意図どおりか確かめる）', async () => {
    const rows = (await db.raw(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'rate_limits'`,
    )) as Array<{ relrowsecurity: boolean }>;
    assert.equal(rows[0]?.relrowsecurity, false);
    const columns = await db.raw(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'rate_limits' AND column_name = 'tenant_id'`,
    );
    assert.equal(columns.length, 0, '会社のデータは入れない');
  });
});

describe('接続元の印', () => {
  const req = (ip: string) => new Request('http://localhost/', { headers: { [CLIENT_IP_HEADER]: ip } });

  it('IP をそのまま残さず、鍵付きのハッシュにする', () => {
    const key = clientKey(req('203.0.113.9'), 'accept', 'salt');
    assert.match(key, /^accept:[0-9a-f]{32}$/);
    assert.ok(!key.includes('203.0.113.9'));
  });

  it('同じ IP と鍵なら同じ印、鍵が違えば別の印', () => {
    assert.equal(clientKey(req('198.51.100.1'), 'a', 's'), clientKey(req('198.51.100.1'), 'a', 's'));
    assert.notEqual(clientKey(req('198.51.100.1'), 'a', 's'), clientKey(req('198.51.100.1'), 'a', 't'));
    assert.notEqual(clientKey(req('198.51.100.1'), 'a', 's'), clientKey(req('198.51.100.2'), 'a', 's'));
  });
});

describe('窓の計算', () => {
  it('窓の始まりで切り下げ、経過した分だけ前の窓を引き継ぐ', () => {
    const head = Math.floor(1_000_000_060_000 / 60_000) * 60_000;
    const w = windows(head, 60_000);
    assert.equal(new Date(w.start).getTime() % 60_000, 0);
    assert.equal(new Date(w.previous).getTime(), new Date(w.start).getTime() - 60_000);
    assert.ok(w.carryOver > 0.99, '窓の頭ではほぼ全部引き継ぐ');
    const late = windows(new Date(w.start).getTime() + 59_000, 60_000);
    assert.ok(late.carryOver < 0.02, '窓の終わりではほとんど引き継がない');
  });
});

describe('開発用アダプタの値の数', () => {
  it('余った値があれば止める（本番の pg ドライバーと同じように）', async () => {
    const { interpolate } = await import('../src/db/psqlDatabase.ts');
    assert.equal(interpolate('SELECT $1, $2', ['a', 'b']), "SELECT 'a', 'b'");
    assert.equal(interpolate('SELECT $1, $1', ['a']), "SELECT 'a', 'a'", '同じ値を何度使ってもよい');
    assert.throws(() => interpolate('SELECT $1', ['a', 'b']), /unused parameter \$2/);
    assert.throws(() => interpolate('SELECT $1, $2', ['a']), /missing parameter \$2/);
  });
});
