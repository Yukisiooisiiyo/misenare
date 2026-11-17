// 依存なしの小さなルーター。Web 標準の Request / Response を使う（Node 22 以降は標準で使える）。
// ハンドラの形は (Request) => Promise<Response> なので、Hono などにもそのまま載せ替えられる。

export type Params = Record<string, string>;
export type Handler<C> = (ctx: C, req: Request, params: Params) => Promise<Response | Deferred<C>>;

/**
 * ハンドラが「DB の取引の外でやる仕事」を返すための入れ物。
 * 時間のかかる仕事（資料の読み取りなど）を、取引を開けたまま待たないために使う。
 * 呼ぶ側は、いまの取引を閉じてから work を走らせ、その結果を**新しい取引**の中で finish に渡す。
 */
export interface Deferred<C> {
  readonly deferred: true;
  work(): Promise<unknown>;
  finish(ctx: C, value: unknown): Promise<Response>;
}

/** 取引の外でやる仕事（work）と、その結果を受けて続きをする処理（finish）を組にして返す */
export function outside<C, T>(work: () => Promise<T>, finish: (ctx: C, value: T) => Promise<Response>): Deferred<C> {
  return { deferred: true, work, finish: (ctx, value) => finish(ctx, value as T) };
}

interface Route<C> {
  method: string;
  /** 経路の型（/knowledge/:id）。数え取りのラベルに使う（IDそのものは入れない） */
  path: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler<C>;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class Router<C> {
  private readonly routes: Route<C>[] = [];

  on(method: string, path: string, handler: Handler<C>): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/\/:([a-zA-Z]+)/g, (_, k: string) => { keys.push(k); return '/([^/]+)'; }) + '/?$',
    );
    this.routes.push({ method, path, pattern, keys, handler });
    return this;
  }

  get(path: string, h: Handler<C>) { return this.on('GET', path, h); }
  post(path: string, h: Handler<C>) { return this.on('POST', path, h); }
  put(path: string, h: Handler<C>) { return this.on('PUT', path, h); }
  patch(path: string, h: Handler<C>) { return this.on('PATCH', path, h); }
  delete(path: string, h: Handler<C>) { return this.on('DELETE', path, h); }

  match(method: string, pathname: string): { handler: Handler<C>; params: Params; path: string } | 'method_not_allowed' | undefined {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Params = {};
      r.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1]!);
        } catch {
          // 壊れた %（%E0%A4%A など）。URIError のまま外へ出すと 500 になるので 400 に
          throw new HttpError(400, 'パスが正しくありません');
        }
      });
      return { handler: r.handler, params, path: r.path };
    }
    return pathMatched ? 'method_not_allowed' : undefined;
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** If-None-Match が etag に一致するか。弱い比較（W/ の有無は無視）で、カンマ区切りの複数と * も受ける。 */
export function matchesEtag(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const bare = (v: string) => v.trim().replace(/^W\//, '');
  return header.split(',').some((v) => v.trim() === '*' || bare(v) === bare(etag));
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'JSON を読み取れませんでした');
  }
}
