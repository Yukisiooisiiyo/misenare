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
import { readingCandidates, suggestReading } from '@misenare/search-core';
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
  // 2026-10-26 の2回目で確かめた売場語。条件を選んだあとに足した群なので、
  // ここでの振る舞いが**条件の検証**になる（条件は先の 86 語を見て決めた）。
  ['両替', 'リョウガエ'], ['釣銭', 'ツリセン'], ['値下げ', 'ネサゲ'], ['品出し', 'シナダシ'],
  ['棚替え', 'タナガエ'], ['前出し', 'マエダシ'], ['納品', 'ノウヒン'], ['検品', 'ケンピン'],
  ['梱包', 'コンポウ'], ['開梱', 'カイコン'], ['搬出', 'ハンシュツ'], ['据付', 'スエツケ'],
  ['試運転', 'シウンテン'], ['初期不良', 'ショキフリョウ'], ['取扱説明書', 'トリアツカイセツメイショ'],
  ['保証期間', 'ホショウキカン'], ['無償', 'ムショウ'], ['有償', 'ユウショウ'],
  ['出張費', 'シュッチョウヒ'], ['見積', 'ミツモリ'], ['納期遅れ', 'ノウキオクレ'],
];

/**
 * 売場では使うが、読みが揺れる・辞書に無さそうな語。
 * 正解を1つに決められないので合否には使わず、**どう振る舞ったか**だけ出す。
 * ここで読みを返してきたら、それは自信過剰のしるしなので目で見る。
 */
