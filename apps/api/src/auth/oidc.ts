// OpenID Connect の相手側とのやり取り。設定の取得・鍵の取得・引換券の交換。
//
// 相手（Entra ID・Google Workspace・Okta など）に登録してもらうのは
// 発行元（issuer）と client_id だけにする。残りは相手が公開している
// 設定（/.well-known/openid-configuration）から取る。登録項目が増えるほど、
// 情報システム部との往復が増えて導入が止まるため。
//
// 取ってきた設定と鍵は覚えておく。毎回取りに行くと、相手のサーバーが
// 落ちている間こちらも入れなくなり、相手に負荷もかける。

import { createHash, randomBytes } from 'node:crypto';
import type { Jwk } from './jwt.ts';
import { FetchRefused, requireSafeUrl, safeFetch, type SafeResponse } from './safeFetch.ts';

/** 設定と鍵を覚えておく時間。相手が鍵を入れ替えてもこの時間で追いつく */
export const CACHE_TTL_MS = 60 * 60_000;
/** 鍵が見つからないときに取り直す間隔の下限（取り直しの連打を防ぐ） */
export const REFETCH_MIN_MS = 5 * 60_000;

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  /** PKCE に対応しているか（S256 が無ければ、相手の設定が古い） */
  code_challenge_methods_supported?: string[];
}

/**
 * 外に取りに行く口。**既定は安全な口（safeFetch）**。
 *
 * ここを差し替えられるようにしているのは試験のため（偽の IdP を相手にする）。
 * 本番で通るのは safeFetch だけで、社内のアドレスや付け替えは全部そこで止まる。
 */
export type Fetch = (url: string, init?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string })
  => Promise<SafeResponse>;

const defaultFetch: Fetch = (url, init) => safeFetch({ url, ...(init ?? {}) });

export class OidcError extends Error {}

interface Entry<T> { value: T; at: number }
/** 鍵の覚え。取り直しの連打を防ぐため、「見つからなくて取り直した時刻」も持つ */
interface KeyEntry extends Entry<Jwk[]> { lastMiss?: number }

/**
 * 相手の設定と鍵の覚え。発行元ごとに1つ。
 * 時計は差し替えられるようにしてある（試験で期限切れを作るため）。
 */
export class OidcDirectory {
  private readonly discovery = new Map<string, Entry<Discovery>>();
  private readonly keys = new Map<string, KeyEntry>();

  constructor(
    private readonly fetchImpl: Fetch = defaultFetch,
    private readonly now: () => number = Date.now,
  ) {}

  private fresh<T>(entry: Entry<T> | undefined, ttl = CACHE_TTL_MS): T | null {
    if (!entry || this.now() - entry.at > ttl) return null;
    return entry.value;
  }

