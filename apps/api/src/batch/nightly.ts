// 夜間バッチ。会社（テナント）ごとに次を行う。
//   1. 期限切れのナレッジを expired にして索引から外す
//   2. 「もしかして」で選ばれた組み合わせから、同義の候補を作る（承認は人が行う）
//   3. 外部の候補提供元（Sudachi の同義語辞書・日本語WordNet・単語ベクトルなど）があれば、その候補も加える
//   4. タグ辞書が変わっても索引が古いままにならないよう、公開ナレッジを索引し直す
//   5. タグの使用回数を数え直す
//   6. トークナイザーが読みを返せるなら、読みの無いタグに読みを付ける（かな入力で漢字のタグを引くため）
//   7. 送りかけのまま残った写真を片付ける
//   8. 古い試行回数の記録を捨てる（会社に属さないので、会社ごとの処理の前に1回）
//   9. 持ち越しの期間を過ぎた引き継ぎを閉じる
//
// 実行：DATABASE_URL=... npx tsx apps/api/src/batch/nightly.ts （毎晩1回、cron や EventBridge から）

import type { Tokenizer } from '@misenare/search-core';
import type { Database, Db } from '../db/db.ts';
import { indexKnowledge } from '../domain/indexer.ts';
import { closeStaleHandovers } from '../domain/handovers.ts';
import { STALE_DAYS } from '../domain/knowledge.ts';
import { sweepAbandonedPhotos } from '../domain/photos.ts';
import { sweepChallenges } from '../domain/passkeys.ts';
import { sweepRateLimits } from '../http/rateLimit.ts';
import type { Storage } from '../storage/storage.ts';

export interface BatchOptions {
  /** 「もしかして」で同じ組み合わせが何回選ばれたら候補にするか */
  pickedThreshold?: number;
  /** 何日分の検索ログを見るか */
  logDays?: number;
  /** 1社あたり1晩で索引し直す上限（超えた分は翌晩に回る） */
  maxReindex?: number;
  /** 外部の候補提供元 */
  candidateProviders?: CandidateProvider[];
  /** 写真の保存先（送りかけのまま残った中身を片付けるのに使う） */
  storage?: Storage;
}

/**
 * 同義・包含の候補を出す外部の仕組み（Sudachi の同義語辞書、日本語WordNet、単語ベクトルなど）。
 * 候補を出すだけで、承認は管理画面で人が行う。モデルは夜間バッチの中だけで読み込む。
 */
export interface CandidateProvider {
  name: 'dictionary' | 'vector';
  propose(tags: Array<{ id: string; name: string }>): Promise<Array<{ kind: 'synonym' | 'includes'; fromTagId: string; toTagId: string; score: number }>>;
}

export interface TenantReport {
  tenantId: string;
  expired: number;
  candidatesFromLogs: number;
  candidatesFromProviders: number;
  reindexed: number;
  staleKnowledge: number;
  readingsFilled: number;
  /** 送りかけのまま残って片付けた写真 */
  sweptPhotos: number;
  /** 持ち越しの期間を過ぎた引き継ぎ */
  closedHandovers: number;
}

/** トークナイザーが読みを返せるなら（kuromoji など）、読みの無いタグに読みを付ける */
async function fillReadings(db: Db, tokenizer: Tokenizer): Promise<number> {
  if (!tokenizer.reading) return 0;
  const tags = await db.query<{ id: string; name: string }>(`SELECT id, name FROM hashtags WHERE reading IS NULL AND state = 'active'`);
  let filled = 0;
  for (const t of tags) {
    const r = tokenizer.reading(t.name);
    if (!r) continue;
    await db.query(`UPDATE hashtags SET reading = $2 WHERE id = $1`, [t.id, r]);
    filled++;
  }
  return filled;
}

/** 期限切れのナレッジを expired にし、索引から外す */
async function expireKnowledge(db: Db, tokenizer: Tokenizer): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `UPDATE knowledge SET status = 'expired'
      WHERE status = 'published' AND expires_at IS NOT NULL AND expires_at <= now()
      RETURNING id`,
  );
  for (const { id } of rows) await indexKnowledge(db, tokenizer, id);
  return rows.length;
}

/**
 * 「もしかして」の選択ログ（suggested_tag_id の候補として picked_tag_id が選ばれた）を集計し、
 * 一定回数以上の組み合わせを同義の候補にする。すでに何かの関係（却下も含む）があるものは作らない。
 */
async function candidatesFromPickedLogs(db: Db, tenantId: string, threshold: number, days: number): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `WITH picks AS (
       SELECT least(suggested_tag_id, picked_tag_id) AS a, greatest(suggested_tag_id, picked_tag_id) AS b, count(*)::int AS n
         FROM search_logs
        WHERE suggested_tag_id IS NOT NULL AND picked_tag_id IS NOT NULL
          AND suggested_tag_id <> picked_tag_id
          AND created_at > now() - make_interval(days => $2)
        GROUP BY 1, 2
       HAVING count(*) >= $3
     )
     INSERT INTO tag_relations (tenant_id, kind, from_tag_id, to_tag_id, state, source, evidence)
     SELECT $1, 'synonym', p.a, p.b, 'candidate', 'picked_log', p.n
       FROM picks p
       JOIN hashtags ha ON ha.id = p.a AND ha.state = 'active'
       JOIN hashtags hb ON hb.id = p.b AND hb.state = 'active'
      WHERE NOT EXISTS (
        SELECT 1 FROM tag_relations r
         WHERE r.kind <> 'alias'
           AND ((r.from_tag_id = p.a AND r.to_tag_id = p.b) OR (r.from_tag_id = p.b AND r.to_tag_id = p.a))
      )
     RETURNING id`,
    [tenantId, days, threshold],
  );
  return rows.length;
}

