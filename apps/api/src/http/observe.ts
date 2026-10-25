// 動いているかを外から見られるようにする道具。
//   ・数え取り（/metrics）… Prometheus の形式で、リクエスト数・応答時間・エラー数を出す
//   ・ログ               … 1行1件の JSON。リクエストIDを付けて、あとから追えるようにする
//   ・通知               … サーバー側のエラーが続いたら Webhook（Slack 互換）に知らせる
//
// 依存は足さない。数え取りはメモリ上なので、台ごとの数になる（Prometheus 側で足す）。

import { randomUUID } from 'node:crypto';

// --- 数え取り ---------------------------------------------------------------------

/** 応答時間の区切り（秒）。店舗のスマホから使うので、遅い側も見られるようにしておく */
const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labels(pairs: Record<string, string>): string {
  const inner = Object.entries(pairs).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
  return inner ? `{${inner}}` : '';
}

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, { counts: number[]; sum: number; total: number }>();
  private readonly startedAt = Date.now();

  /** リクエスト1件を数える。route は経路の型（/knowledge/:id）で、ID そのものは入れない */
  request(route: string, method: string, status: number, seconds: number): void {
    this.count('misenare_requests_total', { route, method, status: String(status) });
    const key = labels({ route });
    const h = this.histograms.get(key) ?? { counts: new Array(BUCKETS.length).fill(0), sum: 0, total: 0 };
    for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]!) h.counts[i]!++;
    h.sum += seconds;
    h.total++;
    this.histograms.set(key, h);
  }

  /** 数えるだけのもの（エラーの種類など） */
  count(name: string, pairs: Record<string, string> = {}, by = 1): void {
    const key = `${name}${labels(pairs)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  render(): string {
    const lines: string[] = [];
    lines.push('# HELP misenare_uptime_seconds サーバーが動き続けている秒数');
    lines.push('# TYPE misenare_uptime_seconds gauge');
    lines.push(`misenare_uptime_seconds ${((Date.now() - this.startedAt) / 1000).toFixed(0)}`);

    const byName = new Map<string, string[]>();
    for (const [key, value] of this.counters) {
      const name = key.split('{')[0]!;
      const list = byName.get(name) ?? [];
      list.push(`${key} ${value}`);
      byName.set(name, list);
    }
    for (const [name, rows] of byName) {
      lines.push(`# TYPE ${name} counter`);
      lines.push(...rows.sort());
    }

    if (this.histograms.size > 0) {
      lines.push('# HELP misenare_request_duration_seconds 応答までにかかった秒数');
      lines.push('# TYPE misenare_request_duration_seconds histogram');
      for (const [key, h] of [...this.histograms].sort()) {
        const inner = key.slice(1, -1); // {route="..."} → route="..."
        for (let i = 0; i < BUCKETS.length; i++) {
          lines.push(`misenare_request_duration_seconds_bucket{${inner},le="${BUCKETS[i]}"} ${h.counts[i]}`);
        }
        lines.push(`misenare_request_duration_seconds_bucket{${inner},le="+Inf"} ${h.total}`);
        lines.push(`misenare_request_duration_seconds_sum{${inner}} ${h.sum.toFixed(6)}`);
        lines.push(`misenare_request_duration_seconds_count{${inner}} ${h.total}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

// --- ログ -------------------------------------------------------------------------

export type Level = 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: string | number | boolean | undefined;
}

/**
 * 1行1件の JSON。個人の名前や本文は書かない（IDと経路だけ）。
 * MISENARE_LOG=off のときは何も書かない（テスト中に出力が混ざらないように）。
 */
export class Logger {
  constructor(
    private readonly write: (line: string) => void =
      process.env.MISENARE_LOG === 'off' ? () => {} : (line) => process.stdout.write(`${line}\n`),
  ) {}

  log(level: Level, msg: string, fields: LogFields = {}): void {
    const entry: Record<string, unknown> = { t: new Date().toISOString(), level, msg };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) entry[k] = v;
    this.write(JSON.stringify(entry));
  }

  info(msg: string, fields?: LogFields): void { this.log('info', msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.log('warn', msg, fields); }
  error(msg: string, fields?: LogFields): void { this.log('error', msg, fields); }
}

/** リクエストID。外から来ていればそれを使い、無ければ作る */
export function requestId(req: Request): string {
  const given = req.headers.get('x-request-id');
  if (given && /^[\w.-]{1,128}$/.test(given)) return given;
  return randomUUID();
}

// --- 通知 -------------------------------------------------------------------------

export interface AlertOptions {
  url?: string | undefined;
  /** 同じ知らせを続けて送らない間隔（ミリ秒） */
  quietMs?: number;
  now?: () => number;
  send?: (url: string, body: string) => Promise<void>;
}

/**
 * サーバー側のエラーを Webhook に知らせる（Slack 互換の {"text": …}）。
 * 同じ種類の知らせは間隔を空ける。送れなくてもリクエストは止めない。
 */
export class Alerts {
  private readonly lastSent = new Map<string, number>();
  private readonly skipped = new Map<string, number>();
  private readonly url: string | undefined;
  private readonly quietMs: number;
  private readonly now: () => number;
  private readonly send: (url: string, body: string) => Promise<void>;

  constructor(options: AlertOptions = {}) {
    this.url = options.url ?? process.env.ALERT_WEBHOOK_URL;
    this.quietMs = options.quietMs ?? 5 * 60_000;
    this.now = options.now ?? (() => Date.now());
    this.send = options.send ?? (async (url, body) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (!res.ok) throw new Error(`webhook ${res.status}`);
    });
  }

  get enabled(): boolean { return Boolean(this.url); }

  /** 知らせる。間隔を空けている間は数えておき、次に送るときにまとめて伝える */
  async notify(kind: string, text: string): Promise<'sent' | 'skipped' | 'off'> {
    if (!this.url) return 'off';
    const t = this.now();
    const last = this.lastSent.get(kind);
    if (last !== undefined && t - last < this.quietMs) {
      this.skipped.set(kind, (this.skipped.get(kind) ?? 0) + 1);
      return 'skipped';
    }
    const held = this.skipped.get(kind) ?? 0;
    this.skipped.delete(kind);
    this.lastSent.set(kind, t);
    const suffix = held > 0 ? `\n（同じ知らせを ${held} 件まとめました）` : '';
    try {
      await this.send(this.url, JSON.stringify({ text: `${text}${suffix}` }));
      return 'sent';
    } catch {
      // 知らせられなくても、アプリは動かし続ける
      this.lastSent.delete(kind);
      return 'skipped';
    }
  }
}
