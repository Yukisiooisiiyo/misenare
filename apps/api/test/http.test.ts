import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Actor } from '../src/domain/actor.ts';
import { createApp } from '../src/http/app.ts';
import { DevHeaderAuthenticator } from '../src/http/auth.ts';
import { freshDatabase, jan, STORE_A, STORE_B, tokenizer, trusted, visitor } from './helpers.ts';
import type { TestDatabase } from './helpers.ts';

let db: TestDatabase;
let app: (req: Request) => Promise<Response>;

before(async () => {
  db = await freshDatabase();
  app = createApp({ database: db, auth: new DevHeaderAuthenticator(), tokenizer });
});
after(async () => { await db.close(); });

async function call(actor: Actor | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (actor) {
    headers['x-dev-tenant-id'] = actor.tenantId;
    headers['x-dev-user-id'] = actor.userId;
  }
  const res = await app(new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('HTTP API', () => {
  it('ログインしていなければ 401、知らない経路は 404', async () => {
    assert.equal((await call(null, 'GET', `/stores/${STORE_A}/search?q=テレビ`)).status, 401);
    assert.equal((await call(trusted, 'GET', '/nope')).status, 404);
    assert.equal((await call(trusted, 'DELETE', `/stores/${STORE_A}/search`)).status, 405);
  });

  it('投稿 → 検索 → 開いた記録、の一連の流れ', async () => {
    const created = await call(trusted, 'POST', `/stores/${STORE_A}/knowledge`, {
      title: '冷蔵庫のリサイクル料金', body: '家電リサイクル法の対象。', tagNames: ['#冷蔵庫', '#リサイクル'],
    });
    assert.equal(created.status, 201);
    const found = await call(visitor, 'GET', `/stores/${STORE_A}/search?q=${encodeURIComponent('#冷蔵庫')}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.hits[0].id, created.body.id);
    const fb = await call(visitor, 'POST', `/search-logs/${found.body.logId}/feedback`, { openedKnowledgeId: created.body.id });
    assert.equal(fb.status, 200);
  });

  it('権限のない操作は 403、入力の誤りは 400、競合は 409 で返す', async () => {
    assert.equal((await call(trusted, 'GET', `/stores/${STORE_B}/search?q=x`)).status, 403);
    assert.equal((await call(trusted, 'POST', `/stores/${STORE_A}/knowledge`, { title: '', body: '', tagNames: ['#x'] })).status, 400);
    const p = { janCode: jan('490000000002'), name: '電子レンジ', tagNames: ['#電子レンジ'] };
    assert.equal((await call(trusted, 'POST', `/stores/${STORE_A}/products`, p)).status, 201);
    assert.equal((await call(trusted, 'POST', `/stores/${STORE_A}/products`, p)).status, 409);
  });

  it('形の正しくない ID や本文は 500 ではなく 400 で返す', async () => {
    assert.equal((await call(trusted, 'GET', '/stores/not-a-uuid/search?q=x')).status, 400);
    assert.equal((await call(trusted, 'POST', `/stores/${STORE_A}/knowledge`, { title: 'タイトルだけ' })).status, 400);
    assert.equal((await call(trusted, 'POST', `/stores/${STORE_A}/knowledge`, { title: 'x', body: 'y', tagNames: ['#x'], expiresAt: '明日' })).status, 400);
    assert.equal((await call(trusted, 'PATCH', `/stores/${STORE_A}/products/${STORE_A}`, { tagNames: 'テレビ' })).status, 400);
    assert.equal((await call(trusted, 'GET', '/stores/20000000-0000-0000-0000-0000000000ff/search?q=x')).status, 403);
    assert.equal((await call(trusted, 'GET', `/knowledge/${STORE_A}`)).status, 404);
  });

  it('visitor の投稿は承認待ちとして返り、承認 API で公開される', async () => {
    const created = await call(visitor, 'POST', `/stores/${STORE_A}/knowledge`, {
      title: '電子レンジの返品', body: '開封後は初期不良のみ。', tagNames: ['#電子レンジ', '#返品'],
    });
    assert.equal(created.body.published, false);
    const pending = await call(trusted, 'GET', `/stores/${STORE_A}/pending`);
    assert.deepEqual(pending.body.map((x: { id: string }) => x.id), [created.body.id]);
    assert.equal((await call(visitor, 'GET', `/stores/${STORE_A}/pending`)).status, 403);
    const ok = await call(trusted, 'POST', `/knowledge/${created.body.id}/versions/1/approve`);
    assert.equal(ok.status, 200);
    const k = await call(visitor, 'GET', `/knowledge/${created.body.id}`);
    assert.equal(k.body.status, 'published');
    assert.deepEqual(k.body.tags, ['電子レンジ', '返品']);
  });

  it('バーコードを読むと商品カードと関連ナレッジが返る', async () => {
    const r = await call(visitor, 'GET', `/stores/${STORE_A}/barcode/${jan('490000000002')}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'found');
    assert.equal(r.body.product.name, '電子レンジ');
    assert.equal(r.body.related[0].title, '電子レンジの返品');
  });

  it('端末に配るタグ辞書を返す', async () => {
    const r = await call(visitor, 'GET', '/tags/dictionary');
    assert.ok(r.body.tags.some((t: { name: string }) => t.name === '電子レンジ'));
    assert.ok(Object.keys(r.body.cooccurrence).length > 0);
  });
});
