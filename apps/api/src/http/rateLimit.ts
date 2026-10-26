// 試行回数の制限。接続元（IP）ごとに、一定時間内の回数を数える。
//
// 2通りある。
//   MemoryRateLimiter   … サーバーの記憶の中で数える。1台で動かすときはこれで十分（既定）
//   DatabaseRateLimiter … PostgreSQL で数える。台を増やしても全体で1つの上限になる（RATE_LIMIT=db）
//
// 数え方は「ずらし窓」。窓を幅ごとに区切って数えつつ、1つ前の窓の回数を
// 経過した割合だけ差し引いて足す。窓の切れ目で上限の2倍通ってしまうのを防ぐ。

import { createHash } from 'node:crypto';

export interface RateRule {
  /** 何回まで */
  limit: number;
  /** 何ミリ秒の間に */
  windowMs: number;
}

export interface Limiter {
  /** 上限に達していれば false。達していなければ1回数えて true。 */
  take(key: string, rule: RateRule): Promise<boolean>;
  /** 上限に達しているかだけを見る（数えない） */
  blocked(key: string, rule: RateRule): Promise<boolean>;
}

export class MemoryRateLimiter implements Limiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async take(key: string, rule: RateRule): Promise<boolean> {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < rule.windowMs);
    if (list.length >= rule.limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    this.sweep(t, rule.windowMs);
    return true;
  }

  async blocked(key: string, rule: RateRule): Promise<boolean> {
    const t = this.now();
    return (this.hits.get(key) ?? []).filter((x) => t - x < rule.windowMs).length >= rule.limit;
  }

  /** 古い記録をときどき捨てて、メモリが増え続けないようにする */
  private sweepCounter = 0;
  private sweep(t: number, windowMs: number): void {
    if (++this.sweepCounter % 1000 !== 0) return;
    for (const [k, v] of this.hits) {
      const kept = v.filter((x) => t - x < windowMs);
      if (kept.length === 0) this.hits.delete(k);
      else this.hits.set(k, kept);
    }
  }
}

/** 今の窓・1つ前の窓・1つ前をどれだけ引き継ぐか */
export function windows(now: number, windowMs: number): { start: string; previous: string; carryOver: number } {
  const startMs = Math.floor(now / windowMs) * windowMs;
  const elapsed = (now - startMs) / windowMs;
  return {
    start: new Date(startMs).toISOString(),
    previous: new Date(startMs - windowMs).toISOString(),
    carryOver: 1 - elapsed,
  };
}

type Raw = (sql: string, params?: readonly unknown[]) => Promise<unknown[]>;

export class DatabaseRateLimiter implements Limiter {
  constructor(private readonly raw: Raw, private readonly now: () => number = () => Date.now()) {}

  /** 1つ前の窓から引き継ぐ回数 */
  private async carried(key: string, previous: string, carryOver: number): Promise<number> {
    const rows = (await this.raw(
      `SELECT count FROM rate_limits WHERE key = $1 AND window_start = $2::timestamptz`,
      [key, previous],
    )) as Array<{ count: number | string }>;
    return Number(rows[0]?.count ?? 0) * carryOver;
  }

  async take(key: string, rule: RateRule): Promise<boolean> {
    const { start, previous, carryOver } = windows(this.now(), rule.windowMs);
    const carried = await this.carried(key, previous, carryOver);
    // 「この1回を足しても上限を超えないか」で見る（記憶の中で数えるものと同じ数え方）
    if (carried + 1 > rule.limit) return false;
    // 超えないときだけ1つ増やす。増やせなければ（行が返らなければ）上限に達している
    const rows = await this.raw(
      `INSERT INTO rate_limits AS r (key, window_start, count) VALUES ($1, $2::timestamptz, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = r.count + 1
        WHERE r.count + $3::float8 + 1 <= $4::int
       RETURNING r.count`,
      [key, start, carried, rule.limit],
    );
    return rows.length > 0;
  }

  async blocked(key: string, rule: RateRule): Promise<boolean> {
    const { start, previous, carryOver } = windows(this.now(), rule.windowMs);
    const rows = (await this.raw(
      `SELECT coalesce((SELECT count FROM rate_limits WHERE key = $1 AND window_start = $2::timestamptz), 0) AS current,
              coalesce((SELECT count FROM rate_limits WHERE key = $1 AND window_start = $3::timestamptz), 0) AS previous`,
      [key, start, previous],
    )) as Array<{ current: number | string; previous: number | string }>;
    const row = rows[0];
    if (!row) return false;
    return Number(row.current) + Number(row.previous) * carryOver + 1 > rule.limit;
  }
}

/** 古い窓を捨てる（夜間バッチから呼ぶ）。残すのは直近1時間ぶん */
export async function sweepRateLimits(raw: Raw, keepHours = 1): Promise<number> {
  const rows = await raw(
    `DELETE FROM rate_limits WHERE window_start < now() - ($1 || ' hours')::interval RETURNING key`,
    [String(keepHours)],
  );
  return rows.length;
}

export const RULES = {
  /** 招待の受け取り：10分で10回まで */
  acceptInvitation: { limit: 10, windowMs: 10 * 60_000 },
  /** 無効なトークンでのアクセス：10分で30回まで（超えたら、その接続元からの認証付きリクエストを止める） */
  failedAuth: { limit: 30, windowMs: 10 * 60_000 },
  /**
   * パスキーで入る：10分で20回まで。
   * ログイン前に呼べる経路なので、総当たりの的になる。パスキーは署名を破れないが、
   * 1回ごとに chall を作って鍵を引くので、数を打たれると台が重くなる。
   */
  passkeyLogin: { limit: 20, windowMs: 10 * 60_000 },
  /**
   * 会社アカウントで入る：10分で20回まで。
   * 入口（/auth/sso/start）は打たれたアドレスでドメインの登録を引くので、
   * 数を打てば「どの会社が導入しているか」を外から数えられる。そこを鈍らせる。
   */
  ssoLogin: { limit: 20, windowMs: 10 * 60_000 },
} satisfies Record<string, RateRule>;

/** node:http のアダプタが付ける、接続元の IP のヘッダー（外から来た同名のヘッダーは上書きする） */
export const CLIENT_IP_HEADER = 'x-misenare-client-ip';

export function clientIp(req: Request): string {
  return req.headers.get(CLIENT_IP_HEADER) ?? 'unknown';
}

/**
 * 接続元の印。IP をそのまま残さず、鍵付きのハッシュにする。
 * 鍵（MISENARE_RATE_SALT）を決めておけば、台をまたいでも同じ印になる。
 */
export function clientKey(req: Request, prefix: string, salt = process.env.MISENARE_RATE_SALT ?? ''): string {
  return `${prefix}:${createHash('sha256').update(`${salt}:${clientIp(req)}`).digest('hex').slice(0, 32)}`;
}
