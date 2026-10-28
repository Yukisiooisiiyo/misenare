// 既存のマニュアルから、ナレッジの下書きを作る。
//
// 取り込めるもの：
//   .txt / .md   … 見出し（# や ■、行末が「：」だけの行）で区切る
//   .csv / .tsv  … 1行1件。見出し行から「タイトル」「本文」「タグ」の列を探す
//   .docx        … Word の見出しスタイルで区切る
//   .xlsx        … 1行1件（CSV と同じ見方）
//   .pdf         … 文字の大きさで見出しを見分ける（画像だけの PDF は読めない）
//
// 出てくるのは下書きなので、公開するかどうかは人が決める。
// タグは付けない（本文から機械的に拾うと的外れなタグが増えるため）。書いた人が承認時に付ける。

import { ImportError } from './error.ts';
import { readZipEntry } from './zip.ts';
import { readDocument } from './pdfObjects.ts';
import { extractPdfText, isEncrypted, UNREADABLE } from './pdfText.ts';

export interface Draft {
  title: string;
  body: string;
  /** もとの資料のどこから来たか（確認するときの手がかり） */
  source: string;
}

export type ImportFormat = 'text' | 'markdown' | 'csv' | 'tsv' | 'docx' | 'xlsx' | 'pdf';

export interface ParseResult {
  drafts: Draft[];
  /** 読み取りで気づいたこと（読めなかったページなど） */
  warnings: string[];
}

/** 1件あたりの上限（長すぎる塊はそのまま入れず、切って知らせる） */
export const MAX_BODY_CHARS = 4000;
export const MAX_TITLE_CHARS = 100;
/** 1ファイルから作る下書きの上限 */
export const MAX_DRAFTS = 200;

export function formatOf(fileName: string): ImportFormat | undefined {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'txt' || ext === 'text') return 'text';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'csv') return 'csv';
  if (ext === 'tsv') return 'tsv';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'pdf') return 'pdf';
  return undefined;
}

// --- 文字列の下ごしらえ -----------------------------------------------------------

/** BOM と改行コードの違いを吸収する */
function normalizeText(buf: Buffer): string {
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n?/g, '\n');
}

function tidy(s: string): string {
  // 行末の空白は正規表現（`[ \t　]+$`）で消さない。「空白の連続＋空白でない字」の行で
  // 連続の長さの2乗の時間になり、8万個の空白で20秒かかった。trimEnd は行の長さに比例する
  return s.split('\n').map((line) => line.replace(/[　]+$/, '').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 見出しらしい行か。Markdown の #、■ や【】の見出し、「第3章」など */
function headingOf(line: string): string | undefined {
  const t = line.trim();
  if (!t) return undefined;
  const md = /^(#{1,6})\s+(.+)$/.exec(t);
  if (md) return md[2]!.trim();
  const mark = /^[■◆●○▲▼]\s*(.+)$/.exec(t);
  if (mark) return mark[1]!.trim();
  const bracket = /^【(.+)】$/.exec(t);
  if (bracket) return bracket[1]!.trim();
  const chapter = /^(第[0-9０-９一二三四五六七八九十]+[章節条項]\s*.*)$/.exec(t);
  if (chapter && t.length <= 40) return chapter[1]!.trim();
  return undefined;
}

/** 見出しで区切る。見出しが1つも無ければ、空行2つで区切って先頭行をタイトルにする */
function splitByHeadings(text: string, source: string): Draft[] {
  const lines = text.split('\n');
  const drafts: Draft[] = [];
  let title: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    const body = tidy(buffer.join('\n'));
    if (title !== null && body) drafts.push({ title: cut(title, MAX_TITLE_CHARS), body: cut(body, MAX_BODY_CHARS), source });
    buffer = [];
  };
  for (const line of lines) {
    const heading = headingOf(line);
    if (heading !== undefined) {
      flush();
      title = heading;
    } else {
      buffer.push(line);
    }
  }
  flush();
  if (drafts.length > 0) return drafts;

  // 見出しが無い資料：空行で区切って、最初の行をタイトルにする
  return tidy(text)
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [first = '', ...rest] = block.split('\n');
      const body = rest.join('\n').trim() || block;
      return { title: cut(first.trim(), MAX_TITLE_CHARS), body: cut(body, MAX_BODY_CHARS), source };
    });
}

// --- 表（CSV / TSV / Excel） ------------------------------------------------------

/** 引用符つきの CSV を読む（"" は " 一文字、引用符の中の改行とカンマはそのまま） */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const TITLE_HEADERS = ['タイトル', '件名', '表題', '項目', '見出し', 'title', 'subject'];
const BODY_HEADERS = ['本文', '内容', '説明', '詳細', '手順', 'body', 'content', 'description'];

/** 1行目が見出しの行らしいか（短い語が並んでいる） */
function looksLikeHeader(row: string[]): boolean {
  return row.length > 1 && row.every((c) => c.trim().length > 0 && c.trim().length <= 12);
}

