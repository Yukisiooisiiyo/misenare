// ナレッジの投稿・編集・承認・却下・過去版への戻し。
// visitor の変更は承認待ちの版（pending）として積み、trusted の変更はその場で公開する。
// どちらの場合も、編集のたびに版を1つ追加して残す。

import { readingCandidates, suggestReading, type Tokenizer } from '@misenare/search-core';
import { maybeOne, one, type Db } from '../db/db.ts';
import { assert, canAccessStore, canModerate, isTrusted, type Actor } from './actor.ts';
import { indexKnowledge } from './indexer.ts';
import { assertStore } from './scope.ts';
import { syncApprovalNotice } from './notices.ts';
import { activateTags, resolveTags } from './tags.ts';

export interface KnowledgeInput {
  /** null なら全店共通（本部のみ作成可） */
  storeId: string | null;
  title: string;
  body: string;
  tagNames: string[];
  areaIds?: string[];
  expiresAt?: string | null;
  /**
   * 画面が見ていた版（KnowledgeView.version）。
   * 送ってきたときは、いまの公開版と同じでなければ受け付けない。
   * 2人の trusted が同じ本文を開いて直すと、後から送った方が前の人の修正を黙って消すため。
   * 送ってこない（古い端末）ときは止めない。
   */
  baseVersion?: number | null;
}

export interface KnowledgeView {
  id: string;
  storeId: string | null;
  status: 'draft' | 'published' | 'expired';
  version: number | null;
  title: string;
  body: string;
  tags: string[];
  /** 内容が最後に変わった日時（表示中の版の編集日時） */
  updatedAt: string;
  updatedBy: string | null;
  /** 最初にこのナレッジを作った人。間違いが続くなら、その人に教え直す必要がある */
  createdBy: string | null;
  /** 表示中の版を承認した人。**承認した人が内容に責任を持つ**ので、名前を出す */
  approvedBy: string | null;
  approvedAt: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  /**
   * 承認待ちの修正案。**誰の案かを全員に見せる。**
   * 見えないと、同じところを2人が別々に直して、片方が黙って消える。
   * 中身は「見る」で開く（listVersions）。検索には出ない。
   */
  pendingEdits: Array<{ version: number; editedBy: string | null; editedAt: string; mine: boolean }>;
}

interface KnowledgeRow {
  id: string;
  tenant_id: string;
  store_id: string | null;
  status: KnowledgeView['status'];
  current_version: number | null;
  expires_at: string | null;
}

const MAX_TITLE = 100;
const MAX_BODY = 20_000;

