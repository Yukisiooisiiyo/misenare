import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeQr, errorCorrection, expGF, multiplyGF, qrToSvg } from '../src/qr.ts';

/** 盤の決まりごと（位置検出・タイミング・形式情報）を確かめる */
function checkStructure(qr: ReturnType<typeof encodeQr>): void {
  const m = qr.modules;
  const n = qr.size;
  assert.equal(n, qr.version * 4 + 17);
  for (const [top, left] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
    // 位置検出パターン：外枠が黒、その内側が白、中心 3×3 が黒
    for (let i = 0; i < 7; i++) {
      assert.equal(m[top]![left + i], true, '上辺は黒');
      assert.equal(m[top + 6]![left + i], true, '下辺は黒');
      assert.equal(m[top + i]![left], true, '左辺は黒');
      assert.equal(m[top + i]![left + 6], true, '右辺は黒');
    }
    assert.equal(m[top + 1]![left + 1], false);
    assert.equal(m[top + 3]![left + 3], true);
  }
  // タイミングパターンは白黒の交互
  for (let i = 8; i < n - 8; i++) {
    assert.equal(m[6]![i], i % 2 === 0);
    assert.equal(m[i]![6], i % 2 === 0);
  }
  // 必ず黒になるモジュール
  assert.equal(m[n - 8]![8], true);
}

describe('QR コード', () => {
  it('誤り訂正符号が規格の例と一致する', () => {
    // JIS X 0510 の例（1-M・「01234567」）のデータ符号に対する誤り訂正符号。
    const data = Uint8Array.from([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
    assert.deepEqual(
      [...errorCorrection(data, 10)],
      [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55],
    );
  });

  it('データと誤り訂正符号を並べた列は、α^0〜α^(n-1) を入れると 0 になる', () => {
    // 誤り訂正の決まりそのもの。生成多項式の作り方に依らない確かめ方なので、
    // 符号の並べ方を間違えるとここで落ちる。
    const data = Uint8Array.from([0x40, 0x14, 0x10, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec]);
    for (const length of [7, 10, 16, 26]) {
      const whole = [...data, ...errorCorrection(data, length)];
      for (let i = 0; i < length; i++) {
        let v = 0;
        for (const c of whole) v = multiplyGF(v, expGF(i)) ^ c;
        assert.equal(v, 0, `α^${i} を入れたら ${v} になった（誤り訂正 ${length} 個）`);
      }
    }
  });

  it('型番ごとに入る文字数が規格の表と一致する', () => {
    // バイトモード・レベル M の最大文字数（JIS X 0510 の容量表）。
    // 誤り訂正の表と、盤から数えた符号数の両方が正しくないと、この並びにならない。
    const expected = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666];
    for (const [i, max] of expected.entries()) {
      const version = i + 1;
      assert.equal(encodeQr('A'.repeat(max)).version, version, `${max} 文字は ${version} 型に入るはず`);
      if (version < expected.length) {
        assert.equal(encodeQr('A'.repeat(max + 1)).version, version + 1, `${max + 1} 文字は ${version + 1} 型になるはず`);
      }
    }
  });

  it('短い文字列は小さい型番、長くなるほど大きい型番を選ぶ', () => {
    assert.equal(encodeQr('HELLO').version, 1);
    const long = encodeQr('x'.repeat(300));
    assert.ok(long.version > 10, `型番 ${long.version}`);
    checkStructure(encodeQr('HELLO'));
    checkStructure(long);
  });

  it('どの長さでも盤の決まりごとを満たす', () => {
    for (const length of [1, 10, 50, 100, 120, 200, 400, 600]) {
      checkStructure(encodeQr('a'.repeat(length)));
    }
  });

  it('日本語（UTF-8）も載せられる', () => {
    const qr = encodeQr('店なれ：招待リンク');
    checkStructure(qr);
    assert.ok(qr.version >= 1);
  });

  it('大きすぎるものは断る', () => {
    assert.throws(() => encodeQr('x'.repeat(10000)), /収まりません/);
  });

  it('SVG は余白つきで、モジュールの数だけ四角を描く', () => {
    const qr = encodeQr('TEST');
    const svg = qrToSvg(qr, { quiet: 4, label: '招待' });
    const side = qr.size + 8;
    assert.match(svg, new RegExp(`viewBox="0 0 ${side} ${side}"`));
    const dark = qr.modules.flat().filter(Boolean).length;
    assert.equal((svg.match(/M\d+ \d+h1v1h-1z/g) ?? []).length, dark);
    assert.match(svg, /<title>招待<\/title>/);
  });
});
