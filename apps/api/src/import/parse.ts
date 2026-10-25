// 既存のマニュアルから、ナレッジの下書きを作る。
//
// 取り込めるもの：
//   .txt / .md   … 見出し（# や ■、行末が「：」だけの行）で区切る
//   .csv / .tsv  … 1行1件。見出し行から「タイトル」「本文」「タグ」の列を探す
//   .docx        … Word の見出しスタイルで区切る
//   .xlsx        … 1行1件（CSV と同じ見方）
//
// 出てくるのは下書きなので、公開するかどうかは人が決める。
// タグは付けない（本文から機械的に拾うと的外れなタグが増えるため）。書いた人が承認時に付ける。

import { readZipEntry } from './zip.ts';

export interface Draft {
  title: string;
  body: string;
  /** もとの資料のどこから来たか（確認するときの手がかり） */
  source: string;
}

export type ImportFormat = 'text' | 'markdown' | 'csv' | 'tsv' | 'docx' | 'xlsx';

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
  return s.replace(/[ \t　]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
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
  if (!xml) throw new Error('Word ファイルとして読めませんでした');
  const document = xml.toString('utf8');
  const lines: string[] = [];
  for (const match of document.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const paragraph = match[0];
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
  if (!sheet) throw new Error('Excel ファイルとして読めませんでした');
  const xml = sheet.toString('utf8');
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row[ >][\s\S]*?<\/row>|<row[^>]*\/>/g)) {
    const row: string[] = [];
    for (const cell of rowMatch[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
      const attrs = cell[1] ?? cell[3] ?? '';
      const inner = cell[2] ?? '';
      const index = columnOf(/r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? 'A1');
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

// --- まとめ ----------------------------------------------------------------------

export function parseImport(fileName: string, buf: Buffer): Draft[] {
  const format = formatOf(fileName);
  if (!format) throw new Error('取り込めるのは .txt .md .csv .tsv .docx .xlsx です');
  const drafts = (() => {
    switch (format) {
      case 'docx': return draftsFromDocx(buf, fileName);
      case 'xlsx': return draftsFromXlsx(buf, fileName);
      case 'csv': return draftsFromRows(parseDelimited(normalizeText(buf), ','), fileName);
      case 'tsv': return draftsFromRows(parseDelimited(normalizeText(buf), '\t'), fileName);
      default: return splitByHeadings(normalizeText(buf), fileName);
    }
  })();
  return drafts.filter((d) => d.title && d.body).slice(0, MAX_DRAFTS);
}
