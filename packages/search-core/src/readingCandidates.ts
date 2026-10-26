// 語の読みの候補を、漢字の読みの総当たりで作る。
//
// 狙いは「当てる」ことではなく「**選べるようにする**」こと。
// 人が選ぶなら1位が当たっている必要はなく、候補に入っていればよい。
// だから並べ替えを外しても害がなく、総当たりの弱点（決め手が無い）が消える。
//
// 絞り方は辞書引きではなく、日本語の複合語の規則。根拠は4つだけ：
//
//   1. 音読みどうし・訓読みどうしで揃うのが普通。混ざる（重箱・湯桶読み）のは稀。
//        食洗機 → ショク+セン+キ（音音音）… 普通
//               → ショク+アライ+キ（音訓音）… 重箱読み＝稀
//   2. 漢字だけが並ぶ語は、音読みで揃うほうが多数派（漢語）。
//        室外機 → シツガイキ（○）／ ムロソトハタ（×）
//   3. 送り仮名が付いている漢字は訓読み。しかも送り仮名は読みの末尾と重なる。
//        前出し → マエ+ダシ（「し」が「ダシ」の末尾と重なる）
//   4. 送り仮名が要る形（動詞の語幹）は、複合語の途中に裸では出てこない。
//        据付 → スエ+ツケ（連用形）… 普通
//             → ス+ツ（語幹のまま）… 語にならない
//
// 連濁・促音便は「起きた形」も「起きない形」も両方出す。どちらが正しいかは
// 決めない（下取＝シタドリ／シタトリ）。並べ替えでは起きない形をわずかに上に置く。

import { hiraToKata } from './kana.ts';
import { handakuAfterSokuon, type KanjiReading, kanjiReadings, rendakuForms, sokuonForm } from './kanjiReadings.ts';

/**
 * 総当たりの打ち切り。これを超えないよう、使う読みを順位の低い方から削る。
 * 連濁・促音便のぶん、実際に作る文字列はこの3倍ほどになる。
 * 漢字が4字以上で読みの多い語（空気清浄機、取扱説明書）がいちばん重く、1語 55ms ほど。
 * タグを作る瞬間に1回走るだけなので、これで足りる。
 */
const MAX_COMBINATIONS = 2500;

const isKanji = (ch: string): boolean => /\p{Script=Han}/u.test(ch);
const HIRAGANA_ONLY = /^[\u3041-\u3096]+$/;

interface Option {
  reading: string;
  type: 'on' | 'kun' | 'kana';
  /** 同じ種類（音／訓）の中での並び順。前のものほどよく使う読み */
  rank: number;
  /** 送り仮名が要る形（動詞・形容詞の語幹）か */
  stem: boolean;
  /** 送り仮名が読みの末尾と重なっていた（引き → ヒキ の「キ」） */
  absorbed: boolean;
  /** 規則で濁らせた形（連濁）か */
  voiced: boolean;
  /** 前の語の末尾を詰めた形（促音便）か */
  squeezed: boolean;
}

interface Part {
  options: Option[];
  /** 直後にかな（送り仮名）が続く漢字か */
  beforeKana: boolean;
}

/**
 * 読み方の種類。日本語の複合語は、この4通りのどれかになる。
 *   on     音読みで揃う      冷蔵庫＝レイゾウコ
 *   kun    訓読みで揃う      棚卸＝タナオロシ
 *   jubako 重箱読み（音→訓） 両替＝リョウガエ、台所＝ダイドコロ
 *   yutou  湯桶読み（訓→音） 釣銭＝ツリセン、見本＝ミホン
 * 重箱読みと湯桶読みを分けて数えるのは、どちらも稀でありながら
 * 別の現象で、片方が出ていても他方が出たことにはならないため。
 */
type Kind = 'on' | 'kun' | 'jubako' | 'yutou';

function kindOf(chosen: readonly Option[]): Kind {
  let on = false; let kun = false; let first: 'on' | 'kun' | null = null;
  for (const c of chosen) {
    if (c.type === 'on') { on = true; first ??= 'on'; }
    else if (c.type === 'kun') { kun = true; first ??= 'kun'; }
  }
  if (on && kun) return first === 'on' ? 'jubako' : 'yutou';
  return kun ? 'kun' : 'on';
}

