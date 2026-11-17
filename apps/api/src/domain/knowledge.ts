// ナレッジの投稿・編集・承認・却下・過去版への戻し。
// visitor の変更は承認待ちの版（pending）として積み、trusted の変更はその場で公開する。
// どちらの場合も、編集のたびに版を1つ追加して残す。

import { bookmarkState } from './bookmarks.ts';
import { readingCandidates, suggestReading, type Tokenizer } from '@misenare/search-core';
import { maybeOne, one, type Db } from '../db/db.ts';
import { assert, canAccessStore, canAdminister, canModerate, isTrusted, type Actor } from './actor.ts';
import type { Storage } from '../storage/storage.ts';
import { indexKnowledge } from './indexer.ts';
import { assertStore } from './scope.ts';
import { syncApprovalNotice } from './notices.ts';
import { activateTags, canonicalTagIds, invalidateDictionary, resolveTags } from './tags.ts';

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
  /** 有効期限。過ぎると、夜間に検索から外れる（status が expired になる）。無ければ期限なし */
  expiresAt: string | null;
  /** どの売場の話か（付けてあれば）。消された売場は出さない */
  areas: Array<{ id: string; name: string }>;
  /**
   * 承認待ちの修正案。**誰の案かを全員に見せる。**
   * 見えないと、同じところを2人が別々に直して、片方が黙って消える。
   * 中身は「見る」で開く（listVersions）。検索には出ない。
   */
  pendingEdits: Array<{ version: number; editedBy: string | null; editedAt: string; mine: boolean }>;
  /**
   * まだ一度も公開されていないときの、いちばん新しい案の状態。
   * 却下された投稿を、書いた本人の画面で「承認待ち」のまま見せないために返す（公開済みなら項目ごと無い）
   */
  draftState?: 'pending' | 'rejected';
  /** 消せるか（deleteKnowledge と同じ判定。消すボタンを出すかどうかに使う） */
  canDelete: boolean;
  /** 自分がブックマークしているか */
  bookmarked: boolean;
  /** ブックマークを付けられるか（自分が書いたものには付けられない） */
  canBookmark: boolean;
  /** 付いたブックマークの数。**書いた本人にだけ**返す（ほかの人には項目ごと無い） */
  bookmarkCount?: number;
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

/**
 * 有効期限は、先の日時か、無しか。
 *
 * 過ぎた期限のまま公開すると、その晩に検索から外れて、だれにも見つからなくなる。
 * 承認できない人の案も、ここで断る（過ぎた期限の案は、どのみち承認できない）。
 * 比べるのは DB の時計（端末の時計がずれていても同じ答えになる）。
 */
