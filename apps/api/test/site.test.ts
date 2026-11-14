import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createSite } from '../src/http/site.ts';

let dir: string;
let site: (req: Request) => Promise<Response>;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'misenare-site-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>x</title>');
  await writeFile(join(dir, 'app.js'), 'console.log(1);');
  site = createSite(async () => new Response('api'), dir);
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

const get = (path: string, headers: Record<string, string> = {}) =>
  site(new Request(`http://localhost${path}`, { headers }));

describe('静的ファイルの ETag', () => {
  it('弱い ETag を付けて返す。cache-control は今までどおり', async () => {
    const res = await get('/app/app.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('etag') ?? '', /^W\/"\d+-\d+"$/);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(await res.text(), 'console.log(1);');
    assert.equal((await get('/app/')).headers.get('cache-control'), 'no-cache');
  });

  it('If-None-Match が一致すれば 304 で、本文を送らない', async () => {
    const etag = (await get('/app/app.js')).headers.get('etag')!;
    const res = await get('/app/app.js', { 'if-none-match': etag });
    assert.equal(res.status, 304);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('etag'), etag);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    // index.html（no-cache）も同じ。毎回確かめに来ても本文は送り直さない
    const indexTag = (await get('/app/')).headers.get('etag')!;
    assert.equal((await get('/app/', { 'if-none-match': indexTag })).status, 304);
  });

  it('一致しなければ 200。ファイルが変われば ETag も変わる', async () => {
    assert.equal((await get('/app/app.js', { 'if-none-match': 'W/"1-1"' })).status, 200);
    const before = (await get('/app/app.js')).headers.get('etag')!;
    await writeFile(join(dir, 'app.js'), 'console.log(22);');
    await utimes(join(dir, 'app.js'), new Date(), new Date(Date.now() + 5000));
    const res = await get('/app/app.js', { 'if-none-match': before });
    assert.equal(res.status, 200, '古い ETag では 304 にしない');
    assert.notEqual(res.headers.get('etag'), before);
    assert.equal(await res.text(), 'console.log(22);');
  });

  it('存在しないファイルは 404 のまま', async () => {
    assert.equal((await get('/app/none.js', { 'if-none-match': '*' })).status, 404);
  });
});

describe('ハッシュ付きファイル名の長期キャッシュ', () => {
  it('app.<8桁>.js / styles.<8桁>.css は1年・immutable。ハッシュの無い名前や index.html は今までどおり', async () => {
    await writeFile(join(dir, 'app.1a2b3c4d.js'), 'console.log(3);');
    await writeFile(join(dir, 'styles.0123abcd.css'), 'body{}');
    await writeFile(join(dir, 'app.12345.js'), 'x'); // 5桁は対象外
    await writeFile(join(dir, 'app.ZZZZZZZZ.js'), 'x'); // 16進でない
    const long = 'public, max-age=31536000, immutable';
    assert.equal((await get('/app/app.1a2b3c4d.js')).headers.get('cache-control'), long);
    assert.equal((await get('/app/styles.0123abcd.css')).headers.get('cache-control'), long);
    assert.equal((await get('/app/app.12345.js')).headers.get('cache-control'), 'public, max-age=300');
    assert.equal((await get('/app/app.ZZZZZZZZ.js')).headers.get('cache-control'), 'public, max-age=300');
    assert.equal((await get('/app/app.js')).headers.get('cache-control'), 'public, max-age=300');
    assert.equal((await get('/app/')).headers.get('cache-control'), 'no-cache');
    // 304 でも同じ指定を返す
    const tag = (await get('/app/app.1a2b3c4d.js')).headers.get('etag')!;
    assert.equal((await get('/app/app.1a2b3c4d.js', { 'if-none-match': tag })).headers.get('cache-control'), long);
  });
});

