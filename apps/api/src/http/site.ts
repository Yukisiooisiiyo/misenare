// Web 版の配信と API をまとめる。
//   /app/…  … Web 版（apps/web/dist の静的ファイル）
//   /api/…  … API（先頭の /api を外して渡す）
//   それ以外 … API（以前のパスとの互換）

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  // 外部から読み込むのは Google Fonts だけ
  'content-security-policy':
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export function staticFiles(dir: string) {
  const rootDir = normalize(dir).replace(/[\\/]+$/, '');
  return async (pathname: string): Promise<Response> => {
    const rel = pathname.replace(/^\/app\/?/, '') || 'index.html';
    const file = normalize(join(rootDir, decodeURIComponent(rel)));
    // ディレクトリの外は読ませない
    if (file !== rootDir && !file.startsWith(rootDir + sep)) return new Response('Not Found', { status: 404 });
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      const cache = extname(file) === '.html' ? 'no-cache' : 'public, max-age=300';
      return new Response(body, { headers: { 'content-type': type, 'cache-control': cache, ...SECURITY_HEADERS } });
    } catch {
      return new Response('Not Found', { status: 404, headers: SECURITY_HEADERS });
    }
  };
}

export function createSite(api: (req: Request) => Promise<Response>, webDir: string) {
  const files = staticFiles(webDir);
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/app') {
      return new Response(null, { status: 302, headers: { location: '/app/' } });
    }
    if (url.pathname.startsWith('/app/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
      return files(url.pathname);
    }
    if (url.pathname.startsWith('/api/')) {
      const inner = new URL(req.url);
      inner.pathname = url.pathname.slice('/api'.length);
      const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers: req.headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') { init.body = await req.arrayBuffer(); }
      return api(new Request(inner, init));
    }
    return api(req);
  };
}
