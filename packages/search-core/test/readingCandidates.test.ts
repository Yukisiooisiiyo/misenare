import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readingCandidates } from '../src/readingCandidates.ts';

/**
 * ここで測るのは「1位が当たるか」ではなく「**候補に入っているか**」。
 * 選ぶのは人なので、正解が5件のどこかにあれば用が足りる。
 * 押すと入力欄に入り、そこで直せるので、1つ下を押すのも一文字直すのも手間は小さい。
 *
 * 売場語全体での数字（107語）は apps/api/test/readingBench.test.ts で測り、
 * CI の注記に出している。ここは規則ごとの振る舞いを固定するための試験。
 */
const CASES: Array<[word: string, reading: string]> = [
  ['食洗機', 'ショクセンキ'], ['下取', 'シタドリ'], ['開梱', 'カイコン'], ['前出し', 'マエダシ'],
  ['冷蔵庫', 'レイゾウコ'], ['引き取り', 'ヒキトリ'], ['値札', 'ネフダ'], ['売り場', 'ウリバ'],
  ['棚卸', 'タナオロシ'], ['据付', 'スエツケ'], ['品出し', 'シナダシ'],
  ['真空引き', 'シンクウビキ'], ['室外機', 'シツガイキ'], ['転倒防止', 'テントウボウシ'],
  ['乾燥機', 'カンソウキ'], ['洗濯機', 'センタクキ'], ['電子レンジ', 'デンシレンジ'],
  ['取付', 'トリツケ'],
];

describe('読みの候補', () => {
  it('正解が5件の候補に入る（1位でなくてよい）', () => {
    const missed = CASES.filter(([word, want]) => !readingCandidates(word, 5).includes(want));
    assert.deepEqual(missed.map(([w]) => w), [], `候補に入らない: ${missed.map(([w]) => w).join('、')}`);
  });

  it('送り仮名を二重に数えない', () => {
    // 引(ヒキ) + き を重ねると ヒキキ になる。読みの末尾と送り仮名は重なるのが普通。
    assert.ok(readingCandidates('引き取り', 5).includes('ヒキトリ'));
    assert.ok(!readingCandidates('引き取り', 20).includes('ヒキキトリリ'));
  });

  it('送り仮名が付く漢字は訓読みを上に出す', () => {
    assert.equal(readingCandidates('前出し', 1)[0], 'マエダシ');
    assert.equal(readingCandidates('売り場', 1)[0], 'ウリバ');
  });

  it('漢字だけが並ぶ語は、音読みで揃う形を上に出す', () => {
    assert.equal(readingCandidates('食洗機', 1)[0], 'ショクセンキ');
    assert.equal(readingCandidates('転倒防止', 1)[0], 'テントウボウシ');
    assert.equal(readingCandidates('室外機', 1)[0], 'シツガイキ');
    assert.equal(readingCandidates('乾燥機', 1)[0], 'カンソウキ');
  });

  it('送り仮名から連用形を起こす（表には語幹しか載っていない）', () => {
    // KANJIDIC2 の「据」は ス.エル だけ。スエ は規則で起こしている。
    assert.ok(readingCandidates('据付', 5).includes('スエツケ'));
    // 「卸」は オロ.ス。棚卸＝タナオロシ の「オロシ」も同じ規則から。
    assert.ok(readingCandidates('棚卸', 5).includes('タナオロシ'));
  });

  it('連濁した形も候補に出す（決め打ちしない）', () => {
    const c = readingCandidates('下取', 5);
    assert.ok(c.includes('シタドリ'), c.join('/'));
    assert.ok(c.includes('シタトリ'), `濁らない形も残す: ${c.join('/')}`);
  });

  it('同じ骨組みの濁点ちがいで枠を埋めない', () => {
    // 型番は カタツガ／カタズガ／カタヅガ／ガタツガ／ガタズガ で5件が尽きていた。
    const c = readingCandidates('型番', 5);
    const skeletons = new Set(c.map((r) => r.replace(/[ガギグゲゴ]/g, 'カ').replace(/[ザジズゼゾ]/g, 'サ')
      .replace(/[ダヂヅデド]/g, 'タ').replace(/[バビブベボパピプペポ]/g, 'ハ')));
    assert.ok(skeletons.size >= 3, `骨組みが足りない: ${c.join('/')}`);
    // 湯桶・重箱読みのための枠が空いているので、カタバン が残る
    assert.ok(c.includes('カタバン'), c.join('/'));
  });

  it('カタカナの語は送り仮名として扱わない', () => {
    // 「レンジ」を送り仮名と見ると、「子」を訓読み（コ）に引っ張ってしまう
    assert.equal(readingCandidates('電子レンジ', 1)[0], 'デンシレンジ');
  });

  it('表に無い漢字が混ざる語では、候補を出さない', () => {
    // 無理に出すより黙るほうがよい。画面は入力欄だけ見せる。
    // 「㐂」は JIS X 0208 の外なので表に無い（表の線はそこで引いてある）。
    assert.deepEqual(readingCandidates('㐂寿'), []);
  });

  it('日本語の文章に書ける漢字なら、表に載っている', () => {
    // 収録の線を常用漢字から JIS X 0208 に広げた。常用外でも売場では使う。
    assert.ok(readingCandidates('梱包', 5).length > 0, '梱');
    assert.ok(readingCandidates('熨斗', 5).length > 0, '熨');
  });

  it('かなだけの語はそのまま返す', () => {
    assert.deepEqual(readingCandidates('ぽいんと'), ['ポイント']);
  });
});
