// 見せる用のデータを、**すでにある会社の1店舗**に書き込む（発表やデモで、実店舗の運用らしく見せるため）。
//   DATABASE_URL=... npx tsx apps/api/src/cli/seed-showcase.ts --tenant <会社ID> --store <店舗ID>
//
// seed-demo.ts との違い：会社を作らない。運営者の画面で作った店舗に、あとから中身だけ入れる。
//   ・書き手として、架空のスタッフ4人（店長・ベテラン・パート・新人）をその店舗に足す
//   ・ナレッジ、タグの関係、商品、連絡、引き継ぎ、承認待ち、見つからなかった検索、見直し待ちを入れる
//   ・中身は架空の店の決まりごと。実在の会社・商品の話ではない
// 同じ店舗に2回流すと二重になるので、その店舗にナレッジがあれば止まる（--force で続行）。

import { parseArgs } from 'node:util';
import { SegmenterTokenizer } from '@misenare/search-core';
import { appTimeZone, todayIn } from '../config.ts';
import { maybeOne, one, type Db } from '../db/db.ts';
import type { Actor } from '../domain/actor.ts';
import { addHandover, setHandoverState } from '../domain/handovers.ts';
import { createKnowledge } from '../domain/knowledge.ts';
import { ackNotice, createNotice, markRead } from '../domain/notices.ts';
import { linkKnowledgeToProduct, registerProduct } from '../domain/products.ts';
import { proposeRelation } from '../domain/tagAdmin.ts';

