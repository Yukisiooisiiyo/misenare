// 漢字1文字ごとの読み。生成した表を読み、**規則で読みを増やす**。
//
// 表そのものは kanjiReadings.generated.ts（KANJIDIC2 から機械で作る）。
// 表には出典どおりの形しか入っていない。たとえば「据」は「ス.エル」だけで、
// 据付＝スエツケ の「スエ」は入っていない。「スエ」は連用形で、送り仮名から
// 規則で起こせる。
//
// 規則にする理由：表に変形まで書き込むと、出典を取り直すたびに消える。
// 規則なら残る。足したい変形が増えても、表の形を変えずに済む。
//
//   連用形 ス.エル → スエ、オロ.ス → オロシ、ト.ル → トリ
//          （和語の複合名詞に出てくるのはこの形：据付、棚卸、下取）
//   連濁   シタ＋トリ → シタドリ、タナ＋オロシ → ダナオロシ
//   促音便 ハツ＋チュウ → ハッチュウ
//   半濁音 イッ＋ホン → イッポン

import { KANJI_READINGS_RAW } from './kanjiReadings.generated.ts';

export interface KunReading {
  reading: string;
  /**
   * 送り仮名が要る形（動詞・形容詞の語幹）か。
   * 「ス」（す.える）は単独では語にならないので、複合語の途中に裸で出てくるのは珍しい。
   * 「スエ」（連用形）や「タナ」（名詞）は裸で出てくる。この違いで候補の順番が決まる。
   */
  stem: boolean;
}

export interface KanjiReading {
  on: readonly string[];
  kun: readonly KunReading[];
}

/** ウ段 → イ段。五段動詞の連用形を作る（オロ.ス → オロシ） */
const RENYOU_GODAN: Readonly<Record<string, string>> = {
  ウ: 'イ', ク: 'キ', グ: 'ギ', ス: 'シ', ズ: 'ジ', ツ: 'チ',
  ヅ: 'ヂ', ヌ: 'ニ', フ: 'ヒ', ブ: 'ビ', プ: 'ピ', ム: 'ミ', ル: 'リ',
};
/** イ段・エ段。ここで終わる語幹に「ル」が付くのは一段動詞（デ.ル → デ） */
const ICHIDAN_TAIL = /[イキギシジチヂニヒビピミリエケゲセゼテデネヘベペメレ]$/;

/**
 * 送り仮名から連用形を起こす。起こせないときは null。
 *
 *   ス.エル   一段  → スエ      （送り仮名の「ル」を落とす）
 *   オロ.ス   五段  → オロシ    （ウ段をイ段に変える）
 *   ト.ル     五段  → トリ      （語幹の末尾がイ段・エ段でないので五段）
 *   デ.ル     一段  → デ        （語幹と同じ形。重複は呼ぶ側で畳む）
 *   ト.リ     変形なし → null   （送り仮名が活用語尾ではない。表の形がすでに語）
 */
function renyou(stem: string, okurigana: string): string | null {
  if (stem === '' || okurigana === '') return null;
  const tail = okurigana.at(-1)!;
  const head = okurigana.slice(0, -1);
  if (tail === 'ル') {
    // 「ル」の直前（送り仮名が1文字なら語幹の末尾）がイ段・エ段なら一段動詞
    const before = head === '' ? stem : head;
    if (ICHIDAN_TAIL.test(before)) return stem + head;
    return `${stem + head}リ`;
  }
  const changed = RENYOU_GODAN[tail];
  if (changed === undefined) return null; // イ形容詞や、すでに語の形（ト.リ）
  return stem + head + changed;
}

/**
 * 表の文字列を読む。形は「漢字:音,音|訓.送り,訓」を「;」でつないだもの。
 * 送り仮名つきの訓読みからは、語幹と連用形の2つを起こす。
 * 試験のために外に出してある（出典を取り直さずに規則だけを確かめられる）。
 */