async function candidatesFromProviders(db: Db, tenantId: string, providers: CandidateProvider[]): Promise<number> {
  if (providers.length === 0) return 0;
  const tags = await db.query<{ id: string; name: string }>(`SELECT id, name FROM hashtags WHERE state = 'active'`);
  let created = 0;
  for (const p of providers) {
    for (const c of await p.propose(tags)) {
      if (c.fromTagId === c.toTagId) continue;
      const rows = await db.query(
        `INSERT INTO tag_relations (tenant_id, kind, from_tag_id, to_tag_id, state, source, evidence)
         SELECT $1, $2, $3, $4, 'candidate', $5, $6
          WHERE NOT EXISTS (
            SELECT 1 FROM tag_relations r WHERE r.kind <> 'alias'
               AND ((r.from_tag_id = $3 AND r.to_tag_id = $4) OR (r.from_tag_id = $4 AND r.to_tag_id = $3)))
         RETURNING id`,
        [tenantId, c.kind, c.fromTagId, c.toTagId, p.name, Math.round(c.score * 100)],
      );
      created += rows.length;
    }
  }
  return created;
}

/** 索引が古い順に（knowledge_stats が無いもの、つまり未索引を先に）索引し直す */
async function reindex(db: Db, tokenizer: Tokenizer, limit: number): Promise<number> {
  const ids = await db.query<{ id: string }>(
    `SELECT k.id FROM knowledge k
      WHERE k.status = 'published'
      ORDER BY (SELECT 1 FROM knowledge_stats s WHERE s.knowledge_id = k.id) NULLS FIRST, k.verified_at
      LIMIT $1`,
    [limit],
  );
  for (const { id } of ids) await indexKnowledge(db, tokenizer, id);
  return ids.length;
}

export async function runNightly(database: Database, tokenizer: Tokenizer, options: BatchOptions = {}): Promise<TenantReport[]> {
  // 会社に属さない片付け（試行回数の記録）は、会社ごとの処理の前に1回だけ
  await sweepRateLimits((sql, params) => database.raw(sql, params)).catch((err) => console.error('rate_limits の片付けに失敗', err));
  await sweepChallenges((sql, params) => database.raw(sql, params)).catch((err) => console.error('期限切れの合言葉の片付けに失敗', err));
  const tenants = (await database.raw(`SELECT id FROM tenants ORDER BY created_at`)) as Array<{ id: string }>;
  const reports: TenantReport[] = [];
  for (const { id: tenantId } of tenants) {
    // 会社ごとに別のトランザクション。1社の失敗が他社の処理を止めないようにする
    try {
      const report = await database.withTenant(tenantId, async (db) => {
        const expired = await expireKnowledge(db, tokenizer);
        const fromLogs = await candidatesFromPickedLogs(db, tenantId, options.pickedThreshold ?? 3, options.logDays ?? 30);
        const fromProviders = await candidatesFromProviders(db, tenantId, options.candidateProviders ?? []);
        const reindexed = await reindex(db, tokenizer, options.maxReindex ?? 5000);
        const readingsFilled = await fillReadings(db, tokenizer);
        const sweptPhotos = options.storage ? await sweepAbandonedPhotos(db, options.storage) : 0;
        const closedHandovers = await closeStaleHandovers(db);
        await db.query(
          `UPDATE hashtags h SET use_count =
             (SELECT count(*) FROM knowledge_tags kt WHERE kt.hashtag_id = h.id) +
             (SELECT count(*) FROM product_tags pt WHERE pt.hashtag_id = h.id)`,
        );
        // 「古い」の日数は1か所（domain/knowledge.ts の STALE_DAYS）で決める
        const stale = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM knowledge k
             JOIN knowledge_versions v ON v.knowledge_id = k.id AND v.version = k.current_version
            WHERE k.status = 'published'
              AND greatest(k.verified_at, v.edited_at) < now() - make_interval(days => $1)`,
          [STALE_DAYS],
        );
        return { tenantId, expired, candidatesFromLogs: fromLogs, candidatesFromProviders: fromProviders, reindexed, staleKnowledge: stale[0]!.n, readingsFilled, sweptPhotos, closedHandovers };
      });
      reports.push(report);
    } catch (err) {
      console.error(`tenant ${tenantId}: nightly batch failed`, err);
    }
  }
  return reports;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { chooseTokenizer } = await import('../search/kuromojiTokenizer.ts');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL を設定してください');
  const database = process.env.DB_DRIVER === 'psql'
    ? new (await import('../db/psqlDatabase.ts')).PsqlDatabase(url)
    : new (await import('../db/pgDatabase.ts')).PgDatabase(url);
  const { assertRlsEnforced } = await import('../db/safety.ts');
  await assertRlsEnforced((sql) => database.raw(sql));
  const { storageFromEnv } = await import('../storage/storage.ts');
  const reports = await runNightly(database, await chooseTokenizer(), { storage: storageFromEnv() });
  console.log(JSON.stringify(reports, null, 2));
  await database.close();
}
