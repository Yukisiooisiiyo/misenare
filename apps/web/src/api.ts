// API の呼び出し。端末のセッショントークンは localStorage に保存する。

const TOKEN_KEY = 'misenare.session';
const STORE_KEY = 'misenare.store';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const session = {
  get token(): string | null {
    return storage()?.getItem(TOKEN_KEY) ?? null;
  },
  set token(v: string | null) {
    const s = storage();
    if (!s) return;
    if (v === null) s.removeItem(TOKEN_KEY);
    else s.setItem(TOKEN_KEY, v);
  },
  get storeId(): string | null {
    return storage()?.getItem(STORE_KEY) ?? null;
  },
  set storeId(v: string | null) {
    const s = storage();
    if (!s) return;
    if (v === null) s.removeItem(STORE_KEY);
    else s.setItem(STORE_KEY, v);
  },
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// 401（セッション切れ・無効な利用者）の戻り先。api.ts から main.ts を読むと循環するので、
// main.ts の boot() が登録する。どの画面の要求でも、ここ1か所で招待画面へ戻せる。
let unauthorizedHandler: (() => void) | null = null;

export function onUnauthorized(fn: () => void): void {
  unauthorizedHandler = fn;
}

const UNREADABLE = '応答を読めませんでした。電波の状態を確かめて、もう一度お試しください';

/**
 * 応答の本文を JSON として読む。HTML のエラーページや店舗 Wi-Fi のログイン画面（200 で返ることもある）、
 * 途中で切れた本文は ApiError にする。SyntaxError のままだと、ブラウザ固有の英語が画面に出てしまう。
 * 401 は本文が読めなくても扱う。sent は要求に付けたトークンで、同じトークンのうちは1回だけ戻す
 * （並列の要求がまとめて 401 になっても招待画面を何度も描かない／新しく登録し直した後の古い応答で追い出さない）。
 */
async function readBody(res: Response, sent: string | null): Promise<any> {
  let data: any = null;
  let readable = true;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    readable = false;
  }
  if (res.status === 401 && sent !== null && session.token === sent) unauthorizedHandler?.();
  if (!readable) throw new ApiError(res.status, UNREADABLE);
  return data;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  // ファイルの中身（ArrayBuffer）はそのまま送る。それ以外は JSON にする
  const raw = body instanceof ArrayBuffer || body instanceof Blob;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = raw ? 'application/octet-stream' : 'application/json';
  const sent = session.token;
  if (sent) headers.authorization = `Bearer ${sent}`;
  let res: Response;
  try {
    const payload = body === undefined ? {} : { body: raw ? (body as BodyInit) : JSON.stringify(body) };
    res = await fetch(`/api${path}`, { method, headers, ...payload });
  } catch {
    throw new ApiError(0, '通信できませんでした。電波の届く場所で、もう一度お試しください。');
  }
  const data = await readBody(res, sent);
  if (!res.ok) throw new ApiError(res.status, (data && data.message) || `エラーが発生しました（${res.status}）`);
  return data as T;
}

// 辞書は起動のたびに取るが、中身はめったに変わらない。前回の ETag を覚えて If-None-Match で送り、
// 304 なら前回の辞書をそのまま使う（本文の転送と解析を省く）。メモリだけで持つので、画面を開き直せば取り直す。
// 店舗ごとに辞書が違うので、店舗 ID を鍵にする。
const dictionaryMemo = new Map<string, { etag: string; dictionary: Dictionary }>();

export async function fetchDictionary(storeId: string): Promise<Dictionary> {
  const known = dictionaryMemo.get(storeId);
  const headers: Record<string, string> = {};
  const sent = session.token;
  if (sent) headers.authorization = `Bearer ${sent}`;
  if (known) headers['if-none-match'] = known.etag;
  let res: Response;
  try {
    res = await fetch(`/api/stores/${storeId}/tags/dictionary`, { method: 'GET', headers });
  } catch {
    throw new ApiError(0, '通信できませんでした。電波の届く場所で、もう一度お試しください。');
  }
  if (res.status === 304 && known) return known.dictionary;
  const data = await readBody(res, sent);
  if (!res.ok) throw new ApiError(res.status, (data && data.message) || `エラーが発生しました（${res.status}）`);
  const etag = res.headers.get('etag');
  if (etag) dictionaryMemo.set(storeId, { etag, dictionary: data as Dictionary });
  else dictionaryMemo.delete(storeId);
  return data as Dictionary;
}

// --- API の型（サーバーの戻り値に合わせる） -----------------------------------

export interface Me {
  id: string;
  name: string;
  trustLevel: 'visitor' | 'trusted';
  adminScope: 'none' | 'store' | 'tenant';
  stores: Array<{ id: string; name: string }>;
  /** 「古い」とみなすまでの日数（サーバーが決める） */
  staleDays?: number;
}

export interface Hit {
  id: string;
  title: string;
  snippet: string;
  tags: string[];
  updatedAt: string;
  verifiedAt: string | null;
  verifiedBy: string | null;
  linked?: boolean;
}

export interface SearchResult {
  hits: Hit[];
  chips: Array<{ name: string; count: number }>;
  logId: number;
}

export interface Knowledge {
  id: string;
  storeId: string | null;
  status: 'draft' | 'published' | 'expired';
  version: number | null;
  title: string;
  body: string;
  tags: string[];
  updatedAt: string;
  updatedBy: string | null;
  /** 最初に書いた人 */
  createdBy: string | null;
  /** いま出ている版を承認した人 */
  approvedBy: string | null;
  approvedAt: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  pendingEdits: Array<{ version: number; editedBy: string | null; editedAt: string; mine: boolean }>;
}

export interface Dictionary {
  tags: Array<{ id: string; name: string; readings: string[]; useCount: number }>;
  relations: Array<{ kind: 'synonym' | 'includes' | 'alias'; from_tag_id: string | null; from_text: string | null; to_tag_id: string }>;
  cooccurrence: Record<string, number>;
}

export interface ProductCard {
  id: string;
  janCode: string;
  name: string;
  maker: string | null;
  area: { id: string; name: string } | null;
  note: string | null;
  tags: string[];
  pending: boolean;
}

export type ScanResult =
  | { status: 'unknown'; janCode: string }
  | { status: 'found'; product: ProductCard; related: Hit[] };
