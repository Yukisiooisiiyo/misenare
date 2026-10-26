import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handakuAfterSokuon, parseKanjiReadings, rendakuForms, sokuonForm } from '../src/kanjiReadings.ts';

/**
 * ここで確かめるのは、出典の形（送り仮名つきの読み）から
 * 複合語に出てくる形（連用形）を起こす規則。
 * 出典そのものは別に取り直すので、固定の見本で規則だけを見る。
 */
const kun = (raw: string, ch: string): string[] =>
  (parseKanjiReadings(raw).get(ch)?.kun ?? []).map((k) => `${k.reading}${k.stem ? '*' : ''}`);

describe('漢字の読みの表', () => {
  it('一段動詞は送り仮名の「ル」を落として連用形にする', () => {
    // す.える → スエ（据付＝スエツケ がこれで作れる）
    assert.deepEqual(kun('据:キョ|ス.エル,ス.ワル', '据'), ['ス*', 'スエ', 'スワリ']);
  });

  it('五段動詞はウ段をイ段に変えて連用形にする', () => {
    // おろ.す → オロシ（棚卸＝タナオロシ）
    assert.deepEqual(kun('卸:シャ|オロ.ス', '卸'), ['オロ*', 'オロシ']);
    // と.る → トリ（下取＝シタドリ の「トリ」）
    assert.deepEqual(kun('取:シュ|ト.ル', '取'), ['ト*', 'トリ']);
    // かわ.く → カワキ
    assert.deepEqual(kun('乾:カン|カワ.ク', '乾'), ['カワ*', 'カワキ']);
  });

  it('語幹の末尾がエ段なら、送り仮名「ル」は一段動詞と見る', () => {
    // で.る → デ（デリ にはしない）。一段動詞は連用形が語幹と同じ形なので、
    // この「デ」は裸で語になる（見本、見積の「ミ」と同じ）。印は付けない。
    assert.deepEqual(kun('出:シュツ|デ.ル,ダ.ス', '出'), ['デ', 'ダ*', 'ダシ']);
  });

  it('活用語尾でない送り仮名からは、連用形を起こさない', () => {
    // と.り は、すでに語の形。リ を変形させる規則は当てない。
    assert.deepEqual(kun('取:シュ|ト.リ', '取'), ['ト*']);
    // イ形容詞も変形させない
    assert.deepEqual(kun('長:チョウ|ナガ.イ', '長'), ['ナガ*']);
  });

  it('送り仮名のない読みは、裸で使える形として扱う', () => {
    assert.deepEqual(kun('棚:ホウ|タナ,ダナ', '棚'), ['タナ', 'ダナ']);
  });

  it('同じ形が語幹としても連用形としても出たら、裸で使える方を採る', () => {
    // で.る の語幹 デ と、送り仮名なしの デ。裸で出てよい形として1つにまとめる。
    assert.deepEqual(kun('出:シュツ|デ.ル,デ', '出'), ['デ']);
    // 五段なら語幹は裸では出ない。印を残す（ハラ* と連用形 ハライ）。
    assert.deepEqual(kun('払:フツ|ハラ.ウ', '払'), ['ハラ*', 'ハライ']);
  });

  it('連濁・促音便・半濁音の形を作る', () => {
    assert.deepEqual(rendakuForms('トリ'), ['ドリ']);
    assert.deepEqual(rendakuForms('ホン'), ['ボン', 'ポン']);
    assert.deepEqual(rendakuForms('アラ'), []);
    assert.equal(sokuonForm('ハツ', 'チュウ'), 'ハッ');
    assert.equal(sokuonForm('ツ', 'カ'), null, '1文字の読みは詰めない');
    assert.equal(handakuAfterSokuon('イッ', 'ホン'), 'ポン');
    assert.equal(handakuAfterSokuon('イチ', 'ホン'), null);
  });
});