/** 濁点・半濁点・促音を外した形。濁点ちがいの候補を同じものと見るための鍵。 */
const UNVOICE: Readonly<Record<string, string>> = {
  ガ: 'カ', ギ: 'キ', グ: 'ク', ゲ: 'ケ', ゴ: 'コ',
  ザ: 'サ', ジ: 'シ', ズ: 'ス', ゼ: 'セ', ゾ: 'ソ',
  ダ: 'タ', ヂ: 'チ', ヅ: 'ツ', デ: 'テ', ド: 'ト',
  バ: 'ハ', ビ: 'ヒ', ブ: 'フ', ベ: 'ヘ', ボ: 'ホ',
  パ: 'ハ', ピ: 'ヒ', プ: 'フ', ペ: 'ヘ', ポ: 'ホ',
  ッ: '',
};
function unvoice(reading: string): string {
  let out = '';
  for (const ch of reading) out += UNVOICE[ch] ?? ch;
  return out;
}

/** 語を、漢字1文字ずつと、かなのまとまりに分ける */
function split(word: string, table: ReadonlyMap<string, KanjiReading>): Part[] | null {
  const chars = [...word];
  const parts: Part[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (!isKanji(ch)) {
      // かなはそのまま（カタカナに寄せる）。続くかなはまとめる。
      let run = '';
      while (i < chars.length && !isKanji(chars[i]!)) { run += chars[i]!; i++; }
      i--;
      parts.push({
        options: [{ reading: hiraToKata(run), type: 'kana', rank: 0, stem: false, absorbed: false, voiced: false, squeezed: false }],
        beforeKana: false,
      });
      continue;
    }
    const entry = table.get(ch);
    if (!entry) return null; // 表に無い漢字がある語は、候補を作らない

    // 送り仮名が続くなら、読みにその仮名が含まれている形（ヒキ＋き）は
    // 重ねずに読みだけを採る。重ねると「ヒキキ」になる。
    let run = '';
    for (let j = i + 1; j < chars.length && !isKanji(chars[j]!); j++) run += chars[j]!;
    // 送り仮名はひらがなで書く。カタカナが続くのは別の語（電子レンジ の「レンジ」）なので、
    // 送り仮名として扱うと「子」を訓読みに引っ張ってしまう。
    const beforeKana = run !== '' && HIRAGANA_ONLY.test(run);
    const okurigana = beforeKana ? hiraToKata(run) : '';

    // 順位は音・訓それぞれの中で付ける。まとめて通し番号にすると、
    // 表が音読みを先に並べているせいで、訓読みが常に不利になる。
    const options: Option[] = [];
    const add = (reading: string, type: 'on' | 'kun', rank: number, stem: boolean): void => {
      const absorbed = okurigana !== '' && reading.endsWith(okurigana) && reading.length > okurigana.length;
      options.push({
        reading: absorbed ? reading.slice(0, -okurigana.length) : reading,
        type, rank, stem, absorbed, voiced: false, squeezed: false,
      });
    };
    for (const [rank, reading] of entry.on.entries()) add(reading, 'on', rank, false);
    for (const [rank, k] of entry.kun.entries()) add(k.reading, 'kun', rank, k.stem);
    if (options.length === 0) return null;
    parts.push({ options, beforeKana });
  }
  return parts;
}

/**
 * 総当たりが大きくなりすぎないよう、順位の低い（＝あまり使わない）読みから削る。
 * 削るのは常に「いま一番読みの多い漢字」の最後の1つ。よく使う読みは最後まで残る。
 */
function trim(parts: Part[]): void {
  const size = (): number => parts.reduce((n, p) => n * p.options.length, 1);
  while (size() > MAX_COMBINATIONS) {
    let widest = parts[0]!;
    for (const p of parts) if (p.options.length > widest.options.length) widest = p;
    if (widest.options.length <= 1) return;
    widest.options.pop();
  }
}

