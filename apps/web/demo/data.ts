// デモ用の仮データ。本番の seed-demo.ts と同じ中身を、端末の中だけに置く。

export interface DemoTag { id: string; name: string; reading: string | null }
export interface DemoKnowledge {
  id: string; storeId: string | null; title: string; body: string; tags: string[];
  updatedAt: string; updatedBy: string; verifiedAt: string | null; verifiedBy: string | null;
}
export interface DemoProduct {
  id: string; janCode: string; name: string; maker: string | null;
  area: { id: string; name: string } | null; note: string | null; tags: string[]; knowledgeIds: string[];
}
export interface DemoRelation { kind: 'synonym' | 'includes' | 'alias'; from: string | null; fromText: string | null; to: string }
export interface DemoNotice {
  id: string; storeId: string | null; title: string; body: string;
  priority: 'normal' | 'important'; requiresAck: boolean; endsAt: string | null;
  createdBy: string; createdAt: string; readAt: string | null; ackedAt: string | null; pendingAcks: number;
}
export interface DemoHandover {
  id: string; body: string; state: 'open' | 'done'; forDate: string;
  createdBy: string; createdAt: string; doneBy: string | null; doneAt: string | null;
}

const day = 24 * 3600_000;
export const ago = (days: number): string => new Date(Date.now() - days * day).toISOString();
export const dateOnly = (days: number): string => new Date(Date.now() - days * day).toISOString().slice(0, 10);

export const STORE = { id: '20000000-0000-0000-0000-00000000000a', name: '本店' };
export const AREAS = [
  { id: '30000000-0000-0000-0000-000000000001', name: 'キッチン家電' },
  { id: '30000000-0000-0000-0000-000000000002', name: '大型家電' },
  { id: '30000000-0000-0000-0000-000000000003', name: '修理受付' },
];

const TAG_NAMES = [
  '冷蔵庫', '冷凍冷蔵庫', 'リサイクル', '引き取り', '搬入', '配送', 'テレビ', '修理',
  '延長保証', '長期保証', 'レジ', 'エアコン', 'クーラー', '工事', '設置', '食洗機',
  'ポイント', '大型家電',
];
export const TAGS: DemoTag[] = TAG_NAMES.map((name, i) => ({
  id: `da000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  name,
  reading: null,
}));
const tagId = (name: string): string => TAGS.find((t) => t.name === name)!.id;

export const RELATIONS: DemoRelation[] = [
  { kind: 'synonym', from: tagId('延長保証'), fromText: null, to: tagId('長期保証') },
  { kind: 'synonym', from: tagId('エアコン'), fromText: null, to: tagId('クーラー') },
  { kind: 'includes', from: tagId('冷蔵庫'), fromText: null, to: tagId('冷凍冷蔵庫') },
  { kind: 'alias', from: null, fromText: '映らない', to: tagId('修理') },
];

const NOTES: Array<[string, string, string[], number]> = [
  ['冷蔵庫のリサイクル料金',
    '家電リサイクル法の対象。引き取り時にリサイクル料金と収集運搬料金がかかる。\n\n料金はメーカーと容量で変わるので、レジ横の早見表で確認する。',
    ['冷蔵庫', 'リサイクル', '引き取り'], 12],
  ['大型の冷凍冷蔵庫を搬入するとき',
    'マンションはエレベーターの奥行きと扉の幅を事前に確認する。\n\n階段搬入になる場合は2名体制で、配送センターに前日までに連絡する。',
    ['冷凍冷蔵庫', '搬入', '配送'], 30],
  ['テレビの修理受付',
    'メーカー保証期間内なら修理は無料。保証書とレシートを確認する。\n\n「映らない」「音が出ない」は、まずリモコンの入力切替を一緒に確認する。',
    ['テレビ', '修理'], 5],
  ['延長保証の加入条件', '本体の購入から30日以内なら加入できる。レシートが必要。', ['延長保証', 'レジ'], 60],
  ['エアコンの取り付け工事の予約',
    '工事日は配送システムで空きを確認してから案内する。繁忙期（6〜8月）は2週間以上先になることが多い。',
    ['エアコン', '工事', '配送'], 20],
  ['GR-W600 の扉の付け替え',
    'この機種は左右の扉の付け替えができない。設置場所の壁の位置を必ず確認する。',
    ['冷蔵庫', '設置'], 400],
  ['食洗機の分岐水栓',
    '食洗機の取り付けには分岐水栓が必要。蛇口の型番を写真で撮ってきてもらうと早い。',
    ['食洗機', '工事'], 45],
  ['長期保証の案内のしかた', '5年保証と10年保証がある。', ['長期保証'], 70],
  ['クーラーのフィルター掃除の案内', '2週間に1回の掃除で電気代が変わる。', ['クーラー'], 90],
];

export const KNOWLEDGE: DemoKnowledge[] = NOTES.map(([title, body, tags, days], i) => ({
  id: `ca000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  storeId: STORE.id,
  title,
  body,
  tags,
  updatedAt: ago(days),
  updatedBy: '田中（ベテラン）',
  verifiedAt: days > 200 ? ago(days) : ago(Math.max(0, days - 3)),
  verifiedBy: '田中（ベテラン）',
})).concat([{
  id: 'ca000000-0000-0000-0000-000000000099',
  storeId: null,
  title: 'ポイントカードの再発行',
  body: '本人確認書類があれば即日再発行できる。手数料は無料。',
  tags: ['ポイント', 'レジ'],
  updatedAt: ago(15),
  updatedBy: '本部 山田',
  verifiedAt: ago(15),
  verifiedBy: '本部 山田',
}]);