async function assertNotExpired(db: Db, expiresAt: string | null): Promise<void> {
  if (expiresAt === null) return;
  const r = await one<{ past: boolean }>(db, `SELECT $1::timestamptz <= now() AS past`, [expiresAt]);
  assert(!r.past, 'invalid', '有効期限が過ぎています。先の日付にするか、期限なしにしてください');
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

/**
 * 写真の待ちを、版の決着に合わせる（承認・却下・出し直し・戻しのあとに呼ぶ）。
 *
 *   案が公開された       … 待ちを解く（全員に見える）
 *   案が通らなかった     … 捨てる（一覧から消える。実体は夜間バッチが片付ける）
 *
 * 写真は、承認できない人が公開中のナレッジへの修正案と一緒に付けたときだけ待つ（photos.ts）。
 */
async function settlePhotos(db: Db, id: string): Promise<void> {
  await db.query(
    `UPDATE knowledge_photos p SET pending_version = NULL
       FROM knowledge_versions v
      WHERE p.knowledge_id = $1 AND p.pending_version IS NOT NULL
        AND v.knowledge_id = p.knowledge_id AND v.version = p.pending_version AND v.state = 'published'`,
    [id],
  );
  await db.query(
    `UPDATE knowledge_photos p SET state = 'discarded'
      WHERE p.knowledge_id = $1 AND p.pending_version IS NOT NULL AND p.state <> 'discarded'
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_versions v
           WHERE v.knowledge_id = p.knowledge_id AND v.version = p.pending_version AND v.state = 'pending')`,
    [id],
  );
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
  await assertNotExpired(db, input.expiresAt ?? null);
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
      const set = await db.query<{ tenant_id: string }>(
        `UPDATE hashtags SET readings = ARRAY[$2], reading_checked_at = now() WHERE id = $1 RETURNING tenant_id`,
        [r.id, suggestion.reading],
      );
      // 読みは辞書の別名になるので、覚えてある辞書を捨てる
      for (const t of set) invalidateDictionary(t.tenant_id);
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
  // 売場を送ってこなければ、いまの版の売場を引き継ぐ（売場の欄が無い古い画面から直しても、印が消えないように）
  const areaIds = input.areaIds ?? (await maybeOne<{ area_ids: string[] }>(
    db, `SELECT area_ids FROM knowledge_versions WHERE knowledge_id = $1 AND version = $2`, [id, k.current_version],
  ))?.area_ids ?? [];
  // 期限を指定しなければ今の期限を引き継ぐ。どちらの場合も公開（承認）されるまで効かない
  const expiresAt = input.expiresAt !== undefined ? input.expiresAt : k.expires_at;
  await assertNotExpired(db, expiresAt);
  const tagIds = await resolveTags(db, actor, input.tagNames);
  const version = await nextVersion(db, id);
  // 同じ人の案は最新の1つだけ残す。直すたびに積まれると承認者が同じ人の案を何本も見ることになり、
  // 本人も最新がどれか分からなくなる。閉じるのは本人の案だけで、他人の案は触らない
  await db.query(
    `UPDATE knowledge_versions SET state = 'superseded' WHERE knowledge_id = $1 AND edited_by = $2 AND state = 'pending'`,
    [id, actor.userId],
  );
  await insertVersion(db, actor, id, version, {
    title: input.title.trim(), body: input.body, tagIds, areaIds, expiresAt,
  }, k.current_version);
  // 前の案と一緒に待っていた本人の写真は、出し直した案に付け替える（前の案は上で閉じた）
  await db.query(
    `UPDATE knowledge_photos SET pending_version = $3
      WHERE knowledge_id = $1 AND created_by = $2 AND pending_version IS NOT NULL AND state <> 'discarded'`,
    [id, actor.userId, version],
  );
  const published = isTrusted(actor);
  if (published) await publish(db, tokenizer, actor, id, version);
  await settlePhotos(db, id);
  await syncApprovalNotice(db, actor.tenantId, k.store_id);
  return { id, version, published };
}

export async function approveVersion(db: Db, tokenizer: Tokenizer, actor: Actor, id: string, version: number) {
  const k = await load(db, id, true);
  assert(canModerate(actor, k.store_id), 'forbidden', '承認する権限がありません');
  const v = await maybeOne<{ state: string; base_version: number | null; expired: boolean }>(
    db,
    `SELECT state, base_version, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
       FROM knowledge_versions WHERE knowledge_id = $1 AND version = $2`,
    [id, version],
  );
  assert(v !== undefined, 'not_found', '版が見つかりません');
  assert(v.state === 'pending', 'conflict', 'この版は承認待ちではありません');
  // 公開してもすぐ expired になるだけなので、期限を直してもらってから通す
  assert(!v.expired, 'conflict', 'この案は有効期限が過ぎています。期限を直してから承認してください');
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
  await settlePhotos(db, id);
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
  // 却下した案と一緒に待っていた写真は捨てる（残すと、通らなかった案の写真だけが出続ける）
  await settlePhotos(db, id);
  // 一度も公開されていないナレッジの唯一の案を却下した場合、pending のタグも辞書に入らないまま残る
  await syncApprovalNotice(db, actor.tenantId, k.store_id);
  return { id, version };
}

/** 過去版の内容で新しい版を作って公開する（履歴は消さない）。 */
export async function revertToVersion(db: Db, tokenizer: Tokenizer, actor: Actor, id: string, version: number) {
  const k = await load(db, id, true);
  assert(canModerate(actor, k.store_id), 'forbidden', '過去版に戻す権限がありません');
  const old = await maybeOne<{ title: string; body: string; tag_ids: string[]; area_ids: string[]; expires_at: string | null; state: string; was_published: boolean; expired: boolean }>(
    db,
    `SELECT title, body, tag_ids, area_ids, expires_at::text AS expires_at, state,
            (decided_at IS NOT NULL) AS was_published,
            (expires_at IS NOT NULL AND expires_at <= now()) AS expired
       FROM knowledge_versions WHERE knowledge_id = $1 AND version = $2`,
    [id, version],
  );
  assert(old !== undefined, 'not_found', '版が見つかりません');
  // 戻せるのは一度公開された版だけ。承認待ち・却下の案を戻しで公開すると承認を飛ばせてしまう。
  // 過去版（superseded）には、公開されないまま閉じられた案も混ざる。公開されたものには、承認した日時が残っている
  assert((old.state === 'superseded' || old.state === 'published') && old.was_published, 'conflict', '一度も公開されていない版には戻せません');
  const next = await nextVersion(db, id);
  await insertVersion(db, actor, id, next, {
    title: old.title, body: old.body,
    // 統合済みのタグは統合先に置き換える。そのまま戻すと詳細に統合元の古い名前が出る
    tagIds: await canonicalTagIds(db, old.tag_ids), areaIds: old.area_ids,
    // その版に付いていた期限がもう過ぎていたら、いまの期限を引き継ぐ（戻したとたんに検索から外れないように）
    expiresAt: old.expired ? k.expires_at : old.expires_at,
  }, k.current_version);
  // 戻すと、いま承認待ちの案は閉じられる。approveVersion と同じく、閉じた案を返して黙って消さない
  const closing = await db.query<{ version: number; editor: string | null }>(
    `SELECT v.version, u.name AS editor
       FROM knowledge_versions v LEFT JOIN users u ON u.id = v.edited_by
      WHERE v.knowledge_id = $1 AND v.state = 'pending' AND v.version < $2`,
    [id, next],
  );
  await publish(db, tokenizer, actor, id, next);
  await settlePhotos(db, id);
  await syncApprovalNotice(db, actor.tenantId, k.store_id);
  return { id, version: next, closed: closing.map((c) => ({ version: c.version, editedBy: c.editor })) };
}

export async function getKnowledge(db: Db, actor: Actor, id: string): Promise<KnowledgeView> {
  const k = await load(db, id);
  assert(canAccessStore(actor, k.store_id), 'forbidden', 'このナレッジは閲覧できません');
  // 公開中の版。未公開なら最新の案（投稿者本人と承認者だけが見られる）
  const v = await maybeOne<{ version: number; state: string; title: string; body: string; tag_ids: string[]; area_ids: string[]; edited_by: string; edited_at: string; editor: string | null; approver: string | null; decided_at: string | null; expires_at: string | null }>(
    db,
    `SELECT version, state, title, body, tag_ids, area_ids, edited_by, edited_at::text AS edited_at, expires_at::text AS expires_at,
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
    assert(
      v.edited_by === actor.userId || canModerate(actor, k.store_id), 'forbidden',
      k.status === 'expired' ? 'このナレッジは有効期限が過ぎたので、いまは出していません' : 'このナレッジはまだ公開されていません',
    );
  }
  const tags = await db.query<{ name: string }>(
    `SELECT name FROM hashtags WHERE id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], id)`,
    [v.tag_ids],
  );
  const meta = await one<{ verified_at: string | null; verified_by: string | null; created_by: string | null; created_by_id: string }>(
    db,
    `SELECT k.verified_at::text AS verified_at, u.name AS verified_by, cu.name AS created_by, k.created_by AS created_by_id
       FROM knowledge k
       LEFT JOIN users u  ON u.id  = k.verified_by
       LEFT JOIN users cu ON cu.id = k.created_by
      WHERE k.id = $1`,
    [id],
  );
  // 売場の印（付けていないものが大半なので、あるときだけ引く）
  const areas = v.area_ids.length === 0 ? [] : await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM areas WHERE id = ANY($1::uuid[]) ORDER BY name`, [v.area_ids],
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
    // 公開されたものは、いま効いている期限。まだ公開されていないものは、その案に付いている期限
    expiresAt: k.status === 'draft' ? v.expires_at : k.expires_at,
    areas,
    pendingEdits: pending.map((p) => ({ version: p.version, editedBy: p.editor, editedAt: p.edited_at, mine: p.mine })),
    // 期限切れ（expired）は、一度は公開されたもの。「承認待ち」とは言わない
    ...(k.status === 'draft' ? { draftState: v.state === 'rejected' ? 'rejected' as const : 'pending' as const } : {}),
    canDelete: await canDeleteKnowledge(db, actor, k),
    ...(await bookmarkState(db, actor, id, meta.created_by_id)),
  };
}

