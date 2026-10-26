import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readingCandidates } from '../src/readingCandidates.ts';

/**
 * ここで測るのは「1位が当たるか」ではなく「**候補に入っているか**」。
 * 選ぶのは人なので、正解が5件のどこかにあれば用が足りる。
 * 並べ替えを外しても、利用者が1つ下を押すだけで済む。
 */
const CASES: Array<[word: string, reading: string]> = [
  ['食洗機', 'ショクセンキ'], ['下取', 'シタドリ'], ['開梱', 'カイコン'], ['前出し', 'マエダシ'],
  ['冷蔵庫', 'レイゾウコ'], ['引き取り', 'ヒキトリ'], ['値札', 'ネフダ'], ['売り場', 'ウリバ'],
  ['棚卸', 'タナオロシ'], ['据付', 'スエツケ'], ['品出し', 'シナダシ'],
  ['真空引き', 'シンクウビキ'], ['室外機', 'シツガイキ'], ['転倒防止', 'テントウボウシ'],
];

describe('読みの候補', () => {
  it('正解が5件の候補に入る（1位でなくてよい）', () => {
    const missed: string[] = [];
    for (const [word, want] of CASES) {
      if (!readingCandidates(word, 5).includes(want)) missed.push(word);
    }
    // 取扱説明書のような「2語がくっついた語」は外れる。人が打つ。
    assert.ok(missed.length === 0, `候補に入らない: ${missed.join('、')}`);
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

  it('音どうしで揃う語は、音読みを上に出す', () => {
    assert.equal(readingCandidates('食洗機', 1)[0], 'ショクセンキ');
    assert.equal(readingCandidates('転倒防止', 1)[0], 'テントウボウシ');
    assert.equal(readingCandidates('室外機', 1)[0], 'シツガイキ');
  });

  it('連濁した形も候補に出す（決め打ちしない）', () => {
    const c = readingCandidates('下取', 5);
    assert.ok(c.includes('シタドリ'), c.join('/'));
    assert.ok(c.includes('シタトリ'), '濁らない形も残す');
  });

  it('表に無い漢字が混ざる語では、候補を出さない', () => {
    // 無理に出すより黙るほうがよい。画面は入力欄だけ見せる。
    assert.deepEqual(readingCandidates('熨斗'), []);
  });

  it('かなだけの語はそのまま返す', () => {
    assert.deepEqual(readingCandidates('ぽいんと'), ['ポイント']);
  });
});
