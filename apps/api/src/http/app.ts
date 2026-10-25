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
  listStale,
  listVersions,
  rejectVersion,
  revertToVersion,
  verifyKnowledge,
  type KnowledgeInput,
} from '../domain/knowledge.ts';
import {
  approveProduct,
  approveProductChange,
  deleteProduct,
  linkKnowledgeToProduct,
  listPendingProducts,
  productHistory,
  rejectProductChange,
  registerProduct,
  scanBarcode,
  updateProduct,
  type ProductInput,
  type ProductPatch,
} from '../domain/products.ts';
import { recordSearchFeedback, search, zeroHitQueries } from '../domain/search.ts';
import { decideRelation, deleteRelation, listRelations, mergeTags, proposeRelation, type RelationInput } from '../domain/tagAdmin.ts';
import { exportDictionary } from '../domain/tags.ts';
import {
  acceptInvitation,
  createInvitation,
  listStoreUsers,
  me,
  parseToken,
  revokeSession,
  updateUser,
  type InvitationInput,
  type UserPatch,
} from '../domain/users.ts';
import { loadActor, type Authenticator, type Identity } from './auth.ts';
import { HttpError, json, readJson, Router } from './router.ts';

interface Ctx {
  actor: Actor;
  identity: Identity;
  db: Db;
  tokenizer: Tokenizer;
}