describe('紹介サイト（SITE_HOST）', () => {
  let siteDir: string;
  let both: (req: Request) => Promise<Response>;
  const seen: string[] = [];

  before(async () => {
    siteDir = await mkdtemp(join(tmpdir(), 'misenare-marketing-'));
    await writeFile(join(siteDir, 'index.html'), '<!doctype html><title>紹介</title>');
    await writeFile(join(siteDir, 'site.css'), 'body{}');
    await writeFile(join(siteDir, '.env'), 'SECRET=1');
    both = createSite(async (req) => { seen.push(`${req.method} ${new URL(req.url).pathname}`); return new Response('api'); }, dir, { host: 'Tsugigami.example', dir: siteDir });
  });
  after(async () => { await rm(siteDir, { recursive: true, force: true }); });

  const at = (host: string, path: string, init: RequestInit = {}) => both(new Request(`http://${host}${path}`, init));

  it('そのホスト名で来たら、/ で紹介サイトを返す（アプリへ飛ばさない）', async () => {
    const res = await at('tsugigami.example', '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /紹介/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(!csp.includes("'unsafe-inline'"), 'inline は許さない');
    assert.match(csp, /form-action 'self'/);
    assert.equal((await at('tsugigami.example', '/site.css')).headers.get('content-type'), 'text/css; charset=utf-8');
  });

  it('ポートが付いていても同じ。www 付きは付かないほうへ寄せる', async () => {
    assert.equal((await at('tsugigami.example:8787', '/')).status, 200);
    const res = await at('www.tsugigami.example', '/x?y=1');
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), 'https://tsugigami.example/x?y=1');
  });

  it('アプリのホスト名は今までどおり（/ は /app/ へ）', async () => {
    const res = await at('app.tsugigami.example', '/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/app/');
  });

  it('紹介サイトのドメインから通る API は /contact の POST と /health だけ', async () => {
    seen.length = 0;
    assert.equal((await at('tsugigami.example', '/contact', { method: 'POST', body: '{}' })).status, 200);
    assert.equal((await at('tsugigami.example', '/health')).status, 200);
    assert.deepEqual(seen, ['POST /contact', 'GET /health']);
    assert.equal((await at('tsugigami.example', '/contact')).status, 405);
    assert.equal((await at('tsugigami.example', '/auth/accept', { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await at('tsugigami.example', '/api/me')).status, 404);
    assert.equal((await at('tsugigami.example', '/app/')).status, 404);
    assert.deepEqual(seen, ['POST /contact', 'GET /health'], 'ほかは API に届かない');
  });

  it('隠しファイルと、置き場の外は出さない', async () => {
    assert.equal((await at('tsugigami.example', '/.env')).status, 404);
    assert.equal((await at('tsugigami.example', '/..%2F..%2Fetc%2Fpasswd')).status, 404);
  });

  it('SITE_HOST を決めなければ、何も変わらない', async () => {
    const res = await site(new Request('http://tsugigami.example/'));
    assert.equal(res.status, 302);
  });

  it('運営者の管理画面は、アプリのホスト名の /admin/ でだけ配る（検索に載せない・紹介サイトの名前では出さない）', async () => {
    const adminDir = await mkdtemp(join(tmpdir(), 'misenare-admin-'));
    await writeFile(join(adminDir, 'index.html'), '<!doctype html><title>運営</title>');
    await writeFile(join(adminDir, '.secret'), 'x');
    try {
      const withAdmin = createSite(async () => new Response('api'), dir, { host: 'tsugigami.example', dir: siteDir }, adminDir);
      const page = await withAdmin(new Request('http://app.tsugigami.example/admin/'));
      assert.equal(page.status, 200);
      assert.match(await page.text(), /運営/);
      assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
      assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
      assert.equal((await withAdmin(new Request('http://app.tsugigami.example/admin'))).headers.get('location'), '/admin/');
      assert.equal((await withAdmin(new Request('http://app.tsugigami.example/admin/.secret'))).status, 404);
      assert.equal((await withAdmin(new Request('http://app.tsugigami.example/admin/', { method: 'POST' }))).status, 405);
      assert.equal((await withAdmin(new Request('http://tsugigami.example/admin/'))).status, 404);
    } finally {
      await rm(adminDir, { recursive: true, force: true });
    }
  });
});
