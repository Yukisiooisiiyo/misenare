// カメラの画から JAN（EAN-13 / EAN-8）を読む。
//
// Android の Chrome などは BarcodeDetector を持っているが、iPhone の Safari には無い。
// 売場で使うのは iPhone が多いので、同じことを自前でやる：
//   画の横1本（走査線）を白黒に分け、黒と白の幅の並びから数字を読む。
//   手ぶれ・傾き・照明のむらがあるので、何本もの線で試し、チェックデジットが合ったものだけ採る。
// 外部のライブラリは使わない（アプリを重くしない・外から読み込まない）。

/** 左側の奇数パリティ（L）。7モジュールを 白-黒-白-黒 の幅で表す */
const L_CODES: ReadonlyArray<readonly [number, number, number, number]> = [
  [3, 2, 1, 1], [2, 2, 2, 1], [2, 1, 2, 2], [1, 4, 1, 1], [1, 1, 3, 2],
  [1, 2, 3, 1], [1, 1, 1, 4], [1, 3, 1, 2], [1, 2, 1, 3], [3, 1, 1, 2],
];
/** 先頭の1桁は、左6桁の L / G の並びで表される（1 = G） */
const FIRST_DIGIT = ['000000', '001011', '001101', '001110', '010011', '011001', '011100', '010101', '010110', '011010'];

/** 1桁ぶんの4本の幅を、型と見比べる。いちばん近い数字と、そのずれ（小さいほど確か）を返す */
function matchDigit(runs: readonly number[], at: number, allowG: boolean): { digit: number; parity: 0 | 1; error: number } | null {
  const total = runs[at]! + runs[at + 1]! + runs[at + 2]! + runs[at + 3]!;
  if (total <= 0) return null;
  const unit = total / 7;
  let best: { digit: number; parity: 0 | 1; error: number } | null = null;
  for (let d = 0; d < 10; d++) {
    const code = L_CODES[d]!;
    for (let parity = 0 as 0 | 1; parity <= (allowG ? 1 : 0); parity = (parity + 1) as 0 | 1) {
      let error = 0;
      for (let i = 0; i < 4; i++) {
        // G は L を左右逆にした形。右側（R）は L の白黒を入れ替えた形で、幅の並びは L と同じ
        const want = parity === 1 ? code[3 - i]! : code[i]!;
        error += Math.abs(runs[at + i]! / unit - want);
      }
      if (!best || error < best.error) best = { digit: d, parity, error };
    }
  }
  return best && best.error < 1.5 ? best : null;
}

/** ガード（細い線の並び）らしいか：n 本の幅がほぼそろっている */
function even(runs: readonly number[], at: number, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += runs[at + i]!;
  const unit = sum / n;
  for (let i = 0; i < n; i++) if (Math.abs(runs[at + i]! - unit) > unit * 0.7) return 0;
  return unit;
}

