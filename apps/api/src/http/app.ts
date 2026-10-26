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
import {
  addHandover,
  deleteHandover,
  handoverBadge,
  handoverHistory,
  listHandovers,
  restoreHandover,
  setHandoverState,
} from '../domain/handovers.ts';
import { discardImport, importManual, listImports, MAX_IMPORT_BYTES } from '../domain/imports.ts';
import {
  deletePasskey,
  finishRegistration,
  listPasskeys,
  loginWithPasskey,
  siteConfigFromEnv,
  startLogin,
  startRegistration,
  type SiteConfig,
} from '../domain/passkeys.ts';
import {
  ackNotice,
  createNotice,
  deleteNotice,
  endNotice,
  getNotice,
  listNotices,
  markRead,
  noticeBadge,
  noticeReaders,
  updateNotice,
  type NoticeInput,
} from '../domain/notices.ts';
import {
  deletePhoto,
  finishPhotoUpload,
  listPhotos,
  openPhoto,
  receivePhoto,
  startPhotoUpload,
} from '../domain/photos.ts';
import { recordSearchFeedback, search, zeroHitQueries } from '../domain/search.ts';
import {
  confirmReading, decideRelation, deleteRelation, listReadingProposals, listRelations,
  mergeTags, proposeRelation, type RelationInput,
} from '../domain/tagAdmin.ts';
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
import { OidcDirectory } from '../auth/oidc.ts';
import { approveRequest, listRequests, rejectRequest } from '../domain/accessRequests.ts';
import {
  addProvider, disableProvider, finishSso, listProviders, ssoSiteFromEnv, startSso,
  type SsoSite,
} from '../domain/sso.ts';
import { storageFromEnv, type Storage } from '../storage/storage.ts';
import { loadActor, type Authenticator, type Identity } from './auth.ts';
import { clientKey, DatabaseRateLimiter, MemoryRateLimiter, RULES, type Limiter } from './rateLimit.ts';
import { Alerts, Logger, Metrics, requestId } from './observe.ts';
import { HttpError, json, readJson, Router } from './router.ts';