const { values } = parseArgs({ options: { tenant: { type: 'string' }, store: { type: 'string' }, force: { type: 'boolean', default: false } } });
if (!values.tenant || !values.store) {
  console.error('使い方: seed-showcase.ts --tenant <会社ID> --store <店舗ID> [--force]');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL を設定してください');
const database = process.env.DB_DRIVER === 'psql'
  ? new (await import('../db/psqlDatabase.ts')).PsqlDatabase(url)
  : new (await import('../db/pgDatabase.ts')).PgDatabase(url);
const tokenizer = new SegmenterTokenizer();
const T = values.tenant;
const S = values.store;

function jan(first12: string): string {
  let sum = 0;
  [...first12].map(Number).reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return first12 + String((10 - (sum % 10)) % 10);
}

async function staff(db: Db, name: string, trust: Actor['trustLevel'], admin: Actor['adminScope']): Promise<Actor> {
  const u = await one<{ id: string }>(db, `INSERT INTO users (tenant_id, name, trust_level, admin_scope) VALUES ($1, $2, $3, $4) RETURNING id`, [T, name, trust, admin]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, store_id) VALUES ($1, $2, $3)`, [T, u.id, S]);
  return { userId: u.id, tenantId: T, storeIds: [S], trustLevel: trust, adminScope: admin };
}

type Note = { title: string; body: string; tags: string[]; by: 'manager' | 'veteran' | 'part'; area?: string };

const NOTES: Note[] = [
  // レジ・会計
  { by: 'veteran', area: 'レジ', title: '領収書の宛名と但し書き', tags: ['レジ', '領収書'],
    body: '宛名は必ずお客様に書いていただいたメモを見て打つ（聞き取りで打たない）。\n但し書きは「家電製品代として」を基本にする。「お品代」は経理で通らないことがあるので、聞かれたら品目を入れる。\n\n再発行はしない。どうしても必要なときは、元の領収書と引き換えに店長が対応する。' },
  { by: 'veteran', area: 'レジ', title: 'ポイントカードを忘れたお客様', tags: ['レジ', 'ポイント'],
    body: 'レシートに「ポイント後付け」のスタンプを押して渡す。次の来店時にカードとレシートを持ってきてもらえば付けられる。\n\n後付けは購入日から30日以内。電話番号での検索はできるが、本人確認（名前と生年月日）をしてからにする。' },
  { by: 'manager', area: 'レジ', title: 'レジ締めで金額が合わないとき', tags: ['レジ', 'レジ締め'],
    body: '1. もう一度、金種ごとに数え直す（千円札と五千円札の取り違えが一番多い）\n2. 取消・返品の伝票が打たれているか、ジャーナルで確かめる\n3. それでも合わなければ、差額と時間帯をレジ締め表に書いて店長に電話する\n\n自分の財布から足さない。合わないこと自体は責めないので、必ずそのまま報告する。' },
  { by: 'part', area: 'レジ', title: 'クレジットカードの分割回数を変えたいと言われたら', tags: ['レジ', 'クレジット'],
    body: '会計の当日・レジを閉める前なら、取消して打ち直せる。翌日以降は店では変えられないので、カード会社に連絡してもらう。\n\n取消の操作は trusted の人を呼ぶ（新人だけでやらない）。' },
  // 保証・修理
  { by: 'veteran', area: '修理受付', title: '長期保証に入れるもの・入れないもの', tags: ['長期保証', '修理'],
    body: '入れるのは本体価格が税込1万円以上の家電。消耗品（電池・インク・フィルター）と、展示品処分は対象外。\n\n加入は購入と同時が基本。あとから入りたいと言われたら、購入から30日以内・レシートあり・未使用に近い状態なら店長判断で受ける。' },
  { by: 'veteran', area: '修理受付', title: '修理受付で最初に聞く5つ', tags: ['修理', '受付'],
    body: '1. いつから・どんなときに起きるか（毎回か、ときどきか）\n2. 購入日と購入店（保証書・レシート・長期保証の控え）\n3. 型番と製造番号（本体の銘板を一緒に見る）\n4. 修理のあいだの代わりが要るか\n5. 見積もりが出たときの連絡先と、つながりやすい時間帯\n\n「映らない」「動かない」は、まず電源コードの差し直しと、リモコンの電池を一緒に確かめる。それで直ることが3割くらいある。' },
  { by: 'manager', area: '修理受付', title: '修理の代替機の貸し出し', tags: ['修理', '代替機'],
    body: '貸し出せるのは、洗濯機・冷蔵庫・炊飯器・掃除機。在庫はバックヤード奥の棚、台帳は修理受付の引き出し。\n\n貸すときは台帳に日付・お客様名・製造番号を書き、返ってきたら必ず消す。台帳と棚の数が合わないまま帰らない。' },
  { by: 'part', area: '修理受付', title: '保証書に店の印が無いと言われたら', tags: ['修理', '保証書'],
    body: 'レシート（または購入履歴）で購入日が分かれば、保証は受けられる。保証書だけで日付が分からないときは、ポイントカードの履歴を調べる。\n\n印を後から押すのは、購入履歴で確認できたときだけ。' },
  // 配送・工事
  { by: 'veteran', area: '大型家電', title: '冷蔵庫・洗濯機の搬入で先に確かめること', tags: ['配送', '搬入', '冷蔵庫', '洗濯機'],
    body: '・玄関、廊下、設置場所の幅（本体の幅＋10cm が目安）\n・エレベーターの有無と奥行き、階段なら踊り場の広さ\n・冷蔵庫は扉の開く向きと壁の位置\n・洗濯機は防水パンの内寸と蛇口の高さ\n\n測っていないお客様には、売場の「搬入チェック表」を渡して、写真を撮ってきてもらう。通らなかったときの持ち帰りは、配送料がもう一度かかることを先に伝える。' },
  { by: 'veteran', area: '大型家電', title: 'ドラム式洗濯機は左開き・右開きを必ず聞く', tags: ['洗濯機', 'ドラム式', '搬入'],
    body: '設置場所の壁がどちら側にあるかで決まる。展示機と逆の向きを希望されることが多いので、注文書の「開き」の欄を空のまま出さない。\n\n防水パンが 64cm 角より小さい家は、かさ上げ台が要ることがある。' },
  { by: 'manager', area: '大型家電', title: 'エアコン工事の繁忙期の案内', tags: ['エアコン', '工事', '配送'],
    body: '6月下旬〜8月は、工事まで2週間以上かかる前提で話す。「今週中に」は約束しない。\n\n標準工事に入らないもの（配管の延長、室外機の屋根置き・壁掛け、専用コンセントの増設）は、下見のあとで追加の見積もりになると先に伝える。\n\n真夏に壊れて困っているお客様には、窓用エアコンと扇風機の在庫を先に案内する。' },
  { by: 'part', area: '大型家電', title: '家電リサイクルの対象と、引き取りの流れ', tags: ['リサイクル', '引き取り'],
    body: '対象はエアコン・テレビ・冷蔵庫（冷凍庫）・洗濯機（衣類乾燥機）の4品目。\n\n買い替えのときは、配送と同時に引き取る。料金はリサイクル料金＋収集運搬料金で、メーカーと大きさで変わるので、レジ横の早見表で確かめてから伝える。\n\n引き取りだけ（うちで買っていないもの）も受けるが、持ち込みか、別便の予約になる。' },
  { by: 'veteran', area: '大型家電', title: '配送日の変更を電話で受けたら', tags: ['配送', '電話'],
    body: '前日の17時までなら、配送システムでそのまま変更できる。17時を過ぎたら配送センターに直接電話する（番号は電話機の短縮1番）。\n\n変更したら、注文書の控えに日付と自分の名前を書いておく。' },
  // 売場
  { by: 'manager', area: '売場', title: '値引きの相談を受けたとき', tags: ['値引き', '接客'],
    body: '自分で決めてよいのは、値札に「相談OK」の印がある商品の、売価の5%まで。それを超えるとき・他店のチラシを見せられたときは、その場で答えず店長かベテランを呼ぶ。\n\n「確認してきます」と言って離れるのは失礼ではない。あいまいに約束するほうが、あとで困る。' },
  { by: 'veteran', area: '売場', title: '展示品を売るとき', tags: ['展示品', '接客'],
    body: '・付属品（リモコン、取扱説明書、棚板）がそろっているか、箱の有無\n・キズの場所をお客様と一緒に見て、注文書に書く\n・保証はメーカー保証が購入日から付く。長期保証は付けられない\n\n展示品は値札の裏に展示開始日が書いてある。' },
  { by: 'part', area: '売場', title: '電球・蛍光灯の「これと同じもの」', tags: ['電球', '照明'],
    body: '持ってきてもらった電球の、口金の太さ（E26 か E17）と、ワット数・色（電球色／昼白色）を見る。\n\n密閉型の器具（浴室・玄関の丸いカバー）は「密閉器具対応」、調光つきのスイッチなら「調光器対応」を選ぶ。分からなければ器具の写真を撮ってきてもらう。' },
  { by: 'veteran', area: '売場', title: 'プリンターのインクは型番で探す', tags: ['インク', 'プリンター'],
    body: 'お客様が言う色や形ではなく、プリンター本体の型番を聞く。分からなければ、インク売場の「対応表」でメーカー→型番の順に引く。\n\n開封したインクは返品できないことを、会計の前に一言伝える。' },
  { by: 'part', area: '売場', title: '取り寄せ・取り置きの受け方', tags: ['取り寄せ', '取り置き'],
    body: '取り寄せは、注文書に型番・色・数量・連絡先を書き、控えをお客様に渡す。入荷の目安は「分かり次第お電話します」と伝え、日付を約束しない。\n\n取り置きは3日まで。札に名前と期限を書いてサービスカウンターの棚へ。期限を過ぎたら売場に戻す前に一度電話する。' },
  // 開店・閉店・その他
  { by: 'manager', title: '開店前の15分でやること', tags: ['開店', '朝礼'],
    body: '1. 引き継ぎを読む（このアプリの「連絡」）\n2. レジの釣り銭を確かめる\n3. 入口のチラシ台と、目玉商品の値札\n4. 展示機の電源（テレビ・照明・エアコン）\n5. 朝礼：今日の配送件数、工事の下見、休みの人' },
  { by: 'manager', title: '閉店作業と戸締まり', tags: ['閉店', 'レジ締め'],
    body: '・レジ締め → 売上金は金庫へ（2人で）\n・展示機の電源を切る。冷蔵庫と冷凍庫の展示は切らない\n・バックヤードの搬入口、非常口、トイレの窓\n・最後の人が警備をセットして、引き継ぎに一言書く' },
  { by: 'veteran', title: '落とし物・忘れ物を見つけたら', tags: ['忘れ物', 'サービスカウンター'],
    body: 'サービスカウンターの「忘れ物ノート」に、日付・場所・品物・見つけた人を書いて、カウンター下の箱へ。財布・スマホ・鍵は箱に入れず、店長に直接渡す。\n\n引き継ぎにも一言書いておく（次の番の人が電話を受けることが多い）。' },
  { by: 'manager', title: '強い口調のお客様への対応', tags: ['クレーム', '接客'],
    body: '・まず最後まで聞く。途中で理由を説明しない\n・その場で約束できないことは約束しない\n・5分たっても落ち着かない、または金額の話になったら、迷わず店長かベテランに代わる\n\n1人で抱えない。代わったあと、何があったかを引き継ぎに書く。' },
  { by: 'part', title: 'お客様のスマホの設定を頼まれたら', tags: ['スマホ', '接客'],
    body: '初期設定やデータ移行は、有料の設定サービス（サービスカウンターで受付）を案内する。売場でその場でやらない。\n\nパスワードや暗証番号は、こちらで聞かない・入力しない。お客様自身に打ってもらう。' },
  { by: 'veteran', title: 'ギフト包装とのしの受け方', tags: ['ギフト', '包装'],
    body: '包装は無料、サービスカウンターで受ける。箱の大きさで包めないもの（大型家電）は、リボンとのしだけにする。\n\nのしは表書き（御祝・内祝・御礼など）と名入れを紙に書いてもらう。漢字は聞き取りで書かない。' },
];

const result = await database.withTenant(T, async (db) => {
  const store = await maybeOne<{ name: string }>(db, `SELECT name FROM stores WHERE id = $1`, [S]);
  if (!store) throw new Error('その会社に、この店舗はありません（会社IDと店舗IDを確かめてください）');
  const existing = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM knowledge WHERE store_id = $1`, [S]);
  if (Number(existing.n) > 0 && !values.force) throw new Error(`この店舗にはすでにナレッジが ${existing.n} 件あります。二重になるので止めました（続けるなら --force）`);

  const manager = await staff(db, '中村 店長', 'trusted', 'store');
  const veteran = await staff(db, '田中（勤続12年）', 'trusted', 'none');
  const part = await staff(db, '山本（パート）', 'trusted', 'none');
  const newbie = await staff(db, '佐々木（新人）', 'visitor', 'none');
  const who = { manager, veteran, part };

  // 売場
  const areas = new Map<string, string>();
  for (const name of ['レジ', '修理受付', '大型家電', '売場']) {
    const a = await one<{ id: string }>(db, `INSERT INTO areas (tenant_id, store_id, name) VALUES ($1, $2, $3) RETURNING id`, [T, S, name]);
    areas.set(name, a.id);
  }

  // ナレッジ
  const ids = new Map<string, string>();
  for (const n of NOTES) {
    const k = await createKnowledge(db, tokenizer, who[n.by], {
      storeId: S, title: n.title, body: n.body, tagNames: n.tags, ...(n.area ? { areaIds: [areas.get(n.area)!] } : {}),
    });
    ids.set(n.title, k.id);
  }

  // 新人の投稿は承認待ちになる（「承認・管理」に出る）
  await createKnowledge(db, tokenizer, newbie, {
    storeId: S, title: '乾電池の回収ボックスの場所', tagNames: ['電池', '回収'],
    body: '入口を入って右、チラシ台の横にあります。ボタン電池は別の小さい箱です。\n（先輩に教わったのでメモしました。合っているか見てください）',
  });
  await createKnowledge(db, tokenizer, newbie, {
    storeId: S, title: '駐車場のサービス券を渡し忘れたとき', tagNames: ['駐車場', 'レジ'],
    body: 'レシートを見せてもらえれば、サービスカウンターであとから渡せるそうです。当日だけ。',
  });

  // 見直し待ち：半年以上、だれも確かめていないもの
  for (const title of ['ギフト包装とのしの受け方', '電球・蛍光灯の「これと同じもの」']) {
    const id = ids.get(title)!;
    await db.query(`UPDATE knowledge_versions SET edited_at = now() - interval '210 days' WHERE knowledge_id = $1`, [id]);
    await db.query(`UPDATE knowledge SET verified_at = NULL, created_at = now() - interval '210 days' WHERE id = $1`, [id]);
  }

  // タグの関係（言い方が違っても同じものに当たるように）
  const relate = (input: Parameters<typeof proposeRelation>[2]) => proposeRelation(db, veteran, input).catch(() => undefined);
  await relate({ kind: 'alias', fromText: '延長保証', toTag: '長期保証' });
  await relate({ kind: 'alias', fromText: 'クーラー', toTag: 'エアコン' });
  await relate({ kind: 'alias', fromText: '苦情', toTag: 'クレーム' });
  await relate({ kind: 'alias', fromText: '落とし物', toTag: '忘れ物' });
  await relate({ kind: 'alias', fromText: 'ラッピング', toTag: '包装' });
  await relate({ kind: 'includes', fromTag: '洗濯機', toTag: 'ドラム式' });

  // 商品（バーコードで引ける。架空の型番）
  const washer = await registerProduct(db, veteran, S, {
    janCode: jan('499000000101'), name: 'ドラム式洗濯乾燥機 TW-D120（左開き）', maker: 'サンプル電機', areaId: areas.get('大型家電')!,
    note: '防水パン 64cm 角以上。右開きは型番の末尾が R。', tagNames: ['洗濯機', 'ドラム式'],
  });
  await linkKnowledgeToProduct(db, veteran, ids.get('ドラム式洗濯機は左開き・右開きを必ず聞く')!, washer.id);
  await linkKnowledgeToProduct(db, veteran, ids.get('冷蔵庫・洗濯機の搬入で先に確かめること')!, washer.id);
  const fridge = await registerProduct(db, veteran, S, {
    janCode: jan('499000000102'), name: '冷凍冷蔵庫 RF-500X（500L・フレンチドア）', maker: 'サンプル電機', areaId: areas.get('大型家電')!,
    note: '本体幅 68.5cm。搬入は幅 79cm 以上が目安。', tagNames: ['冷蔵庫'],
  });
  await linkKnowledgeToProduct(db, veteran, ids.get('冷蔵庫・洗濯機の搬入で先に確かめること')!, fridge.id);
  await linkKnowledgeToProduct(db, part, ids.get('家電リサイクルの対象と、引き取りの流れ')!, fridge.id);
  const bulb = await registerProduct(db, part, S, {
    janCode: jan('499000000103'), name: 'LED電球 E26 60W相当 電球色（密閉器具対応）', maker: 'サンプル電機', areaId: areas.get('売場')!,
    tagNames: ['電球', '照明'],
  });
  await linkKnowledgeToProduct(db, part, ids.get('電球・蛍光灯の「これと同じもの」')!, bulb.id);

  // 連絡
  const sale = await createNotice(db, manager, S, {
    title: '週末の決算セール：値札の貼り替え',
    body: '金曜の閉店後に、チラシ掲載の42品目の値札を貼り替えます。一覧はバックヤードの掲示板。\n土曜の朝礼で、目玉の3品（ドラム式洗濯機・500L冷蔵庫・6畳用エアコン）の在庫数を共有します。',
    priority: 'important',
  });
  const register = await createNotice(db, manager, S, {
    title: '【要確認】レジの釣り銭の数え方が変わりました',
    body: '今週から、開店前の釣り銭は「2人で数えて、2人の名前を書く」に変わりました。1人で数えた日は、理由を引き継ぎに書いてください。\n読んだら「確認しました」を押してください。',
    requiresAck: true,
  });
  await createNotice(db, veteran, S, {
    title: '修理受付の代替機：炊飯器が1台戻っていません',
    body: '台帳では3台、棚には2台です。貸し出した方は、台帳の記入を確かめてください。',
  });
  await createNotice(db, part, S, {
    title: 'インクの対応表を新しくしました',
    body: 'インク売場の対応表を今月版に差し替えました。古い表（表紙が青）は捨ててください。',
  });
  for (const a of [veteran, part]) { await markRead(db, a, sale.id); await ackNotice(db, a, register.id); }
  await markRead(db, newbie, sale.id);

  // 引き継ぎ（昨日の残りは、今日に持ち越しで出る）
  const zone = appTimeZone();
  const yesterday = todayIn(zone, new Date(Date.now() - 24 * 3600_000));
  await addHandover(db, part, S, '取り置きの炊飯器（佐藤様・サービスカウンターの棚）は明日まで。まだ来店されていません。', yesterday);
  const doneYesterday = await addHandover(db, veteran, S, '配送センターから、明日の午前便が1件増えたと連絡あり。注文書は配送ファイルの一番上。', yesterday);
  await setHandoverState(db, manager, doneYesterday.id, 'done');
  await addHandover(db, veteran, S, 'ドラム式 TW-D120（左開き）の在庫が残り1台。発注済みで、入荷は木曜の予定です。右開きは在庫あり。');
  await addHandover(db, manager, S, '15時にエアコン工事の下見（高橋様・2階の寝室）。配管の延長がありそうなので、見積もりは下見のあとで。');
  const doneToday = await addHandover(db, part, S, 'レジ2番のレシート用紙を交換しました。予備はあと2巻なので、発注をお願いします。');
  await setHandoverState(db, veteran, doneToday.id, 'done');
  await addHandover(db, newbie, S, '入口のチラシ台の横に、傘の忘れ物が1本あります。忘れ物ノートに書きました。');

  // 見つからなかった検索（店長が見て、足りないナレッジに気づく）
  const misses: Array<[string, number, Actor]> = [['ふるさと納税 領収書', 3, newbie], ['Wi-Fi ルーター 設定', 2, newbie], ['免税 手続き', 2, part], ['テレビ 壁掛け 工事', 1, newbie]];
  for (const [query, times, actor] of misses) {
    for (let i = 0; i < times; i++) {
      await db.query(
        `INSERT INTO search_logs (tenant_id, store_id, user_id, query, result_count, created_at) VALUES ($1, $2, $3, $4, 0, now() - make_interval(hours => $5))`,
        [T, S, actor.userId, query, 5 + i * 26],
      );
    }
  }

  return { store: store.name, notes: NOTES.length };
});
await database.close();

console.log(`「${result.store}」に書き込みました：ナレッジ ${result.notes} 件（＋承認待ち2件）、商品3点、連絡4件、引き継ぎ6件、スタッフ4人`);