export function checkDigitOk(code: string): boolean {
  if (!/^(\d{8}|\d{13})$/.test(code)) return false;
  let sum = 0;
  const digits = [...code].map(Number);
  // 右端（チェックデジット）の隣から、3・1・3… と掛ける
  for (let i = digits.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += digits[i]! * w;
  return (10 - (sum % 10)) % 10 === digits[digits.length - 1];
}

/**
 * 黒白の幅の並びから読む。runs[0] は白（余白）で、以後 黒・白 が交互に来る前提。
 * 見つからなければ null。
 */
export function decodeRuns(runs: readonly number[]): string | null {
  // 黒から始まる位置（奇数番目）を、開始のガードの候補として順に試す
  for (let start = 1; start + 3 + 24 + 5 + 24 + 3 <= runs.length + 24; start += 2) {
    const unit = even(runs, start, 3);
    if (!unit) continue;
    // ガードの手前に、十分な余白があること（模様の途中から読み始めない）
    if (runs[start - 1]! < unit * 3) continue;
    for (const half of [6, 4]) {
      const need = 3 + half * 4 + 5 + half * 4 + 3;
      if (start + need > runs.length) continue;
      let at = start + 3;
      let digits = '';
      let parities = '';
      let total = 0;
      let ok = true;
      for (let i = 0; i < half && ok; i++, at += 4) {
        const m = matchDigit(runs, at, half === 6);
        if (!m) { ok = false; break; }
        digits += m.digit; parities += m.parity; total += m.error;
      }
      if (!ok) continue;
      const mid = even(runs, at, 5);
      if (!mid || Math.abs(mid - unit) > unit * 0.6) continue;
      at += 5;
      for (let i = 0; i < half && ok; i++, at += 4) {
        const m = matchDigit(runs, at, false);
        if (!m) { ok = false; break; }
        digits += m.digit; total += m.error;
      }
      if (!ok) continue;
      const end = even(runs, at, 3);
      if (!end || Math.abs(end - unit) > unit * 0.6) continue;
      // 1桁ずつは通っても、全体としてずれが大きいものは、たまたま形が似ただけの模様
      if (total / (half * 2) > 0.8) continue;
      let code = digits;
      if (half === 6) {
        const first = FIRST_DIGIT.indexOf(parities);
        if (first < 0) continue;
        code = `${first}${digits}`;
      }
      if (checkDigitOk(code)) return code;
    }
  }
  return null;
}

/** 明るさの1列を、黒と白の幅の並びにする。照明のむらに合わせて、近くの平均と比べて白黒を決める */
export function toRuns(line: ArrayLike<number>): number[] {
  const n = line.length;
  const radius = Math.max(8, Math.round(n / 12));
  // 近くの平均（左右 radius ぶん）を、足し込みで速く求める
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + line[i]!;
  let min = 255, max = 0;
  for (let i = 0; i < n; i++) { const v = line[i]!; if (v < min) min = v; if (v > max) max = v; }
  if (max - min < 40) return []; // のっぺりした線（バーコードが写っていない）
  const runs: number[] = [];
  let dark = false; // 白から始める
  let length = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(n, i + radius + 1);
    const local = (prefix[b]! - prefix[a]!) / (b - a);
    // 近くの平均と、線全体のまんなかの間を取る（広い余白の中でも、細い線を拾える）
    const threshold = (local + (min + max) / 2) / 2 - 4;
    const isDark = line[i]! < threshold;
    if (isDark === dark) { length += 1; } else { runs.push(length); dark = isDark; length = 1; }
  }
  runs.push(length);
  return runs;
}

/** 明るさの1列から読む。逆さに写っていることもあるので、左右どちらからも試す */
export function decodeLine(line: ArrayLike<number>): string | null {
  const runs = toRuns(line);
  if (runs.length < 3 + 16 + 5 + 16 + 3 + 1) return null;
  const forward = decodeRuns(runs);
  if (forward) return forward;
  const reversed = [...runs].reverse();
  // 逆にしたとき、先頭が白になるようにそろえる（末尾が黒で終わっていたら、幅0の白を足す）
  if (runs.length % 2 === 0) reversed.unshift(0);
  return decodeRuns(reversed);
}

/**
 * 画（RGBA）から読む。まんなかの帯に何本か横線を引いて、読めたものを返す。
 * rows は試す本数。多いほど拾いやすいが、1コマにかかる時間が延びる。
 */
export function decodeImage(image: { data: ArrayLike<number>; width: number; height: number }, rows = 15): string | null {
  const { data, width, height } = image;
  const line = new Uint8Array(width);
  for (let r = 0; r < rows; r++) {
    // 上下 20% は捨て、まんなかから外へ向かって試す
    const offset = ((r % 2 === 0 ? 1 : -1) * Math.ceil(r / 2)) / rows;
    const y = Math.min(height - 2, Math.max(1, Math.round(height * (0.5 + offset * 0.6))));
    for (let x = 0; x < width; x++) {
      // 上下3行をならして、印刷のかすれや画のざらつきを抑える
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const p = ((y + dy) * width + x) * 4;
        sum += data[p]! * 0.299 + data[p + 1]! * 0.587 + data[p + 2]! * 0.114;
      }
      line[x] = sum / 3;
    }
    const code = decodeLine(line);
    if (code) return code;
  }
  return null;
}
