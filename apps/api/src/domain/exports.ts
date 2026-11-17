// 本部が持ち帰って分析するための書き出し。ナレッジ・検索の記録・タグの3つ。
//
// 形は CSV を基本にする（UTF-8・BOM 付き）。本部の人が Excel でそのまま開けて、
// 分析の道具（BI・Python・R）にもそのまま入る。プログラムから読むための JSON も同じ中身で出せる。
//   ・1行1件、見出しは日本語。日時は ISO 8601（並べ替え・絞り込みがそのまま効く）
//   ・ナレッジの列名（タイトル・本文・タグ）は取り込み（import/parse.ts）と同じにしてあり、別の会社や店舗へ持って行ける
//   ・だれが検索したかは出さない（分析に要るのは「何が探されたか」で、人の見張りに使わせない）
//   ・ブックマークの数は出さない（書いた本人にだけ見せる約束なので）
// 出せるのは本部（会社全体の管理者）だけ。

import type { Db } from '../db/db.ts';
import { assert, type Actor } from './actor.ts';

export type ExportKind = 'knowledge' | 'searches' | 'tags';
export const EXPORT_KINDS: readonly ExportKind[] = ['knowledge', 'searches', 'tags'];
/** 検索の記録をさかのぼれる日数（夜間バッチが残している長さと同じ） */
export const EXPORT_SEARCH_DAYS = 180;
const MAX_ROWS = 50000;

