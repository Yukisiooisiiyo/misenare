// デモ用のデータを入れる（家電量販店の1社・2店舗）。開発・お試し用。
//   DATABASE_URL=... npx tsx apps/api/src/cli/seed-demo.ts
// 店長・ベテラン（trusted）・新人（visitor）の招待リンクを表示する。

import { SegmenterTokenizer } from '@misenare/search-core';
import { appTimeZone, todayIn } from '../config.ts';
import { one } from '../db/db.ts';
import type { Actor } from '../domain/actor.ts';
import { addHandover } from '../domain/handovers.ts';
import { createKnowledge } from '../domain/knowledge.ts';
import { createNotice } from '../domain/notices.ts';
import { linkKnowledgeToProduct, registerProduct } from '../domain/products.ts';
import { proposeRelation } from '../domain/tagAdmin.ts';
import { createInvitation } from '../domain/users.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL を設定してください');
const base = process.env.APP_URL ?? 'http://localhost:8787';
const database = process.env.DB_DRIVER === 'psql'
  ? new (await import('../db/psqlDatabase.ts')).PsqlDatabase(url)
  : new (await import('../db/pgDatabase.ts')).PgDatabase(url);
const tokenizer = new SegmenterTokenizer();

const tenant = (await database.raw(`INSERT INTO tenants (name, plan) VALUES ('ミセナレ電機（デモ）', 'trial') RETURNING id`))[0] as { id: string };
const T = tenant.id;

function jan(first12: string): string {
  let sum = 0;
  [...first12].map(Number).reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return first12 + String((10 - (sum % 10)) % 10);
}