/**
 * 表から下書きを作る。
 *   「タイトル」「本文」の列があれば、その列を使う
 *   無ければ、1列目をタイトル・残りを本文にする（1行目が見出しらしければ「列名：値」の形で残す）
 */
function draftsFromRows(rows: string[][], source: string): Draft[] {
  if (rows.length === 0) return [];
  const header = rows[0]!;
  const norm = header.map((h) => h.trim().toLowerCase());
  const titleColumn = norm.findIndex((h) => TITLE_HEADERS.includes(h));
  const bodyColumns = norm.map((h, i) => (BODY_HEADERS.includes(h) ? i : -1)).filter((i) => i >= 0);
  const named = titleColumn >= 0 && bodyColumns.length > 0;

  const title = named ? titleColumn : 0;
  const body = named ? bodyColumns : header.map((_, i) => i).filter((i) => i !== 0);
  const hasHeader = named || looksLikeHeader(header);
  const label = !named && hasHeader;

  const drafts: Draft[] = [];
  for (const [i, row] of rows.slice(hasHeader ? 1 : 0).entries()) {
    const t = (row[title] ?? '').trim();
    const text = body
      .map((c) => ({ name: (header[c] ?? '').trim(), value: (row[c] ?? '').trim() }))
      .filter((x) => x.value)
      .map((x) => (label && x.name ? `${x.name}：${x.value}` : x.value))
      .join('\n');
    if (!t || !text) continue;
    drafts.push({
      title: cut(t, MAX_TITLE_CHARS),
      body: cut(tidy(text), MAX_BODY_CHARS),
      source: `${source} ${i + (hasHeader ? 2 : 1)}行目`,
    });
  }
  return drafts;
}

// --- Word (.docx) ----------------------------------------------------------------

/**
 * XML のタグを外して中の文字だけにする。
 * Excel は日本語を「&#12479;」のような文字参照で書くことがあるので、そこも戻す。
 */
function xmlText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function draftsFromDocx(buf: Buffer, source: string): Draft[] {
  const xml = readZipEntry(buf, 'word/document.xml');
  if (!xml) throw new ImportError('Word ファイルとして読めませんでした');
  const document = xml.toString('utf8');
  const lines: string[] = [];
  for (const paragraph of paragraphsOf(document)) {
    const text = xmlText(paragraph.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, '')).trim();
    // Word の見出しスタイル（Heading1、見出し 1 など）は Markdown の # に置き換えて、同じ区切り方にする
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(paragraph)?.[1] ?? '';
    const heading = /^(Heading|見出し)/i.test(style) || /^Title$/i.test(style);
    if (!text) { lines.push(''); continue; }
    lines.push(heading ? `# ${text}` : text);
  }
  return splitByHeadings(lines.join('\n'), source);
}

// --- Excel (.xlsx) ---------------------------------------------------------------

function sharedStrings(buf: Buffer): string[] {
  const xml = readZipEntry(buf, 'xl/sharedStrings.xml');
  if (!xml) return [];
  return [...xml.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]!));
}

/**
 * Word の XML から段落（<w:p …>…</w:p> と <w:p/>）を順に取り出す。
 * 正規表現の `[\s\S]*?` でやると、閉じタグの無い `<w:p ` が続く入力で2乗の時間になるので、indexOf で歩く。
 */
function* paragraphsOf(document: string): Generator<string> {
  yield* elementsOf(document, 'w:p');
}

/**
 * `<tag …>…</tag>` と `<tag …/>` を順に取り出す（入れ子は考えない。Word の段落と Excel の行はどちらも入れ子にならない）。
 * 正規表現の `[\s\S]*?` は、閉じタグの無い開きタグが続く入力で2乗の時間になるので使わない。
 */
function* elementsOf(xml: string, tag: string): Generator<string> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let at = 0;
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start < 0) return;
    const after = xml[start + open.length];
    if (after !== ' ' && after !== '>' && after !== '/') { at = start + open.length; continue; } // <w:pPr> などは別の名前
    const gt = xml.indexOf('>', start);
    if (gt < 0) return;
    if (xml[gt - 1] === '/') { // <tag …/>
      yield xml.slice(start, gt + 1);
      at = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt);
    if (end < 0) return;
    yield xml.slice(start, end + close.length);
    at = end + close.length;
  }
}

/** Excel の列の上限（XFD）。番地から出した列番号がこれを超えるなら壊れた資料 */
const MAX_COLUMNS = 16384;

