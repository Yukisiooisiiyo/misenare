// kuromoji（形態素解析）を使った分割の確認。
// kuromoji はここでは入れられないので、入っていなければ飛ばし、CI で必ず動かす。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterTerms, SegmenterTokenizer } from '@misenare/search-core';
import { createMorphologicalTokenizer } from '../src/search/kuromojiTokenizer.ts';

const kuromoji = await createMorphologicalTokenizer().catch(() => null);

describe('形態素解析での分割', { skip: kuromoji ? false : 'kuromoji が入っていません' }, () => {
  const terms = (text: string) => filterTerms(kuromoji!.segment(text));

  it('助詞や記号を落として、内容語だけを残す', () => {
    assert.deepEqual(terms('冷蔵庫のリサイクル料金は、メーカーで変わります。'), ['冷蔵庫', 'リサイクル', '料金', 'メーカー', '変わる']);
  });

  it('活用した語を終止形にそろえる（「修理した」でも「修理する」でも同じ語になる）', () => {
    for (const text of ['テレビを修理した', 'テレビを修理する', 'テレビの修理']) {
      assert.ok(terms(text).includes('修理'), `${text} から 修理 が出ない`);
    }
  });

  it('辞書にない複合語を、漢字1文字に割らない', () => {
    // Intl.Segmenter では「食洗機」が 食|洗|機 に割れることがある
    const got = terms('食洗機の設置');
    assert.ok(got.every((t) => t.length > 1 || !/^\p{Script=Han}$/u.test(t)), `漢字1文字に割れた: ${got.join('|')}`);
    assert.ok(got.includes('設置'));
  });

  it('語の読み（カタカナ）が取れる', () => {
    assert.equal(kuromoji!.reading('搬入'), 'ハンニュウ');
    assert.equal(kuromoji!.reading('冷蔵庫'), 'レイゾウコ');
    assert.equal(kuromoji!.reading('延長保証'), 'エンチョウホショウ');
  });

  it('辞書にない語の読みは null（読みを埋めずに飛ばせる）', () => {
    assert.equal(kuromoji!.reading('ＸＹＺ−１２３４'), null);
  });

  it('Intl.Segmenter と同じ語も取れている（入れ替えても検索が壊れない）', () => {
    const segmenter = new SegmenterTokenizer();
    for (const text of ['冷蔵庫のリサイクル料金', 'エアコンの標準工事', '延長保証の説明']) {
      const a = new Set(filterTerms(segmenter.segment(text)));
      const b = new Set(terms(text));
      const missing = [...a].filter((t) => !b.has(t));
      assert.deepEqual(missing, [], `${text}：形態素解析で落ちた語 ${missing.join('|')}`);
    }
  });
});
