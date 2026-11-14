// カメラの画から JAN を読む部分（apps/web/src/ean.ts）。
// 本物のカメラは試験に持ち込めないので、バーコードの画を作って読ませる：
// 太さ・ぼけ・ざらつき・照明のむら・逆さ を変えても読めること、関係ない画を読んだことにしないこと。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDigitOk, decodeImage, decodeLine } from '../src/ean.ts';

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const FIRST = ['000000', '001011', '001101', '001110', '010011', '011001', '011100', '010101', '010110', '011010'];
const R = (d: number) => [...L[d]!].map((c) => (c === '0' ? '1' : '0')).join('');
const G = (d: number) => [...R(d)].reverse().join('');

/** 数字列を、黒=1・白=0 のモジュールの並びにする */
function modules(code: string): string {
  const d = [...code].map(Number);
  if (code.length === 8) return `101${d.slice(0, 4).map((x) => L[x]).join('')}01010${d.slice(4).map(R).join('')}101`;
  const parity = FIRST[d[0]!]!;
  const left = d.slice(1, 7).map((x, i) => (parity[i] === '1' ? G(x) : L[x])).join('');
  return `101${left}01010${d.slice(7).map(R).join('')}101`;
}

let seed = 7;
const random = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

interface Shot { scale?: number; blur?: number; noise?: number; tilt?: number; dark?: number; light?: number; quiet?: number; flip?: boolean }

/** 1本の走査線を作る（明るさ 0〜255） */
function scanline(code: string, o: Shot = {}): Uint8Array {
  const scale = o.scale ?? 3;
  const quiet = Math.round((o.quiet ?? 12) * scale);
  const bars = modules(code);
  const raw: number[] = [];
  for (let i = 0; i < quiet; i++) raw.push(0);
  for (const m of bars) for (let i = 0; i < Math.round(scale * 100) / 100; i++) raw.push(m === '1' ? 1 : 0);
  for (let i = 0; i < quiet; i++) raw.push(0);
  if (o.flip) raw.reverse();
  const blur = o.blur ?? 0;
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    let sum = 0, n = 0;
    for (let k = -blur; k <= blur; k++) { const v = raw[i + k]; if (v !== undefined) { sum += v; n++; } }
    const ink = sum / n;
    const shade = 1 - (o.tilt ?? 0) * (i / raw.length); // 片側が暗い照明
    const v = ((o.light ?? 235) - ink * ((o.light ?? 235) - (o.dark ?? 35))) * shade + (random() - 0.5) * (o.noise ?? 0);
    out[i] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return out;
}

/** チェックデジットを付ける（試験の中で、読む側とは別に計算する） */
function withCheck(body: string): string {
  let sum = 0;
  [...body].map(Number).reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return body + String((10 - (sum % 10)) % 10);
}
const CODES = ['490123456789', '499000000101', '454769168967', '001234567890', '978487311565', '197000000000', '4912345', '4567890'].map(withCheck);

describe('JAN を読む', () => {
  it('チェックデジットを確かめる', () => {
    for (const c of CODES) assert.ok(checkDigitOk(c), c);
    assert.equal(checkDigitOk('4901234567895'), false);
    assert.equal(checkDigitOk('490123456789'), false);
    assert.equal(checkDigitOk('49012345678a4'), false);
  });

  it('きれいな線から、13桁と8桁を読む', () => {
    for (const c of CODES) assert.equal(decodeLine(scanline(c)), c);
  });

  it('細い（1モジュール2画素）・太い（6画素）でも読む', () => {
    for (const c of CODES) {
      assert.equal(decodeLine(scanline(c, { scale: 2 })), c, `${c} 細い`);
      assert.equal(decodeLine(scanline(c, { scale: 6 })), c, `${c} 太い`);
    }
  });

  it('逆さに写っていても読む', () => {
    for (const c of CODES) assert.equal(decodeLine(scanline(c, { flip: true })), c);
  });

  it('ぼけ・ざらつき・片側が暗い照明・薄い印刷でも読む', () => {
    for (const c of CODES) {
      assert.equal(decodeLine(scanline(c, { scale: 4, blur: 1, noise: 24 })), c, `${c} ぼけ＋ざらつき`);
      assert.equal(decodeLine(scanline(c, { scale: 4, tilt: 0.45, noise: 10 })), c, `${c} 照明のむら`);
      assert.equal(decodeLine(scanline(c, { scale: 3, dark: 95, light: 190, noise: 8 })), c, `${c} 薄い印刷`);
    }
  });

  it('画（RGBA）から読む。バーコードがまんなかより少し上下にずれていてもよい', () => {
    const code = '4901234567894';
    const line = scanline(code, { scale: 3, noise: 12 });
    const width = line.length, height = 120;
    for (const top of [20, 45, 70]) {
      const data = new Uint8ClampedArray(width * height * 4).fill(230);
      for (let y = top; y < top + 30; y++) for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        data[p] = data[p + 1] = data[p + 2] = line[x]!;
      }
      assert.equal(decodeImage({ data, width, height }), code, `上から ${top}`);
    }
  });

  it('関係ない画（ざらつき・縞・文字のような模様）を、読んだことにしない', () => {
    let wrong = 0;
    for (let t = 0; t < 4000; t++) {
      const n = 320;
      const line = new Uint8Array(n);
      const kind = t % 4;
      let level = 230, left = 0;
      for (let i = 0; i < n; i++) {
        if (kind === 0) line[i] = Math.round(random() * 255);
        else {
          // 幅がばらばらの縞（棚・文字・ほかの種類のバーコードに似せる）
          if (left <= 0) { level = level > 128 ? 30 + random() * 40 : 200 + random() * 40; left = 1 + Math.floor(random() * (kind === 1 ? 4 : kind === 2 ? 9 : 16)); }
          left -= 1;
          line[i] = Math.round(level + (random() - 0.5) * 20);
        }
      }
      if (decodeLine(line)) wrong += 1;
    }
    assert.equal(wrong, 0, `${wrong} 回、無いものを読んだ`);
  });
});
