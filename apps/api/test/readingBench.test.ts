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
import { appendFileSync, writeFileSync } from 'node:fs';
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
  // 売場の実語彙。読みは1つに決まるが、辞書には複合語として載っていないものが多い。
  // 2026-10-26 の測定で、ここに外しが出た（食洗機・下取）。いちばん大事な群。
  ['食洗機', 'ショクセンキ'], ['下取', 'シタドリ'], ['取付', 'トリツケ'],
  ['テレビ台', 'テレビダイ'], ['リサイクル券', 'リサイクルケン'],
  ['収集運搬料', 'シュウシュウウンパンリョウ'], ['ポイント還元', 'ポイントカンゲン'],
  ['家電リサイクル法', 'カデンリサイクルホウ'],
];

/**
 * 売場では使うが、読みが揺れる・辞書に無さそうな語。
 * 正解を1つに決められないので合否には使わず、**どう振る舞ったか**だけ出す。
 * ここで読みを返してきたら、それは自信過剰のしるしなので目で見る。
 */
const AMBIGUOUS = [
  'リ券', '両替', '釣銭', '値下げ', '品出し', '棚替え', '前出し', '納品', '検品',
  '梱包', '開梱', '搬出', '据付', '試運転', '初期不良', '取扱説明書', '保証期間',
  '無償', '有償', '出張費', '見積', '納期遅れ',
];

/**
 * 測定の結果をファイルに残す。
 *
 * 直に ::notice:: を出すと、TAP レポーターが行頭に印を付けるので
 * GitHub に拾われない。ファイルに書いて、次の手順から出す。
 */
const REPORT = process.env.READING_BENCH_OUT ?? 'reading-bench.md';
let started = false;
function record(title: string, body: string): void {
  console.log(body);
  if (!process.env.GITHUB_ACTIONS && !process.env.READING_BENCH_OUT) return;
  const block = `## ${title}\n\n\`\`\`\n${body}\n\`\`\`\n\n`;
  if (started) appendFileSync(REPORT, block);
  else { writeFileSync(REPORT, block); started = true; }
}

/**
 * 「案として見せてよいか」を決める条件の候補。
 * どれを採るかは勘で決めず、下の測定で各条件の正解率を出してから選ぶ。
 */
const RULES: Array<[name: string, ok: (g: { morphemes: number; loneKanji: number; loneKanjiFree: number }) => boolean]> = [
  ['条件なし（全部出す）', () => true],
  ['1形態素のみ', (g) => g.morphemes === 1],
  ['単漢字に割れていない', (g) => g.loneKanji === 0],
  ['単漢字の自立語を含まない', (g) => g.loneKanjiFree === 0],
];

describe('タグの読みの自動付与：精度の測定', { skip: kuromoji ? false : 'kuromoji が入っていません' }, () => {
  it('どの条件なら案として見せてよいかを測る', () => {
    const lines: string[] = ['条件ごとの、案として見せたときの正解率:', ''];
    lines.push('| 条件 | 見せる語 | 正解 | 正解率 | 取りこぼす語 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const [name, ok] of RULES) {
      let shown = 0; let correct = 0; const dropped: string[] = [];
      for (const [word, want] of ANSWERS) {
        const g = kuromoji!.guessReading(word);
        if (g == null) continue;
        if (!ok(g)) { if (g.reading === want) dropped.push(word); continue; }
        shown++;
        if (g.reading === want) correct++;
      }
      const rate = shown === 0 ? 0 : (correct / shown) * 100;
      lines.push(`| ${name} | ${shown} | ${correct} | ${rate.toFixed(1)}% | ${dropped.length}件 |`);
    }
    lines.push('');
    lines.push('※「取りこぼす語」＝条件で弾いたが、実は読みが合っていた語。多いほど確認の手間が増える。');
    lines.push('');
    lines.push('語ごとの内訳（形態素数 / 単漢字 / 単漢字の自立語）:');
    for (const [word, want] of ANSWERS) {
      const g = kuromoji!.guessReading(word);
      if (g == null) { lines.push(`  ${word}: 読みなし`); continue; }
      const mark = g.reading === want ? '○' : '×';
      lines.push(`  ${mark} ${word}: ${g.reading} (${g.morphemes}/${g.loneKanji}/${g.loneKanjiFree})`);
    }
    record('タグの読み：見せてよい条件', lines.join('\n'));
    assert.ok(true);
  });

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

    record('タグの読み：精度', report);

    // 衝突はゼロでなければならない。1件でもあれば、検索が別の語に当たる。
    assert.equal(collisions.length, 0, `誤った読みが他の語とぶつかった: ${collisions.map(([w, g]) => `${w}→${g}`).join(', ')}`);

    // 下限は実測から決める。2026-10-26 の測定で 86 語中 84 正解（97.7%）だった。
    // 外したのは「食洗機 → ショクアライキ」「下取 → シタト」の2語で、
    // どちらも**家電売場で確実にタグになる語**。これが、読みを人の確認に
    // 掛けている理由そのもの。ここが下がったら、確認の運用を見直す合図。
    assert.ok(precision >= 0.9, `正解率が下がった: ${(precision * 100).toFixed(1)}%`);
  });

  it('正解を決めていない語で、どう振る舞うかを残す', () => {
    // まだ正解表に入れていない売場の語。ここの出力を見て、読みが1つに
    // 決まると確かめられたものから正解表へ移す。合否には使わない。
    const rows = AMBIGUOUS.map((w) => `  ${w}: ${kuromoji!.reading(w) ?? '（読みを返さない）'}`);
    const report = ['正解表に入れていない語（次に見るもの）:', ...rows].join('\n');
    record('タグの読み：揺れる語', report);
    // 合否には使わない。人が見て判断するための記録。
    assert.ok(true);
  });
});