const links = await database.withTenant(T, async (db) => {
  const main = await one<{ id: string }>(db, `INSERT INTO stores (tenant_id, name) VALUES ($1, '本店') RETURNING id`, [T]);
  await db.query(`INSERT INTO stores (tenant_id, name) VALUES ($1, '駅前店')`, [T]);
  const kitchen = await one<{ id: string }>(db, `INSERT INTO areas (tenant_id, store_id, name) VALUES ($1, $2, 'キッチン家電') RETURNING id`, [T, main.id]);
  await db.query(`INSERT INTO areas (tenant_id, store_id, name) VALUES ($1, $2, '大型家電'), ($1, $2, '修理受付')`, [T, main.id]);
  const hqUser = await one<{ id: string }>(db, `INSERT INTO users (tenant_id, name, trust_level, admin_scope) VALUES ($1, '本部 山田', 'trusted', 'tenant') RETURNING id`, [T]);
  const hq: Actor = { userId: hqUser.id, tenantId: T, storeIds: [], trustLevel: 'trusted', adminScope: 'tenant' };
  const veteranUser = await one<{ id: string }>(db, `INSERT INTO users (tenant_id, name, trust_level) VALUES ($1, '田中（ベテラン）', 'trusted') RETURNING id`, [T]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, store_id) VALUES ($1, $2, $3)`, [T, veteranUser.id, main.id]);
  const veteran: Actor = { userId: veteranUser.id, tenantId: T, storeIds: [main.id], trustLevel: 'trusted', adminScope: 'none' };

  const notes: Array<[string, string, string[]]> = [
    ['冷蔵庫のリサイクル料金', '家電リサイクル法の対象。引き取り時にリサイクル料金と収集運搬料金がかかる。\n\n料金はメーカーと容量で変わるので、レジ横の早見表で確認する。', ['冷蔵庫', 'リサイクル', '引き取り']],
    ['大型の冷凍冷蔵庫を搬入するとき', 'マンションはエレベーターの奥行きと扉の幅を事前に確認する。\n\n階段搬入になる場合は2名体制で、配送センターに前日までに連絡する。', ['冷凍冷蔵庫', '搬入', '配送']],
    ['テレビの修理受付', 'メーカー保証期間内なら修理は無料。保証書とレシートを確認する。\n\n「映らない」「音が出ない」は、まずリモコンの入力切替を一緒に確認する。', ['テレビ', '修理']],
    ['延長保証の加入条件', '本体の購入から30日以内なら加入できる。レシートが必要。', ['延長保証', 'レジ']],
    ['エアコンの取り付け工事の予約', '工事日は配送システムで空きを確認してから案内する。繁忙期（6〜8月）は2週間以上先になることが多い。', ['エアコン', '工事', '配送']],
    ['GR-W600 の扉の付け替え', 'この機種は左右の扉の付け替えができない。設置場所の壁の位置を必ず確認する。', ['冷蔵庫', '設置']],
    ['食洗機の分岐水栓', '食洗機の取り付けには分岐水栓が必要。蛇口の型番を写真で撮ってきてもらうと早い。', ['食洗機', '工事']],
  ];
  const ids: string[] = [];
  for (const [title, body, tagNames] of notes) {
    ids.push((await createKnowledge(db, tokenizer, veteran, { storeId: main.id, title, body, tagNames })).id);
  }
  await createKnowledge(db, tokenizer, hq, { storeId: null, title: 'ポイントカードの再発行', body: '本人確認書類があれば即日再発行できる。手数料は無料。', tagNames: ['ポイント', 'レジ'] });

  // タグの関係
  await proposeRelation(db, veteran, { kind: 'synonym', fromTag: '延長保証', toTag: '長期保証' }).catch(async () => {
    await createKnowledge(db, tokenizer, veteran, { storeId: main.id, title: '長期保証の案内のしかた', body: '5年保証と10年保証がある。', tagNames: ['長期保証'] });
    await proposeRelation(db, veteran, { kind: 'synonym', fromTag: '延長保証', toTag: '長期保証' });
  });
  await proposeRelation(db, veteran, { kind: 'includes', fromTag: '冷蔵庫', toTag: '冷凍冷蔵庫' });
  await proposeRelation(db, veteran, { kind: 'alias', fromText: '映らない', toTag: '修理' });
  await createKnowledge(db, tokenizer, veteran, { storeId: main.id, title: 'クーラーのフィルター掃除の案内', body: '2週間に1回の掃除で電気代が変わる。', tagNames: ['クーラー'] });
  await proposeRelation(db, veteran, { kind: 'synonym', fromTag: 'エアコン', toTag: 'クーラー' });

  // 商品
  const fridge = await registerProduct(db, veteran, main.id, {
    janCode: jan('490452000060'), name: '東芝 冷凍冷蔵庫 GR-W600', maker: '東芝', areaId: kitchen.id, tagNames: ['冷蔵庫', '大型家電'],
  });
  await linkKnowledgeToProduct(db, veteran, ids[5]!, fridge.id);

  // 連絡事項と引き継ぎ
  await createNotice(db, veteran, main.id, {
    title: '年末年始の営業時間',
    body: '12/31 は 18 時まで。1/1 は休み。1/2 から通常どおりです。\nチラシの差し替えは 12/28 までにお願いします。',
    priority: 'important',
  });
  await createNotice(db, veteran, main.id, {
    title: '新しいレジの使い方',
    body: 'バックヤードに手順書を置きました。読んだら確認を押してください。',
    requiresAck: true,
  });
  await addHandover(db, veteran, main.id, '冷蔵庫（GR-W600）の在庫が1台になりました。発注済みで入荷は明後日です。');
  // 昨日も日本時間で数える（UTC だと 0:00〜8:59 に「今日」になってしまう）
  const yesterday = todayIn(appTimeZone(), new Date(Date.now() - 24 * 3600_000));
  await addHandover(db, veteran, main.id, 'レジ横の忘れ物（傘）を預かっています。', yesterday);

  // 招待
  const manager = await createInvitation(db, hq, { storeId: main.id, name: '佐藤店長', trustLevel: 'trusted', adminScope: 'store' });
  const vet = await createInvitation(db, hq, { storeId: main.id, userId: veteranUser.id });
  const newbie = await createInvitation(db, hq, { storeId: main.id, name: '鈴木（新人）' });
  return { manager: manager.token, veteran: vet.token, newbie: newbie.token, fridgeJan: jan('490452000060') };
});
await database.close();

const link = (t: string) => `${base}/app/#invite=${encodeURIComponent(t)}`;
console.log(`会社ID: ${T}`);
console.log(`店長      : ${link(links.manager)}`);
console.log(`ベテラン  : ${link(links.veteran)}`);
console.log(`新人      : ${link(links.newbie)}`);
console.log(`冷蔵庫のJAN: ${links.fridgeJan}`);
