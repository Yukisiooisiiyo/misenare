// 商品（バーコード）。JAN を読むと商品カードと関連ナレッジを返す。
// 初めて読まれた JAN はその場で登録する。売場やタグは後から編集でき、すべて履歴に残る。
// trusted の登録・編集は即時反映、visitor は承認待ちになる。

import { analyzeQuery, type Tokenizer } from '@misenare/search-core';
import { maybeOne, one, type Db } from '../db/db.ts';
import { assert, canAccessStore, canAdminister, canModerate, isTrusted, type Actor } from './actor.ts';
import { describeHits, rankByGroups, type SearchHit } from './search.ts';
import { assertStore } from './scope.ts';
import { activateTags, loadDictionary, refreshUseCounts, resolveTags } from './tags.ts';

/** JAN（GTIN-8 / GTIN-13）のチェックデジットを検証する。 */
export function isValidJan(code: string): boolean {
  if (!/^(\d{8}|\d{13})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

export interface ProductCard {
  id: string;
  janCode: string;
  name: string;
  maker: string | null;
  area: { id: string; name: string } | null;
  note: string | null;
  tags: string[];
  /** visitor が登録し、まだ承認されていない */
  pending: boolean;
}

export type ScanResult =
  | { status: 'unknown'; janCode: string }
  | { status: 'found'; product: ProductCard; related: Array<SearchHit & { linked: boolean }> };

async function card(db: Db, productId: string, storeId: string): Promise<ProductCard> {
  const p = await one<{ id: string; jan_code: string; name: string; maker: string | null; state: string }>(
    db,
    `SELECT id, jan_code, name, maker, state FROM products WHERE id = $1`,
    [productId],
  );
  const sp = await maybeOne<{ area_id: string | null; area_name: string | null; note: string | null }>(
    db,
    `SELECT sp.area_id, a.name AS area_name, sp.note
       FROM store_products sp LEFT JOIN areas a ON a.id = sp.area_id
      WHERE sp.store_id = $1 AND sp.product_id = $2`,
    [storeId, productId],
  );
  const tags = await db.query<{ name: string }>(
    `SELECT h.name FROM product_tags pt JOIN hashtags h ON h.id = pt.hashtag_id
      WHERE pt.product_id = $1 ORDER BY h.use_count DESC, h.name`,
    [productId],
  );
  return {
    id: p.id,
    janCode: p.jan_code,
    name: p.name,
    maker: p.maker,
    area: sp?.area_id ? { id: sp.area_id, name: sp.area_name! } : null,
    note: sp?.note ?? null,
    tags: tags.map((t) => t.name),
    pending: p.state === 'pending',
  };
}

/**
 * 関連ナレッジ：
 *   1. その商品に直接紐づいたナレッジ（最上位）
 *   2. 商品のタグ・商品名・メーカーを検索語にした BM25F の結果（同義・包含の展開込み）
 */
async function relatedKnowledge(db: Db, tokenizer: Tokenizer, tenantId: string, storeId: string, product: ProductCard, limit = 10) {
  const linked = await db.query<{ id: string }>(
    `SELECT k.id FROM knowledge_products kp JOIN knowledge k ON k.id = kp.knowledge_id
      WHERE kp.product_id = $1 AND k.status = 'published'
        AND (k.expires_at IS NULL OR k.expires_at > now())
        AND (k.scope = 'tenant' OR k.store_id = $2)
      ORDER BY k.verified_at DESC NULLS LAST`,
    [product.id, storeId],
  );
  const linkedHits = await describeHits(db, linked.map((l) => ({ id: l.id, score: 0, matchedTerms: [] })));

  const dictionary = await loadDictionary(db, tenantId);
  // search() と同じ上限。保存された文字列がそのまま解析に流れるので、ここでも切る
  const queryText = [...product.tags.map((t) => `#${t}`), product.name, product.maker ?? ''].join(' ').slice(0, 200);
  const { groups } = analyzeQuery(queryText, { tokenizer, dictionary });
  const ranked = await rankByGroups(db, storeId, groups, {
    limit: Math.max(0, limit - linkedHits.length),
    excludeIds: linked.map((l) => l.id),
  });
  const searched = await describeHits(db, ranked);
  return [
    ...linkedHits.map((h) => ({ ...h, linked: true })),
    ...searched.map((h) => ({ ...h, linked: false })),
  ];
}

export async function scanBarcode(db: Db, tokenizer: Tokenizer, actor: Actor, storeId: string, janCode: string): Promise<ScanResult> {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗では読み取れません');
  assert(isValidJan(janCode), 'invalid', 'JANコードとして読み取れませんでした');
  await assertStore(db, storeId);
  const p = await maybeOne<{ id: string; state: string; created_by: string; origin_store_id: string | null }>(
    db,
    `SELECT id, state, created_by, origin_store_id FROM products WHERE jan_code = $1`,
    [janCode],
  );
  // 承認待ちの商品は、登録した本人と、登録された店舗で承認できる人にだけ見せる
  if (!p || (p.state === 'pending' && p.created_by !== actor.userId && !canModerate(actor, p.origin_store_id))) {
    return { status: 'unknown', janCode };
  }
  const product = await card(db, p.id, storeId);
  return { status: 'found', product, related: await relatedKnowledge(db, tokenizer, actor.tenantId, storeId, product) };
}

export interface ProductInput {
  janCode: string;
  name: string;
  maker?: string | null;
  areaId?: string | null;
  note?: string | null;
  tagNames: string[];
}

async function history(db: Db, actor: Actor, productId: string, storeId: string | null, field: string, before: unknown, after: unknown, editedBy = actor.userId) {
  await db.query(
    `INSERT INTO product_history (tenant_id, product_id, store_id, field, before, after, edited_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [actor.tenantId, productId, storeId, field, JSON.stringify(before ?? null), JSON.stringify(after ?? null), editedBy],
  );
}

async function setTags(db: Db, actor: Actor, productId: string, tagIds: string[]) {
  const before = await db.query<{ hashtag_id: string }>(`SELECT hashtag_id FROM product_tags WHERE product_id = $1`, [productId]);
  await db.query(`DELETE FROM product_tags WHERE product_id = $1`, [productId]);
  if (tagIds.length > 0) {
    await db.query(
      `INSERT INTO product_tags (tenant_id, product_id, hashtag_id) SELECT $1, $2, unnest($3::uuid[])`,
      [actor.tenantId, productId, tagIds],
    );
  }
  await refreshUseCounts(db, [...new Set([...before.map((b) => b.hashtag_id), ...tagIds])]);
}

async function setStoreProduct(db: Db, actor: Actor, storeId: string, productId: string, areaId: string | null, note: string | null, editedBy = actor.userId) {
  await db.query(
    `INSERT INTO store_products (tenant_id, store_id, product_id, area_id, note, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (store_id, product_id)
     DO UPDATE SET area_id = EXCLUDED.area_id, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [actor.tenantId, storeId, productId, areaId, note, editedBy],
  );
}

async function assertArea(db: Db, storeId: string, areaId: string | null | undefined) {
  if (!areaId) return;
  const a = await maybeOne(db, `SELECT 1 FROM areas WHERE id = $1 AND store_id = $2`, [areaId, storeId]);
  assert(a !== undefined, 'invalid', 'この店舗の売場ではありません');
}

/** 文字数の上限。メーカー名は商品名と同じ、売場メモは本文並み。
 *  メーカー名はバーコードを読むたびに検索語として形態素解析に流れるので、長さを放置できない */
const MAX_NAME = 100;
const MAX_MAKER = 100;
const MAX_NOTE = 1000;
const MAX_TAGS = 20;
/** 1人が同時に抱えられる承認待ちの変更依頼。承認時に弾かれる依頼を山ほど積まれないため */
const MAX_PENDING_CHANGES = 50;

/** 名前・メーカー・メモ・タグの長さと件数を見る（登録・編集・依頼の保存で共通） */
function validatePatch(patch: ProductPatch): void {
  if (patch.name !== undefined) {
    assert(patch.name.trim().length > 0 && patch.name.length <= MAX_NAME, 'invalid', `商品名を1〜${MAX_NAME}文字で入力してください`);
  }
  if (patch.maker !== undefined && patch.maker !== null) {
    assert(patch.maker.length <= MAX_MAKER, 'invalid', `メーカー名は${MAX_MAKER}文字以内にしてください`);
  }
  if (patch.note !== undefined && patch.note !== null) {
    assert(patch.note.length <= MAX_NOTE, 'invalid', `売場のメモは${MAX_NOTE}文字以内にしてください`);
  }
  if (patch.tagNames !== undefined) {
    assert(patch.tagNames.length <= MAX_TAGS, 'invalid', `タグは${MAX_TAGS}個までにしてください`);
  }
}

/** 初めて読まれた JAN を登録する。 */
export async function registerProduct(db: Db, actor: Actor, storeId: string, input: ProductInput) {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗では登録できません');
  assert(isValidJan(input.janCode), 'invalid', 'JANコードが正しくありません');
  validatePatch(input);
  await assertStore(db, storeId);
  const exists = await maybeOne(db, `SELECT 1 FROM products WHERE jan_code = $1`, [input.janCode]);
  assert(exists === undefined, 'conflict', 'この商品はすでに登録されています');
  await assertArea(db, storeId, input.areaId);

  const trusted = isTrusted(actor);
  // 確認と挿入の間に同じ JAN が入ると UNIQUE 違反で 500 になるので、衝突は conflict に寄せる
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO products (tenant_id, jan_code, name, maker, state, origin_store_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, jan_code) DO NOTHING RETURNING id`,
    [actor.tenantId, input.janCode, input.name.trim(), input.maker?.trim() || null, trusted ? 'active' : 'pending', storeId, actor.userId],
  );
  assert(inserted.length === 1, 'conflict', 'この商品はすでに登録されています');
  const p = inserted[0]!;
  const tagIds = await resolveTags(db, actor, input.tagNames);
  await setTags(db, actor, p.id, tagIds);
  await setStoreProduct(db, actor, storeId, p.id, input.areaId ?? null, input.note ?? null);
  await history(db, actor, p.id, storeId, 'created', null, { ...input, janCode: input.janCode });
  return { id: p.id, published: trusted };
}

export interface ProductPatch {
  name?: string;
  maker?: string | null;
  areaId?: string | null;
  note?: string | null;
  tagNames?: string[];
}

/** 編集を実際に反映する（trusted の編集と、visitor の編集の承認で共通） */
async function applyPatch(db: Db, actor: Actor, storeId: string, productId: string, patch: ProductPatch, editedBy: string) {
  validatePatch(patch);
  const before = await card(db, productId, storeId);
  if (patch.name !== undefined && patch.name.trim() !== before.name) {
    await db.query(`UPDATE products SET name = $2 WHERE id = $1`, [productId, patch.name.trim()]);
    await history(db, actor, productId, null, 'name', before.name, patch.name.trim(), editedBy);
  }
  if (patch.maker !== undefined && (patch.maker?.trim() || null) !== before.maker) {
    await db.query(`UPDATE products SET maker = $2 WHERE id = $1`, [productId, patch.maker?.trim() || null]);
    await history(db, actor, productId, null, 'maker', before.maker, patch.maker?.trim() || null, editedBy);
  }
  if (patch.areaId !== undefined || patch.note !== undefined) {
    await assertArea(db, storeId, patch.areaId);
    const areaId = patch.areaId !== undefined ? patch.areaId : before.area?.id ?? null;
    const note = patch.note !== undefined ? patch.note : before.note;
    await setStoreProduct(db, actor, storeId, productId, areaId, note, editedBy);
    if (areaId !== (before.area?.id ?? null)) await history(db, actor, productId, storeId, 'area', before.area?.id ?? null, areaId, editedBy);
    if (note !== before.note) await history(db, actor, productId, storeId, 'note', before.note, note, editedBy);
  }
  if (patch.tagNames !== undefined) {
    const tagIds = await resolveTags(db, actor, patch.tagNames);
    // タグを辞書に入れる（active にする）のは、商品そのものが公開されているときだけ
    const state = await one<{ state: string }>(db, `SELECT state FROM products WHERE id = $1`, [productId]);
    if (state.state === 'active') await activateTags(db, tagIds);
    await setTags(db, actor, productId, tagIds);
    const after = await db.query<{ name: string }>(`SELECT name FROM hashtags WHERE id = ANY($1::uuid[]) ORDER BY name`, [tagIds]);
    const afterNames = after.map((a) => a.name);
    if ([...before.tags].sort().join('|') !== afterNames.join('|')) {
      await history(db, actor, productId, null, 'tags', before.tags, afterNames, editedBy);
    }
  }
}

/** 商品情報・売場・タグの編集。trusted は即時反映、visitor は承認待ち。 */
export async function updateProduct(db: Db, actor: Actor, storeId: string, productId: string, patch: ProductPatch) {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗では編集できません');
  await assertStore(db, storeId);
  const p = await maybeOne<{ state: string; origin_store_id: string | null }>(
    db, `SELECT state, origin_store_id FROM products WHERE id = $1`, [productId],
  );
  assert(p !== undefined, 'not_found', '商品が見つかりません');
  // 承認待ちの商品は、登録した店舗の承認者だけが直せる。他店舗の trusted が書き換えて、
  // ついでに pending のタグを辞書に入れてしまう（承認を飛ばす）形を塞ぐ
  if (p.state !== 'active') {
    assert(canModerate(actor, p.origin_store_id), 'conflict', '承認待ちの商品は、登録した店舗の承認者だけが直せます');
  }
  if (isTrusted(actor)) {
    await applyPatch(db, actor, storeId, productId, patch, actor.userId);
    return { productId, published: true as const };
  }
  // 依頼として積む前に、承認時と同じ検査をする（通らない依頼を積ませない）
  validatePatch(patch);
  const waiting = await one<{ count: number }>(
    db, `SELECT count(*)::int AS count FROM change_requests WHERE requested_by = $1 AND state = 'pending'`, [actor.userId],
  );
  assert(waiting.count < MAX_PENDING_CHANGES, 'conflict', '承認待ちの依頼が多すぎます。先に承認されるのを待ってください');
  const req = await one<{ id: string }>(
    db,
    `INSERT INTO change_requests (tenant_id, store_id, entity_type, entity_id, payload, requested_by)
     VALUES ($1, $2, 'product', $3, $4::jsonb, $5) RETURNING id`,
    [actor.tenantId, storeId, productId, JSON.stringify(patch), actor.userId],
  );
  return { productId, published: false as const, requestId: req.id };
}

/** visitor の編集依頼を承認して反映する。履歴の編集者は依頼した本人にする。 */
export async function approveProductChange(db: Db, actor: Actor, requestId: string) {
  const r = await maybeOne<{ store_id: string; entity_id: string; payload: ProductPatch; requested_by: string; state: string }>(
    db,
    `SELECT store_id, entity_id, payload, requested_by, state FROM change_requests WHERE id = $1 AND entity_type = 'product' FOR UPDATE`,
    [requestId],
  );
  assert(r !== undefined, 'not_found', '依頼が見つかりません');
  assert(canModerate(actor, r.store_id), 'forbidden', '承認する権限がありません');
  assert(r.state === 'pending', 'conflict', 'この依頼は処理済みです');
  const exists = await maybeOne(db, `SELECT 1 FROM products WHERE id = $1`, [r.entity_id]);
  assert(exists !== undefined, 'not_found', '商品が削除されています');
  await applyPatch(db, actor, r.store_id, r.entity_id, r.payload, r.requested_by);
  // 同時に2人が承認すると applyPatch が2回走る。行ロックで待たせた上で、pending のときだけ確定する
  const done = await db.query(
    `UPDATE change_requests SET state = 'approved', decided_by = $2, decided_at = now()
      WHERE id = $1 AND state = 'pending' RETURNING id`,
    [requestId, actor.userId],
  );
  assert(done.length === 1, 'conflict', 'この依頼は処理済みです');
  return { productId: r.entity_id };
}

export async function rejectProductChange(db: Db, actor: Actor, requestId: string) {
  const r = await maybeOne<{ store_id: string; state: string }>(
    db,
    `SELECT store_id, state FROM change_requests WHERE id = $1 AND entity_type = 'product'`,
    [requestId],
  );
  assert(r !== undefined, 'not_found', '依頼が見つかりません');
  assert(canModerate(actor, r.store_id), 'forbidden', '却下する権限がありません');
  const rows = await db.query(
    `UPDATE change_requests SET state = 'rejected', decided_by = $2, decided_at = now()
      WHERE id = $1 AND state = 'pending' RETURNING id`,
    [requestId, actor.userId],
  );
  assert(rows.length === 1, 'conflict', 'この依頼は処理済みです');
  return { requestId };
}

/** 承認待ちの商品と、商品情報の変更依頼の一覧 */
export async function listPendingProducts(db: Db, actor: Actor, storeId: string) {
  assert(canModerate(actor, storeId), 'forbidden', '承認待ちを見る権限がありません');
  const products = await db.query(
    `SELECT p.id, p.jan_code, p.name, p.created_at::text AS created_at, u.name AS created_by
       FROM products p JOIN users u ON u.id = p.created_by
      WHERE p.state = 'pending' AND p.origin_store_id = $1 ORDER BY p.created_at`,
    [storeId],
  );
  const changes = await db.query(
    `SELECT r.id, r.entity_id AS product_id, p.name, r.payload, r.requested_at::text AS requested_at, u.name AS requested_by
       FROM change_requests r JOIN products p ON p.id = r.entity_id JOIN users u ON u.id = r.requested_by
      WHERE r.state = 'pending' AND r.entity_type = 'product' AND r.store_id = $1 ORDER BY r.requested_at`,
    [storeId],
  );
  return { products, changes };
}

/** visitor が登録した商品を承認する（タグも有効にする）。 */
export async function approveProduct(db: Db, actor: Actor, productId: string) {
  const p = await maybeOne<{ origin_store_id: string | null }>(db, `SELECT origin_store_id FROM products WHERE id = $1`, [productId]);
  assert(p !== undefined, 'not_found', '商品が見つかりません');
  // 承認できるのは、登録された店舗で承認できる人（店舗が消えていれば本部）
  assert(canModerate(actor, p.origin_store_id), 'forbidden', '承認する権限がありません');
  const rows = await db.query(`UPDATE products SET state = 'active' WHERE id = $1 AND state = 'pending' RETURNING id`, [productId]);
  assert(rows.length === 1, 'conflict', 'この商品は承認待ちではありません');
  const tags = await db.query<{ hashtag_id: string }>(`SELECT hashtag_id FROM product_tags WHERE product_id = $1`, [productId]);
  await activateTags(db, tags.map((t) => t.hashtag_id));
  return { productId };
}

/** visitor が登録した承認待ちの商品を却下する（消す）。間違った登録が店長の一覧に残り続けないように */
export async function rejectProduct(db: Db, actor: Actor, productId: string) {
  const p = await maybeOne<{ origin_store_id: string | null }>(db, `SELECT origin_store_id FROM products WHERE id = $1`, [productId]);
  assert(p !== undefined, 'not_found', '商品が見つかりません');
  assert(canModerate(actor, p.origin_store_id), 'forbidden', '却下する権限がありません');
  const tags = await db.query<{ hashtag_id: string }>(`SELECT hashtag_id FROM product_tags WHERE product_id = $1`, [productId]);
  // product_tags などは CASCADE で消える。承認済みの商品はここでは消さない
  const rows = await db.query(`DELETE FROM products WHERE id = $1 AND state = 'pending' RETURNING id`, [productId]);
  assert(rows.length === 1, 'conflict', 'この商品は承認待ちではありません');
  await refreshUseCounts(db, tags.map((t) => t.hashtag_id));
  return { productId };
}

/** ナレッジと商品を直接紐づける（trusted 以上）。 */
export async function linkKnowledgeToProduct(db: Db, actor: Actor, knowledgeId: string, productId: string) {
  const k = await maybeOne<{ store_id: string | null }>(db, `SELECT store_id FROM knowledge WHERE id = $1`, [knowledgeId]);
  assert(k !== undefined, 'not_found', 'ナレッジが見つかりません');
  // 本文を直せる人と同じ：店舗は trusted 以上、全店共通は本部だけ
  // （canAccessStore(actor, null) は常に true なので、全店共通は別に見る）
  assert(isTrusted(actor) && canAccessStore(actor, k.store_id), 'forbidden', '紐づける権限がありません');
  if (k.store_id === null) assert(actor.adminScope === 'tenant', 'forbidden', '全店共通のナレッジに商品を紐づけられるのは本部のみです');
  const p = await maybeOne<{ state: string }>(db, `SELECT state FROM products WHERE id = $1`, [productId]);
  assert(p !== undefined, 'not_found', '商品が見つかりません');
  assert(p.state === 'active', 'conflict', '承認待ちの商品には紐づけられません');
  await db.query(
    `INSERT INTO knowledge_products (tenant_id, knowledge_id, product_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [actor.tenantId, knowledgeId, productId],
  );
}

export async function productHistory(db: Db, actor: Actor, storeId: string, productId: string) {
  assert(canAccessStore(actor, storeId), 'forbidden', '履歴を見る権限がありません');
  return db.query(
    `SELECT h.field, h.before, h.after, h.edited_at::text AS edited_at, u.name AS edited_by
       FROM product_history h JOIN users u ON u.id = h.edited_by
      WHERE h.product_id = $1 AND (h.store_id IS NULL OR h.store_id = $2)
      ORDER BY h.id DESC`,
    [productId, storeId],
  );
}

/** 商品の削除（administrator のみ） */
/**
 * 商品の削除。商品マスタは全店舗で共有するので、削除できるのは本部の administrator だけ。
 * 店長は、自店舗の売場情報（store_products）だけを外せる。
 */
export async function deleteProduct(db: Db, actor: Actor, storeId: string, productId: string) {
  if (actor.adminScope !== 'tenant') {
    assert(canAdminister(actor, storeId), 'forbidden', '商品を削除できるのは administrator のみです');
    const exists = await maybeOne(db, `SELECT 1 FROM products WHERE id = $1`, [productId]);
    assert(exists !== undefined, 'not_found', '商品が見つかりません'); // 無いと履歴の INSERT が外部キーで 500 になる
    await db.query(`DELETE FROM store_products WHERE store_id = $1 AND product_id = $2`, [storeId, productId]);
    await history(db, actor, productId, storeId, 'store_removed', null, null);
    return { removed: 'store' as const };
  }
  const tags = await db.query<{ hashtag_id: string }>(`SELECT hashtag_id FROM product_tags WHERE product_id = $1`, [productId]);
  const rows = await db.query(`DELETE FROM products WHERE id = $1 RETURNING id`, [productId]);
  assert(rows.length === 1, 'not_found', '商品が見つかりません');
  // change_requests には商品への FK が無く、残ると依頼者の承認待ちの枠を占有し続ける
  await db.query(`DELETE FROM change_requests WHERE entity_type = 'product' AND entity_id = $1 AND state = 'pending'`, [productId]);
  await refreshUseCounts(db, tags.map((t) => t.hashtag_id));
  return { removed: 'tenant' as const };
}
