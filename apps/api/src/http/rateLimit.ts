// 試行回数の制限。接続元（IP）ごとに、一定時間内の回数を数える。
// メモリ上で数えるので、サーバーを複数台にしたときは台ごとの上限になる（必要なら Redis などに置き換える）。

export interface RateRule {
  /** 何回まで */
  limit: number;
  /** 何ミリ秒の間に */
  windowMs: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** 上限に達していれば false。達していなければ1回数えて true。 */
  take(key: string, rule: RateRule): boolean {
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

  /** 上限に達しているかだけを見る（数えない） */
  blocked(key: string, rule: RateRule): boolean {
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

export const RULES = {
  /** 招待の受け取り：10分で10回まで */
  acceptInvitation: { limit: 10, windowMs: 10 * 60_000 },
  /** 無効なトークンでのアクセス：10分で30回まで（超えたら、その接続元からの認証付きリクエストを止める） */
  failedAuth: { limit: 30, windowMs: 10 * 60_000 },
} satisfies Record<string, RateRule>;

/** node:http のアダプタが付ける、接続元の IP のヘッダー（外から来た同名のヘッダーは上書きする） */
export const CLIENT_IP_HEADER = 'x-misenare-client-ip';

export function clientIp(req: Request): string {
  return req.headers.get(CLIENT_IP_HEADER) ?? 'unknown';
}
