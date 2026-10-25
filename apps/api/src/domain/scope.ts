// ID の存在確認。外部キーの検査は行レベルセキュリティを無視するため、
// 他社の店舗IDや商品IDを推測して渡されても通ってしまう。ここで RLS の効いた SELECT で確かめる。

import { maybeOne, type Db } from '../db/db.ts';
import { assert } from './actor.ts';

export async function assertStore(db: Db, storeId: string): Promise<void> {
  const s = await maybeOne(db, `SELECT 1 FROM stores WHERE id = $1`, [storeId]);
  assert(s !== undefined, 'not_found', '店舗が見つかりません');
}
