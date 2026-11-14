// 運営者の管理画面（/admin/）が呼ぶ口。/operator/… にまとめ、利用者の API とは認証も権限も別にする。
//
//   ログイン前  POST /operator/auth/setup     パスワード設定リンクを送る（運営者のアドレスだけ）
//               POST /operator/auth/password  設定リンクでパスワードを決める
//               POST /operator/auth/login     メアドとパスワードで入る
//   ログイン後  会社と店舗の一覧・作成・編集・停止・再開・完全削除、契約の控え、操作の記録

import type { Database } from '../db/db.ts';
import {
  addStore, createTenant, deleteTenant, getTenant, issueAdminInvite, listTenants, loginOperator, logoutOperator,
  recentLog, removeStore, renameStore, requestOperatorSetup, resumeTenant, setOperatorPassword, suspendTenant,
  updateTenant, verifyOperator,
} from '../domain/operator.ts';
import type { Mailer } from '../mail/mailer.ts';
import type { Storage } from '../storage/storage.ts';
import { clientKey, RULES, type Limiter } from './rateLimit.ts';
import { HttpError, json, readJson } from './router.ts';

export interface OperatorDeps {
  database: Database;
  mailer: Mailer;
  storage: Storage;
  limiter: Limiter;
  appUrl: string;
  env?: NodeJS.ProcessEnv;
}

type Body = Record<string, unknown>;

function bearer(req: Request): string | null {
  return /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? null;
}

export async function handleOperator(deps: OperatorDeps, req: Request, url: URL, tooMany: () => Response): Promise<Response> {
  const { database, limiter } = deps;
  const env = deps.env ?? process.env;
  const path = url.pathname.replace(/^\/operator/, '').replace(/\/+$/, '');
  const method = req.method;
  const body = async (): Promise<Body> => ((await readJson<Body | null>(req)) ?? {});

  // --- ログイン前 ---
  if (path === '/auth/setup' && method === 'POST') {
    if (!(await limiter.take(clientKey(req, 'operator-setup'), RULES.operatorSetup))) return tooMany();
    const b = await body();
    await requestOperatorSetup(database, deps.mailer, deps.appUrl, String(b.email ?? ''), env);
    // 運営者のアドレスかどうかを外から確かめさせない：いつも同じ応答
    return json({ sent: true });
  }
  if (path === '/auth/password' && method === 'POST') {
    if (!(await limiter.take(clientKey(req, 'operator-login'), RULES.operatorLogin))) return tooMany();
    const b = await body();
    await setOperatorPassword(database, String(b.token ?? ''), b.password as string);
    return json({ ok: true });
  }
  if (path === '/auth/login' && method === 'POST') {
    if (!(await limiter.take(clientKey(req, 'operator-login'), RULES.operatorLogin))) return tooMany();
    const b = await body();
    const session = await loginOperator(database, String(b.email ?? ''), String(b.password ?? ''), env);
    if (!session) throw new HttpError(401, 'メールアドレスかパスワードが違います');
    return json(session);
  }

  // --- ここから先はログインが要る ---
  const token = bearer(req);
  const op = await verifyOperator(database, token, env);
  if (!op) {
    // 総当たりを鈍らせる（ログインと同じ枠で数える）
    if (token) await limiter.take(clientKey(req, 'operator-login'), RULES.operatorLogin);
    throw new HttpError(401, 'ログインしてください');
  }

  if (path === '/auth/logout' && method === 'POST') {
    await logoutOperator(database, token!);
    return json({ ok: true });
  }
  if (path === '/me' && method === 'GET') return json({ email: op.email });
  if (path === '/log' && method === 'GET') return json({ entries: await recentLog(database) });

  if (path === '/tenants' && method === 'GET') return json({ tenants: await listTenants(database) });
  if (path === '/tenants' && method === 'POST') return json(await createTenant(database, op, await body(), deps.appUrl), 201);

  const m = /^\/tenants\/([^/]+)(?:\/(suspend|resume|admin-invite|stores)(?:\/([^/]+))?)?$/.exec(path);
  if (m) {
    const [, id, sub, storeId] = m as unknown as [string, string, string | undefined, string | undefined];
    if (!sub) {
      if (method === 'GET') return json(await getTenant(database, id));
      if (method === 'PATCH') { await updateTenant(database, op, id, await body()); return json(await getTenant(database, id)); }
      if (method === 'DELETE') { await deleteTenant(database, deps.storage, op, id, (await body()).confirmName); return json({ deleted: true }); }
    }
    if (sub === 'suspend' && !storeId && method === 'POST') { await suspendTenant(database, op, id); return json(await getTenant(database, id)); }
    if (sub === 'resume' && !storeId && method === 'POST') { await resumeTenant(database, op, id); return json(await getTenant(database, id)); }
    if (sub === 'admin-invite' && !storeId && method === 'POST') return json(await issueAdminInvite(database, op, id, (await body()).name, deps.appUrl), 201);
    if (sub === 'stores' && !storeId && method === 'POST') { await addStore(database, op, id, (await body()).name); return json(await getTenant(database, id), 201); }
    if (sub === 'stores' && storeId && method === 'PATCH') { await renameStore(database, op, id, storeId, (await body()).name); return json(await getTenant(database, id)); }
    if (sub === 'stores' && storeId && method === 'DELETE') { await removeStore(database, op, id, storeId); return json(await getTenant(database, id)); }
  }
  throw new HttpError(404, '見つかりません');
}
