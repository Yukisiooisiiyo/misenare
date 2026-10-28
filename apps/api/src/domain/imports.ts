// 既存のマニュアルの取り込み。
//
// 取り込むと、承認待ちの下書きがまとめてできる。公開するかどうかは、承認画面で1件ずつ人が決める。
// 取り込んだ人が trusted でも自動では公開しない（資料をそのまま入れると、古い記述まで検索に出てしまうため）。

import { ImportError } from '../import/error.ts';
import { assert, canModerate, DomainError, type Actor } from './actor.ts';
import { maybeOne, one, type Db } from '../db/db.ts';
import { assertStore } from './scope.ts';
import { parseImport, type Draft } from '../import/parse.ts';

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

/**
 * 資料を読んで、承認待ちの下書きを作る。
 * 取り込めるのは、承認できる人（trusted 以上）だけ。
 */
export async function importManual(
  db: Db, actor: Actor, storeId: string, fileName: string, content: Buffer,
): Promise<ImportResult> {
  assert(canModerate(actor, storeId), 'forbidden', '資料を取り込めるのは trusted 以上です');
  await assertStore(db, storeId);
  assert(content.byteLength > 0 && content.byteLength <= MAX_IMPORT_BYTES, 'invalid', 'ファイルが大きすぎます');

  let drafts: Draft[];
  let warnings: string[] = [];
  try {
    const parsed = parseImport(fileName, content);
    drafts = parsed.drafts;
    warnings = parsed.warnings;
  } catch (err) {
    // 自分で書いた案内だけ返す。内部の例外文（Buffer の範囲外など）は 400 にしつつ文面は固定にする
    if (err instanceof ImportError) throw new DomainError('invalid', err.message);
    throw new DomainError('invalid', '資料を読めませんでした。ファイルが壊れていないか確かめてください。');
  }
  // 読めなかった理由が分かっていれば、それをそのまま伝える
  assert(
    drafts.length > 0,
    'invalid',
    warnings[0] ?? 'この資料からは下書きを作れませんでした。見出しや列の名前を確かめてください。',
  );

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

  return { importId: imported.id, fileName, drafts: drafts.length, warnings, preview };
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
export async function discardImport(db: Db, actor: Actor, importId: string): Promise<{ discarded: number }> {
  const row = await maybeOne<{ store_id: string | null }>(db, `SELECT store_id FROM imports WHERE id = $1`, [importId]);
  assert(row !== undefined, 'not_found', '取り込みが見つかりません');
  assert(canModerate(actor, row.store_id), 'forbidden', '取り下げる権限がありません');
  const deleted = await db.query<{ id: string }>(
    `DELETE FROM knowledge k
      WHERE k.import_id = $1 AND k.current_version IS NULL
        AND NOT EXISTS (SELECT 1 FROM knowledge_versions v WHERE v.knowledge_id = k.id AND v.state = 'published')
      RETURNING k.id`,
    [importId],
  );
  return { discarded: deleted.length };
}
