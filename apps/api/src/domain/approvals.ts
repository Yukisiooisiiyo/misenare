// 承認待ちが溜まっていることを、承認できる人（trusted 以上）に知らせる。
//
// **1件ごとには送らない。** 忙しい売場で1件ごとにメールが飛ぶと、受け取る側は通知を切る。
// 切られた時点でこの仕組みは死ぬので、利用の申請（accessRequests）と同じ形にする：
// **新しい承認待ちが来たとき**と、**週に1回の念押し**だけ。
//
// 宛先はその店舗の trusted 以上。全店共通ナレッジを承認できるのは本部だけなので
// （actor.ts の canModerate を参照）、そのぶんは本部の管理者へ送る。
//
// 1通に全員のアドレスを並べると互いのアドレスが見えてしまうので、**1人ずつ送る**。
// 送る相手が多すぎるときは送らない（下の MAX_RECIPIENTS）。画面のバッジが残るので、
// 気づけなくなるわけではない。

import { type Db } from '../db/db.ts';

/** 1通に出す見本の数。全部並べると長くなるうえ、題名の一覧がメールで回ることになる */
const SAMPLES = 5;

/**
 * 1店舗あたりの宛先の上限。
 * 大きな店で trusted が何十人もいると、毎晩その人数ぶんメールが出る。
 * 外に出すメールの本数は、無料の中継業者だと1日の上限にすぐ当たる。
 * ここを超える店舗には送らず、画面の承認待ち一覧に任せる。
 */
export const MAX_RECIPIENTS = 20;

/** 新しいものが来なくても、これだけ経ったらもう一度知らせる */
export const APPROVAL_REMINDER_DAYS = 7;

export interface ApprovalDigest {
  /** 店舗。全店共通ナレッジのぶんは null */
  storeId: string | null;
  storeName: string | null;
  to: string[];
  pending: number;
  samples: Array<{ title: string; editedBy: string }>;
  notifiedAt: string | null;
  /** 前に知らせてから、新しい承認待ちが来たか */
  hasNew: boolean;
  /** 宛先が多すぎて送らない場合に true（画面のバッジに任せる） */
  tooMany: boolean;
}

interface PendingRow {
  store_id: string | null;
  title: string;
  edited_at: string;
  edited_by: string;
}

/**
 * 承認できる人のメールアドレス。店舗ぶんは所属者、全店共通ぶんは本部。
 *
 * 注：**いまの作りでは全店共通に承認待ちが生まれない。** 全店共通を作るのも直すのも
 * 本部だけで（knowledge.ts）、本部は常に trusted 扱いなのでその場で公開されるため。
 * つまり全店共通は「本部が作って配る」形のままで、現場から上げる経路が無い。
 * storeId === null の枝は、そこに経路を足したとき（店舗ナレッジの昇格申請など）のために置く。
 */
async function recipients(db: Db, storeId: string | null): Promise<string[]> {
  const rows = storeId === null
    ? await db.query<{ email: string }>(
      `SELECT DISTINCT email FROM users
        WHERE status = 'active' AND email IS NOT NULL AND admin_scope = 'tenant'
        ORDER BY email`,
    )
    : await db.query<{ email: string }>(
      `SELECT DISTINCT u.email FROM users u
         JOIN memberships m ON m.user_id = u.id
        WHERE m.store_id = $1 AND u.status = 'active' AND u.email IS NOT NULL
          AND (u.trust_level = 'trusted' OR u.admin_scope <> 'none')
        ORDER BY u.email`,
      [storeId],
    );
  return rows.map((r) => r.email);
}

/**
 * 店舗ごとの「承認待ちが何件あるか」。
 * 承認待ちが1件も無い店舗は返さない（知らせることが無いため）。
 */
