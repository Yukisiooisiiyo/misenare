// 作った QR コードが本当に読めるかを、別実装の読み取り器（jsQR）で確かめる。
// jsQR は入っていないこともあるので、その時はこのテストを飛ばす。
// CI では必ず入れて動かす（.github/workflows/ci.yml の「QR の読み取り確認」）。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeQr, type QrCode } from '../src/qr.ts';

type Decoder = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

// 入っていないこともあるので、名前を変数にして読み込む（型チェックで「無い」と言われないように）
const decoderModule = 'jsqr';
const loaded: Record<string, unknown> | null = await import(decoderModule).catch(() => null);

/** CommonJS の読み込まれ方は環境で変わるので、関数が見つかるところまで辿る */
function findDecoder(m: unknown, depth = 0): Decoder | null {
  if (typeof m === 'function') return m as Decoder;
  if (m && typeof m === 'object' && depth < 3) {
    for (const key of ['default', 'jsQR']) {
      const found = findDecoder((m as Record<string, unknown>)[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const jsQR = loaded ? findDecoder(loaded) : null;
const shape = loaded ? `keys=${Object.keys(loaded).join(',')} default=${typeof (loaded as { default?: unknown }).default}` : 'なし';

/** QR をそのまま画素にする（1モジュール = scale 画素、周りに余白4モジュール） */
function toPixels(qr: QrCode, scale = 4, quiet = 4): { data: Uint8ClampedArray; width: number } {
  const width = (qr.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y]![x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * width + (x + quiet) * scale + dx;
          data[px * 4] = 0;
          data[px * 4 + 1] = 0;
          data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, width };
}

function roundTrip(text: string): string | null {
  const qr = encodeQr(text);
  const { data, width } = toPixels(qr);
  return jsQR!(data, width, width)?.data ?? null;
}

describe('QR コードの読み取り確認（別実装）', { skip: loaded ? false : 'jsqr が入っていません' }, () => {
  it('読み取り器を関数として読み込めている', () => {
    assert.equal(typeof jsQR, 'function', `読み取り器が見つからない: ${shape}`);
  });

  it('いろいろな大きさの画像で読める（読めない時は大きさの一覧を出す）', () => {
    const text = 'A';
    const qr = encodeQr(text);
    const tried: string[] = [];
    for (const scale of [1, 2, 4, 8]) {
      for (const quiet of [0, 4, 8]) {
        const { data, width } = toPixels(qr, scale, quiet);
        const got = jsQR!(data, width, width)?.data ?? null;
        tried.push(`${scale}x/余白${quiet}:${got === text ? 'OK' : got === null ? 'null' : '違う'}`);
      }
    }
    assert.ok(tried.some((t) => t.endsWith('OK')), `どの大きさでも読めなかった: ${tried.join(' ')}`);
  });

  it('【手がかり】どの段階で失敗しているか', async () => {
    const qr = encodeQr('A');
    const { data, width } = toPixels(qr, 6, 4);
    const notes: string[] = [`jsQR=${typeof jsQR} name=${(jsQR as unknown as { name: string })?.name} arity=${(jsQR as unknown as { length: number })?.length}`, shape];
    const bin = await import('jsqr/dist/binarizer/index.js').then((m: Record<string, unknown>) => m, () => null);
    const loc = await import('jsqr/dist/locator/index.js').then((m: Record<string, unknown>) => m, () => null);
    if (!bin || !loc) {
      notes.push(`内部モジュールを読めない bin=${!!bin} loc=${!!loc}`);
    } else {
      const binarize = (bin.binarize ?? (bin.default as Record<string, unknown>)?.binarize) as
        (d: Uint8ClampedArray, w: number, h: number, inv: boolean) => { binarized: unknown };
      const locate = (loc.locate ?? (loc.default as Record<string, unknown>)?.locate) as (m: unknown) => Array<{ dimension: number }> | null;
      notes.push(`binarize=${typeof binarize} locate=${typeof locate}`);
      if (typeof binarize === 'function' && typeof locate === 'function') {
        const { binarized } = binarize(data, width, width, true);
        const found = locate(binarized);
        notes.push(found ? `位置は見つかった dimension=${found.map((f) => f.dimension).join('/')}（期待 ${qr.size}）` : '位置が見つからない');
      }
    }
    assert.fail(notes.join(' | '));
  });

  it('招待リンクを読み取れる', () => {
    const url = 'https://misenare.example.com/app/#invite=9133359e-0555-4f01-bbdd-00f7c3b0e4eb.o7CJTg6IwFS-1-wPF7EyMMwBr2tcN72a-lxK-77Ojac';
    assert.equal(roundTrip(url), url);
  });

  it('いろいろな長さで読み取れる（型番ごとの表を一通り通す）', () => {
    const seen = new Set<number>();
    for (let length = 1; length <= 640; length += 7) {
      const text = 'A'.repeat(length);
      seen.add(encodeQr(text).version);
      assert.equal(roundTrip(text), text, `${length} 文字`);
    }
    // 1〜20 型までひととおり使われていること（表の写し間違いをここで見つける）
    for (let v = 1; v <= 20; v++) assert.ok(seen.has(v), `型番 ${v} を試していない`);
  });

  it('日本語と記号も読み取れる', () => {
    for (const text of ['店なれ', '＃冷蔵庫 リサイクル料金', 'https://例え.jp/招待?a=1&b=2', '🙂'.repeat(20)]) {
      assert.equal(roundTrip(text), text);
    }
  });
});