interface Ctx {
  actor: Actor;
  identity: Identity;
  db: Db;
  tokenizer: Tokenizer;
  storage: Storage;
  /** 会社に属さないテーブル（合言葉など）を触るため */
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

function noticeBody(v: unknown): NoticeInput {
  const b = (v ?? {}) as Record<string, unknown>;
  if (typeof b.title !== 'string' || typeof b.body !== 'string') throw new HttpError(400, 'title と body（文字列）が必要です');
  if (b.priority !== undefined && b.priority !== 'normal' && b.priority !== 'important') {
    throw new HttpError(400, 'priority は normal か important です');
  }
  if (b.requiresAck !== undefined && typeof b.requiresAck !== 'boolean') throw new HttpError(400, 'requiresAck は true か false です');
  for (const key of ['startsAt', 'endsAt']) {
    const v2 = b[key];
    if (v2 !== undefined && v2 !== null && (typeof v2 !== 'string' || Number.isNaN(Date.parse(v2)))) {
      throw new HttpError(400, `${key} は日時の文字列か null にしてください`);
    }
  }
  return {
    title: b.title,
    body: b.body,
    ...(b.priority !== undefined ? { priority: b.priority as NoticeInput['priority'] } : {}),
    ...(b.requiresAck !== undefined ? { requiresAck: b.requiresAck as boolean } : {}),
    ...(b.startsAt !== undefined ? { startsAt: b.startsAt as string | null } : {}),
    ...(b.endsAt !== undefined ? { endsAt: b.endsAt as string | null } : {}),
  };
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

/** パスキーの設定。WEBAUTHN_RP_ID を決めていなければ使えない */
let cachedSite: SiteConfig | null | undefined;
function requireSite(): SiteConfig {
  if (cachedSite === undefined) cachedSite = siteConfigFromEnv();
  if (!cachedSite) throw new HttpError(404, 'この環境ではパスキーを使えません（WEBAUTHN_RP_ID が未設定）');
  return cachedSite;
}

/** テスト用：設定を読み直す */
export function resetPasskeySite(): void { cachedSite = undefined; }

/** 会社アカウント（SSO）の設定。SSO_REDIRECT_URI を決めていなければ使えない */
let cachedSsoSite: SsoSite | null | undefined;
function requireSsoSite(): SsoSite {
  if (cachedSsoSite === undefined) cachedSsoSite = ssoSiteFromEnv();
  if (!cachedSsoSite) throw new HttpError(404, 'この環境では会社アカウントで入れません（SSO_REDIRECT_URI が未設定）');
  return cachedSsoSite;
}

/** テスト用：設定を読み直す */
export function resetSsoSite(): void { cachedSsoSite = undefined; }

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

  // --- 写真 ---------------------------------------------------------------
  r.get('/knowledge/:id/photos', async (c, _req, p) => json(await listPhotos(c.db, c.storage, c.actor, p.id!)));
  r.post('/knowledge/:id/photos', async (c, req, p) => {
    const b = (await readJson<Record<string, unknown>>(req)) ?? {};
    if (typeof b.contentType !== 'string' || typeof b.bytes !== 'number') throw new HttpError(400, 'contentType と bytes が必要です');
    return json(await startPhotoUpload(c.db, c.storage, c.actor, p.id!, { contentType: b.contentType, bytes: b.bytes }), 201);
  });
  // 中身そのものを受け取る（ローカル保存のとき。S3 のときは端末から直接 S3 に上がる）
  r.put('/photos/:photoId/data', async (c, req, p) => {
    const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim();
    await receivePhoto(c.db, c.storage, c.actor, p.photoId!, new Uint8Array(await req.arrayBuffer()), type);
    return json({ ok: true });
  });
  r.post('/photos/:photoId/complete', async (c, req, p) => {
    const b = (await readJson<Record<string, unknown>>(req)) ?? {};
    optionalString(b, 'caption');
    return json(await finishPhotoUpload(c.db, c.storage, c.actor, p.photoId!, b.caption as string | null | undefined), 201);
  });
  r.get('/photos/:photoId/data', async (c, _req, p) => {
    const out = await openPhoto(c.db, c.storage, c.actor, p.photoId!);
    if (out.kind === 'redirect') return new Response(null, { status: 302, headers: { location: out.url, 'cache-control': 'private, max-age=60' } });
    return new Response(out.body, { headers: { 'content-type': out.contentType, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' } });
  });
  r.delete('/photos/:photoId', async (c, _req, p) => json(await deletePhoto(c.db, c.storage, c.actor, p.photoId!)));

  // --- 連絡事項 -------------------------------------------------------------
  r.get('/stores/:storeId/notices', async (c, req, p) => {
    const includeEnded = new URL(req.url).searchParams.get('all') === '1';
    return json(await listNotices(c.db, c.actor, p.storeId!, includeEnded));
  });
  r.post('/stores/:storeId/notices', async (c, req, p) =>
    json(await createNotice(c.db, c.actor, p.storeId!, noticeBody(await readJson(req))), 201));
  r.post('/notices', async (c, req) =>
    // 全店共通の連絡事項（本部のみ）
    json(await createNotice(c.db, c.actor, null, noticeBody(await readJson(req))), 201));
  r.get('/notices/:noticeId', async (c, _req, p) => json(await getNotice(c.db, c.actor, p.noticeId!)));
  r.put('/notices/:noticeId', async (c, req, p) =>
    json(await updateNotice(c.db, c.actor, p.noticeId!, noticeBody(await readJson(req)))));
  r.post('/notices/:noticeId/end', async (c, _req, p) => json(await endNotice(c.db, c.actor, p.noticeId!)));
  r.delete('/notices/:noticeId', async (c, _req, p) => json(await deleteNotice(c.db, c.actor, p.noticeId!)));
  r.post('/notices/:noticeId/read', async (c, _req, p) => json(await markRead(c.db, c.actor, p.noticeId!)));
  r.post('/notices/:noticeId/ack', async (c, _req, p) => json(await ackNotice(c.db, c.actor, p.noticeId!)));
  r.get('/notices/:noticeId/readers', async (c, _req, p) => json(await noticeReaders(c.db, c.actor, p.noticeId!)));

  // --- 引き継ぎ -------------------------------------------------------------
  r.get('/stores/:storeId/handovers', async (c, req, p) => {
    const date = new URL(req.url).searchParams.get('date') ?? undefined;
    return json(await listHandovers(c.db, c.actor, p.storeId!, date));
  });
  r.post('/stores/:storeId/handovers', async (c, req, p) => {
    const b = (await readJson<Record<string, unknown>>(req)) ?? {};
    if (typeof b.body !== 'string') throw new HttpError(400, 'body（文字列）が必要です');
    if (b.forDate !== undefined && typeof b.forDate !== 'string') throw new HttpError(400, 'forDate は日付の文字列です');
    return json(await addHandover(c.db, c.actor, p.storeId!, b.body, b.forDate as string | undefined), 201);
  });
  r.get('/stores/:storeId/handovers/history', async (c, req, p) => {
    const url = new URL(req.url);
    const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'actions';
    const days = url.searchParams.get('days');
    if (days !== null && !/^\d{1,3}$/.test(days)) throw new HttpError(400, 'days は1〜365の数字です');
    return json(await handoverHistory(c.db, c.actor, p.storeId!, scope, days === null ? undefined : Number(days)));
  });
  r.post('/handovers/:handoverId/done', async (c, _req, p) => json(await setHandoverState(c.db, c.actor, p.handoverId!, 'done')));
  r.post('/handovers/:handoverId/restore', async (c, _req, p) => json(await restoreHandover(c.db, c.actor, p.handoverId!)));
  r.post('/handovers/:handoverId/reopen', async (c, _req, p) => json(await setHandoverState(c.db, c.actor, p.handoverId!, 'open')));
  r.delete('/handovers/:handoverId', async (c, _req, p) => json(await deleteHandover(c.db, c.actor, p.handoverId!)));

  // ホームに出す数（未読・未確認・片付いていない引き継ぎ）
  r.get('/stores/:storeId/badges', async (c, _req, p) => json({
    notices: await noticeBadge(c.db, c.actor, p.storeId!),
    handovers: await handoverBadge(c.db, c.actor, p.storeId!),
  }));

  // --- 既存マニュアルの取り込み ---------------------------------------------
  // ファイルの中身をそのまま本文として送る（境界つきの multipart は使わない）。
  // 名前は ?name= で渡す。
  r.post('/stores/:storeId/imports', async (c, req, p) => {
    const name = new URL(req.url).searchParams.get('name') ?? '';
    if (!name) throw new HttpError(400, 'name（ファイル名）が必要です');
    const body = Buffer.from(await req.arrayBuffer());
    if (body.byteLength > MAX_IMPORT_BYTES) throw new HttpError(413, 'ファイルが大きすぎます');
    return json(await importManual(c.db, c.actor, p.storeId!, name, body), 201);
  });
  r.get('/stores/:storeId/imports', async (c, _req, p) => json(await listImports(c.db, c.actor, p.storeId!)));
  r.post('/imports/:importId/discard', async (c, _req, p) => json(await discardImport(c.db, c.actor, p.importId!)));

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
  // タグの読み：機械が出した案を人が確かめる。確かめたものだけが検索に効く。
  r.get('/tag-readings', async (c) => json(await listReadingProposals(c.db, c.tokenizer, c.actor)));
  r.post('/tag-readings/:tagId', async (c, req, p) => {
    const b = (await readJson<Record<string, unknown>>(req)) ?? {};
    // readings を省く、または空の配列にすると「読みなし」として確定する
    const raw = b.readings ?? [];
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
      throw new HttpError(400, 'readings は文字列の配列です');
    }
    return json(await confirmReading(c.db, c.actor, p.tagId!, raw as string[]));
  });
  r.post('/tags/merge', async (c, req) => {
    const b = (await readJson<Record<string, unknown>>(req)) ?? {};
    if (typeof b.from !== 'string' || typeof b.into !== 'string') throw new HttpError(400, 'from と into（タグ名）が必要です');
    return json(await mergeTags(c.db, c.tokenizer, c.actor, b.from, b.into));
  });

  // --- パスキー -------------------------------------------------------------
  r.post('/passkeys/register/start', async (c, req) => {
    const site = requireSite();
    const b = (await readJson<Record<string, unknown>>(req)) ?? {};
    const name = typeof b.name === 'string' ? b.name : '';
    const who = await me(c.db, c.actor);
    return json(await startRegistration(c.db, c.actor, site, name || who.name));
  });
  r.post('/passkeys/register/finish', async (c, req) => {
    const site = requireSite();
    const b = (await readJson<Record<string, unknown>>(req)) ?? {};
    for (const key of ['clientDataJSON', 'attestationObject']) {
      if (typeof b[key] !== 'string') throw new HttpError(400, `${key} が必要です`);
    }
    return json(await finishRegistration(c.db, c.actor, site, {
      clientDataJSON: b.clientDataJSON as string,
      attestationObject: b.attestationObject as string,
      ...(typeof b.name === 'string' ? { name: b.name } : {}),
    }), 201);
  });
  r.get('/passkeys', async (c) => json(await listPasskeys(c.db, c.actor)));

  // --- 会社アカウント（SSO）の設定：本部の管理者だけ -------------------------
  r.get('/sso/providers', async (c) => json(await listProviders(c.db, c.actor)));
  r.post('/sso/providers', async (c, req) => {
    const b = (await readJson<Record<string, unknown>>(req)) ?? {};
    if (typeof b.issuer !== 'string' || typeof b.clientId !== 'string') {
      throw new HttpError(400, 'issuer と clientId が必要です');
    }
    if (!Array.isArray(b.domains) || b.domains.some((d) => typeof d !== 'string')) {
      throw new HttpError(400, 'domains（メールアドレスのドメイン）が必要です');
    }
    return json(await addProvider(c.db, c.actor, {
      issuer: b.issuer,
      clientId: b.clientId,
      clientSecret: typeof b.clientSecret === 'string' ? b.clientSecret : null,
      domains: b.domains as string[],
      jitEnabled: b.jitEnabled === true,
      defaultStoreId: typeof b.defaultStoreId === 'string' ? b.defaultStoreId : null,
      defaultTrust: b.defaultTrust === 'trusted' ? 'trusted' : 'visitor',
    }), 201);
  });
  r.delete('/sso/providers/:providerId', async (c, _req, p) =>
    json(await disableProvider(c.db, c.actor, p.providerId!)));

  // --- 利用の申請（会社アカウントで入れたが、登録がまだの人） ------------------
  r.get('/access-requests', async (c) => json(await listRequests(c.db, c.actor)));
  r.post('/access-requests/:requestId/approve', async (c, req, p) => {
    const b = (await readJson<Record<string, unknown>>(req)) ?? {};
    if (typeof b.storeId !== 'string') throw new HttpError(400, '配属する店舗が必要です');
    return json(await approveRequest(c.db, c.actor, p.requestId!, {
      storeId: b.storeId,
      ...(typeof b.name === 'string' ? { name: b.name } : {}),
      ...(b.trustLevel === 'trusted' || b.trustLevel === 'visitor' ? { trustLevel: b.trustLevel } : {}),
    }), 201);
  });
  r.post('/access-requests/:requestId/reject', async (c, _req, p) =>
    json(await rejectRequest(c.db, c.actor, p.requestId!)));
  r.delete('/passkeys/:passkeyId', async (c, _req, p) => json(await deletePasskey(c.db, c.actor, p.passkeyId!)));

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

export interface AppDeps {
  database: Database;
  auth: Authenticator;
  tokenizer: Tokenizer;
  limiter?: Limiter;
  storage?: Storage;
  metrics?: Metrics;
  logger?: Logger;
  alerts?: Alerts;
  /** 相手の IdP とのやり取り（試験では偽の IdP を差し込む） */
  oidc?: OidcDirectory;
}

export function createApp(deps: AppDeps) {
  const router = routes();
  // RATE_LIMIT=db なら台をまたいで共有する。既定はサーバーの記憶の中（1台向け）
  const limiter = deps.limiter
    ?? (process.env.RATE_LIMIT === 'db' ? new DatabaseRateLimiter((sql, params) => deps.database.raw(sql, params)) : new MemoryRateLimiter());
  const storage = deps.storage ?? storageFromEnv();
  const metrics = deps.metrics ?? new Metrics();
  const logger = deps.logger ?? new Logger();
  const alerts = deps.alerts ?? new Alerts();
  // 相手の IdP の設定と鍵は覚えておく（毎回取りに行くと、相手が落ちている間こちらも入れない）
  const directory = deps.oidc ?? new OidcDirectory();

  /** 画面に戻す。断片（#）に載せたものはサーバーに送られないので、記録に残らない */
  const appRedirect = (fragment: string): Response =>
    new Response(null, { status: 302, headers: { location: `/app/#${fragment}` } });
  const tooMany = () => json({ error: 'rate_limited', message: '試行回数が多すぎます。しばらく待ってからもう一度お試しください。' }, 429);

  /** 数え取りは、設定した合言葉を知っている人だけに見せる（本番で合言葉が無ければ出さない） */
  function metricsAllowed(req: Request, url: URL): boolean {
    const token = process.env.METRICS_TOKEN;
    if (!token) return process.env.NODE_ENV !== 'production';
    const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('token');
    return given === token;
  }

  async function handleRequest(req: Request, url: URL, id: string): Promise<Response> {
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/ready') {
      try {
        await deps.database.raw('SELECT 1');
        return json({ ok: true });
      } catch (err) {
        logger.error('database not ready', { requestId: id, error: err instanceof Error ? err.message : String(err) });
        return json({ ok: false, error: 'database' }, 503);
      }
    }
    if (url.pathname === '/metrics') {
      if (!metricsAllowed(req, url)) return json({ error: 'not_found' }, 404);
      return new Response(metrics.render(), { headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' } });
    }

    // ログイン前に呼ぶ唯一の API：招待トークンを端末のセッショントークンに交換する
    if (url.pathname === '/auth/accept' && req.method === 'POST') {
      if (!(await limiter.take(clientKey(req, 'accept'), RULES.acceptInvitation))) return tooMany();
      const b = (await readJson<Record<string, unknown>>(req)) ?? {};
      const token = typeof b.token === 'string' ? b.token : '';
      const parsed = parseToken(token);
      if (!parsed) throw new HttpError(400, '招待のQRコードを読み取れませんでした');
      const deviceName = typeof b.deviceName === 'string' ? b.deviceName.slice(0, MAX_DEVICE_NAME) : null;
      const result = await deps.database.withTenant(parsed.tenantId, (db) => acceptInvitation(db, parsed.tenantId, token, deviceName));
      return json(result, 201);
    }

    // ログイン前に呼ぶ、パスキーの2本。
    // 招待リンクと違い、**端末を変えても自分で入り直せる**のがパスキーの値打ちなので、
    // ここが無いと登録だけできて使えない（登録はログイン後の経路にある）。
    if (url.pathname === '/auth/passkey/start' && req.method === 'POST') {
      if (!(await limiter.take(clientKey(req, 'passkey'), RULES.passkeyLogin))) return tooMany();
      const site = requireSite();
      return json(await startLogin((sql, params) => deps.database.raw(sql, params), site));
    }
    if (url.pathname === '/auth/passkey/finish' && req.method === 'POST') {
      if (!(await limiter.take(clientKey(req, 'passkey'), RULES.passkeyLogin))) return tooMany();
      const site = requireSite();
      const b = (await readJson<Record<string, unknown>>(req)) ?? {};
      for (const key of ['credentialId', 'clientDataJSON', 'authenticatorData', 'signature', 'userHandle']) {
        if (typeof b[key] !== 'string') throw new HttpError(400, `${key} が必要です`);
      }
      const result = await loginWithPasskey(deps.database, site, {
        credentialId: b.credentialId as string,
        clientDataJSON: b.clientDataJSON as string,
        authenticatorData: b.authenticatorData as string,
        signature: b.signature as string,
        userHandle: b.userHandle as string,
        ...(typeof b.deviceName === 'string' ? { deviceName: b.deviceName.slice(0, MAX_DEVICE_NAME) } : {}),
      });
      return json(result, 201);
    }

    // ログイン前に呼ぶ、会社アカウント（SSO）の2本。
    //
    // 戻り（callback）は相手の IdP が利用者のブラウザを飛ばしてくる GET なので、
    // JSON ではなく画面に戻す。端末セッションは URL の断片（#）に載せる。
    // 断片はサーバーに送られず、記録にも残らない（招待リンクと同じ考え方）。
    if (url.pathname === '/auth/sso/start' && req.method === 'POST') {
      if (!(await limiter.take(clientKey(req, 'sso'), RULES.ssoLogin))) return tooMany();
      const site = requireSsoSite();
      const b = (await readJson<Record<string, unknown>>(req)) ?? {};
      if (typeof b.email !== 'string') throw new HttpError(400, 'メールアドレスが必要です');
      return json(await startSso(deps.database, directory, site, { email: b.email, returnTo: b.returnTo }));
    }
    if (url.pathname === '/auth/sso/callback' && req.method === 'GET') {
      if (!(await limiter.take(clientKey(req, 'sso'), RULES.ssoLogin))) return tooMany();
      const site = requireSsoSite();
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      // 相手が断った場合（利用者が「許可しない」を押した、など）も戻ってくる
      const denied = url.searchParams.get('error_description') ?? url.searchParams.get('error');
      if (denied !== null) return appRedirect(`sso-error=${encodeURIComponent(denied.slice(0, 200))}`);
      if (code === null || state === null) return appRedirect('sso-error=' + encodeURIComponent('戻り方が正しくありませんでした'));
      try {
        const result = await finishSso(deps.database, directory, site, {
          code, state, deviceName: 'ブラウザ（会社アカウント）',
        });
        const back = result.returnTo === null ? '' : `&to=${encodeURIComponent(result.returnTo)}`;
        return appRedirect(`sso=${encodeURIComponent(result.sessionToken)}${back}`);
      } catch (err) {
        const message = err instanceof DomainError ? err.message
          : err instanceof Error ? err.message : String(err);
        logger.warn('sso callback failed', { requestId: id, error: message });
        return appRedirect(`sso-error=${encodeURIComponent(message.slice(0, 200))}`);
      }
    }

    const matched = router.match(req.method, url.pathname);
    if (matched === undefined) throw new HttpError(404, 'Not Found');
    if (matched === 'method_not_allowed') throw new HttpError(405, 'Method Not Allowed');
    checkParams(matched.params);

    // 無効なトークンでのアクセスが続く接続元からは、認証そのものを止める（トークンの総当たり対策）
    const failKey = clientKey(req, 'authfail');
    if (await limiter.blocked(failKey, RULES.failedAuth)) return tooMany();
    const identity = await deps.auth.identify(req);
    if (!identity) {
      if (req.headers.has('authorization') || req.headers.has('x-dev-user-id')) await limiter.take(failKey, RULES.failedAuth);
      throw new HttpError(401, 'ログインしてください');
    }
    const actor = await loadActor(deps.database, identity);
    if (!actor) throw new HttpError(401, 'この利用者は無効です');

    return await deps.database.withTenant(actor.tenantId, (db) =>
      matched.handler(
        { actor, identity, db, tokenizer: deps.tokenizer, storage },
        req,
        matched.params,
      ),
    );
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const id = requestId(req);
    const startedAt = Date.now();
    // 数え取りのラベルは経路の型だけにする（ID を入れると種類が増え続けるため）
    const route = router.match(req.method, url.pathname);
    const label = typeof route === 'object' ? route.path : url.pathname === '/health' || url.pathname === '/ready' || url.pathname === '/metrics' ? url.pathname : 'その他';

    let response: Response;
    try {
      response = await handleRequest(req, url, id);
    } catch (err) {
      if (err instanceof DomainError) {
        response = json({ error: err.code, message: err.message }, STATUS[err.code]);
      } else if (err instanceof HttpError) {
        response = json({ error: 'http', message: err.message }, err.status);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('unhandled error', { requestId: id, route: label, method: req.method, error: message });
        metrics.count('misenare_errors_total', { route: label, kind: 'internal' });
        void alerts.notify(`internal:${label}`, `misenare: ${req.method} ${label} でサーバーエラー\n${message}`);
        response = json({ error: 'internal', message: 'サーバーでエラーが発生しました' }, 500);
      }
    }

    const seconds = (Date.now() - startedAt) / 1000;
    metrics.request(label, req.method, response.status, seconds);
    if (url.pathname !== '/metrics') {
      logger.log(response.status >= 500 ? 'error' : 'info', 'request', {
        requestId: id, method: req.method, route: label, status: response.status, ms: Math.round(seconds * 1000),
      });
    }
    const headers = new Headers(response.headers);
    headers.set('x-request-id', id);
    return new Response(response.body, { status: response.status, headers });
  };
}