/**
 * 組合せの点数。高いほど上に出す。
 * 当てにいく点数ではなく、**人が目で探しやすい順**にするための点数。
 */
function score(chosen: Option[], parts: Part[]): number {
  let s = 0;
  const kanji = chosen.filter((c) => c.type !== 'kana');
  // 送り仮名が付く漢字は訓読みと決まっているので、「揃っているか」の判定からは外す。
  // 真空引き は 真空（音）＋引き（訓）で、混ざっているのが普通の形。
  const free = chosen.filter((c, i) => c.type !== 'kana' && !parts[i]!.beforeKana);

  // 1. 音どうし・訓どうしで揃っているか。
  //    送り仮名の付かない漢字が2つ以上あればそこで見る（真空／引き）。
  //    1つ以下なら見る材料が無いので、語全体で見る（売り＋場 は和語で揃う）。
  const group = free.length > 1 ? free : kanji;
  if (group.length > 1) {
    const allSame = group.every((k) => k.type === group[0]!.type);
    s += allSame ? 6 : 0;
    // 混ざる読み（重箱読み・湯桶読み）は稀だが、売場の言葉には実際にある
    // （型番＝カタバン、不具合＝フグアイ、両替＝リョウガエ）。
    // 強く罰すると候補の5件から押し出されるので、揺らぎの範囲に収める。
    for (let i = 1; i < group.length; i++) if (group[i]!.type !== group[i - 1]!.type) s -= 1.5;
    // 2. 漢字だけが並ぶ語は、音読みで揃うほうが多数派（漢語）。
    //    送り仮名が混じる語は和語なので、この加点はしない。
    if (allSame && group === free && free[0]!.type === 'on') s += 1;
  }

  for (const [i, part] of parts.entries()) {
    const c = chosen[i]!;
    if (c.type === 'kana') continue;
    if (part.beforeKana) {
      // 3. 送り仮名が付く漢字は訓読み。送り仮名と読みの末尾が重なるのが普通
      s += c.type === 'kun' ? 3 : -3;
      if (c.absorbed) s += 2;
    } else if (kanji.length > 1 && c.stem) {
      // 4. 送り仮名が要る形が、複合語の途中に裸で出てくるのは珍しい
      s -= 2.5;
    }
    // よく使う読みを上に（表の並び順）
    s -= c.rank * 0.6;
    // 濁る形は、濁らない形のすぐ下に置く。どちらも候補には残す。
    if (c.voiced) s -= 0.3;
    // 詰まる形は、詰まらない形のすぐ下に置く。どちらも候補には残す。
    // 詰まる語（発注＝ハッチュウ）と詰まらない語（食洗機＝ショクセンキ）は
    // 読みの形だけでは見分けられない。数を数えると、詰まらない語のほうが多い。
    if (c.squeezed) s -= 0.2;
  }
  return s;
}

/**
 * 読みの候補を、確からしい順に返す。
 * 表に無い漢字が混ざる語では空を返す（そのときは候補を出さず、入力欄だけ見せる）。
 */
