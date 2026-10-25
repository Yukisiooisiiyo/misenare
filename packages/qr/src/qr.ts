// QR コードを作る（バイトモード・誤り訂正レベル M）。招待リンクを紙や画面で渡すために使う。
// ライブラリは足さない。使うのは招待リンク（百数十文字の URL）だけなので、
// 数字モードや漢字モードは持たず、UTF-8 のバイト列をそのまま載せる。
//
// 作り方は JIS X 0510 / ISO 18004 のとおり：
//   1. モード・文字数・データ・終端を並べてビット列にする
//   2. ブロックに分けて Reed-Solomon の誤り訂正符号を付け、交互に並べ直す
//   3. 機能パターン（位置検出・タイミング・位置合わせ）を置いた盤にビットを並べる
//   4. 8通りのマスクを試し、読み取りにくさの点数がいちばん低いものを選ぶ

/** 対応する型番（1〜20）。招待リンクは 7〜9 型に収まるが、余裕を持たせてある */
const MAX_VERSION = 20;

/**
 * 型番ごとの「1ブロックあたりの誤り訂正符号の数」と「ブロック数」（レベル M）。
 * これと盤から数えた総符号数があれば、データ符号の数と各ブロックの長さは計算で出る。
 */
const EC_M: Array<[ecPerBlock: number, blocks: number]> = [
  [10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5],
  [30, 5], [22, 8], [22, 9], [24, 9], [24, 10], [28, 10], [28, 11], [26, 13], [26, 14], [26, 16],
];

/** 型番ごとの位置合わせパターンの中心座標 */
const ALIGNMENT: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
  [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

// --- GF(256) の計算（Reed-Solomon 用） ---------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 原始多項式 x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function mul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

/** 誤り訂正符号を作るための多項式 */
function generatorPoly(degree: number): Uint8Array {
  let poly = Uint8Array.from([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ mul(poly[j]!, EXP[i]!);
      next[j + 1] = next[j + 1]! ^ poly[j]!;
    }
    poly = next;
  }
  return poly;
}

/** データ符号に対する誤り訂正符号（多項式の剰余） */
export function errorCorrection(data: Uint8Array, ecLength: number): Uint8Array {
  const gen = generatorPoly(ecLength);
  const remainder = new Uint8Array(ecLength);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.copyWithin(0, 1);
    remainder[ecLength - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < ecLength; i++) remainder[i] = remainder[i]! ^ mul(gen[i + 1]!, factor);
    }
  }
  return remainder;
}

// --- 盤（機能パターン） ------------------------------------------------------------

type Grid = Int8Array[]; // -1: 空き / 0: 白 / 1: 黒

const size = (version: number) => version * 4 + 17;

function blankGrid(version: number): Grid {
  const n = size(version);
  return Array.from({ length: n }, () => new Int8Array(n).fill(-1));
}

function setSquare(grid: Grid, top: number, left: number, pattern: number[][]): void {
  for (let y = 0; y < pattern.length; y++) {
    for (let x = 0; x < pattern[y]!.length; x++) {
      const row = grid[top + y];
      if (row && left + x >= 0 && left + x < row.length) row[left + x] = pattern[y]![x]! as 0 | 1;
    }
  }
}

/** 位置検出パターン（7×7）と、その周りの区切り（白） */
function placeFinder(grid: Grid, top: number, left: number): void {
  for (let y = -1; y <= 7; y++) {
    for (let x = -1; x <= 7; x++) {
      const inner = y >= 0 && y <= 6 && x >= 0 && x <= 6;
      const dark = inner && ((y === 0 || y === 6 || x === 0 || x === 6) || (y >= 2 && y <= 4 && x >= 2 && x <= 4));
      const row = grid[top + y];
      if (row && left + x >= 0 && left + x < row.length) row[left + x] = dark ? 1 : 0;
    }
  }
}