/** 書いた本人が、公開されたあとでも自分で消せる時間。書き間違いにすぐ気づいたときのため */
export const SELF_DELETE_HOURS = 24;

/**
 * このナレッジを消せるか。
 *
 *   全店共通           … 本部だけ
 *   店舗のナレッジ     … その店舗の店長・本部
 *   書いた本人         … まだ一度も公開されていないもの（取り下げ）と、公開から間もなく、ほかの人の手が入っていないもの
 *
 * 公開されてしばらく経ったものや、ほかの人が直したものは、店のみんなのものになっている。
 * 書いた人ひとりの判断で消せると、積み上げた内容がまとめて無くなりうるので、店長・本部に限る。
 */
async function canDeleteKnowledge(db: Db, actor: Actor, k: KnowledgeRow): Promise<boolean> {
  if (!canAccessStore(actor, k.store_id)) return false;
  if (k.store_id === null) return actor.adminScope === 'tenant';
  if (canAdminister(actor, k.store_id)) return true;
  const mine = await maybeOne<{ recent: boolean; touched: boolean; published: boolean }>(
    db,
    `SELECT k.created_at > now() - make_interval(hours => $3) AS recent,
            EXISTS (SELECT 1 FROM knowledge_versions v WHERE v.knowledge_id = k.id AND v.edited_by <> $2) AS touched,
            EXISTS (SELECT 1 FROM knowledge_versions v WHERE v.knowledge_id = k.id AND v.state IN ('published', 'superseded') AND v.decided_at IS NOT NULL) AS published
       FROM knowledge k WHERE k.id = $1 AND k.created_by = $2`,
    [k.id, actor.userId, SELF_DELETE_HOURS],
  );
  if (!mine || mine.touched) return false;
  return !mine.published || mine.recent;
}