function validate(input: Pick<KnowledgeInput, 'title' | 'body' | 'tagNames'>) {
  assert(input.title.trim().length > 0, 'invalid', 'タイトルを入力してください');
  assert(input.title.length <= MAX_TITLE, 'invalid', `タイトルは${MAX_TITLE}文字以内にしてください`);
  assert(input.body.length <= MAX_BODY, 'invalid', `本文は${MAX_BODY}文字以内にしてください`);
  assert(input.tagNames.some((t) => t.replace(/[#＃\s]/g, '').length > 0), 'invalid', 'ハッシュタグを1つ以上付けてください');
}

/** lock = true なら行ロックを取る（同時編集で版番号が衝突しないように、変更系では必ず使う）。 */
async function load(db: Db, id: string, lock = false): Promise<KnowledgeRow> {
  const row = await maybeOne<KnowledgeRow>(
    db,
    `SELECT id, tenant_id, store_id, status, current_version, expires_at::text AS expires_at
       FROM knowledge WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  assert(row !== undefined, 'not_found', 'ナレッジが見つかりません');
  return row;
}

async function nextVersion(db: Db, id: string): Promise<number> {
  const r = await one<{ v: number }>(db, `SELECT coalesce(max(version), 0) + 1 AS v FROM knowledge_versions WHERE knowledge_id = $1`, [id]);
  return r.v;
}

/**
 * 版を公開する：旧公開版と、それより古い承認待ちの案を過去版にし、current_version と期限を進め、
 * 確認日を更新し、索引に反映する。期限は版に持たせておき、公開した時点で初めて効かせる。
 */
async function publish(db: Db, tokenizer: Tokenizer, actor: Actor, id: string, version: number): Promise<void> {
  await db.query(
    `UPDATE knowledge_versions SET state = 'superseded'
      WHERE knowledge_id = $1 AND (state = 'published' OR (state = 'pending' AND version < $2))`,
    [id, version],
  );
  const v = await one<{ tag_ids: string[]; expires_at: string | null }>(
    db,
    `UPDATE knowledge_versions SET state = 'published', decided_by = $3, decided_at = now()
      WHERE knowledge_id = $1 AND version = $2 RETURNING tag_ids, expires_at`,
    [id, version, actor.userId],
  );
  await activateTags(db, v.tag_ids);
  await db.query(
    `UPDATE knowledge SET status = 'published', current_version = $2, expires_at = $3::timestamptz,
            verified_by = $4, verified_at = now()
      WHERE id = $1`,
    [id, version, v.expires_at, actor.userId],
  );
  await indexKnowledge(db, tokenizer, id);
}

async function insertVersion(
  db: Db,
  actor: Actor,
  id: string,
  version: number,
  v: { title: string; body: string; tagIds: string[]; areaIds: string[]; expiresAt: string | null },
  /** どの版を直したものか。公開中の版を見て直すので、そのときの current_version */
  baseVersion: number | null = null,
) {
  await db.query(
    `INSERT INTO knowledge_versions (tenant_id, knowledge_id, version, title, body, tag_ids, area_ids, expires_at, state, edited_by, base_version)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7::uuid[], $8::timestamptz, 'pending', $9, $10)`,
    [actor.tenantId, id, version, v.title, v.body, v.tagIds, v.areaIds, v.expiresAt, actor.userId, baseVersion],
  );
}

async function assertAreas(db: Db, storeId: string | null, areaIds: string[] | undefined) {
  if (!areaIds || areaIds.length === 0) return;
  assert(storeId !== null, 'invalid', '全店共通のナレッジには売場を指定できません');
  const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM areas WHERE id = ANY($1::uuid[]) AND store_id = $2`, [areaIds, storeId]);
  assert(n.n === new Set(areaIds).size, 'invalid', 'この店舗の売場ではありません');
}

export async function createKnowledge(db: Db, tokenizer: Tokenizer, actor: Actor, input: KnowledgeInput) {
  validate(input);
  if (input.storeId === null) {
    assert(actor.adminScope === 'tenant', 'forbidden', '全店共通のナレッジは本部のみ作成できます');
  } else {
    assert(canAccessStore(actor, input.storeId), 'forbidden', 'この店舗には投稿できません');
    await assertStore(db, input.storeId);
  }
  await assertAreas(db, input.storeId, input.areaIds);
  const tagIds = await resolveTags(db, actor, input.tagNames);
  const k = await one<{ id: string }>(
    db,
    `INSERT INTO knowledge (tenant_id, scope, store_id, status, created_by)
     VALUES ($1, $2, $3, 'draft', $4) RETURNING id`,
    [actor.tenantId, input.storeId === null ? 'tenant' : 'store', input.storeId, actor.userId],
  );
  await insertVersion(db, actor, k.id, 1, {
    title: input.title.trim(), body: input.body, tagIds, areaIds: input.areaIds ?? [], expiresAt: input.expiresAt ?? null,
  });
  if (isTrusted(actor)) await publish(db, tokenizer, actor, k.id, 1);
  // 新しく作ったタグのうち、まだ読みが決まっていないものを返す。
  // 画面はこれを見て、その場で読みを尋ねる（一番よく知っているのは、いま打った人）。
  const readingsNeeded = await pendingReadings(db, tokenizer, tagIds);
  // 承認待ちの件数を連絡事項に反映する（承認できる人にだけ出る）
  await syncApprovalNotice(db, actor.tenantId, input.storeId);
  return { id: k.id, version: 1, published: isTrusted(actor), readingsNeeded };
}

/** 読みが決まっていないタグ。保存した直後にその場で尋ねるために使う。 */
export interface ReadingNeeded {
  id: string;
  name: string;
  /** 形態素解析器の案。信用できないときは空 */
  proposed: string;
  /** 漢字の読みの総当たりから作った候補。押すと入力欄に入り、そこから直せる */
  candidates: string[];
}

/**
 * 読みが決まっていないタグを、その場で尋ねられる形にして返す。
 *
 * 案（入力欄の初期値）は**ここで作る**。夜間バッチも同じ案を貯めるが、
 * タグを作った直後にいちばん詳しいのはいま打った人なので、バッチを待たない。
 * カタカナ語のように確かめるまでもない読みは、その場で登録して尋ねない。
 */
async function pendingReadings(db: Db, tokenizer: Tokenizer, tagIds: readonly string[]): Promise<ReadingNeeded[]> {
  if (tagIds.length === 0) return [];
  const rows = await db.query<{ id: string; name: string; reading_proposed: string | null }>(
    `SELECT id, name, reading_proposed
       FROM hashtags
      WHERE id = ANY($1::uuid[])
        AND state = 'active'
        AND cardinality(readings) = 0
        AND reading_checked_at IS NULL
      ORDER BY name`,
    [[...tagIds]],
  );
  const out: ReadingNeeded[] = [];
  for (const r of rows) {
    // バッチが置いた案があればそれを使い、無ければいま作る
    const suggestion = r.reading_proposed === null ? suggestReading(tokenizer, r.name) : null;
    if (suggestion?.kind === 'settled') {
      await db.query(
        `UPDATE hashtags SET readings = ARRAY[$2], reading_checked_at = now() WHERE id = $1`,
        [r.id, suggestion.reading],
      );
      continue; // 尋ねない
    }
    const proposed = r.reading_proposed ?? (suggestion?.kind === 'proposal' ? suggestion.reading : '');
    out.push({
      id: r.id,
      name: r.name,
      proposed,
      // 案と重なる候補は省く（同じものを2回見せない）
      candidates: readingCandidates(r.name).filter((c) => c !== proposed),
    });
  }
  return out;
}

export async function editKnowledge(
  db: Db,
  tokenizer: Tokenizer,
  actor: Actor,
  id: string,
  input: Omit<KnowledgeInput, 'storeId'>,
) {
  validate(input);
  const k = await load(db, id, true);
  assert(canAccessStore(actor, k.store_id), 'forbidden', 'このナレッジは編集できません');
  if (k.store_id === null) assert(actor.adminScope === 'tenant', 'forbidden', '全店共通のナレッジは本部のみ編集できます');
  if (input.baseVersion !== undefined && input.baseVersion !== null) {
    assert(
      input.baseVersion === k.current_version,
      'conflict',
      'あなたが開いたあとに、別の人がこのナレッジを直しています。いまの本文を見てから作り直してください。',
    );
  }
  await assertAreas(db, k.store_id, input.areaIds);
  const tagIds = await resolveTags(db, actor, input.tagNames);
  const version = await nextVersion(db, id);
  // 期限を指定しなければ今の期限を引き継ぐ。どちらの場合も公開（承認）されるまで効かない
  await insertVersion(db, actor, id, version, {
    title: input.title.trim(), body: input.body, tagIds, areaIds: input.areaIds ?? [],
    expiresAt: input.expiresAt !== undefined ? input.expiresAt : k.expires_at,
  }, k.current_version);
  const published = isTrusted(actor);
  if (published) await publish(db, tokenizer, actor, id, version);
  await syncApprovalNotice(db, actor.tenantId, k.store_id);
  return { id, version, published };
}

export async function approveVersion(db: Db, tokenizer: Tokenizer, actor: Actor, id: string, version: number) {
  const k = await load(db, id, true);
  assert(canModerate(actor, k.store_id), 'forbidden', '承認する権限がありません');
  const v = await maybeOne<{ state: string; base_version: number | null }>(
    db,
    `SELECT state, base_version FROM knowledge_versions WHERE knowledge_id = $1 AND version = $2`,
    [id, version],
  );
  assert(v !== undefined, 'not_found', '版が見つかりません');
  assert(v.state === 'pending', 'conflict', 'この版は承認待ちではありません');
  // 承認待ちの間に新しい版が公開されていたら、古い修正案で上書きしない
  assert(k.current_version === null || version > k.current_version, 'conflict', 'より新しい版が公開済みです。修正案を作り直してください');
  // **土台が古い案は通さない。** 承認待ちの間に別の案が公開されていると、
  // この案はその修正を知らないまま書かれているので、通すと相手の修正が消える
  assert(
    v.base_version === null || v.base_version === k.current_version,
    'conflict',
    'この修正案は、いま公開されている本文より前のものを直したものです。いまの本文を見て作り直してください。',
  );
  // これから閉じられる他の案。**黙って消さず、承認した人に伝える**
  const closing = await db.query<{ version: number; editor: string | null }>(
    `SELECT v.version, u.name AS editor
       FROM knowledge_versions v LEFT JOIN users u ON u.id = v.edited_by
      WHERE v.knowledge_id = $1 AND v.state = 'pending' AND v.version < $2`,
    [id, version],
  );
  await publish(db, tokenizer, actor, id, version);
  await syncApprovalNotice(db, actor.tenantId, k.store_id);
  return { id, version, closed: closing.map((c) => ({ version: c.version, editedBy: c.editor })) };
}

export async function rejectVersion(db: Db, actor: Actor, id: string, version: number) {
  const k = await load(db, id, true);
  assert(canModerate(actor, k.store_id), 'forbidden', '却下する権限がありません');
  const rows = await db.query(
    `UPDATE knowledge_versions SET state = 'rejected', decided_by = $3, decided_at = now()
      WHERE knowledge_id = $1 AND version = $2 AND state = 'pending' RETURNING version`,
    [id, version, actor.userId],
  );
  assert(rows.length === 1, 'conflict', 'この版は承認待ちではありません');
  // 一度も公開されていないナレッジの唯一の案を却下した場合、pending のタグも辞書に入らないまま残る
  await syncApprovalNotice(db, actor.tenantId, k.store_id);
  return { id, version };
}

/** 過去版の内容で新しい版を作って公開する（履歴は消さない）。 */
export async function revertToVersion(db: Db, tokenizer: Tokenizer, actor: Actor, id: string, version: number) {
  const k = await load(db, id, true);
  assert(canModerate(actor, k.store_id), 'forbidden', '過去版に戻す権限がありません');
  const old = await maybeOne<{ title: string; body: string; tag_ids: string[]; area_ids: string[]; expires_at: string | null; state: string }>(
    db,
    `SELECT title, body, tag_ids, area_ids, expires_at::text AS expires_at, state
       FROM knowledge_versions WHERE knowledge_id = $1 AND version = $2`,
    [id, version],
  );
  assert(old !== undefined, 'not_found', '版が見つかりません');
  // 戻せるのは一度公開された版だけ。承認待ち・却下の案を戻しで公開すると承認を飛ばせてしまう
  assert(old.state === 'superseded' || old.state === 'published', 'conflict', '一度も公開されていない版には戻せません');
  const next = await nextVersion(db, id);
  await insertVersion(db, actor, id, next, {
    title: old.title, body: old.body, tagIds: old.tag_ids, areaIds: old.area_ids, expiresAt: old.expires_at,
  }, k.current_version);
  // 戻すと、いま承認待ちの案は閉じられる。approveVersion と同じく、閉じた案を返して黙って消さない
  const closing = await db.query<{ version: number; editor: string | null }>(
    `SELECT v.version, u.name AS editor
       FROM knowledge_versions v LEFT JOIN users u ON u.id = v.edited_by
      WHERE v.knowledge_id = $1 AND v.state = 'pending' AND v.version < $2`,
    [id, next],
  );
  await publish(db, tokenizer, actor, id, next);
  await syncApprovalNotice(db, actor.tenantId, k.store_id);
  return { id, version: next, closed: closing.map((c) => ({ version: c.version, editedBy: c.editor })) };
}

export async function getKnowledge(db: Db, actor: Actor, id: string): Promise<KnowledgeView> {
  const k = await load(db, id);
  assert(canAccessStore(actor, k.store_id), 'forbidden', 'このナレッジは閲覧できません');
  // 公開中の版。未公開なら最新の案（投稿者本人と承認者だけが見られる）
  const v = await maybeOne<{ version: number; title: string; body: string; tag_ids: string[]; edited_by: string; edited_at: string; editor: string | null; approver: string | null; decided_at: string | null }>(
    db,
    `SELECT version, title, body, tag_ids, edited_by, edited_at::text AS edited_at,
            (SELECT name FROM users WHERE id = edited_by) AS editor,
            (SELECT name FROM users WHERE id = decided_by) AS approver,
            decided_at::text AS decided_at
       FROM knowledge_versions
      WHERE knowledge_id = $1 AND (version = $2 OR $2::int IS NULL)
      ORDER BY version DESC LIMIT 1`,
    [id, k.current_version],
  );
  assert(v !== undefined, 'not_found', 'ナレッジが見つかりません');
  if (k.status !== 'published') {
    assert(v.edited_by === actor.userId || canModerate(actor, k.store_id), 'forbidden', 'このナレッジはまだ公開されていません');
  }
  const tags = await db.query<{ name: string }>(
    `SELECT name FROM hashtags WHERE id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], id)`,
    [v.tag_ids],
  );
  const meta = await one<{ verified_at: string | null; verified_by: string | null; created_by: string | null }>(
    db,
    `SELECT k.verified_at::text AS verified_at, u.name AS verified_by, cu.name AS created_by
       FROM knowledge k
       LEFT JOIN users u  ON u.id  = k.verified_by
       LEFT JOIN users cu ON cu.id = k.created_by
      WHERE k.id = $1`,
    [id],
  );
  // 承認待ちの版は**全員に見せる**。
  // 隠すと、同じところを2人が別々に直して、承認のときに片方が黙って消える。
  // 見えていれば、2人目は相手の案を読んでから書ける（あるいは待てる）。
  const pending = await db.query<{ version: number; editor: string | null; edited_at: string; mine: boolean }>(
    `SELECT v.version, u.name AS editor, v.edited_at::text AS edited_at, (v.edited_by = $2) AS mine
       FROM knowledge_versions v LEFT JOIN users u ON u.id = v.edited_by
      WHERE v.knowledge_id = $1 AND v.state = 'pending'
      ORDER BY v.version`,
    [id, actor.userId],
  );
  return {
    id,
    storeId: k.store_id,
    status: k.status,
    version: k.current_version,
    title: v.title,
    body: v.body,
    tags: tags.map((t) => t.name),
    updatedAt: v.edited_at,
    updatedBy: v.editor,
    createdBy: meta.created_by,
    approvedBy: v.approver,
    approvedAt: v.decided_at,
    verifiedAt: meta.verified_at,
    verifiedBy: meta.verified_by,
    pendingEdits: pending.map((p) => ({ version: p.version, editedBy: p.editor, editedAt: p.edited_at, mine: p.mine })),
  };
}

/**
 * 版の一覧（差分表示・戻し用）。公開された版（公開中・過去版）は誰でも見られる。
 * 承認待ち・却下の案は、承認できる人と、その案を書いた本人にだけ見せる。
 */
export async function listVersions(db: Db, actor: Actor, id: string) {
  const k = await load(db, id);
  assert(canAccessStore(actor, k.store_id), 'forbidden', 'このナレッジは閲覧できません');
  // 一度も公開されていないもの（承認待ちの新規投稿・取り込んだ資料の下書き）は、getKnowledge と同じく
  // 書いた本人と承認できる人だけ。ここだけ緩いと、版の一覧から本文が読めてしまう
  if (k.status !== 'published') {
    const mine = await maybeOne(db, `SELECT 1 FROM knowledge_versions WHERE knowledge_id = $1 AND edited_by = $2`, [id, actor.userId]);
    assert(mine !== undefined || canModerate(actor, k.store_id), 'forbidden', 'このナレッジはまだ公開されていません');
  }
  return db.query<{ version: number; state: string; title: string; body: string; edited_at: string; edited_by: string; decided_by: string | null; decided_at: string | null }>(
    // 承認・却下した人も出す。承認した人がその内容に責任を持つため、誰が通したかを残す
    `SELECT v.version, v.state, v.title, v.body, v.edited_at, u.name AS edited_by,
            du.name AS decided_by, v.decided_at
       FROM knowledge_versions v
       JOIN users u ON u.id = v.edited_by
       LEFT JOIN users du ON du.id = v.decided_by
      WHERE v.knowledge_id = $1
        -- 承認待ちも見せる（同じところを直そうとしている人が、相手の案を読めるように）。
        -- 却下された案だけは、書いた本人と承認できる人に限る
        AND (v.state <> 'rejected' OR $2 OR v.edited_by = $3)
      ORDER BY v.version DESC`,
    [id, canModerate(actor, k.store_id), actor.userId],
  );
}

/** 承認待ちの一覧（trusted / administrator 向け） */
export async function listPending(db: Db, actor: Actor, storeId: string) {
  assert(canModerate(actor, storeId), 'forbidden', '承認待ちを見る権限がありません');
  return db.query(
    `SELECT k.id, v.version, v.title, v.edited_at, u.name AS edited_by, k.current_version IS NULL AS is_new
       FROM knowledge_versions v
       JOIN knowledge k ON k.id = v.knowledge_id
       JOIN users u ON u.id = v.edited_by
      WHERE v.state = 'pending' AND k.store_id = $1
      ORDER BY v.edited_at`,
    [storeId],
  );
}

/**
 * 「古い」とみなすまでの日数。ここが1つの決まりごとで、
 * 承認・管理の一覧（下の listStale）と、詳細画面の注意書きの両方がこの値を使う。
 * 画面側には /me で配って、ずれないようにしている。
 */
export const STALE_DAYS = 180;

/** 一定期間、更新も確認もされていない公開ナレッジ（鮮度管理。承認できる人が見直す） */
export async function listStale(db: Db, actor: Actor, storeId: string, days = STALE_DAYS) {
  assert(canModerate(actor, storeId), 'forbidden', '見直しの一覧を見る権限がありません');
  return db.query<{ id: string; title: string; verified_at: string | null; verified_by: string | null }>(
    `SELECT k.id, v.title, k.verified_at::text AS verified_at, u.name AS verified_by
       FROM knowledge k
       JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version
       LEFT JOIN users u ON u.id = k.verified_by
      WHERE k.status = 'published' AND k.store_id = $1
        AND greatest(k.verified_at, v.edited_at) < now() - make_interval(days => $2)
      ORDER BY greatest(k.verified_at, v.edited_at)`,
    [storeId, days],
  );
}

/** 内容は変えずに「今も正しい」と確認した記録だけを残す（最終確認日・確認者を更新） */
export async function verifyKnowledge(db: Db, actor: Actor, id: string) {
  const k = await load(db, id, true);
  assert(canModerate(actor, k.store_id), 'forbidden', '確認する権限がありません');
  assert(k.status === 'published', 'conflict', '公開中のナレッジではありません');
  await db.query(`UPDATE knowledge SET verified_by = $2, verified_at = now() WHERE id = $1`, [id, actor.userId]);
  return { id };
}
