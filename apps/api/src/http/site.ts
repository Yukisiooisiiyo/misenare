// Web 版の配信と API をまとめる。
//   /app/…  … Web 版（apps/web/dist の静的ファイル）
//   /api/…  … API（先頭の /api を外して渡す）
//   それ以外 … API（以前のパスとの互換）
//
// SITE_HOST を決めると、そのホスト名（例: tsugigami.app）で来たものだけ別扱いにする。
//   GET  /…        … 紹介サイト（apps/site の静的ファイル）
//   POST /contact  … 問い合わせフォーム（API に渡す）
//   それ以外        … 404（アプリの API を紹介サイトのドメインからは触らせない）

import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join, normalize, sep } from 'node:path';
import { matchesEtag } from './router.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
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

const APP_HEADERS = securityHeaders(process.env.PHOTO_ORIGIN);

/**
 * 紹介サイト用。読み込むのは自分のファイルと Google Fonts だけ。
 * inline の style / script は許さない（見た目は site.css、動きは site.js に置いてある）。
 * 画像の data: は、site.css の中に書いた SVG のため。
 */
const SITE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; "
    + "img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

/**
 * ファイル名に内容のハッシュ（app.1a2b3c4d.js）が入っているものは、中身が変われば名前も変わる。
 * なので1年キャッシュして、二度と取りに来させない。build.mjs が index.html をこの名前に書き換える。
 */
const HASHED_NAME = /\.[0-9a-f]{8,16}\.[A-Za-z0-9]+$/;

export function staticFiles(dir: string, options: { prefix?: RegExp; headers?: Record<string, string> } = {}) {
  const rootDir = normalize(dir).replace(/[\\/]+$/, '');
  const prefix = options.prefix ?? /^\/app\/?/;
  const SECURITY_HEADERS = options.headers ?? APP_HEADERS;
  return async (pathname: string, req?: Request): Promise<Response> => {
    const rel = pathname.replace(prefix, '') || 'index.html';
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
      const cache = extname(file) === '.html'
        ? 'no-cache'
        : HASHED_NAME.test(basename(file)) ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
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

export interface MarketingSite {
  /** 紹介サイトのホスト名（例: tsugigami.app）。ポートは付けない */
  host: string;
  /** 紹介サイトの静的ファイルの置き場（apps/site） */
  dir: string;
}

export function createSite(api: (req: Request) => Promise<Response>, webDir: string, marketing?: MarketingSite) {
  const files = staticFiles(webDir);
  const siteHost = marketing?.host.trim().toLowerCase().replace(/\.$/, '') ?? '';
  const siteFiles = marketing && siteHost !== '' ? staticFiles(marketing.dir, { prefix: /^\/+/, headers: SITE_HEADERS }) : null;
  const notFound = (): Response => new Response('Not Found', { status: 404, headers: SITE_HEADERS });
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (siteFiles) {
      const host = url.hostname.toLowerCase();
      // www 付きは、付かないほうへ寄せる（同じページが2つの住所で見えないように）
      if (host === `www.${siteHost}`) {
        return new Response(null, { status: 301, headers: { location: `https://${siteHost}${url.pathname}${url.search}` } });
      }
      if (host === siteHost) {
        // 生死の確認だけは、どのホスト名でも答える（外からの監視がこのドメインを見ることがある）
        if (url.pathname === '/health') return api(req);
        if (url.pathname === '/contact') {
          if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: SITE_HEADERS });
          return api(req);
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: SITE_HEADERS });
        // 隠しファイル（.env など）は、置いてあっても出さない
        if (url.pathname.split('/').some((part) => part.startsWith('.'))) return notFound();
        return siteFiles(url.pathname, req);
      }
    }
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
