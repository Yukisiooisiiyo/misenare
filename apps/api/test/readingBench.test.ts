// タグの「読み」を自動で埋めてよいか、数字で確かめる。
//
// なぜ要るか：読みは別名として登録され、「れいぞうこ」で #冷蔵庫 に当たる経路になる。
// つまり **間違った読みを黙って登録すると、検索の土台に嘘が混ざる**。
// 形態素解析器の読みは、音読み訓読みの揺れや連濁で外すことがあるので、
// 「だいたい合っている」では済まない。毎回ここで測り、数字を CI の注記に出す。
//
// 測るもの：
//   被覆率 = 読みを返した語 ÷ 全語（返さなければ登録されないので、実害はない）
//   正解率 = 返したうち正しかった語 ÷ 返した語（**ここが実害に直結する**）
//   衝突   = 誤った読みが、別の語の正しい読みと一致した件数（最悪のケース）
//
// kuromoji はこの環境に入れられないので、入っていなければ飛ばし、CI で必ず動かす。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMorphologicalTokenizer } from '../src/search/kuromojiTokenizer.ts';

const kuromoji = await createMorphologicalTokenizer().catch(() => null);

/**
 * 家電売場で実際にタグになりそうな語と、手で確かめた読み。
 * 読みが1つに決まる語だけをここに置く（揺れる語は下の AMBIGUOUS へ）。
 */
const ANSWERS: Array<[word: string, reading: string]> = [
  // 商品の種類
  ['冷蔵庫', 'レイゾウコ'], ['冷凍庫', 'レイトウコ'], ['洗濯機', 'センタクキ'],
  ['掃除機', 'ソウジキ'], ['炊飯器', 'スイハンキ'], ['電子レンジ', 'デンシレンジ'],
  ['扇風機', 'センプウキ'], ['加湿器', 'カシツキ'], ['空気清浄機', 'クウキセイジョウキ'],
  ['照明', 'ショウメイ'], ['電池', 'デンチ'], ['家電', 'カデン'], ['大型家電', 'オオガタカデン'],
  // 売り方・お金
  ['延長保証', 'エンチョウホショウ'], ['長期保証', 'チョウキホショウ'], ['保証書', 'ホショウショ'],
  ['領収書', 'リョウシュウショ'], ['請求書', 'セイキュウショ'], ['現金', 'ゲンキン'],
  ['会計', 'カイケイ'], ['割引', 'ワリビキ'], ['値引き', 'ネビキ'], ['値札', 'ネフダ'],
  ['分割払い', 'ブンカツバライ'], ['一括払い', 'イッカツバライ'],
  // 物の動き
  ['配送', 'ハイソウ'], ['搬入', 'ハンニュウ'], ['設置', 'セッチ'], ['工事', 'コウジ'],
  ['在庫', 'ザイコ'], ['入荷', 'ニュウカ'], ['発注', 'ハッチュウ'], ['納期', 'ノウキ'],
  ['予約', 'ヨヤク'], ['棚卸', 'タナオロシ'], ['下取り', 'シタドリ'], ['引き取り', 'ヒキトリ'],
  ['取り付け', 'トリツケ'], ['取り寄せ', 'トリヨセ'], ['売り場', 'ウリバ'],
  // 物の状態
  ['品番', 'ヒンバン'], ['型番', 'カタバン'], ['展示品', 'テンジヒン'], ['新品', 'シンピン'],
  ['中古', 'チュウコ'], ['寸法', 'スンポウ'], ['重量', 'ジュウリョウ'], ['小型', 'コガタ'],
  ['付属品', 'フゾクヒン'], ['説明書', 'セツメイショ'],
  // 困りごと
  ['返品', 'ヘンピン'], ['交換', 'コウカン'], ['修理', 'シュウリ'], ['故障', 'コショウ'],
  ['点検', 'テンケン'], ['分解', 'ブンカイ'], ['不具合', 'フグアイ'], ['苦情', 'クジョウ'],
  // 店の中
  ['開店', 'カイテン'], ['閉店', 'ヘイテン'], ['清掃', 'セイソウ'], ['制服', 'セイフク'],
  ['休憩', 'キュウケイ'], ['新人', 'シンジン'], ['店長', 'テンチョウ'], ['本部', 'ホンブ'],
  // カタカナ語（読みはそのまま。ここを外すと設計が壊れている）
  ['テレビ', 'テレビ'], ['エアコン', 'エアコン'], ['クーラー', 'クーラー'],
  ['リサイクル', 'リサイクル'], ['ポイント', 'ポイント'], ['レジ', 'レジ'],
  ['メーカー', 'メーカー'], ['カタログ', 'カタログ'], ['クレーム', 'クレーム'],
  ['サイズ', 'サイズ'], ['ケーブル', 'ケーブル'], ['リモコン', 'リモコン'],
];