const AMBIGUOUS = [
  'リ券', '即日', '当日渡し', '後日配送', '店渡し', '持ち帰り', '下見', '採寸',
  '室外機', '室内機', '配管', '真空引き', '化粧カバー', '標準工事', '追加工事',
  '壁掛け', '天吊り', '転倒防止', '結露', '霜取り',
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

    // 採用した条件：単漢字の自立語を含まない。
    // この条件で見せた案に誤りが混ざったら、条件を選び直す合図。
    let shown = 0; let wrong = 0; const wrongWords: string[] = [];
    for (const [word, want] of ANSWERS) {
      const g = kuromoji!.guessReading(word);
      if (g == null || g.loneKanjiFree > 0) continue;
      shown++;
      if (g.reading !== want) { wrong++; wrongWords.push(`${word}→${g.reading}（正しくは ${want}）`); }
    }
    const rate = shown === 0 ? 0 : (shown - wrong) / shown;
    assert.ok(rate >= 0.98, `採用した条件で誤りが出た（${(rate * 100).toFixed(1)}%）: ${wrongWords.join(', ')}`);
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

    // ここは「条件なしで全部出した場合」の数字。実際には下の条件で絞るので、
    // この値がそのまま利用者の目に入るわけではない。下がったら気づくための線。
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

/**
 * 人が選ぶための候補を出す経路（readingCandidates）の測定。
 *
 * 上の測定（形態素解析器）とは**測る中身が違う**。
 * 上は「黙って案として見せてよいか」なので 1位が当たる率を見る。
 * ここは「人が5件から選ぶ」ので **正解が候補に入っている率**（再現率）を見る。
 * 選ぶのは人なので、1位が当たっていなくても、入っていれば用が足りる。
 *
 * この経路は辞書を引かない。漢字1字ごとの読み（KANJIDIC2）を総当たりし、
 * 複合語の規則（音訓の揃い・連用形・連濁）で並べているだけなので、
 * kuromoji が無くても動く。だからここは CI でなくても測れる。
 */
describe('タグの読みの候補：人が選べるかの測定', () => {
  it('正解が5件の候補に入る率を測り、数字を残す', () => {
    const missed: string[] = [];
    const notFirst: string[] = [];
    let first = 0; let within = 0; let silent = 0;
    let worst = 0; let worstWord = '';

    for (const [word, want] of ANSWERS) {
      const t0 = performance.now();
      const got = readingCandidates(word, 5);
      const ms = performance.now() - t0;
      if (ms > worst) { worst = ms; worstWord = word; }
      if (got.length === 0) { silent++; missed.push(`${word}（候補を出さない）`); continue; }
      const at = got.indexOf(want);
      if (at === 0) { first++; within++; continue; }
      if (at > 0) { within++; notFirst.push(`${word}: ${at + 1}位`); continue; }
      missed.push(`${word}→ ${got.slice(0, 3).join('／')}（正しくは ${want}）`);
    }

    const total = ANSWERS.length;
    const report = [
      `語数 ${total}`,
      `正解が候補5件に入った ${within}（再現率 ${((within / total) * 100).toFixed(1)}%）`,
      `うち1位 ${first}（${((first / total) * 100).toFixed(1)}%）`,
      `候補を出さなかった語 ${silent}（表に無い漢字が混ざる語。入力欄だけ見せる）`,
      `いちばん遅い語 ${worstWord} ${worst.toFixed(0)}ms`,
      '',
      ...(missed.length > 0 ? ['候補に入らなかった語:', ...missed.map((m) => `  ${m}`), ''] : []),
      ...(notFirst.length > 0 ? ['1位ではないが候補に入った語:', ...notFirst.map((m) => `  ${m}`)] : []),
    ].join('\n');
    record('タグの読みの候補：再現率', report);

    // 人が5件から選ぶ前提なので、見る線は再現率。
    // 1位の率は参考（下がっても、押す位置が1つ下がるだけ）。
    assert.ok(within / total >= 0.9, `再現率が下がった: ${((within / total) * 100).toFixed(1)}%`);
    // 1語あたりの計算時間。タグを作る瞬間に1回走るので、体感に出ない範囲に収める。
    assert.ok(worst < 400, `候補を作るのが遅い（${worstWord} ${worst.toFixed(0)}ms）`);
  });

  it('読みが揺れる語でも、候補のどこかに両方の形を出す', () => {
    // 下取は シタドリ とも シタトリ とも打たれる。どちらが正しいかを決めず、
    // 両方を候補に残す。利用者は押して、入力欄で直せる。
    const c = readingCandidates('下取', 5);
    assert.ok(c.includes('シタドリ'), c.join('／'));
    assert.ok(c.includes('シタトリ'), `濁らない形も残す: ${c.join('／')}`);
  });

  it('正解を決めていない語で、候補の出方を残す', () => {
    const rows = AMBIGUOUS.map((w) => {
      const c = readingCandidates(w, 5);
      return `  ${w}: ${c.length === 0 ? '（候補を出さない）' : c.join('／')}`;
    });
    record('タグの読みの候補：揺れる語', ['正解表に入れていない語の、候補の出方:', ...rows].join('\n'));
    assert.ok(true);
  });
});

/**
 * 利用者が実際に見る画面で測る。
 *
 * 上の2つは経路ごとの数字だが、タグを作った直後の確認画面には**両方が同時に出る**。
 *   入力欄 … 形態素解析器の案（信用できないときは空）
 *   その下 … 漢字の読みの総当たりから作った候補（押すと入力欄に入る）
 * どちらかに正解があれば、打たずに済む。だから見るべき数字はその**合わせ技**。
 *
 * 2つの経路は外す語が違う（辞書に載っている複合語と、載っていない複合語）。
 * 片方だけを見ていると、この補い合いが数字に出ない。
 */
describe('タグの読み：画面に出るもの全部での測定', { skip: kuromoji ? false : 'kuromoji が入っていません' }, () => {
  it('入力欄か候補のどこかに正解がある率を測る', () => {
    const rows: string[] = [];
    let box = 0; let chips = 0; let either = 0;
    const missed: string[] = [];

    for (const [word, want] of ANSWERS) {
      const s = suggestReading(kuromoji!, word);
      // settled（カタカナ語）は尋ねずに登録される。確認の手間はゼロ。
      const proposed = s.kind === 'silent' ? '' : s.reading;
      const candidates = readingCandidates(word, 5).filter((c) => c !== proposed);
      const inBox = proposed === want;
      const inChips = candidates.includes(want);
      if (inBox) box++;
      if (inChips) chips++;
      if (inBox || inChips) either++;
      else { missed.push(`${word}（正しくは ${want}）`); }
      rows.push(`  ${inBox ? '欄' : inChips ? '候' : '×'} ${word}: 欄=${proposed || '（空）'} 候=${candidates.join('／')}`);
    }

    const total = ANSWERS.length;
    const report = [
      `語数 ${total}`,
      `入力欄に正解が入っていた ${box}（${((box / total) * 100).toFixed(1)}%）… そのまま登録できる`,
      `候補に正解があった ${chips}（${((chips / total) * 100).toFixed(1)}%）… 1回押せば入る`,
      `**どちらかにあった ${either}（${((either / total) * 100).toFixed(1)}%）**… 打たずに済む`,
      '',
      ...(missed.length > 0 ? ['どちらにも無かった語（人が打つ）:', ...missed.map((m) => `  ${m}`), ''] : []),
      '語ごとの内訳（欄＝入力欄が正解／候＝候補に正解）:',
      ...rows,
    ].join('\n');
    record('タグの読み：画面に出るもの全部', report);

    // 2つの経路は外す語が違うので、合わせれば取りこぼしはごく少ないはず。
    // ここが下がったら、片方の経路が壊れたか、両方が同じ語で外し始めた合図。
    assert.ok(either / total >= 0.97, `打たずに済む率が下がった: ${((either / total) * 100).toFixed(1)}%`);
  });
});
