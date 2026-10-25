// 操作する人と権限。権限は雇用形態ではなく trust_level（visitor / trusted）と admin_scope で決める。

export type TrustLevel = 'visitor' | 'trusted';
export type AdminScope = 'none' | 'store' | 'tenant';

export interface Actor {
  userId: string;
  tenantId: string;
  /** 所属店舗（兼務なら複数） */
  storeIds: string[];
  trustLevel: TrustLevel;
  adminScope: AdminScope;
}

export class DomainError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}

/** administrator（店長・本部）は trusted の権限も持つ。 */
export function isTrusted(a: Actor): boolean {
  return a.trustLevel === 'trusted' || a.adminScope !== 'none';
}

/** その店舗のデータに触れるか。本部は全店舗。 */
export function canAccessStore(a: Actor, storeId: string | null): boolean {
  if (storeId === null) return true; // 全店共通ナレッジは誰でも閲覧できる
  return a.adminScope === 'tenant' || a.storeIds.includes(storeId);
}

/** 承認・却下・過去版への戻し・タグ関係の承認ができるか。 */
export function canModerate(a: Actor, storeId: string | null): boolean {
  if (!isTrusted(a)) return false;
  if (storeId === null) return a.adminScope === 'tenant'; // 全店共通は本部のみ
  return canAccessStore(a, storeId);
}

/** 商品の削除・統合、マニュアル取込、ユーザー管理。 */
export function canAdminister(a: Actor, storeId: string | null): boolean {
  if (a.adminScope === 'tenant') return true;
  return a.adminScope === 'store' && storeId !== null && a.storeIds.includes(storeId);
}

export function assert(cond: boolean, code: DomainError['code'], message: string): asserts cond {
  if (!cond) throw new DomainError(code, message);
}