const STATUS: Record<DomainError['code'], number> = { forbidden: 403, not_found: 404, invalid: 400, conflict: 409 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NON_UUID_PARAMS = new Set(['jan', 'version', 'logId']);
const MAX_DEVICE_NAME = 60;

/** パスの ID がUUIDの形か確かめる（形が違うと DB 側で 500 になるため、先に 400 で返す） */
function checkParams(params: Record<string, string>): void {
  for (const [k, v] of Object.entries(params)) {
    if (!NON_UUID_PARAMS.has(k) && !UUID.test(v)) throw new HttpError(400, `${k} が正しくありません`);
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function knowledgeBody(v: unknown): Omit<KnowledgeInput, 'storeId'> {
  const b = (v ?? {}) as Record<string, unknown>;
  if (typeof b.title !== 'string' || typeof b.body !== 'string' || !isStringArray(b.tagNames)) {
    throw new HttpError(400, 'title・body（文字列）と tagNames（文字列の配列）が必要です');
  }
  if (b.areaIds !== undefined && !(isStringArray(b.areaIds) && b.areaIds.every((x) => UUID.test(x)))) {
    throw new HttpError(400, 'areaIds が正しくありません');
  }
  if (b.expiresAt !== undefined && b.expiresAt !== null && (typeof b.expiresAt !== 'string' || Number.isNaN(Date.parse(b.expiresAt)))) {
    throw new HttpError(400, 'expiresAt は日時の文字列か null にしてください');
  }
  return {
    title: b.title,
    body: b.body,
    tagNames: b.tagNames,
    ...(b.areaIds !== undefined ? { areaIds: b.areaIds as string[] } : {}),
    ...(b.expiresAt !== undefined ? { expiresAt: b.expiresAt as string | null } : {}),
  };
}

function optionalString(b: Record<string, unknown>, key: string): void {
  if (b[key] !== undefined && b[key] !== null && typeof b[key] !== 'string') throw new HttpError(400, `${key} は文字列にしてください`);
}

function productPatchBody(v: unknown): ProductPatch {
  const b = (v ?? {}) as Record<string, unknown>;
  for (const k of ['name', 'maker', 'note']) optionalString(b, k);
  if (b.areaId !== undefined && b.areaId !== null && !(typeof b.areaId === 'string' && UUID.test(b.areaId))) {
    throw new HttpError(400, 'areaId が正しくありません');
  }
  if (b.tagNames !== undefined && !isStringArray(b.tagNames)) throw new HttpError(400, 'tagNames は文字列の配列にしてください');
  // 知らない項目は捨てる（承認待ちの依頼として保存されるため）
  const patch: ProductPatch = {};
  if (b.name !== undefined) patch.name = b.name as string;
  if (b.maker !== undefined) patch.maker = b.maker as string | null;
  if (b.areaId !== undefined) patch.areaId = b.areaId as string | null;
  if (b.note !== undefined) patch.note = b.note as string | null;
  if (b.tagNames !== undefined) patch.tagNames = b.tagNames as string[];
  return patch;
}

function productBody(v: unknown): ProductInput {
  const b = (v ?? {}) as Record<string, unknown>;
  if (typeof b.janCode !== 'string' || typeof b.name !== 'string' || !isStringArray(b.tagNames)) {
    throw new HttpError(400, 'janCode・name（文字列）と tagNames（文字列の配列）が必要です');
  }
  return { ...productPatchBody(b), janCode: b.janCode, name: b.name, tagNames: b.tagNames } as ProductInput;
}

function invitationBody(v: unknown): InvitationInput {
  const b = (v ?? {}) as Record<string, unknown>;
  if (b.storeId !== null && !(typeof b.storeId === 'string' && UUID.test(b.storeId))) throw new HttpError(400, 'storeId（UUID か null）が必要です');
  if (b.userId !== undefined && !(typeof b.userId === 'string' && UUID.test(b.userId))) throw new HttpError(400, 'userId が正しくありません');
  optionalString(b, 'name');
  if (b.trustLevel !== undefined && b.trustLevel !== 'visitor' && b.trustLevel !== 'trusted') throw new HttpError(400, 'trustLevel は visitor か trusted です');
  if (b.adminScope !== undefined && !['none', 'store', 'tenant'].includes(b.adminScope as string)) throw new HttpError(400, 'adminScope は none・store・tenant です');
  return {
    storeId: b.storeId as string | null,
    ...(b.userId !== undefined ? { userId: b.userId as string } : {}),
    ...(typeof b.name === 'string' ? { name: b.name } : {}),
    ...(b.trustLevel !== undefined ? { trustLevel: b.trustLevel as InvitationInput['trustLevel'] } : {}),
    ...(b.adminScope !== undefined ? { adminScope: b.adminScope as InvitationInput['adminScope'] } : {}),
  };
}

function userPatchBody(v: unknown): UserPatch {
  const b = (v ?? {}) as Record<string, unknown>;
  const patch: UserPatch = {};
  if (b.trustLevel !== undefined) {
    if (b.trustLevel !== 'visitor' && b.trustLevel !== 'trusted') throw new HttpError(400, 'trustLevel は visitor か trusted です');
    patch.trustLevel = b.trustLevel;
  }
  if (b.adminScope !== undefined) {
    if (!['none', 'store', 'tenant'].includes(b.adminScope as string)) throw new HttpError(400, 'adminScope は none・store・tenant です');
    patch.adminScope = b.adminScope as UserPatch['adminScope'];
  }
  if (b.status !== undefined) {
    if (b.status !== 'active' && b.status !== 'disabled') throw new HttpError(400, 'status は active か disabled です');
    patch.status = b.status;
  }
  return patch;
}

function relationBody(v: unknown): RelationInput {
  const b = (v ?? {}) as Record<string, unknown>;
  if (b.kind !== 'synonym' && b.kind !== 'includes' && b.kind !== 'alias') throw new HttpError(400, 'kind は synonym・includes・alias です');
  if (typeof b.toTag !== 'string') throw new HttpError(400, 'toTag（タグ名）が必要です');
  if (b.kind === 'alias' && typeof b.fromText !== 'string') throw new HttpError(400, 'alias には fromText（単語）が必要です');
  if (b.kind !== 'alias' && typeof b.fromTag !== 'string') throw new HttpError(400, 'fromTag（タグ名）が必要です');
  return {
    kind: b.kind,
    toTag: b.toTag,
    ...(typeof b.fromTag === 'string' ? { fromTag: b.fromTag } : {}),
    ...(typeof b.fromText === 'string' ? { fromText: b.fromText } : {}),
  };
}

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
    const raw = (await readJson<Record<string, unknown>>(req)) ?? {};
    const body: { openedKnowledgeId?: string; suggestedTagId?: string; pickedTagId?: string } = {};
    for (const k of ['openedKnowledgeId', 'suggestedTagId', 'pickedTagId'] as const) {
      const v = raw[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string' || !UUID.test(v)) throw new HttpError(400, `${k} が正しくありません`);
      body[k] = v;
    }
    await recordSearchFeedback(c.db, c.actor, intParam(p.logId, 'logId'), body);
    return json({ ok: true });
  });
  // 端末に同期するタグ辞書（候補表示と「もしかして」は端末内で計算する）
  r.get('/stores/:storeId/tags/dictionary', async (c, _req, p) => json(await exportDictionary(c.db, c.actor, p.storeId!)));

  // --- バーコード ----------------------------------------------------------
  r.get('/stores/:storeId/barcode/:jan', async (c, _req, p) =>
    json(await scanBarcode(c.db, c.tokenizer, c.actor, p.storeId!, p.jan!)));
  r.post('/stores/:storeId/products', async (c, req, p) =>
    json(await registerProduct(c.db, c.actor, p.storeId!, productBody(await readJson(req))), 201));
  r.patch('/stores/:storeId/products/:productId', async (c, req, p) =>
    json(await updateProduct(c.db, c.actor, p.storeId!, p.productId!, productPatchBody(await readJson(req)))));
  r.delete('/stores/:storeId/products/:productId', async (c, _req, p) =>
    json(await deleteProduct(c.db, c.actor, p.storeId!, p.productId!)));
  r.get('/stores/:storeId/products/:productId/history', async (c, _req, p) =>
    json(await productHistory(c.db, c.actor, p.storeId!, p.productId!)));
  r.post('/products/:productId/approve', async (c, _req, p) =>
    json(await approveProduct(c.db, c.actor, p.productId!)));
  r.post('/product-changes/:requestId/approve', async (c, _req, p) =>
    json(await approveProductChange(c.db, c.actor, p.requestId!)));
  r.post('/product-changes/:requestId/reject', async (c, _req, p) =>
    json(await rejectProductChange(c.db, c.actor, p.requestId!)));
  r.get('/stores/:storeId/pending-products', async (c, _req, p) =>
    json(await listPendingProducts(c.db, c.actor, p.storeId!)));
  r.post('/knowledge/:id/products/:productId', async (c, _req, p) => {
    await linkKnowledgeToProduct(c.db, c.actor, p.id!, p.productId!);
    return json({ ok: true });
  });

  // --- 書く ---------------------------------------------------------------
  r.post('/stores/:storeId/knowledge', async (c, req, p) => {
    const body = knowledgeBody(await readJson(req));
    return json(await createKnowledge(c.db, c.tokenizer, c.actor, { ...body, storeId: p.storeId! }), 201);
  });
  r.post('/knowledge', async (c, req) => {
    // 全店共通ナレッジ（本部のみ）
    const body = knowledgeBody(await readJson(req));
    return json(await createKnowledge(c.db, c.tokenizer, c.actor, { ...body, storeId: null }), 201);
  });
  r.get('/knowledge/:id', async (c, _req, p) => json(await getKnowledge(c.db, c.actor, p.id!)));
  r.put('/knowledge/:id', async (c, req, p) =>
    json(await editKnowledge(c.db, c.tokenizer, c.actor, p.id!, knowledgeBody(await readJson(req)))));
  r.get('/knowledge/:id/versions', async (c, _req, p) => json(await listVersions(c.db, c.actor, p.id!)));
  r.post('/knowledge/:id/versions/:version/approve', async (c, _req, p) =>
    json(await approveVersion(c.db, c.tokenizer, c.actor, p.id!, intParam(p.version, 'version'))));
  r.post('/knowledge/:id/versions/:version/reject', async (c, _req, p) =>
    json(await rejectVersion(c.db, c.actor, p.id!, intParam(p.version, 'version'))));
  r.post('/knowledge/:id/versions/:version/revert', async (c, _req, p) =>
    json(await revertToVersion(c.db, c.tokenizer, c.actor, p.id!, intParam(p.version, 'version'))));

  // --- タグ辞書の管理 -------------------------------------------------------
  r.get('/tag-relations', async (c, req) => {
    const state = new URL(req.url).searchParams.get('state') ?? 'candidate';
    if (!['candidate', 'approved', 'rejected'].includes(state)) throw new HttpError(400, 'state は candidate・approved・rejected です');
    return json(await listRelations(c.db, c.actor, state as 'candidate'));
  });
  r.post('/tag-relations', async (c, req) => json(await proposeRelation(c.db, c.actor, relationBody(await readJson(req))), 201));
  r.post('/tag-relations/:relationId/approve', async (c, _req, p) => json(await decideRelation(c.db, c.actor, p.relationId!, 'approved')));
  r.post('/tag-relations/:relationId/reject', async (c, _req, p) => json(await decideRelation(c.db, c.actor, p.relationId!, 'rejected')));
  r.delete('/tag-relations/:relationId', async (c, _req, p) => {
    await deleteRelation(c.db, c.actor, p.relationId!);
    return json({ ok: true });
  });
  r.post('/tags/merge', async (c, req) => {
    const b = (await readJson<Record<string, unknown>>(req)) ?? {};
    if (typeof b.from !== 'string' || typeof b.into !== 'string') throw new HttpError(400, 'from と into（タグ名）が必要です');
    return json(await mergeTags(c.db, c.tokenizer, c.actor, b.from, b.into));
  });

  // --- 利用者・端末 ---------------------------------------------------------
  r.get('/me', async (c) => json(await me(c.db, c.actor)));
  r.post('/auth/logout', async (c) => {
    if (c.identity.sessionId) await revokeSession(c.db, c.actor, c.identity.sessionId);
    return json({ ok: true });
  });
  r.post('/invitations', async (c, req) => json(await createInvitation(c.db, c.actor, invitationBody(await readJson(req))), 201));
  r.get('/stores/:storeId/users', async (c, _req, p) => json(await listStoreUsers(c.db, c.actor, p.storeId!)));
  r.patch('/users/:userId', async (c, req, p) => json(await updateUser(c.db, c.actor, p.userId!, userPatchBody(await readJson(req)))));
  r.delete('/sessions/:sessionId', async (c, _req, p) => {
    await revokeSession(c.db, c.actor, p.sessionId!);
    return json({ ok: true });
  });

  // --- 育てる・管理 ---------------------------------------------------------
  r.get('/stores/:storeId/pending', async (c, _req, p) => json(await listPending(c.db, c.actor, p.storeId!)));
  r.get('/stores/:storeId/stale', async (c, _req, p) => json(await listStale(c.db, c.actor, p.storeId!)));
  r.post('/knowledge/:id/verify', async (c, _req, p) => json(await verifyKnowledge(c.db, c.actor, p.id!)));
  r.get('/stores/:storeId/zero-hits', async (c, _req, p) => json(await zeroHitQueries(c.db, c.actor, p.storeId!)));

  return r;
}

export function createApp(deps: { database: Database; auth: Authenticator; tokenizer: Tokenizer }) {
  const router = routes();

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true });
    try {
      // ログイン前に呼ぶ唯一の API：招待トークンを端末のセッショントークンに交換する
      if (url.pathname === '/auth/accept' && req.method === 'POST') {
        const b = (await readJson<Record<string, unknown>>(req)) ?? {};
        const token = typeof b.token === 'string' ? b.token : '';
        const parsed = parseToken(token);
        if (!parsed) throw new HttpError(400, '招待のQRコードを読み取れませんでした');
        const deviceName = typeof b.deviceName === 'string' ? b.deviceName.slice(0, MAX_DEVICE_NAME) : null;
        const result = await deps.database.withTenant(parsed.tenantId, (db) => acceptInvitation(db, parsed.tenantId, token, deviceName));
        return json(result, 201);
      }

      const matched = router.match(req.method, url.pathname);
      if (matched === undefined) throw new HttpError(404, 'Not Found');
      if (matched === 'method_not_allowed') throw new HttpError(405, 'Method Not Allowed');
      checkParams(matched.params);

      const identity = await deps.auth.identify(req);
      if (!identity) throw new HttpError(401, 'ログインしてください');
      const actor = await loadActor(deps.database, identity);
      if (!actor) throw new HttpError(401, 'この利用者は無効です');

      return await deps.database.withTenant(actor.tenantId, (db) =>
        matched.handler({ actor, identity, db, tokenizer: deps.tokenizer }, req, matched.params),
      );
    } catch (err) {
      if (err instanceof DomainError) return json({ error: err.code, message: err.message }, STATUS[err.code]);
      if (err instanceof HttpError) return json({ error: 'http', message: err.message }, err.status);
      console.error(err);
      return json({ error: 'internal', message: 'サーバーでエラーが発生しました' }, 500);
    }
  };
}
