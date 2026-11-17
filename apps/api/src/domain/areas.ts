// 売場（店舗の中の場所の名前。「キッチン家電」「大型家電」など）。
//
// 商品に「どの売場にあるか」を付け、ナレッジに「どの売場の話か」を付けるための名前の一覧。
// 店舗ごとに持つ。作る・名前を変える・消すのは、その店舗の店長と本部。選ぶのは、その店舗の人ならだれでも。

import { maybeOne, type Db } from '../db/db.ts';
import { assert, canAccessStore, canAdminister, type Actor } from './actor.ts';
import { assertStore } from './scope.ts';

export const MAX_AREA_NAME = 40;
/** 1店舗に作れる売場の数。選ぶ欄に全部並べるので、際限なく増やさない */
export const MAX_AREAS_PER_STORE = 100;

export interface AreaView { id: string; name: string; /** この売場に置いてある、と登録されている商品の数 */ products: number }

function cleanName(value: unknown): string {
  // 打たれた字はそのまま残す（全角の括弧や数字を半角に直さない）。そろえるのは空白だけ
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  assert(name.length > 0 && name.length <= MAX_AREA_NAME, 'invalid', `売場の名前を1〜${MAX_AREA_NAME}文字で入力してください`);
  return name;
}

export async function listAreas(db: Db, actor: Actor, storeId: string): Promise<AreaView[]> {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗の売場は見られません');
  await assertStore(db, storeId);
  const rows = await db.query<{ id: string; name: string; products: number }>(
    `SELECT a.id, a.name, (SELECT count(*)::int FROM store_products sp WHERE sp.area_id = a.id) AS products
       FROM areas a WHERE a.store_id = $1 ORDER BY a.name`,
    [storeId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, products: Number(r.products) }));
}

export async function createArea(db: Db, actor: Actor, storeId: string, name: unknown): Promise<{ id: string }> {
  assert(canAdminister(actor, storeId), 'forbidden', '売場を作れるのは、店長と本部です');
  await assertStore(db, storeId);
  const clean = cleanName(name);
  const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM areas WHERE store_id = $1`, [storeId]);
  assert(Number(count[0]!.n) < MAX_AREAS_PER_STORE, 'conflict', `売場は1店舗に${MAX_AREAS_PER_STORE}か所までです`);
  // 同じ名前は作らない。確かめてから入れる間に同じ名前が入っても、一意制約で落とさず同じ断り方にする
  const rows = await db.query<{ id: string }>(
    `INSERT INTO areas (tenant_id, store_id, name) VALUES ($1, $2, $3) ON CONFLICT (store_id, name) DO NOTHING RETURNING id`,
    [actor.tenantId, storeId, clean],
  );
  assert(rows.length === 1, 'conflict', `「${clean}」は、もうあります`);
  return { id: rows[0]!.id };
}

async function loadArea(db: Db, actor: Actor, areaId: string): Promise<{ id: string; store_id: string; name: string }> {
  const area = await maybeOne<{ id: string; store_id: string; name: string }>(db, `SELECT id, store_id, name FROM areas WHERE id = $1`, [areaId]);
  assert(area !== undefined, 'not_found', '売場が見つかりません');
  assert(canAdminister(actor, area.store_id), 'forbidden', '売場を変えられるのは、その店舗の店長と本部です');
  return area;
}

export async function renameArea(db: Db, actor: Actor, areaId: string, name: unknown): Promise<{ id: string }> {
  const area = await loadArea(db, actor, areaId);
  const clean = cleanName(name);
  if (clean === area.name) return { id: area.id };
  const taken = await maybeOne(db, `SELECT 1 FROM areas WHERE store_id = $1 AND name = $2 AND id <> $3`, [area.store_id, clean, area.id]);
  assert(taken === undefined, 'conflict', `「${clean}」は、もうあります`);
  await db.query(`UPDATE areas SET name = $2 WHERE id = $1`, [area.id, clean]);
  return { id: area.id };
}

/**
 * 売場を消す。その売場に置いてあった商品は「売場：未登録」に戻る（商品そのものは消えない）。
 * ナレッジに付けてあった売場の印は、出なくなるだけで、ナレッジは変わらない。
 */
export async function deleteArea(db: Db, actor: Actor, areaId: string): Promise<{ ok: true; products: number }> {
  const area = await loadArea(db, actor, areaId);
  const used = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM store_products WHERE area_id = $1`, [area.id]);
  await db.query(`DELETE FROM areas WHERE id = $1`, [area.id]);
  return { ok: true, products: Number(used[0]!.n) };
}