export function parseKanjiReadings(raw: string): Map<string, KanjiReading> {
  const out = new Map<string, KanjiReading>();
  for (const entry of raw.split(';')) {
    const colon = entry.indexOf(':');
    if (colon < 0) continue;
    const [onPart, kunPart] = entry.slice(colon + 1).split('|');
    const kun: KunReading[] = [];
    const seen = new Map<string, number>();
    const push = (reading: string, stem: boolean): void => {
      const at = seen.get(reading);
      if (at === undefined) {
        seen.set(reading, kun.length);
        kun.push({ reading, stem });
        return;
      }
      // 同じ形が語幹としても連用形としても出たら、連用形（裸で使える）を採る
      if (!stem) kun[at] = { reading, stem: false };
    };
    for (const raw of (kunPart ?? '').split(',')) {
      if (raw === '') continue;
      const dot = raw.indexOf('.');
      if (dot < 0) { push(raw, false); continue; }
      const stem = raw.slice(0, dot);
      const form = renyou(stem, raw.slice(dot + 1));
      // 一段動詞は連用形が語幹と同じ形（ミ.ル → ミ、デ.ル → デ）。
      // この形は裸で語になる（見積、見本）ので、送り仮名が要る形としては扱わない。
      push(stem, form !== stem);
      // 連用形は語幹のすぐ後ろに置く。順番＝よく使う順なので、離すと埋もれる。
      if (form !== null && form !== stem) push(form, false);
    }
    out.set(entry.slice(0, colon), {
      on: onPart === '' || onPart === undefined ? [] : onPart.split(','),
      kun,
    });
  }
  return out;
}

/**
 * 漢字 → 読み。生成した表に、送り仮名から起こした連用形を足したもの。
 *
 * 初めて呼ばれたときに作る。読み込むだけで作らないのは、**使わない側から
 * 外せるようにする**ため。読みの候補を作るのはサーバーの仕事で、画面側は
 * API から受け取るだけなので、画面の配信物に 83KB の表を混ぜる理由がない。
 * （上から呼び出しを書くと、束ね役が「使っている」と見なして外せなくなる）
 */
let cache: ReadonlyMap<string, KanjiReading> | null = null;
export function kanjiReadings(): ReadonlyMap<string, KanjiReading> {
  cache ??= parseKanjiReadings(KANJI_READINGS_RAW);
  return cache;
}

/** 清音 → 濁音・半濁音。語の2つ目以降で起きる（連濁） */
const RENDAKU: Readonly<Record<string, string[]>> = {
  カ: ['ガ'], キ: ['ギ'], ク: ['グ'], ケ: ['ゲ'], コ: ['ゴ'],
  サ: ['ザ'], シ: ['ジ'], ス: ['ズ'], セ: ['ゼ'], ソ: ['ゾ'],
  タ: ['ダ'], チ: ['ヂ', 'ジ'], ツ: ['ヅ', 'ズ'], テ: ['デ'], ト: ['ド'],
  ハ: ['バ', 'パ'], ヒ: ['ビ', 'ピ'], フ: ['ブ', 'プ'], ヘ: ['ベ', 'ペ'], ホ: ['ボ', 'ポ'],
};

/** ハ行 → 半濁音。促音・撥音のあとで起きる（いっ＋ほん → いっぽん） */
const HANDAKU: Readonly<Record<string, string>> = { ハ: 'パ', ヒ: 'ピ', フ: 'プ', ヘ: 'ペ', ホ: 'ポ' };

/** 促音になりうる末尾。音読みの語が重なるときに詰まる（はつ＋ちゅう → はっちゅう） */
const SOKUON_TAIL = new Set(['ツ', 'チ', 'ク', 'キ']);
/** そのあとに来ると詰まりやすい頭の音 */
const SOKUON_HEAD = /^[カキクケコサシスセソタチツテトハヒフヘホパピプペポ]/;

/** 2つ目以降に来たときの、濁った形（連濁）。無ければ空 */
export function rendakuForms(reading: string): string[] {
  const head = reading[0];
  if (head === undefined) return [];
  return (RENDAKU[head] ?? []).map((v) => v + reading.slice(1));
}

/** 前の語の末尾が詰まる形（促音便）。詰まらないなら null */
export function sokuonForm(prev: string, next: string): string | null {
  const tail = prev.at(-1);
  if (tail === undefined || !SOKUON_TAIL.has(tail) || prev.length < 2) return null;
  if (!SOKUON_HEAD.test(next)) return null;
  return `${prev.slice(0, -1)}ッ`;
}

/** 促音・撥音のあとのハ行が半濁る形。変わらないなら null */
export function handakuAfterSokuon(prev: string, next: string): string | null {
  const tail = prev.at(-1);
  if (tail !== 'ッ' && tail !== 'ン') return null;
  const head = next[0];
  if (head === undefined) return null;
  const changed = HANDAKU[head];
  return changed === undefined ? null : changed + next.slice(1);
}
