// かな・ローマ字の変換。タグ候補を「てれ」「tere」でも引けるようにするために使う。

const HIRA_START = 0x3041;
const HIRA_END = 0x3096;
const KATA_OFFSET = 0x60;

export function hiraToKata(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += code >= HIRA_START && code <= HIRA_END ? String.fromCodePoint(code + KATA_OFFSET) : ch;
  }
  return out;
}

export function kataToHira(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const shifted = code - KATA_OFFSET;
    out += shifted >= HIRA_START && shifted <= HIRA_END ? String.fromCodePoint(shifted) : ch;
  }
  return out;
}

// ヘボン式・訓令式の主な綴りに対応したローマ字 → カタカナ表。長い綴りから順に照合する。
const ROMAJI: Record<string, string> = {
  kya: 'キャ', kyu: 'キュ', kyo: 'キョ', sha: 'シャ', shu: 'シュ', sho: 'ショ', she: 'シェ',
  sya: 'シャ', syu: 'シュ', syo: 'ショ', cha: 'チャ', chu: 'チュ', cho: 'チョ', che: 'チェ',
  tya: 'チャ', tyu: 'チュ', tyo: 'チョ', nya: 'ニャ', nyu: 'ニュ', nyo: 'ニョ', hya: 'ヒャ',
  hyu: 'ヒュ', hyo: 'ヒョ', mya: 'ミャ', myu: 'ミュ', myo: 'ミョ', rya: 'リャ', ryu: 'リュ',
  ryo: 'リョ', gya: 'ギャ', gyu: 'ギュ', gyo: 'ギョ', ja: 'ジャ', ju: 'ジュ', jo: 'ジョ', je: 'ジェ',
  zya: 'ジャ', zyu: 'ジュ', zyo: 'ジョ', bya: 'ビャ', byu: 'ビュ', byo: 'ビョ', pya: 'ピャ',
  pyu: 'ピュ', pyo: 'ピョ', shi: 'シ', chi: 'チ', tsu: 'ツ', thi: 'ティ', dhi: 'ディ', fa: 'ファ',
  fi: 'フィ', fe: 'フェ', fo: 'フォ', vu: 'ヴ', ka: 'カ', ki: 'キ', ku: 'ク', ke: 'ケ', ko: 'コ',
  sa: 'サ', si: 'シ', su: 'ス', se: 'セ', so: 'ソ', ta: 'タ', ti: 'チ', tu: 'ツ', te: 'テ', to: 'ト',
  na: 'ナ', ni: 'ニ', nu: 'ヌ', ne: 'ネ', no: 'ノ', ha: 'ハ', hi: 'ヒ', fu: 'フ', hu: 'フ', he: 'ヘ',
  ho: 'ホ', ma: 'マ', mi: 'ミ', mu: 'ム', me: 'メ', mo: 'モ', ya: 'ヤ', yu: 'ユ', yo: 'ヨ',
  ra: 'ラ', ri: 'リ', ru: 'ル', re: 'レ', ro: 'ロ', wa: 'ワ', wo: 'ヲ', ga: 'ガ', gi: 'ギ', gu: 'グ',
  ge: 'ゲ', go: 'ゴ', za: 'ザ', zi: 'ジ', ji: 'ジ', zu: 'ズ', ze: 'ゼ', zo: 'ゾ', da: 'ダ', di: 'ヂ',
  du: 'ヅ', de: 'デ', do: 'ド', ba: 'バ', bi: 'ビ', bu: 'ブ', be: 'ベ', bo: 'ボ', pa: 'パ', pi: 'ピ',
  pu: 'プ', pe: 'ペ', po: 'ポ', va: 'ヴァ', vi: 'ヴィ', ve: 'ヴェ', vo: 'ヴォ', a: 'ア', i: 'イ',
  u: 'ウ', e: 'エ', o: 'オ', '-': 'ー',
};
const ROMAJI_KEYS = Object.keys(ROMAJI).sort((a, b) => b.length - a.length);

/**
 * ローマ字をカタカナに変換する。変換できない末尾（入力途中の子音など）は
 * `rest` として返すので、前方一致の候補探しで「途中まで」として扱える。
 */
export function romajiToKata(input: string): { kana: string; rest: string } {
  const s = input.toLowerCase();
  let kana = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    const next = s[i + 1];
    // 促音：同じ子音が続く（kk, tt, ss …）
    if (next !== undefined && ch === next && /[bcdfghjklmpqrstvwxyz]/.test(ch) && ch !== 'n') {
      kana += 'ッ';
      i += 1;
      continue;
    }
    // 撥音：n の後が母音・y でない、または nn
    if (ch === 'n') {
      if (next === 'n') { kana += 'ン'; i += 2; continue; }
      if (next !== undefined && !/[aiueoy]/.test(next)) { kana += 'ン'; i += 1; continue; }
    }
    const key = ROMAJI_KEYS.find((k) => s.startsWith(k, i));
    if (key === undefined) break;
    kana += ROMAJI[key]!;
    i += key.length;
  }
  return { kana, rest: s.slice(i) };
}

/** タグ候補の照合用に、入力をカタカナの「読み」の形に寄せる。 */
export function toReadingKey(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z\-]+$/i.test(trimmed)) return romajiToKata(trimmed).kana;
  return hiraToKata(trimmed);
}
