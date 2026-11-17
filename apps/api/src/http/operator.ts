// 運営者の管理画面（/admin/）が呼ぶ口。/operator/… にまとめ、利用者の API とは認証も権限も別にする。
//
//   ログイン前  POST /operator/auth/setup     パスワード設定リンクを送る（運営者のアドレスだけ）
//               POST /operator/auth/password  設定リンクでパスワードを決める
//               POST /operator/auth/login     メアドとパスワード（設定していれば確認コード）で入る
//   ログイン後  会社と店舗の一覧・作成・編集・停止・再開・完全削除、契約の控え、利用者を止める・戻す
//               2段階の確認の設定、ログインの記録、操作の記録、問い合わせの一覧、退避（バックアップ）の様子
//
// 鍵（セッションのトークン）は Authorization で受ける。クッキーに入れるのは「前に入ったことのあるブラウザー」の印だけで、
// これは鍵ではない（パスワードと確認コードは毎回要る）。印は HttpOnly なので、画面のスクリプトからは読めない。

import type { Database } from '../db/db.ts';
import { readBackupStatus } from '../domain/backupStatus.ts';
import {
  addStore, createTenant, deleteTenant, DEVICE_DAYS, disableTotp, enableTotp, getTenant, issueAdminInvite, listInquiries,
  listTenants, listTenantUsers, loginOperator, logoutOperator, recentLog, recentLogins, regenerateRecoveryCodes,
  removeStore, renameStore, requestOperatorSetup, resumeTenant, securityStatus, setOperatorPassword, setTenantUserStatus,
  startTotp, suspendTenant, updateTenant, verifyOperator, type LoginClient,
} from '../domain/operator.ts';
import type { Mail, Mailer } from '../mail/mailer.ts';
import type { Storage } from '../storage/storage.ts';
import { clientIp, clientKey, RULES, type Limiter } from './rateLimit.ts';
import { HttpError, json, readJson } from './router.ts';

export interface OperatorDeps {
  database: Database;
  mailer: Mailer;
  storage: Storage;
  limiter: Limiter;
  appUrl: string;
  env?: NodeJS.ProcessEnv;
  /** 応答を返したあとに続ける仕事を預ける口（メールの送信を待たずに返すため）。無ければその場で待つ */
  later?: (name: string, work: Promise<unknown>) => void;
}

type Body = Record<string, unknown>;

function bearer(req: Request): string | null {
  return /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? null;
}

const DEVICE_COOKIE = 'tsugigami_op_device';

