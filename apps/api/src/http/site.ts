// Web 版の配信と API をまとめる。
//   /app/…  … Web 版（apps/web/dist の静的ファイル）
//   /api/…  … API（先頭の /api を外して渡す）
//   それ以外 … API（以前のパスとの互換）

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { matchesEtag } from './router.ts';

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

/**
 * 写真を S3 に置くときは、画像の読み込み先と送信先にその場所を足す必要がある。
 * PHOTO_ORIGIN に `https://<バケット>.s3.<リージョン>.amazonaws.com` を入れる。
 */
function securityHeaders(photoOrigin?: string): Record<string, string> {
  const extra = photoOrigin ? ` ${photoOrigin}` : '';
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    // 外部から読み込むのは Google Fonts と（設定したときだけ）写真の保存先
    'content-security-policy':
      "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; "
      + `img-src 'self' data: blob:${extra}; media-src 'self' blob:; connect-src 'self'${extra}; base-uri 'none'; frame-ancestors 'none'`,
  };
}

const SECURITY_HEADERS = securityHeaders(process.env.PHOTO_ORIGIN);

export function staticFiles(dir: string) {
  const rootDir = normalize(dir).replace(/[\\/]+$/, '');
  return async (pathname: string, req?: Request): Promise<Response> => {
    const rel = pathname.replace(/^\/app\/?/, '') || 'index.html';
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return new Response('Not Found', { status: 404, headers: SECURITY_HEADERS }); // 壊れた %
    }
    const file = normalize(join(rootDir, decoded));
    // ディレクトリの外は読ませない
    if (file !== rootDir && !file.startsWith(rootDir + sep)) return new Response('Not Found', { status: 404, headers: SECURITY_HEADERS });
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      const cache = extname(file) === '.html' ? 'no-cache' : 'public, max-age=300';
      // 中身を読まずに決められる弱い ETag（大きさと更新時刻）。期限が切れた再取得や no-cache の index.html が、
      // 変わっていなければ 304 で済み、本文を送り直さない
      const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
      if (matchesEtag(req?.headers.get('if-none-match') ?? null, etag)) {
        return new Response(null, { status: 304, headers: { etag, 'cache-control': cache, ...SECURITY_HEADERS } });
      }
      const body = await readFile(file);
      return new Response(body, { headers: { 'content-type': type, 'cache-control': cache, etag, ...SECURITY_HEADERS } });
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
      return files(url.pathname, req);
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
