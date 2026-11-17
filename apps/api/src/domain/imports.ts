// 既存のマニュアルの取り込み。
//
// 取り込むと、承認待ちの下書きがまとめてできる。公開するかどうかは、承認画面で1件ずつ人が決める。
// 取り込んだ人が trusted でも自動では公開しない（資料をそのまま入れると、古い記述まで検索に出てしまうため）。

import { ImportError } from '../import/error.ts';
import { syncApprovalNotice } from './notices.ts';
import type { Storage } from '../storage/storage.ts';
import { assert, canModerate, DomainError, type Actor } from './actor.ts';
import { maybeOne, one, type Db } from '../db/db.ts';
import { assertStore } from './scope.ts';
import { parseIsolated } from '../import/isolated.ts';
import type { Draft, ParseResult } from '../import/parse.ts';

/** 取り込めるファイルの大きさ */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

export interface ImportResult {
  importId: string;
  fileName: string;
  drafts: number;
  /** 読み取りで気づいたこと（読めなかったページなど）。取り込みは続ける */
  warnings: string[];
  /** 作った下書き（確認用に最初の数件） */
  preview: Array<{ id: string; title: string; source: string | null }>;
}

/** 取り込める人か（trusted 以上）と、店舗があるかを確かめる。重い読み取りの前に呼ぶ */
export async function assertCanImport(db: Db, actor: Actor, storeId: string): Promise<void> {
  assert(canModerate(actor, storeId), 'forbidden', '資料を取り込めるのは trusted 以上です');
  await assertStore(db, storeId);
}

/**
 * 資料を読んで、下書きの素を作る（DB は使わない）。
 * 読み取りは、本体とは別のプロセスで行う（import/isolated.ts。使える記憶と時間に上限がある）。
 * `parse` は試験で読み取りを差し替えるための口で、ふだんは渡さない。
 */
export async function readManual(
  fileName: string, content: Buffer,
  parse: (fileName: string, content: Buffer) => Promise<ParseResult> = parseIsolated,
): Promise<ParseResult> {
  assert(content.byteLength > 0 && content.byteLength <= MAX_IMPORT_BYTES, 'invalid', 'ファイルが大きすぎます');
  let parsed: ParseResult;
  try {
    parsed = await parse(fileName, content);
  } catch (err) {
    // 自分で書いた案内だけ返す。内部の例外文（Buffer の範囲外など）は 400 にしつつ文面は固定にする
    if (err instanceof ImportError) throw new DomainError('invalid', err.message);
    throw new DomainError('invalid', '資料を読めませんでした。ファイルが壊れていないか確かめてください。');
  }
  // 読めなかった理由が分かっていれば、それをそのまま伝える
  assert(
    parsed.drafts.length > 0,
    'invalid',
    parsed.warnings[0] ?? 'この資料からは下書きを作れませんでした。見出しや列の名前を確かめてください。',
  );
  return parsed;
}

/** 読んだ下書きの素を、承認待ちの下書きとして置く */
export async function saveImport(
  db: Db, actor: Actor, storeId: string, fileName: string, parsed: ParseResult,
): Promise<ImportResult> {
  await assertCanImport(db, actor, storeId);
  const drafts: Draft[] = parsed.drafts;
  const warnings = parsed.warnings;
  assert(drafts.length > 0, 'invalid', warnings[0] ?? 'この資料からは下書きを作れませんでした。見出しや列の名前を確かめてください。');

  const imported = await one<{ id: string }>(
    db,
    `INSERT INTO imports (tenant_id, store_id, file_name, status, drafts, created_by)
     VALUES ($1, $2, $3, 'done', $4, $5) RETURNING id`,
    [actor.tenantId, storeId, fileName.slice(0, 200), drafts.length, actor.userId],
  );

  const preview: ImportResult['preview'] = [];
  for (const d of drafts) {
    const k = await one<{ id: string }>(
      db,
      `INSERT INTO knowledge (tenant_id, scope, store_id, status, created_by, import_id, import_source)
       VALUES ($1, 'store', $2, 'draft', $3, $4, $5) RETURNING id`,
      [actor.tenantId, storeId, actor.userId, imported.id, d.source],
    );
    // 下書きなので、タグはまだ付けない（承認するときに付ける）
    await db.query(
      `INSERT INTO knowledge_versions (tenant_id, knowledge_id, version, state, title, body, tag_ids, area_ids, edited_by)
       VALUES ($1, $2, 1, 'pending', $3, $4, '{}', '{}', $5)`,
      [actor.tenantId, k.id, d.title, d.body, actor.userId],
    );
    if (preview.length < 5) preview.push({ id: k.id, title: d.title, source: d.source });
  }
  // 下書きは承認待ちなので、「承認待ちが N 件」の知らせを合わせる
  await syncApprovalNotice(db, actor.tenantId, storeId);

  return { importId: imported.id, fileName, drafts: drafts.length, warnings, preview };
}

