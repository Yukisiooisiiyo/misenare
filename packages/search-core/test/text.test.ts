import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeDocument, analyzeQuery, analyzeText } from '../src/analyzer.ts';
import { hiraToKata, romajiToKata, toReadingKey } from '../src/kana.ts';
import { extractModelNumbers, normalizeTagName, normalizeText } from '../src/normalize.ts';
import { deps } from './fixtures.ts';

describe('正規化', () => {
  it('全角英数と半角カナをそろえ、英字を小文字にする', () => {
    assert.equal(normalizeText('ＫＪ－５５Ｘ８５Ｌ　ﾃﾚﾋﾞ'), 'kj-55x85l テレビ');
  });

  it('タグ名の先頭の # と空白を外す', () => {
    assert.equal(normalizeTagName('＃ 延長 保証'), '延長保証');
    assert.equal(normalizeTagName('##テレビ'), 'テレビ');
  });

  it('型番は1語として取り出し、数字だけ・英字だけの語は型番にしない', () => {
    const { modelNumbers } = extractModelNumbers(normalizeText('KJ-55X85L は55インチ、usb-c 対応、NA-LX129CL も同様'));
    assert.deepEqual(modelNumbers, ['kj-55x85l', 'na-lx129cl']);
  });
});

describe('かな・ローマ字', () => {
  it('ひらがなをカタカナにする', () => {
    assert.equal(hiraToKata('てれび'), 'テレビ');
  });

  it('ローマ字をカタカナにし、入力途中の子音は rest に残す', () => {
    assert.deepEqual(romajiToKata('tere'), { kana: 'テレ', rest: '' });
    assert.deepEqual(romajiToKata('reizouko'), { kana: 'レイゾウコ', rest: '' });
    assert.deepEqual(romajiToKata('kuu'), { kana: 'クウ', rest: '' });
    assert.deepEqual(romajiToKata('sentakk'), { kana: 'センタッ', rest: 'k' });
    assert.equal(toReadingKey('てれ'), 'テレ');
  });
});

describe('タグ辞書', () => {
  it('最長一致で拾う（冷凍冷蔵庫を冷蔵庫より優先）', () => {
    const { dictionary } = deps();
    assert.deepEqual(dictionary.matchPhrases('冷凍冷蔵庫の搬入'), ['t-freezer', 't-carry']);
  });

  it('別名（単語 → タグ）を拾う', () => {
    const { dictionary } = deps();
    assert.deepEqual(dictionary.matchPhrases('テレビが映らない'), ['t-tv', 't-repair']);
  });

  it('同義は双方向に展開する', () => {
    const { dictionary } = deps();
    const fromAc = dictionary.expand('t-ac').map((e) => e.tagId);
    const fromCooler = dictionary.expand('t-cooler').map((e) => e.tagId);
    assert.deepEqual(fromAc.sort(), ['t-ac', 't-cooler']);
    assert.deepEqual(fromCooler.sort(), ['t-ac', 't-cooler']);
  });

  it('包含は上位から下位にだけ展開する', () => {
    const { dictionary } = deps();
    assert.deepEqual(dictionary.expand('t-fridge').map((e) => [e.tagId, e.weight]), [
      ['t-fridge', 1],
      ['t-freezer', 0.7],
    ]);
    assert.deepEqual(dictionary.expand('t-freezer').map((e) => e.tagId), ['t-freezer']);
  });
});

describe('解析', () => {
  it('文書側はタグに一致した部分も単語に分ける', () => {
    const terms = analyzeText('延長保証の対象外です', deps());
    assert.ok(terms.includes('延長保証'));
    assert.ok(terms.includes('保証'));
    assert.ok(!terms.includes('の'));
    assert.ok(!terms.includes('です'));
  });

  it('辞書にない語が漢字1文字ずつに割れたら、つなぎ直す（食|洗|機 → 食洗機）', () => {
    const terms = analyzeText('食洗機の分岐水栓', deps());
    assert.ok(terms.includes('食洗機'), terms.join(','));
    assert.ok(!terms.includes('機'));
  });

  it('タグ欄はタグ名を分割せず1語として数える', () => {
    const doc = analyzeDocument({ title: 'x', body: '', tagNames: ['#延長保証', '延長保証', '#修理'] }, deps());
    assert.deepEqual([...doc.tf.tag.keys()], ['延長保証', '修理']);
    assert.equal(doc.length.tag, 2);
  });

  it('検索側では #冷凍冷蔵庫 が「冷蔵庫」に割れない（包含の逆流を防ぐ）', () => {
    const q = analyzeQuery('#冷凍冷蔵庫', deps());
    assert.deepEqual([...q.terms.keys()], ['冷凍冷蔵庫']);
  });

  it('検索側で #冷蔵庫 は下位の #冷凍冷蔵庫 を 0.7 で含める', () => {
    const q = analyzeQuery('#冷蔵庫 リサイクル', deps());
    assert.equal(q.terms.get('冷蔵庫'), 1);
    assert.equal(q.terms.get('冷凍冷蔵庫'), 0.7);
    assert.equal(q.terms.get('リサイクル'), 1);
  });

  it('別名「映らない」は #修理 として検索される', () => {
    const q = analyzeQuery('テレビ 映らない', deps());
    assert.equal(q.terms.get('修理'), 1);
    assert.equal(q.terms.get('テレビ'), 1);
  });
});
