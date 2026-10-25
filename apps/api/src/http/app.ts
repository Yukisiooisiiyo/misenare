// API のルート定義。すべてのリクエストは「認証 → Actor 読み込み → テナント固定のトランザクション」の中で動く。

import type { Tokenizer } from '@misenare/search-core';
import type { Database, Db } from '../db/db.ts';
import { DomainError, type Actor } from '../domain/actor.ts';
import {
  approveVersion,
  createKnowledge,
  editKnowledge,
  getKnowledge,
  listPending,
  listVersions,
  rejectVersion,
  revertToVersion,
  type KnowledgeInput,
} from '../domain/knowledge.ts';
import {
  approveProduct,
  approveProductChange,
  deleteProduct,
  linkKnowledgeToProduct,
  productHistory,
  registerProduct,
  scanBarcode,
  updateProduct,
  type ProductInput,
  type ProductPatch,
} from '../domain/products.ts';
import { recordSearchFeedback, search, zeroHitQueries } from '../domain/search.ts';
import { exportDictionary } from '../domain/tags.ts';
import { loadActor, type Authenticator } from './auth.ts';
import { HttpError, json, readJson, Router } from './router.ts';

interface Ctx {
  actor: Actor;
  db: Db;
  tokenizer: Tokenizer;
}

const STATUS: Record<DomainError['code'], number> = { forbidden: 403, not_found: 404, invalid: 400, conflict: 409 };

function intParam(v: string | undefined, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${name} が正しくありません`);
  return n;
}

function routes(): Router<Ctx> {
  const r = new Router<Ctx>();

  // --- 探す ---------------------------------------------------------------
  r.get('/stores/:storeId/search', async (c, req, p) => {
    const q = new URL(req.url).searchParams.get('q') ?? '';
    return json(await search(c.db, c.tokenizer, c.actor, p.storeId!, q));
  });
  r.post('/search-logs/:logId/feedback', async (c, req, p) => {
    const body = await readJson<{ openedKnowledgeId?: string; suggestedTagId?: string; pickedTagId?: string }>(req);
    await recordSearchFeedback(c.db, c.actor, intParam(p.logId, 'logId'), body);
    return json({ ok: true });
  });
  // 端末に同期するタグ辞書（候補表示と「もしかして」は端末内で計算する）
  r.get('/tags/dictionary', async (c) => json(await exportDictionary(c.db)));

  // --- バーコード ----------------------------------------------------------
  r.get('/stores/:storeId/barcode/:jan', async (c, _req, p) =>
    json(await scanBarcode(c.db, c.tokenizer, c.actor, p.storeId!, p.jan!)));
  r.post('/stores/:storeId/products', async (c, req, p) =>
    json(await registerProduct(c.db, c.actor, p.storeId!, await readJson<ProductInput>(req)), 201));
  r.patch('/stores/:storeId/products/:productId', async (c, req, p) =>
    json(await updateProduct(c.db, c.actor, p.storeId!, p.productId!, await readJson<ProductPatch>(req))));
  r.delete('/stores/:storeId/products/:productId', async (c, _req, p) => {
    await deleteProduct(c.db, c.actor, p.storeId!, p.productId!);
    return new Response(null, { status: 204 });
  });
  r.get('/stores/:storeId/products/:productId/history', async (c, _req, p) =>
    json(await productHistory(c.db, c.actor, p.storeId!, p.productId!)));
  r.post('/stores/:storeId/products/:productId/approve', async (c, _req, p) =>
    json(await approveProduct(c.db, c.actor, p.storeId!, p.productId!)));
  r.post('/product-changes/:requestId/approve', async (c, _req, p) =>
    json(await approveProductChange(c.db, c.actor, p.requestId!)));
  r.post('/knowledge/:id/products/:productId', async (c, _req, p) => {
    await linkKnowledgeToProduct(c.db, c.actor, p.id!, p.productId!);
    return json({ ok: true });
  });

  // --- 書く ---------------------------------------------------------------
  r.post('/stores/:storeId/knowledge', async (c, req, p) => {
    const body = await readJson<Omit<KnowledgeInput, 'storeId'>>(req);
    return json(await createKnowledge(c.db, c.tokenizer, c.actor, { ...body, storeId: p.storeId! }), 201);
  });
  r.post('/knowledge', async (c, req) => {
    // 全店共通ナレッジ（本部のみ）
    const body = await readJson<Omit<KnowledgeInput, 'storeId'>>(req);
    return json(await createKnowledge(c.db, c.tokenizer, c.actor, { ...body, storeId: null }), 201);
  });
  r.get('/knowledge/:id', async (c, _req, p) => json(await getKnowledge(c.db, c.actor, p.id!)));
  r.put('/knowledge/:id', async (c, req, p) =>
    json(await editKnowledge(c.db, c.tokenizer, c.actor, p.id!, await readJson<Omit<KnowledgeInput, 'storeId'>>(req))));
  r.get('/knowledge/:id/versions', async (c, _req, p) => json(await listVersions(c.db, c.actor, p.id!)));
  r.post('/knowledge/:id/versions/:version/approve', async (c, _req, p) =>
    json(await approveVersion(c.db, c.tokenizer, c.actor, p.id!, intParam(p.version, 'version'))));
  r.post('/knowledge/:id/versions/:version/reject', async (c, _req, p) =>
    json(await rejectVersion(c.db, c.actor, p.id!, intParam(p.version, 'version'))));
  r.post('/knowledge/:id/versions/:version/revert', async (c, _req, p) =>
    json(await revertToVersion(c.db, c.tokenizer, c.actor, p.id!, intParam(p.version, 'version'))));

  // --- 育てる・管理 ---------------------------------------------------------
  r.get('/stores/:storeId/pending', async (c, _req, p) => json(await listPending(c.db, c.actor, p.storeId!)));
  r.get('/stores/:storeId/zero-hits', async (c, _req, p) => json(await zeroHitQueries(c.db, c.actor, p.storeId!)));

  return r;
}

export function createApp(deps: { database: Database; auth: Authenticator; tokenizer: Tokenizer }) {
  const router = routes();

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true });
    try {
      const matched = router.match(req.method, url.pathname);
      if (matched === undefined) throw new HttpError(404, 'Not Found');
      if (matched === 'method_not_allowed') throw new HttpError(405, 'Method Not Allowed');

      const identity = await deps.auth.identify(req);
      if (!identity) throw new HttpError(401, 'ログインしてください');
      const actor = await loadActor(deps.database, identity);
      if (!actor) throw new HttpError(401, 'この利用者は無効です');

      return await deps.database.withTenant(actor.tenantId, (db) =>
        matched.handler({ actor, db, tokenizer: deps.tokenizer }, req, matched.params),
      );
    } catch (err) {
      if (err instanceof DomainError) return json({ error: err.code, message: err.message }, STATUS[err.code]);
      if (err instanceof HttpError) return json({ error: 'http', message: err.message }, err.status);
      console.error(err);
      return json({ error: 'internal', message: 'サーバーでエラーが発生しました' }, 500);
    }
  };
}