/**
 * 売場では使うが、読みが揺れる・辞書に無さそうな語。
 * 正解を1つに決められないので合否には使わず、**どう振る舞ったか**だけ出す。
 * ここで読みを返してきたら、それは自信過剰のしるしなので目で見る。
 */
const AMBIGUOUS = ['食洗機', 'テレビ台', 'リサイクル券', '収集運搬料', 'ポイント還元', '家電リサイクル法', '取付', '下取', 'リ券'];

/** GitHub Actions の注記として出す（成功しても数字が残るように） */
function notice(title: string, body: string): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const esc = body.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
  console.log(`::notice title=${title}::${esc}`);
}

describe('タグの読みの自動付与：精度の測定', { skip: kuromoji ? false : 'kuromoji が入っていません' }, () => {
  it('被覆率と正解率を測り、数字を残す', () => {
    const wrong: Array<[word: string, got: string, want: string]> = [];
    const missing: string[] = [];
    let returned = 0;

    for (const [word, want] of ANSWERS) {
      const got = kuromoji!.reading(word);
      if (got == null) { missing.push(word); continue; }
      returned++;
      if (got !== want) wrong.push([word, got, want]);
    }

    const total = ANSWERS.length;
    const correct = returned - wrong.length;
    const coverage = returned / total;
    const precision = returned === 0 ? 0 : correct / returned;

    // 誤った読みが、別の語の正しい読みと一致してしまうか（これが起きると検索に嘘が混ざる）
    const allReadings = new Map(ANSWERS.map(([w, r]) => [r, w]));
    const collisions = wrong.filter(([word, got]) => allReadings.has(got) && allReadings.get(got) !== word);

    const report = [
      `語数 ${total} / 読みを返した ${returned}（被覆率 ${(coverage * 100).toFixed(1)}%）`,
      `返したうち正解 ${correct}（正解率 ${(precision * 100).toFixed(1)}%）`,
      `誤り ${wrong.length} 件、うち他の語の読みと衝突 ${collisions.length} 件`,
      '',
      ...(wrong.length > 0 ? ['誤った読み:', ...wrong.map(([w, g, t]) => `  ${w}: ${g} （正しくは ${t}）`)] : []),
      ...(missing.length > 0 ? ['', `読みを返さなかった語（登録されないので実害なし）: ${missing.join('、')}`] : []),
    ].join('\n');

    console.log(report);
    notice('タグの読み：精度', report);

    // 衝突はゼロでなければならない。1件でもあれば、検索が別の語に当たる。
    assert.equal(collisions.length, 0, `誤った読みが他の語とぶつかった: ${collisions.map(([w, g]) => `${w}→${g}`).join(', ')}`);

    // 正解率の下限。まずは実測を見るための緩い線で、測った値を見て締める。
    assert.ok(precision >= 0.6, `正解率が低すぎる: ${(precision * 100).toFixed(1)}%`);
  });

  it('読みが揺れる語で、どう振る舞うかを残す', () => {
    const rows = AMBIGUOUS.map((w) => `  ${w}: ${kuromoji!.reading(w) ?? '（読みを返さない）'}`);
    const report = ['読みが揺れる語・辞書に無さそうな語:', ...rows].join('\n');
    console.log(report);
    notice('タグの読み：揺れる語', report);
    // 合否には使わない。人が見て判断するための記録。
    assert.ok(true);
  });
});
