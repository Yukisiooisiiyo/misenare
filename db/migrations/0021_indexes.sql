-- 索引が無いために全件を舐めていた WHERE に索引を足す（性能計測で洗い出したもの）。
--
-- いまは行が少ないので Seq Scan でも速いが、タグ5,000件で検索が 15ms → 45ms に伸びた。
-- 件数に比例して遅くなる読み方を、先に索引で止めておく。
-- どれも**既存の索引は変えず、足すだけ**（書き込みは索引の分だけ僅かに増える）。
--
--   hashtags (tenant_id, state)         辞書の読み込み（WHERE state='active'）。検索・バーコード・投稿で毎回走る
--   tag_relations (tenant_id, state)    同じく WHERE state='approved'。既存の部分索引は kind 条件付きで使えない
--   knowledge (tenant_id, store_id)     検索の範囲づくり・承認待ち・古いナレッジの WHERE。
--     WHERE status='published'          公開中だけを引く問い合わせなので、部分索引で小さく保つ
--   search_logs (tenant_id, store_id, created_at)
--     WHERE result_count = 0            0件検索の一覧（WHERE store_id=…）。既存の search_logs_zero_hits は
--                                       store_id を持たないので、店舗で絞る分は別に持つ（既存は残す）
--   hashtags (tenant_id, use_count DESC)
--     WHERE 読み未確認                  読みの確認待ち（使われている数の多い順）。既存の
--                                       hashtags_reading_pending_idx は「案がある行」用で、この条件とは別
--   memberships (store_id)              連絡の承認数の副問合せ。主キーが (user_id, store_id) で、
--                                       store_id から引くと Seq Scan になっていた

BEGIN;

CREATE INDEX hashtags_by_state ON hashtags (tenant_id, state);
CREATE INDEX tag_relations_by_state ON tag_relations (tenant_id, state);
CREATE INDEX knowledge_published_by_store ON knowledge (tenant_id, store_id) WHERE status = 'published';
CREATE INDEX search_logs_zero_hits_by_store ON search_logs (tenant_id, store_id, created_at) WHERE result_count = 0;
CREATE INDEX hashtags_reading_todo ON hashtags (tenant_id, use_count DESC)
  WHERE cardinality(readings) = 0 AND reading_checked_at IS NULL;
CREATE INDEX memberships_by_store ON memberships (store_id);

COMMIT;