function placeFunctionPatterns(grid: Grid, version: number): void {
  const n = size(version);
  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, n - 7);
  placeFinder(grid, n - 7, 0);

  // タイミングパターン（白黒の交互）
  for (let i = 8; i < n - 8; i++) {
    grid[6]![i] = i % 2 === 0 ? 1 : 0;
    grid[i]![6] = i % 2 === 0 ? 1 : 0;
  }

  // 位置合わせパターン（位置検出パターンと重なるところは置かない）
  const centers = ALIGNMENT[version - 1]!;
  for (const cy of centers) {
    for (const cx of centers) {
      const nearFinder = (cy <= 8 && cx <= 8) || (cy <= 8 && cx >= n - 9) || (cy >= n - 9 && cx <= 8);
      if (nearFinder) continue;
      setSquare(grid, cy - 2, cx - 2, [
        [1, 1, 1, 1, 1],
        [1, 0, 0, 0, 1],
        [1, 0, 1, 0, 1],
        [1, 0, 0, 0, 1],
        [1, 1, 1, 1, 1],
      ]);
    }
  }

  // 形式情報の場所を予約し、必ず黒になるモジュールを置く
  for (let i = 0; i < 9; i++) {
    if (grid[8]![i] === -1) grid[8]![i] = 0;
    if (grid[i]![8] === -1) grid[i]![8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    grid[8]![n - 1 - i] = 0;
    grid[n - 1 - i]![8] = 0;
  }
  grid[n - 8]![8] = 1;

  // 型番情報（7型以上）
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >> i) & 1) as 0 | 1;
      grid[Math.floor(i / 3)]![n - 11 + (i % 3)] = bit;
      grid[n - 11 + (i % 3)]![Math.floor(i / 3)] = bit;
    }
  }
}

/** 型番情報：6ビットの型番 + BCH(18,6) の誤り訂正 */
function versionBits(version: number): number {
  // 6ビットの型番を12次で割る＝6回だけ引く
  let rest = version << 12;
  for (let i = 0; i < 6; i++) {
    if (rest & (1 << (17 - i))) rest ^= 0x1f25 << (5 - i);
  }
  return (version << 12) | rest;
}

/** 形式情報：レベル(2) + マスク(3) に BCH(15,5) を付け、0x5412 と排他的論理和をとる */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // レベル M は 00
  let rest = data << 10;
  for (let i = 0; i < 5; i++) {
    if (rest & (1 << (14 - i))) rest ^= 0x537 << (4 - i);
  }
  return ((data << 10) | rest) ^ 0x5412;
}

function placeFormat(grid: Grid, mask: number): void {
  const n = grid.length;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i++) {
    const bit = ((bits >> i) & 1) as 0 | 1;
    // 1つ目：位置検出パターンの右と下に沿って、縦（列8）→横（行8）の順に置く
    if (i < 6) grid[i]![8] = bit;
    else if (i === 6) grid[7]![8] = bit;
    else if (i === 7) grid[8]![8] = bit;
    else if (i === 8) grid[8]![7] = bit;
    else grid[8]![14 - i] = bit;
    // 2つ目：右上（行8）と左下（列8）に同じものを置く
    if (i < 8) grid[8]![n - 1 - i] = bit;
    else grid[n - 15 + i]![8] = bit;
  }
}

// --- データの並べ方 ---------------------------------------------------------------

/** 機能パターンを置いたあとに残っている、データを書ける場所の数 */
function freeModules(grid: Grid): number {
  let n = 0;
  for (const row of grid) for (const cell of row) if (cell === -1) n++;
  return n;
}

/** 右下から上下に折り返しながら、2列ずつデータを書く */
function placeData(grid: Grid, bits: Uint8Array): void {
  const n = grid.length;
  let i = 0;
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // タイミングパターンの列は飛ばす
    for (let step = 0; step < n; step++) {
      const y = upward ? n - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (grid[y]![x] !== -1) continue;
        grid[y]![x] = (i < bits.length ? bits[i]! : 0) as 0 | 1;
        i++;
      }
    }
    upward = !upward;
  }
}

const MASKS: Array<(y: number, x: number) => boolean> = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (_, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

/** 読み取りにくさの点数（低いほどよい） */
function penalty(grid: Grid): number {
  const n = grid.length;
  let score = 0;

  // 1. 同じ色が5つ以上続く
  const runs = (get: (a: number, b: number) => number) => {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  };
  runs((y, x) => grid[y]![x]!);
  runs((x, y) => grid[y]![x]!);

  // 2. 同じ色の 2×2
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = grid[y]![x]!;
      if (v === grid[y]![x + 1] && v === grid[y + 1]![x] && v === grid[y + 1]![x + 1]) score += 3;
    }
  }

  // 3. 位置検出パターンに似た並び（1011101 の前後に白4つ）
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  const matches = (line: number[], at: number): boolean => {
    for (let i = 0; i < 7; i++) if (line[at + i] !== pattern[i]) return false;
    const before = line.slice(Math.max(0, at - 4), at);
    const after = line.slice(at + 7, at + 11);
    const quietBefore = before.length === 4 && before.every((v) => v === 0);
    const quietAfter = after.length === 4 && after.every((v) => v === 0);
    return quietBefore || quietAfter;
  };
  for (let a = 0; a < n; a++) {
    const row = Array.from({ length: n }, (_, b) => grid[a]![b]!);
    const col = Array.from({ length: n }, (_, b) => grid[b]![a]!);
    for (let at = 0; at + 7 <= n; at++) {
      if (matches(row, at)) score += 40;
      if (matches(col, at)) score += 40;
    }
  }

  // 4. 黒の割合が半分から離れている
  let dark = 0;
  for (const row of grid) for (const cell of row) if (cell === 1) dark++;
  const percent = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