/**
 * ナレッジを消す。過去の版・写真・ブックマークも一緒に消え、元に戻せない。
 *
 * 編集では、前の版が履歴に残る。お客様の個人情報などを書いてしまったときに、
 * 「直す」だけでは消えないので、丸ごと消す口を用意する。
 */
export async function deleteKnowledge(db: Db, storage: Storage, actor: Actor, id: string): Promise<{ ok: true }> {
  const k = await load(db, id, true);
  assert(canAccessStore(actor, k.store_id), 'forbidden', 'このナレッジは消せません');
  assert(
    await canDeleteKnowledge(db, actor, k), 'forbidden',
    k.store_id === null ? '全店共通のナレッジを消せるのは本部のみです' : '消せるのは、店長・本部か、書いて間もない本人だけです',
  );
  // 行は外部キーで消えるが、保存先の写真の実体は消えないので、先に集めておく
  const photos = await db.query<{ storage_key: string }>(`SELECT storage_key FROM knowledge_photos WHERE knowledge_id = $1`, [id]);
  await db.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
  // タグの使われ方が変わるので、辞書の覚えを捨てる。承認待ちの知らせも数え直す
  invalidateDictionary(actor.tenantId);
  await syncApprovalNotice(db, actor.tenantId, k.store_id);
  // 実体が消せなくても、消したことは成立させる。行は無くなって実体だけ残るので、キーと理由を残す
  for (const p of photos) await storage.remove(p.storage_key).catch((err) => console.warn('写真の実体を消せませんでした', { key: p.storage_key, err }));
  return { ok: true };
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
  return db.query<{ version: number; state: string; title: string; body: string; edited_at: string; edited_by: string; decided_by: string | null; decided_at: string | null; can_revert: boolean }>(
    // 承認・却下した人も出す。承認した人がその内容に責任を持つため、誰が通したかを残す
    `SELECT v.version, v.state, v.title, v.body, v.edited_at, u.name AS edited_by,
            du.name AS decided_by, v.decided_at,
            -- 戻せるのは、前に公開されていた版だけ（revertToVersion と同じ）。いま公開中の版には戻すまでもない
            (v.state = 'superseded' AND v.decided_at IS NOT NULL AND $2) AS can_revert
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
  return db.query<{ id: string; title: string; verified_at: string | null; verified_by: string | null; all_stores: boolean }>(
    `SELECT k.id, v.title, k.verified_at::text AS verified_at, u.name AS verified_by, (k.store_id IS NULL) AS all_stores
       FROM knowledge k
       JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version
       LEFT JOIN users u ON u.id = k.verified_by
      -- 全店共通のものは、直せる本部にだけ出す（ほかの人に出しても、確かめたと記録できない）
      WHERE k.status = 'published' AND (k.store_id = $1 OR (k.store_id IS NULL AND $3))
        AND greatest(k.verified_at, v.edited_at) < now() - make_interval(days => $2)
      ORDER BY greatest(k.verified_at, v.edited_at)`,
    [storeId, days, actor.adminScope === 'tenant'],
  );
}

/**
 * 有効期限が過ぎて、検索から外れたナレッジ（承認できる人が、期限を直して出し直すか、そのままにするかを決める）。
 * 期限を付けて出したものは、過ぎると検索にも一覧にも出なくなる。ここに並べないと、直す入口が無い。
 */
export async function listExpired(db: Db, actor: Actor, storeId: string) {
  assert(canModerate(actor, storeId), 'forbidden', '期限切れの一覧を見る権限がありません');
  return db.query<{ id: string; title: string; expires_at: string; all_stores: boolean }>(
    `SELECT k.id, v.title, k.expires_at::text AS expires_at, (k.store_id IS NULL) AS all_stores
       FROM knowledge k
       JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version
      WHERE k.status = 'expired' AND (k.store_id = $1 OR (k.store_id IS NULL AND $2))
      ORDER BY k.expires_at DESC
      LIMIT 100`,
    [storeId, actor.adminScope === 'tenant'],
  );
}

export interface MyPost {
  id: string;
  title: string;
  /**
   * waiting … 新しく書いたものが承認待ち / rejected … 承認されなかった /
   * editWaiting … 公開中のものへの修正案が承認待ち / editRejected … 修正案が承認されなかった /
   * editClosed … 修正案が、ほかの修正が先に公開されたために閉じられた /
   * published … 公開中 / expired … 有効期限が過ぎた
   */
  state: 'waiting' | 'rejected' | 'editWaiting' | 'editRejected' | 'editClosed' | 'published' | 'expired';
  /** 自分が最後に手を入れた日時 */
  at: string;
  allStores: boolean;
}

/**
 * 自分が書いたもの・直したものの一覧（この店舗と全店共通。新しい順に50件）。
 *
 * 承認待ちのもの・承認されなかったものは、検索に出ない。書いた本人がそこへ戻る道が、ほかに無い。
 */
export async function listMyPosts(db: Db, actor: Actor, storeId: string): Promise<MyPost[]> {
  assert(canAccessStore(actor, storeId), 'forbidden', 'この店舗のナレッジは見られません');
  const rows = await db.query<{ id: string; status: string; title: string; mine_state: string; mine_published: boolean; at: string; all_stores: boolean }>(
    `SELECT k.id, k.status, coalesce(cur.title, mine.title) AS title, mine.state AS mine_state,
            (mine.decided_at IS NOT NULL) AS mine_published,
            mine.edited_at::text AS at, (k.store_id IS NULL) AS all_stores
       FROM knowledge k
       -- 自分が最後に書いた版
       JOIN LATERAL (
         SELECT v.title, v.state, v.edited_at, v.decided_at FROM knowledge_versions v
          WHERE v.knowledge_id = k.id AND v.edited_by = $2
          ORDER BY v.version DESC LIMIT 1) mine ON true
       LEFT JOIN knowledge_versions cur ON cur.knowledge_id = k.id AND cur.version = k.current_version
      WHERE (k.store_id = $1 OR k.store_id IS NULL)
      ORDER BY mine.edited_at DESC
      LIMIT 50`,
    [storeId, actor.userId],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    state: r.status === 'expired' ? 'expired'
      : r.status === 'draft' ? (r.mine_state === 'rejected' ? 'rejected' : 'waiting')
      : r.mine_state === 'pending' ? 'editWaiting'
      : r.mine_state === 'rejected' ? 'editRejected'
      // 過去版（superseded）のうち、承認の日時が無いものは、公開されないまま閉じられた案
      : r.mine_state === 'superseded' && !r.mine_published ? 'editClosed'
      : 'published',
    at: r.at,
    allStores: r.all_stores,
  }));
}

/** 内容は変えずに「今も正しい」と確認した記録だけを残す（最終確認日・確認者を更新） */
export async function verifyKnowledge(db: Db, actor: Actor, id: string) {
  const k = await load(db, id, true);
  assert(canModerate(actor, k.store_id), 'forbidden', '確認する権限がありません');
  assert(k.status === 'published', 'conflict', '公開中のナレッジではありません');
  await db.query(`UPDATE knowledge SET verified_by = $2, verified_at = now() WHERE id = $1`, [id, actor.userId]);
  return { id };
}