  private async getJson(url: string, what: string): Promise<unknown> {
    let res: SafeResponse;
    try {
      res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    } catch (err) {
      throw new OidcError(`${what}を取得できませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status < 200 || res.status >= 300) throw new OidcError(`${what}を取得できませんでした（${res.status}）`);
    try {
      return JSON.parse(res.text);
    } catch {
      throw new OidcError(`${what}の形が読めません`);
    }
  }

  /** 相手の設定。issuer の末尾に / は付けない決まりなので、ここでも落とす */
  async describe(issuer: string): Promise<Discovery> {
    const base = issuer.replace(/\/+$/, '');
    const cached = this.fresh(this.discovery.get(base));
    if (cached) return cached;
    const json = await this.getJson(`${base}/.well-known/openid-configuration`, '相手の設定') as Partial<Discovery>;
    for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof json[key] !== 'string') throw new OidcError(`相手の設定に ${key} がありません`);
    }
    // 設定自身が名乗る発行元が、登録した発行元と違うなら信用しない
    if (json.issuer !== base) throw new OidcError(`相手の設定の発行元が違います: ${json.issuer}`);

    // **相手の文書に書かれた行き先を、そのまま信用しない。**
    // ここを確かめずに従うと、相手が「社内のこのアドレスへ取りに行け」と
    // 書くだけで、こちらのサーバーが社内を触ることになる（safeFetch の冒頭に詳しく）。
    // 実際につなぐときにも safeFetch が同じ確かめをするが、**設定を入れた時点で
    // 断る**ほうがよい。入れた人に、その場で理由を返せる。
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      try {
        requireSafeUrl(json[key]!, `相手の設定の ${key}`);
      } catch (err) {
        throw new OidcError(err instanceof FetchRefused ? err.message : String(err));
      }
    }

    const value = json as Discovery;
    this.discovery.set(base, { value, at: this.now() });
    return value;
  }

  /**
   * 署名用の鍵。
   *
   * 覚えの中に kid が無ければ取り直す。相手が鍵を入れ替えた直後がこれで、
   * **ここで取り直せないと、入れ替えの間ずっと誰も入れない。**
   * ただし、知らない kid を名乗るトークンを何度も投げられると取り直しの連打に
   * なるので、「取り直した時刻」を別に持って間隔を空ける。
   * 覚えの寿命（CACHE_TTL_MS）とは別の数字なのは、役割が違うため。
   */
  async signingKeys(issuer: string, kid?: string): Promise<Jwk[]> {
    const { jwks_uri: uri } = await this.describe(issuer);
    const entry = this.keys.get(uri);
    const cached = this.fresh(entry);
    let miss = false;
    if (cached) {
      // kid の無い鍵を出す IdP もあるので、その場合は「ある」とみなす
      const known = kid === undefined || cached.some((k) => k.kid === kid || k.kid === undefined);
      if (known) return cached;
      const since = entry!.lastMiss;
      if (since !== undefined && this.now() - since < REFETCH_MIN_MS) return cached;
      miss = true;
    }

    const json = await this.getJson(uri, '相手の鍵') as { keys?: unknown };
    if (!Array.isArray(json.keys)) throw new OidcError('相手の鍵の形が読めません');
    const value = json.keys as Jwk[];
    // 取り直した時刻は覚えを入れ替えても引き継ぐ。落とすと、知らない kid を
    // 名乗るトークンを続けて投げられたときに毎回取りに行ってしまう。
    const lastMiss = miss ? this.now() : entry?.lastMiss;
    this.keys.set(uri, { value, at: this.now(), ...(lastMiss === undefined ? {} : { lastMiss }) });
    return value;
  }

  /**
   * 引換券（code）を ID トークンに替える。
   * client_secret を持たない設定（公開クライアント）では PKCE だけで通す。
   */
  async exchange(input: {
    issuer: string;
    clientId: string;
    clientSecret?: string | null;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<{ idToken: string }> {
    const { token_endpoint: endpoint } = await this.describe(input.issuer);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    // 内緒の鍵は本文に書かず、Basic 認証で送る（本文はログに残りやすい）
    if (input.clientSecret) {
      const pair = `${encodeURIComponent(input.clientId)}:${encodeURIComponent(input.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
    }
    let res: SafeResponse;
    try {
      res = await this.fetchImpl(endpoint, { method: 'POST', headers, body: body.toString() });
    } catch (err) {
      throw new OidcError(`引換券を交換できませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
    let json: { id_token?: unknown; error?: unknown; error_description?: unknown };
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new OidcError(`引換券の交換の答えが読めません（${res.status}）`);
    }
    const ok = res.status >= 200 && res.status < 300;
    if (!ok || typeof json.id_token !== 'string') {
      const detail = typeof json.error_description === 'string' ? json.error_description
        : typeof json.error === 'string' ? json.error : `${res.status}`;
      throw new OidcError(`引換券を交換できませんでした: ${detail}`);
    }
    return { idToken: json.id_token };
  }
}

/** PKCE の検証子と、相手に渡す形（S256） */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const randomToken = (): string => randomBytes(32).toString('base64url');

/**
 * 入った後に戻す画面。**外のサイトに飛ばさないよう、経路だけを通す。**
 * 「//evil.example.com」のような、別のサイトに見える形も落とす。
 */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (!value.startsWith('#/')) return null;
  if (/[\r\n]/.test(value)) return null;
  return value.slice(0, 200);
}