/** セルの番地（A1、BC12）から列番号（0始まり）を出す */
function columnOf(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

export function draftsFromXlsx(buf: Buffer, source: string): Draft[] {
  const strings = sharedStrings(buf);
  // 1枚目のシートだけを見る
  const sheet = readZipEntry(buf, 'xl/worksheets/sheet1.xml');
  if (!sheet) throw new ImportError('Excel ファイルとして読めませんでした');
  const xml = sheet.toString('utf8');
  const rows: string[][] = [];
  for (const rowXml of elementsOf(xml, 'row')) {
    const row: string[] = [];
    for (const cell of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = cell[1] ?? cell[3] ?? '';
      const inner = cell[2] ?? '';
      const index = columnOf(/r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? 'A1');
      if (index >= MAX_COLUMNS) throw new ImportError('Excel ファイルとして読めませんでした（列の番地が範囲外です）');
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
      let value: string;
      if (type === 's') value = strings[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = xmlText(inner);
      else value = xmlText(raw);
      while (row.length < index) row.push('');
      row[index] = value;
    }
    rows.push(row);
  }
  return draftsFromRows(rows.filter((r) => r.some((c) => c.trim() !== '')), source);
}

// --- PDF ------------------------------------------------------------------------

/** 読めない字がこの割合を超えたら、取り込みを断る */
const MAX_UNREADABLE = 0.3;

export function draftsFromPdf(buf: Buffer, source: string): ParseResult {
  const doc = readDocument(buf);
  if (isEncrypted(doc)) {
    return { drafts: [], warnings: ['鍵のかかった PDF は読めません。鍵を外してから取り込んでください'] };
  }
  const text = extractPdfText(doc);
  const warnings = [...text.warnings];
  const all = text.pages.flatMap((page) => page.lines.map((line) => ({ ...line, page: page.number })));
  if (all.length === 0) {
    return { drafts: [], warnings: [...warnings, '文字が入っていません。写真だけの PDF は読めません（文字入りで書き出し直してください）'] };
  }
  if (text.unreadableRatio > MAX_UNREADABLE) {
    return {
      drafts: [],
      warnings: [...warnings, `文字の${Math.round(text.unreadableRatio * 100)}%が読み取れませんでした。文字を埋め込んだ PDF か、Word・テキストで取り込んでください`],
    };
  }
  if (text.unreadableRatio > 0) {
    warnings.push(`読み取れなかった字は「${UNREADABLE}」にしています。取り込んだあとに直してください`);
  }

  // 本文の大きさ＝いちばん多く使われている大きさ（字数で数える）
  const weight = new Map<number, number>();
  for (const line of all) {
    const key = Math.round(line.size * 2) / 2;
    weight.set(key, (weight.get(key) ?? 0) + [...line.text].length);
  }
  const bodySize = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const isHeading = (line: { text: string; size: number }): boolean =>
    line.size >= bodySize * 1.15 && [...line.text].length <= 60;

  const drafts: Draft[] = [];
  let title: string | null = null;
  let titlePage = 1;
  let buffer: string[] = [];
  const flush = () => {
    const body = tidy(buffer.join('\n'));
    if (title !== null && body) {
      drafts.push({ title: cut(title, MAX_TITLE_CHARS), body: cut(body, MAX_BODY_CHARS), source: `${source} ${titlePage}ページ目` });
    }
    buffer = [];
  };
  for (const line of all) {
    if (isHeading(line)) {
      flush();
      title = line.text;
      titlePage = line.page;
    } else {
      buffer.push(line.text);
    }
  }
  flush();

  if (drafts.length > 0) return { drafts, warnings };

  // 見出しが見分けられないときは、ページごとに1件（1行目をタイトルにする）
  for (const page of text.pages) {
    const [first, ...rest] = page.lines.map((l) => l.text);
    if (!first) continue;
    const body = tidy(rest.join('\n')) || first;
    drafts.push({ title: cut(first, MAX_TITLE_CHARS), body: cut(body, MAX_BODY_CHARS), source: `${source} ${page.number}ページ目` });
  }
  if (drafts.length > 0) warnings.push('見出しを見分けられなかったので、ページごとに1件にしました');
  return { drafts, warnings };
}

// --- まとめ ----------------------------------------------------------------------

export function parseImport(fileName: string, buf: Buffer): ParseResult {
  const format = formatOf(fileName);
  if (!format) throw new ImportError('取り込めるのは .txt .md .csv .tsv .docx .xlsx .pdf です');
  const result: ParseResult = (() => {
    switch (format) {
      case 'pdf': return draftsFromPdf(buf, fileName);
      case 'docx': return { drafts: draftsFromDocx(buf, fileName), warnings: [] };
      case 'xlsx': return { drafts: draftsFromXlsx(buf, fileName), warnings: [] };
      case 'csv': return { drafts: draftsFromRows(parseDelimited(normalizeText(buf), ','), fileName), warnings: [] };
      case 'tsv': return { drafts: draftsFromRows(parseDelimited(normalizeText(buf), '\t'), fileName), warnings: [] };
      default: return { drafts: splitByHeadings(normalizeText(buf), fileName), warnings: [] };
    }
  })();
  return { drafts: result.drafts.filter((d) => d.title && d.body).slice(0, MAX_DRAFTS), warnings: result.warnings };
}