export const PRODUCTS: DemoProduct[] = [{
  id: 'ea000000-0000-0000-0000-000000000001',
  janCode: '4904520000600',
  name: '東芝 冷凍冷蔵庫 GR-W600',
  maker: '東芝',
  area: AREAS[0]!,
  note: null,
  tags: ['冷蔵庫', '大型家電'],
  knowledgeIds: ['ca000000-0000-0000-0000-000000000005'],
}];

export const NOTICES: DemoNotice[] = [
  {
    id: 'fa000000-0000-0000-0000-000000000001', storeId: STORE.id,
    title: '年末年始の営業時間',
    body: '12/31 は 18 時まで。1/1 は休み。1/2 から通常どおりです。\nチラシの差し替えは 12/28 までにお願いします。',
    priority: 'important', requiresAck: false, endsAt: null,
    createdBy: '田中（ベテラン）', createdAt: ago(2), readAt: null, ackedAt: null, pendingAcks: 0,
  },
  {
    id: 'fa000000-0000-0000-0000-000000000002', storeId: STORE.id,
    title: '新しいレジの使い方',
    body: 'バックヤードに手順書を置きました。読んだら確認を押してください。',
    priority: 'normal', requiresAck: true, endsAt: null,
    createdBy: '佐藤店長', createdAt: ago(1), readAt: null, ackedAt: null, pendingAcks: 3,
  },
  {
    id: 'fa000000-0000-0000-0000-000000000003', storeId: null,
    title: '値札の付け替え（全店）',
    body: '4/1 から新しい値札に変わります。旧い値札は 3/31 の閉店後に回収してください。',
    priority: 'normal', requiresAck: false, endsAt: null,
    createdBy: '本部 山田', createdAt: ago(4), readAt: ago(3), ackedAt: null, pendingAcks: 0,
  },
];

export const HANDOVERS: DemoHandover[] = [
  {
    id: 'ab000000-0000-0000-0000-000000000001',
    body: '冷蔵庫（GR-W600）の在庫が1台になりました。発注済みで入荷は明後日です。',
    state: 'open', forDate: dateOnly(0), createdBy: '田中（ベテラン）', createdAt: ago(0.2),
    doneBy: null, doneAt: null,
  },
  {
    id: 'ab000000-0000-0000-0000-000000000002',
    body: 'レジ横の忘れ物（傘）を預かっています。落とし物の台帳に記入済み。',
    state: 'open', forDate: dateOnly(1), createdBy: '佐藤店長', createdAt: ago(1.1),
    doneBy: null, doneAt: null,
  },
];
