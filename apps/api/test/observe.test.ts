// 監視と通知。数え取り・ログ・疎通確認・Webhook を確かめる。

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Alerts, Logger, Metrics, requestId } from '../src/http/observe.ts';
import { createApp } from '../src/http/app.ts';
import { DevHeaderAuthenticator } from '../src/http/auth.ts';
import { freshDatabase, STORE_A, tokenizer, trusted } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
before(async () => { db = await freshDatabase(); });
after(async () => { await db.close(); });

describe('数え取り', () => {
  it('Prometheus の形式で、数と応答時間を出す', () => {
    const m = new Metrics();
    m.request('/knowledge/:id', 'GET', 200, 0.03);
    m.request('/knowledge/:id', 'GET', 200, 0.4);
    m.request('/knowledge/:id', 'GET', 404, 0.01);
    const text = m.render();
    assert.match(text, /# TYPE misenare_requests_total counter/);
    assert.match(text, /misenare_requests_total\{route="\/knowledge\/:id",method="GET",status="200"\} 2/);
    assert.match(text, /misenare_requests_total\{route="\/knowledge\/:id",method="GET",status="404"\} 1/);
    assert.match(text, /# TYPE misenare_request_duration_seconds histogram/);
    // 0.05 秒以内は 2 件（0.03 と 0.01）、全部で 3 件
    assert.match(text, /_bucket\{route="\/knowledge\/:id",le="0.05"\} 2/);
    assert.match(text, /_bucket\{route="\/knowledge\/:id",le="\+Inf"\} 3/);
    assert.match(text, /_count\{route="\/knowledge\/:id"\} 3/);
    assert.match(text, /misenare_uptime_seconds \d+/);
  });

  it('ラベルの中の記号を逃がす', () => {
    const m = new Metrics();
    m.count('misenare_errors_total', { kind: 'a"b\\c' });
    assert.match(m.render(), /kind="a\\"b\\\\c"/);
  });
});

describe('ログ', () => {
  it('1行1件の JSON で、時刻と種類と中身が入る', () => {
    const lines: string[] = [];
    const log = new Logger((l) => lines.push(l));
    log.info('request', { requestId: 'abc', status: 200, missing: undefined });
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!);
    assert.equal(entry.level, 'info');
    assert.equal(entry.msg, 'request');
    assert.equal(entry.requestId, 'abc');
    assert.equal(entry.status, 200);
    assert.ok(!('missing' in entry), '未設定の項目は書かない');
    assert.ok(!Number.isNaN(Date.parse(entry.t)));
  });

  it('リクエストIDは、外から来ていれば引き継ぎ、おかしな値なら作り直す', () => {
    const req = (v?: string) => new Request('http://localhost/', { headers: v === undefined ? {} : { 'x-request-id': v } });
    assert.equal(requestId(req('abc-123')), 'abc-123');
    assert.match(requestId(req()), /^[0-9a-f-]{36}$/);
    assert.match(requestId(req('a'.repeat(200))), /^[0-9a-f-]{36}$/, '長すぎる値は使わない');
    assert.match(requestId(req('bad id with spaces')), /^[0-9a-f-]{36}$/, 'ログを壊す値は使わない');
  });
});

describe('通知', () => {
  const sent: string[] = [];
  const make = (now: () => number) => new Alerts({
    url: 'https://example.invalid/hook',
    quietMs: 60_000,
    now,
    send: async (_url, body) => { sent.push(body); },
  });

  it('続けて同じ知らせが来たら間引き、次に送るときにまとめて伝える', async () => {
    sent.length = 0;
    let now = 0;
    const alerts = make(() => now);
    assert.equal(await alerts.notify('internal:/a', '1回目'), 'sent');
    assert.equal(await alerts.notify('internal:/a', '2回目'), 'skipped');
    assert.equal(await alerts.notify('internal:/a', '3回目'), 'skipped');
    assert.equal(await alerts.notify('internal:/b', '別の種類'), 'sent', '種類が違えばすぐ送る');
    now += 60_001;
    assert.equal(await alerts.notify('internal:/a', '4回目'), 'sent');
    assert.equal(sent.length, 3);
    assert.match(JSON.parse(sent[2]!).text, /同じ知らせを 2 件まとめました/);
  });

  it('送り先が無ければ何もしない', async () => {
    const alerts = new Alerts({ url: undefined });
    assert.equal(alerts.enabled, false);
    assert.equal(await alerts.notify('x', 'y'), 'off');
  });

  it('送れなくてもアプリは止めない', async () => {
    const alerts = new Alerts({ url: 'https://example.invalid/hook', send: async () => { throw new Error('つながらない'); } });
    assert.equal(await alerts.notify('x', 'y'), 'skipped');
  });
});

describe('サーバーから見たとき', () => {
  const lines: string[] = [];
  const metrics = new Metrics();
  const notified: string[] = [];
  let app: (req: Request) => Promise<Response>;

  before(() => {
    app = createApp({
      database: db,
      auth: new DevHeaderAuthenticator(),
      tokenizer,
      metrics,
      logger: new Logger((l) => lines.push(l)),
      alerts: new Alerts({ url: 'https://example.invalid/hook', send: async (_u, body) => { notified.push(body); } }),
    });
  });

  const call = (method: string, path: string, headers: Record<string, string> = {}) =>
    app(new Request(`http://localhost${path}`, { method, headers }));

  it('/health と /ready は誰でも見られる', async () => {
    assert.equal((await call('GET', '/health')).status, 200);
    const ready = await call('GET', '/ready');
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true });
  });

  it('DB につながらなければ /ready は 503', async () => {
    const broken = createApp({
      database: { ...db, raw: async () => { throw new Error('接続できません'); } },
      auth: new DevHeaderAuthenticator(),
      tokenizer,
      logger: new Logger(() => {}),
    });
    const res = await broken(new Request('http://localhost/ready'));
    assert.equal(res.status, 503);
  });

  it('応答にリクエストIDが付き、ログにも同じIDが残る', async () => {
    lines.length = 0;
    const res = await call('GET', '/me', { 'x-dev-tenant-id': trusted.tenantId, 'x-dev-user-id': trusted.userId, 'x-request-id': 'req-1' });
    assert.equal(res.headers.get('x-request-id'), 'req-1');
    const entry = JSON.parse(lines.at(-1)!);
    assert.equal(entry.requestId, 'req-1');
    assert.equal(entry.route, '/me');
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.ms, 'number');
  });

  it('数え取りは ID ではなく経路の型で数える', async () => {
    await call('GET', `/stores/${STORE_A}/search?q=x`, { 'x-dev-tenant-id': trusted.tenantId, 'x-dev-user-id': trusted.userId });
    const text = metrics.render();
    assert.match(text, /route="\/stores\/:storeId\/search"/);
    assert.ok(!text.includes(STORE_A), '店舗IDそのものはラベルに入れない');
  });

  it('/metrics は、合言葉を決めていれば合言葉がいる', async () => {
    const before = process.env.METRICS_TOKEN;
    try {
      delete process.env.METRICS_TOKEN;
      assert.equal((await call('GET', '/metrics')).status, 200, '決めていなければ（本番以外では）見られる');
      process.env.METRICS_TOKEN = 'secret-token';
      assert.equal((await call('GET', '/metrics')).status, 404, '合言葉が違えば、あることも知らせない');
      assert.equal((await call('GET', '/metrics', { authorization: 'Bearer secret-token' })).status, 200);
      assert.equal((await call('GET', '/metrics?token=secret-token')).status, 200);
    } finally {
      if (before === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = before;
    }
  });

  it('サーバー側のエラーは、ログ・数え取り・通知の3つに残る', async () => {
    lines.length = 0;
    notified.length = 0;
    const failing = createApp({
      database: { ...db, withTenant: async () => { throw new Error('わざと壊す'); } },
      auth: new DevHeaderAuthenticator(),
      tokenizer,
      metrics,
      logger: new Logger((l) => lines.push(l)),
      alerts: new Alerts({ url: 'https://example.invalid/hook', send: async (_u, body) => { notified.push(body); } }),
    });
    const res = await failing(new Request('http://localhost/me', {
      headers: { 'x-dev-tenant-id': trusted.tenantId, 'x-dev-user-id': trusted.userId },
    }));
    assert.equal(res.status, 500);
    assert.equal(((await res.json()) as { message: string }).message, 'サーバーでエラーが発生しました', '中身は外に出さない');
    assert.ok(lines.some((l) => JSON.parse(l).msg === 'unhandled error'));
    assert.ok(lines.some((l) => JSON.parse(l).level === 'error'));
    // 通知は非同期に投げるので、少し待つ
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(notified.length, 1);
    assert.match(JSON.parse(notified[0]!).text, /わざと壊す/);
    assert.match(metrics.render(), /misenare_errors_total\{route="\/me",kind="internal"\} \d+/);
  });
});
