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

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch {
    throw new ApiError(0, '通信できませんでした。電波の届く場所で、もう一度お試しください。');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, (data && data.message) || `エラーが発生しました（${res.status}）`);
  return data as T;
}

// --- API の型（サーバーの戻り値に合わせる） -----------------------------------

export interface Me {
  id: string;
  name: string;
  trustLevel: 'visitor' | 'trusted';
  adminScope: 'none' | 'store' | 'tenant';
  stores: Array<{ id: string; name: string }>;
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
  verifiedAt: string | null;
  verifiedBy: string | null;
  pendingVersions: number[];
}

export interface Dictionary {
  tags: Array<{ id: string; name: string; reading: string | null; useCount: number }>;
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