// --- まとめ ----------------------------------------------------------------------

/** 型番ごとの、データに使える符号の数 */
function capacity(version: number): { total: number; data: number; ecPerBlock: number; blocks: number; remainderBits: number } {
  const grid = blankGrid(version);
  placeFunctionPatterns(grid, version);
  const free = freeModules(grid);
  const total = Math.floor(free / 8);
  const [ecPerBlock, blocks] = EC_M[version - 1]!;
  return { total, data: total - ecPerBlock * blocks, ecPerBlock, blocks, remainderBits: free % 8 };
}

/** その文字数が入るいちばん小さい型番 */
function chooseVersion(byteLength: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (capacity(v).data * 8 >= 4 + countBits + byteLength * 8) return v;
  }
  throw new Error('QRコードに収まりません');
}

/** データをビット列にする（モード・文字数・中身・終端・埋め草） */
function encodeData(bytes: Uint8Array, version: number): Uint8Array {
  const { data: dataCodewords } = capacity(version);
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // バイトモード
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCodewords * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // 終端
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(dataCodewords);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    out[i / 8] = byte;
  }
  // 残りは 0xEC と 0x11 を交互に詰める
  for (let i = bits.length / 8, k = 0; i < dataCodewords; i++, k++) out[i] = k % 2 === 0 ? 0xec : 0x11;
  return out;
}

/** ブロックに分けて誤り訂正符号を付け、交互に並べ直す */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const { ecPerBlock, blocks } = capacity(version);
  const shortLength = Math.floor(data.length / blocks);
  const longBlocks = data.length % blocks; // 1符号だけ長いブロックの数（後ろに置く）

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let at = 0;
  for (let i = 0; i < blocks; i++) {
    const length = shortLength + (i >= blocks - longBlocks ? 1 : 0);
    const block = data.subarray(at, at + length);
    at += length;
    dataBlocks.push(block);
    ecBlocks.push(errorCorrection(block, ecPerBlock));
  }

  const out: number[] = [];
  for (let i = 0; i < shortLength + 1; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return Uint8Array.from(out);
}

export interface QrCode {
  version: number;
  size: number;
  /** modules[y][x] が true なら黒 */
  modules: boolean[][];
}

/** 文字列から QR コードを作る */
export function encodeQr(text: string): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const codewords = interleave(encodeData(bytes, version), version);

  const bits = new Uint8Array(codewords.length * 8 + capacity(version).remainderBits);
  for (let i = 0; i < codewords.length; i++) {
    for (let j = 0; j < 8; j++) bits[i * 8 + j] = (codewords[i]! >> (7 - j)) & 1;
  }

  const base = blankGrid(version);
  placeFunctionPatterns(base, version);
  const dataPlaces = base.map((row) => Array.from(row, (cell) => cell === -1));
  placeData(base, bits);

  // マスクを8通り試して、いちばん読み取りやすいものを選ぶ
  let best: Grid | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = base.map((row) => Int8Array.from(row));
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid.length; x++) {
        if (dataPlaces[y]![x] && MASKS[mask]!(y, x)) grid[y]![x] = (grid[y]![x]! ^ 1) as 0 | 1;
      }
    }
    placeFormat(grid, mask);
    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      best = grid;
    }
  }

  return {
    version,
    size: size(version),
    modules: best!.map((row) => Array.from(row, (cell) => cell === 1)),
  };
}

/**
 * QR コードを SVG にする。印刷しても荒れないよう、モジュールを 1 とした座標で描く。
 * quiet は周りの余白（規格では4モジュール以上）。
 */
export function qrToSvg(qr: QrCode, options: { quiet?: number; label?: string } = {}): string {
  const quiet = options.quiet ?? 4;
  const side = qr.size + quiet * 2;
  const path: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y]![x]) path.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }
  const title = options.label ? `<title>${options.label.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img">`
    + `${title}<rect width="${side}" height="${side}" fill="#fff"/>`
    + `<path d="${path.join('')}" fill="#000"/></svg>`;
}