/**
 * 資料を読んで、承認待ちの下書きを作る（確かめる → 読む → 置く、をひと続きに行う）。
 * 取り込めるのは、承認できる人（trusted 以上）だけ。
 * HTTP の口は、読むあいだ DB の取引を開けたままにしないよう、この3つを分けて呼ぶ（http/app.ts）。
 */
export async function importManual(
  db: Db, actor: Actor, storeId: string, fileName: string, content: Buffer,
  parse: (fileName: string, content: Buffer) => Promise<ParseResult> = parseIsolated,
): Promise<ImportResult> {
  await assertCanImport(db, actor, storeId);
  return saveImport(db, actor, storeId, fileName, await readManual(fileName, content, parse));
}

/** 取り込んだ資料の一覧と、残っている下書きの数 */
export async function listImports(db: Db, actor: Actor, storeId: string) {
  assert(canModerate(actor, storeId), 'forbidden', '取り込みを見る権限がありません');
  return db.query<{ id: string; file_name: string; drafts: number; pending: number; created_at: string; created_by: string }>(
    `SELECT i.id, i.file_name, i.drafts, i.created_at::text AS created_at, u.name AS created_by,
            (SELECT count(*)::int FROM knowledge k JOIN knowledge_versions v
               ON v.knowledge_id = k.id AND v.version = 1 AND v.state = 'pending'
              WHERE k.import_id = i.id) AS pending
       FROM imports i JOIN users u ON u.id = i.created_by
      WHERE i.store_id = $1
      ORDER BY i.created_at DESC
      LIMIT 50`,
    [storeId],
  );
}

/** 取り込んだ下書きのうち、まだ承認されていないものをまとめて取り下げる */
export async function discardImport(db: Db, actor: Actor, importId: string, storage?: Storage): Promise<{ discarded: number }> {
  const row = await maybeOne<{ store_id: string | null }>(db, `SELECT store_id FROM imports WHERE id = $1`, [importId]);
  assert(row !== undefined, 'not_found', '取り込みが見つかりません');
  assert(canModerate(actor, row.store_id), 'forbidden', '取り下げる権限がありません');
  // 行は外部キーで消えるが、保存先の写真の実体は消えないので、先に集めて消す
  const photos = storage
    ? await db.query<{ storage_key: string }>(
      `SELECT p.storage_key FROM knowledge_photos p JOIN knowledge k ON k.id = p.knowledge_id
        WHERE k.import_id = $1 AND k.current_version IS NULL`,
      [importId],
    )
    : [];
  const deleted = await db.query<{ id: string }>(
    `DELETE FROM knowledge k
      WHERE k.import_id = $1 AND k.current_version IS NULL
        AND NOT EXISTS (SELECT 1 FROM knowledge_versions v WHERE v.knowledge_id = k.id AND v.state = 'published')
      RETURNING k.id`,
    [importId],
  );
  await syncApprovalNotice(db, actor.tenantId, row.store_id);
  // 消せなくても取り下げは成立させる。ただし行は消えて実体だけ残るので、キーと理由を残す
  for (const p of photos) await storage!.remove(p.storage_key).catch((err) => console.warn('写真の実体を消せませんでした', { key: p.storage_key, err }));
  return { discarded: deleted.length };
}