/** ブラウザーが持ってきた「前に入ったことがある」印 */
function deviceFrom(req: Request): string | null {
  return new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([A-Za-z0-9_-]{20,100})(?:;|$)`).exec(req.headers.get('cookie') ?? '')?.[1] ?? null;
}

/** 印をブラウザーに持たせる。ログインの口（/api/operator/auth/…）にだけ送られ、スクリプトからは読めない */
function withDevice(res: Response, device: string, url: URL): Response {
  // 手元（localhost）で試すときだけ Secure を外す。http では Secure 付きのクッキーを受け取らないブラウザーがある
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
  res.headers.append('set-cookie',
    `${DEVICE_COOKIE}=${device}; Path=/api/operator/auth; Max-Age=${DEVICE_DAYS * 86400}; HttpOnly; SameSite=Strict${local ? '' : '; Secure'}`);
  return res;
}

function clientOf(req: Request): LoginClient {
  const ip = clientIp(req);
  return { ip: ip === 'unknown' ? null : ip, agent: req.headers.get('user-agent'), device: deviceFrom(req) };
}

export async function handleOperator(deps: OperatorDeps, req: Request, url: URL, tooMany: () => Response): Promise<Response> {
  const { database, limiter } = deps;
  const env = deps.env ?? process.env;
  const path = url.pathname.replace(/^\/operator/, '').replace(/\/+$/, '');
  const method = req.method;
  const body = async (): Promise<Body> => ((await readJson<Body | null>(req)) ?? {});
  const client = clientOf(req);
  /** 知らせのメールは、応答を返したあとに送る（待たせない。送れなくても、操作は済んでいる） */
  const notify = async (name: string, mail: Mail | null): Promise<void> => {
    if (!mail) return;
    const work = deps.mailer.send(mail);
    if (deps.later) deps.later(name, work);
    else await work.catch(() => false);
  };

  // --- ログイン前 ---
  if (path === '/auth/setup' && method === 'POST') {
    if (!(await limiter.take(clientKey(req, 'operator-setup'), RULES.operatorSetup))) return tooMany();
    const b = await body();
    // 運営者のアドレスかどうかを外から確かめさせない：いつも同じ応答を、送り終わるのを待たずに返す
    // （待つと、運営者のアドレスのときだけ応答が遅くなり、かかった時間から分かってしまう）
    const work = requestOperatorSetup(database, deps.mailer, deps.appUrl, String(b.email ?? ''), env);
    if (deps.later) deps.later('operator-setup', work);
    else await work;
    return json({ sent: true });
  }
  if (path === '/auth/password' && method === 'POST') {
    if (!(await limiter.take(clientKey(req, 'operator-login'), RULES.operatorLogin))) return tooMany();
    const b = await body();
    const done = await setOperatorPassword(database, String(b.token ?? ''), b.password as string, client, deps.appUrl);
    await notify('operator-password-notice', done.notice);
    return withDevice(json({ ok: true }), done.device, url);
  }
  if (path === '/auth/login' && method === 'POST') {
    if (!(await limiter.take(clientKey(req, 'operator-login'), RULES.operatorLogin))) return tooMany();
    const b = await body();
    const r = await loginOperator(database, { email: b.email, password: b.password, code: b.code }, client, deps.appUrl, env);
    await notify('operator-login-notice', r.notice);
    if (!r.ok) {
      // 止めているときの応答は、運営者でないアドレスでも同じ（どのアドレスが運営者かを、止まり方から読ませない）
      if (r.reason === 'locked') {
        return json({ error: 'locked', message: 'ログインの失敗が続いたので、このアドレスでのログインをしばらく受け付けません。時間をおくか、下の「パスワードの設定・再設定」からやり直してください' }, 429);
      }
      throw new HttpError(401, 'メールアドレスかパスワード（設定していれば、確認コードも）が違います');
    }
    return withDevice(json({ token: r.token, email: r.email }), r.device, url);
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
  if (path === '/me' && method === 'GET') return json({ email: op.email, totp: (await securityStatus(database, op)).totp.enabled });
  if (path === '/log' && method === 'GET') return json(await recentLog(database, url.searchParams.get('before')));
  if (path === '/logins' && method === 'GET') return json(await recentLogins(database, url.searchParams.get('before')));
  if (path === '/inquiries' && method === 'GET') return json(await listInquiries(database, url.searchParams.get('before')));
  // 退避（バックアップ）が取れているか。取るのは別のコンテナで、ここは結果を読むだけ
  if (path === '/backup' && method === 'GET') return json(await readBackupStatus(env));

  // 2段階の確認。パスワードやコードを確かめ直す口なので、画面を触れた人が当てに来られないよう、運営者ごとに回数を絞る
  if (path === '/security' && method === 'GET') return json(await securityStatus(database, op));
  if (path.startsWith('/security/') && method === 'POST') {
    if (!(await limiter.take(`operator-reauth:${op.id}`, RULES.operatorReauth))) return tooMany();
    const b = await body();
    if (path === '/security/totp/start') return json(await startTotp(database, op, b.password));
    if (path === '/security/totp/enable') {
      const done = await enableTotp(database, op, b.code, client, deps.appUrl);
      await notify('operator-totp-notice', done.notice);
      return json({ recoveryCodes: done.recoveryCodes });
    }
    if (path === '/security/totp/disable') {
      const done = await disableTotp(database, op, b.password, b.code, client, deps.appUrl);
      await notify('operator-totp-notice', done.notice);
      return json(await securityStatus(database, op));
    }
    if (path === '/security/recovery-codes') {
      const done = await regenerateRecoveryCodes(database, op, b.password, b.code, client, deps.appUrl);
      await notify('operator-totp-notice', done.notice);
      return json({ recoveryCodes: done.recoveryCodes });
    }
  }

  if (path === '/tenants' && method === 'GET') return json({ tenants: await listTenants(database) });
  if (path === '/tenants' && method === 'POST') return json(await createTenant(database, op, await body(), deps.appUrl), 201);

  const u = /^\/tenants\/([^/]+)\/users(?:\/([^/]+)\/(disable|enable))?$/.exec(path);
  if (u) {
    const [, id, userId, action] = u as unknown as [string, string, string | undefined, 'disable' | 'enable' | undefined];
    if (!userId && method === 'GET') return json({ users: await listTenantUsers(database, id) });
    if (userId && method === 'POST') {
      await setTenantUserStatus(database, op, id, userId, action === 'disable' ? 'disabled' : 'active');
      return json({ users: await listTenantUsers(database, id) });
    }
  }

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