export function readingCandidates(word: string, limit = 5): string[] {
  const parts = split(word.trim(), kanjiReadings());
  if (parts === null || parts.length === 0) return [];
  trim(parts);

  // 候補は「読み方の種類」ごとに分けて持つ。音読みで揃う形・訓読みで揃う形・
  // 混ざる形の3通りで、どれになるかは語によって違い、こちらからは決められない。
  // 枠を種類ごとに回せば、3通りのどれかに当たりがある語を取りこぼさない。
  const best = new Map<string, { score: number; kind: Kind }>();
  const chosen: Option[] = [];
  // 前の語の末尾が決まらないと促音便（ハツ＋チュウ → ハッチュウ）を決められないので、
  // 組み立てながら音を変えていく。変えた形も変えない形も残す。
  const walk = (i: number, text: string): void => {
    if (i === parts.length) {
      const s = score(chosen, parts);
      const prev = best.get(text);
      if (prev === undefined || prev.score < s) best.set(text, { score: s, kind: kindOf(chosen) });
      return;
    }
    const part = parts[i]!;
    for (const o of part.options) {
      // 連濁は訓読み（和語）の頭で起きる。
      //   * 音読みの連濁（会社→ガイシャ）は稀なので起こさない。起こすと濁った空振りが
      //     枠を食い尽くす（下取 で カジュ・ゲジュ が並び、シタドリ が押し出された）。
      //   * 送り仮名やカタカナ語の部分も濁らせない。「値引き」の「き」を濁らせて
      //     ネヒギ を作っても意味がなく、ネビキ を押し出すだけだった。
      const forms: Option[] = i === 0 || o.type !== 'kun'
        ? [o]
        : [o, ...rendakuForms(o.reading).map((reading) => ({ ...o, reading, voiced: true }))];
      for (const form of forms) {
        // 促音・撥音のあとのハ行は半濁る（イッ＋ホン → イッポン）
        const handaku = handakuAfterSokuon(text, form.reading);
        const heads = handaku === null ? [form.reading] : [handaku, form.reading];
        for (const head of heads) {
          // 前の語の末尾が詰まる形（促音便）も試す。漢語で起きる現象なので、
          // 次が音読みのときだけ（ハツ＋チュウ → ハッチュウ）。訓読みの前で詰めると
          // 「イッカッハライ」のような形まで作ってしまう。
          // さらに語頭の境目だけに限る。詰まるのは語の中の最初の継ぎ目で、
          // 後ろに付く字（洗濯＋機、空気清浄＋機）の前では詰まらない。
          const squeezed = i === 1 && form.type === 'on' ? sokuonForm(text, head) : null;
          for (const base of squeezed === null ? [text] : [squeezed, text]) {
            chosen.push(squeezed !== null && base === squeezed ? { ...form, squeezed: true } : form);
            walk(i + 1, base + head);
            chosen.pop();
          }
        }
      }
    }
  };
  walk(0, '');

  // 採り方は3つの決まりで絞る。どれも「5つの枠を無駄にしない」ための工夫。
  //
  // 1. 基本は点数の高い順。
  // 2. 同じ骨組みの濁点ちがいは2つまで。そうしないと「カタツガ／カタズガ／
  //    カタヅガ／ガタツガ／ガタズガ」で枠が尽きる（型番の実測）。
  //    2つ残すのは、下取＝シタドリ／シタトリ のように本当に揺れる語があるため。
  // 3. 最後の1枠は、出ていない読み方の種類に空けておく。
  //    音で揃う・訓で揃う・重箱読み・湯桶読みの4通りのうち、どれになるかは
  //    語によって違い、こちらからは決められない。点数順に5つ採ると上位の種類で
  //    埋まり、混ざる読み（型番＝カタバン、釣銭＝ツリセン）が落ちる。稀だが
  //    売場の言葉には実際にある。
  const sorted = [...best.entries()]
    .map(([reading, v]) => ({ reading, ...v }))
    .sort((a, b) => b.score - a.score || a.reading.length - b.reading.length || a.reading.localeCompare(b.reading));

  const perSkeleton = new Map<string, number>();
  const picked: Array<{ reading: string; kind: Kind }> = [];
  for (const c of sorted) {
    if (picked.length >= limit) break;
    const skeleton = unvoice(c.reading);
    const n = perSkeleton.get(skeleton) ?? 0;
    if (n >= 2) continue;
    perSkeleton.set(skeleton, n + 1);
    picked.push(c);
  }

  // 出ていない種類があれば、その種類のいちばん良い候補と最下位を入れ替える。
  // 枠が2つ以下のときはしない（確からしい順に出すのが先。1件だけ求められた
  // ときに、わざわざ稀な読み方に差し替えては意味が反転する）。
  if (limit >= 3 && picked.length === limit) {
    const shown = new Set(picked.map((c) => c.kind));
    const missing = sorted.find((c) => !shown.has(c.kind));
    if (missing !== undefined) picked.splice(limit - 1, 1, missing);
  }
  return picked.map((c) => c.reading);
}