export interface ExportTable {
  /** ファイル名の幹（拡張子と日付は呼び出し側が付ける） */
  name: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

function requireHq(actor: Actor): void {
  assert(actor.adminScope === 'tenant', 'forbidden', '書き出せるのは本部（会社全体の管理者）だけです');
}

/** PostgreSQL の日時（"2026-11-15 06:42:01.12+00"）を ISO 8601 に寄せる */
function iso(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

async function knowledgeTable(db: Db): Promise<ExportTable> {
  const rows = await db.query<{
    id: string; store: string | null; status: string; version: number | null; title: string; body: string; tags: string[] | null;
    created_by: string | null; created_at: string; updated_by: string | null; updated_at: string;
    approved_by: string | null; verified_at: string | null; photos: number; opens: number;
  }>(
    `SELECT k.id, s.name AS store, k.status, k.current_version AS version, v.title, v.body,
            (SELECT array_agg(t.name ORDER BY array_position(v.tag_ids, t.id)) FROM hashtags t WHERE t.id = ANY(v.tag_ids)) AS tags,
            cu.name AS created_by, k.created_at::text AS created_at,
            eu.name AS updated_by, v.edited_at::text AS updated_at,
            au.name AS approved_by, k.verified_at::text AS verified_at,
            (SELECT count(*) FROM knowledge_photos p WHERE p.knowledge_id = k.id AND p.state = 'active' AND p.pending_version IS NULL)::int AS photos,
            (SELECT count(*) FROM search_logs l WHERE l.opened_knowledge_id = k.id)::int AS opens
       FROM knowledge k
       JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version
       LEFT JOIN stores s ON s.id = k.store_id
       LEFT JOIN users cu ON cu.id = k.created_by
       LEFT JOIN users eu ON eu.id = v.edited_by
       LEFT JOIN users au ON au.id = v.decided_by
      WHERE k.status = 'published'
      ORDER BY s.name NULLS FIRST, k.created_at
      LIMIT ${MAX_ROWS}`,
  );
  return {
    name: 'ナレッジ',
    columns: ['ID', '店舗', 'タイトル', '本文', 'タグ', '書いた人', '作成日時', '最後に直した人', '更新日時', '承認した人', '最終確認日時', '写真の枚数', '検索から開かれた回数', '版'],
    rows: rows.map((r) => [
      r.id, r.store ?? '全店共通', r.title, r.body, (r.tags ?? []).map((t) => `#${t}`).join(' '),
      r.created_by, iso(r.created_at), r.updated_by, iso(r.updated_at), r.approved_by, iso(r.verified_at),
      Number(r.photos), Number(r.opens), r.version,
    ]),
  };
}

async function searchesTable(db: Db, days: number): Promise<ExportTable> {
  const rows = await db.query<{ at: string; store: string | null; query: string; result_count: number; opened: string | null; suggested: string | null; picked: string | null }>(
    `SELECT l.created_at::text AS at, s.name AS store, l.query, l.result_count,
            (SELECT v.title FROM knowledge k JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version
              WHERE k.id = l.opened_knowledge_id) AS opened,
            st.name AS suggested, pt.name AS picked
       FROM search_logs l
       LEFT JOIN stores s ON s.id = l.store_id
       LEFT JOIN hashtags st ON st.id = l.suggested_tag_id
       LEFT JOIN hashtags pt ON pt.id = l.picked_tag_id
      WHERE l.created_at > now() - make_interval(days => $1)
      ORDER BY l.created_at DESC
      LIMIT ${MAX_ROWS}`,
    [days],
  );
  return {
    name: '検索の記録',
    columns: ['日時', '店舗', '検索した言葉', '見つかった件数', '見つからなかった', '開いたナレッジ', '候補に出たタグ', '選ばれたタグ'],
    rows: rows.map((r) => [
      iso(r.at), r.store, r.query, Number(r.result_count), Number(r.result_count) === 0 ? 1 : 0, r.opened,
      r.suggested ? `#${r.suggested}` : null, r.picked ? `#${r.picked}` : null,
    ]),
  };
}

async function tagsTable(db: Db, days: number): Promise<ExportTable> {
  const rows = await db.query<{ name: string; readings: string[] | null; knowledge: number; searches: number; zero: number; created_at: string }>(
    `SELECT t.name, t.readings, t.created_at::text AS created_at,
            (SELECT count(*) FROM knowledge k JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version
              WHERE k.status = 'published' AND t.id = ANY(v.tag_ids))::int AS knowledge,
            (SELECT count(*) FROM search_logs l WHERE l.created_at > now() - make_interval(days => $1)
               AND position(lower(t.name) in lower(l.query)) > 0)::int AS searches,
            (SELECT count(*) FROM search_logs l WHERE l.created_at > now() - make_interval(days => $1)
               AND l.result_count = 0 AND position(lower(t.name) in lower(l.query)) > 0)::int AS zero
       FROM hashtags t
      WHERE t.state = 'active'
      ORDER BY knowledge DESC, t.name
      LIMIT ${MAX_ROWS}`,
    [days],
  );
  return {
    name: 'タグ',
    columns: ['タグ', '読み', '付いているナレッジの数', `検索された回数（直近${days}日）`, `うち見つからなかった回数`, '作られた日時'],
    rows: rows.map((r) => [`#${r.name}`, (r.readings ?? []).join(' '), Number(r.knowledge), Number(r.searches), Number(r.zero), iso(r.created_at)]),
  };
}

export async function exportTable(db: Db, actor: Actor, kind: ExportKind, days: number = EXPORT_SEARCH_DAYS): Promise<ExportTable> {
  requireHq(actor);
  const span = Math.min(EXPORT_SEARCH_DAYS, Math.max(1, Math.floor(days) || EXPORT_SEARCH_DAYS));
  if (kind === 'knowledge') return knowledgeTable(db);
  if (kind === 'searches') return searchesTable(db, span);
  return tagsTable(db, span);
}

// --- 形にする ------------------------------------------------------------------

/**
 * CSV の1マス。カンマ・改行・引用符を含むものは引用符で囲む。
 * = + - @ で始まる文字は、表計算ソフトが数式として実行してしまうので、頭に ' を付けて文字として読ませる
 * （ナレッジの本文は利用者が自由に書けるので、開いた本部の人の PC で何かが動かないようにする）。
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** UTF-8・BOM 付き・CRLF。Excel がそのまま日本語で開ける形 */
export function toCsv(table: ExportTable): string {
  const lines = [table.columns, ...table.rows].map((row) => row.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** プログラムから読む用。列名をそのまま鍵にした配列 */
export function toJson(table: ExportTable, exportedAt: Date = new Date()): string {
  return JSON.stringify({
    name: table.name,
    exportedAt: exportedAt.toISOString(),
    count: table.rows.length,
    rows: table.rows.map((row) => Object.fromEntries(table.columns.map((c, i) => [c, row[i] ?? null]))),
  }, null, 1);
}