export async function pendingApprovals(db: Db): Promise<ApprovalDigest[]> {
  const rows = await db.query<PendingRow>(
    `SELECT k.store_id, v.title, v.edited_at::text AS edited_at, u.name AS edited_by
       FROM knowledge_versions v
       JOIN knowledge k ON k.id = v.knowledge_id
       JOIN users u ON u.id = v.edited_by
      WHERE v.state = 'pending'
      ORDER BY v.edited_at DESC`,
  );
  if (rows.length === 0) return [];

  const byStore = new Map<string | null, PendingRow[]>();
  for (const r of rows) {
    const list = byStore.get(r.store_id);
    if (list === undefined) byStore.set(r.store_id, [r]);
    else list.push(r);
  }

  const digests: ApprovalDigest[] = [];
  for (const [storeId, list] of byStore) {
    const to = await recipients(db, storeId);
    const mark = storeId === null
      ? await db.query<{ at: string | null; name: string | null }>(
        `SELECT approvals_notified_at::text AS at, NULL::text AS name FROM tenants LIMIT 1`,
      )
      : await db.query<{ at: string | null; name: string | null }>(
        `SELECT approvals_notified_at::text AS at, name FROM stores WHERE id = $1`,
        [storeId],
      );
    const notifiedAt = mark[0]?.at ?? null;
    const since = notifiedAt === null ? null : new Date(notifiedAt).getTime();
    digests.push({
      storeId,
      storeName: mark[0]?.name ?? null,
      to: to.slice(0, MAX_RECIPIENTS),
      pending: list.length,
      samples: list.slice(0, SAMPLES).map((r) => ({ title: r.title, editedBy: r.edited_by })),
      notifiedAt,
      hasNew: since === null ? true : list.some((r) => new Date(r.edited_at).getTime() > since),
      tooMany: to.length > MAX_RECIPIENTS,
    });
  }
  return digests;
}

export function shouldNotifyApprovals(digest: ApprovalDigest, now = Date.now()): boolean {
  if (digest.tooMany || digest.to.length === 0 || digest.pending === 0) return false;
  if (digest.hasNew) return true;
  if (digest.notifiedAt === null) return true;
  const elapsed = now - new Date(digest.notifiedAt).getTime();
  return elapsed >= APPROVAL_REMINDER_DAYS * 24 * 60 * 60_000;
}

export async function markApprovalsNotified(db: Db, storeId: string | null): Promise<void> {
  if (storeId === null) await db.query(`UPDATE tenants SET approvals_notified_at = now()`);
  else await db.query(`UPDATE stores SET approvals_notified_at = now() WHERE id = $1`, [storeId]);
}

/**
 * 知らせの文面。
 *
 * 題名と書いた人の名前を載せるのは、開く前に「自分が見るべきものか」を判断できるように
 * するため。中身（本文）は載せない。メールに本文が流れると、取り消しが効かない。
 */
export function approvalMail(digest: ApprovalDigest, appUrl: string): { subject: string; text: string } {
  const where = digest.storeId === null ? '全店共通のナレッジ' : `${digest.storeName ?? 'お店'}のナレッジ`;
  const lines = [
    `${where}で、承認をお待ちの下書きが ${digest.pending} 件あります。`,
    '',
    ...digest.samples.map((s) => `  ・${s.title}（${s.editedBy}さん）`),
    ...(digest.pending > digest.samples.length ? [`  ほか ${digest.pending - digest.samples.length} 件`] : []),
    '',
    '内容を見て、合っていれば公開、違っていれば直すか却下してください。',
    `  ${appUrl}/app/#/manage`,
    '',
    '※ 承認するまで、この下書きは検索に出ません。',
    '※ 間違いを見つけたときは、却下ではなく**書いた人に伝えてから**直すほうが、次から精度が上がります。',
    '',
    'このメールはミセナレが自動で送っています。返信は不要です。',
    '毎回は送りません（新しい下書きが来たときと、週に1回だけ）。',
  ];
  return {
    subject: `【ミセナレ】承認待ちが${digest.pending}件あります`,
    text: lines.join('\n'),
  };
}
