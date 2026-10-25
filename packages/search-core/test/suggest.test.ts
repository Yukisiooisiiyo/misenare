import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeNpmi, editDistance, pairKey, suggestTags } from '../src/suggest.ts';
import { deps } from './fixtures.ts';

const names = (xs: Array<{ name: string }>) => xs.map((x) => x.name);

describe('タグ候補', () => {
  const { dictionary } = deps();

  it('1文字目から既存タグを前方一致で出す', () => {
    assert.deepEqual(names(suggestTags({ input: '#テ', dictionary }).candidates), ['テレビ', 'テレビ台']);
  });

  it('ひらがな・ローマ字でもカタカナのタグに当たる', () => {
    assert.equal(suggestTags({ input: 'てれ', dictionary }).candidates[0]?.name, 'テレビ');
    assert.equal(suggestTags({ input: 'tere', dictionary }).candidates[0]?.name, 'テレビ');
  });

  it('読みが登録されていれば、漢字のタグにもかなで当たる', () => {
    assert.deepEqual(names(suggestTags({ input: 'れいぞ', dictionary }).candidates), ['冷蔵庫']);
  });

  it('一緒に使われやすいタグを上に出す', () => {
    // #冷蔵庫 を選んだ状態では、使用回数の少ない #搬入 が #配送 より上に来るよう共起を設定
    const co = new Map([[pairKey('t-fridge', 't-carry'), 0.8], [pairKey('t-fridge', 't-delivery'), 0.1]]);
    const all = suggestTags({ input: '搬', dictionary, selectedTagIds: ['t-fridge'], cooccurrence: co });
    assert.equal(all.candidates[0]?.name, '搬入');
  });
});

describe('もしかして', () => {
  const { dictionary } = deps();

  it('#エアコン と打つと、もしかして：#クーラー', () => {
    const r = suggestTags({ input: 'エアコン', dictionary });
    assert.deepEqual(r.maybe.map((m) => [m.tag.name, m.reason]), [['クーラー', 'synonym']]);
  });

  it('#掃除機 と打つと、下位の #ロボット掃除機 も出す', () => {
    const r = suggestTags({ input: '掃除機', dictionary });
    assert.ok(r.maybe.some((m) => m.tag.name === 'ロボット掃除機' && m.reason === 'includes'));
  });

  it('1文字違いの打ち間違いを拾う（#エアコソ → #エアコン）', () => {
    const r = suggestTags({ input: 'エアコソ', dictionary });
    assert.equal(r.candidates.length, 0);
    assert.equal(r.maybe[0]?.tag.name, 'エアコン');
    assert.equal(r.maybe[0]?.reason, 'typo');
  });
});

describe('補助関数', () => {
  it('編集距離（隣接の入れ替えは1）', () => {
    assert.equal(editDistance('エアコン', 'エアコソ', 2), 1);
    assert.equal(editDistance('エアコン', 'エコアン', 2), 1);
    assert.equal(editDistance('テレビ', '冷蔵庫', 1), 2);
  });

  it('NPMI：いつも一緒に使われるタグは 1、独立なら 0 付近', () => {
    const npmi = computeNpmi(
      100,
      new Map([['a', 10], ['b', 10], ['c', 50], ['d', 20]]),
      new Map([[pairKey('a', 'b'), 10], [pairKey('c', 'd'), 10]]),
    );
    assert.ok(Math.abs(npmi.get(pairKey('a', 'b'))! - 1) < 1e-9);
    assert.ok(Math.abs(npmi.get(pairKey('c', 'd'))!) < 1e-9);
  });
});
