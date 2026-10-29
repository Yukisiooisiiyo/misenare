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
