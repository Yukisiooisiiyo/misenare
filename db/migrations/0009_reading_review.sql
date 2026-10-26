-- タグの読みを「人が確かめたもの」と「機械が出した案」に分ける。
--
-- なぜ分けるか：読みは別名として検索に使われる（「れいぞうこ」→ #冷蔵庫）。
-- 形態素解析器の読みは音読み訓読みの揺れや連濁で外すことがあり、
-- 間違ったまま登録すると、検索の土台に嘘が混ざる。
-- そこで **検索に使うのは reading（人が確かめたもの）だけ** にし、
-- 機械が出したものは reading_proposed に置いて確認待ちにする。
--
--   reading            確定した読み。検索に使う。NULL なら読みでは引けない
--   reading_proposed   機械が出した案。人が見るまで検索には使わない
--   reading_checked_at 人が見た時刻。「読みなし」と決めた場合も埋まる
--                      （埋まっていれば、もう案を出し直さない）
--   reading_checked_by 見た人

ALTER TABLE hashtags
  ADD COLUMN reading_proposed   text,
  ADD COLUMN reading_checked_at timestamptz,
  ADD COLUMN reading_checked_by uuid REFERENCES users(id);

-- すでに入っている読みは、自動で入ったのか人が決めたのか区別が付かない。
-- 安全側に倒して、全部「案」に移し、確認待ちにする。
-- これで、確かめていない読みが検索に効いている状態は無くなる。
--
-- hashtags は行レベルセキュリティの対象なので、会社ごとに app.tenant_id を
-- 立てて回す。素で UPDATE すると "unrecognized configuration parameter" で止まる。
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE hashtags
       SET reading_proposed = reading,
           reading = NULL
     WHERE reading IS NOT NULL;
  END LOOP;
END $$;

-- 確認待ちの一覧を引くための索引
CREATE INDEX hashtags_reading_pending_idx
    ON hashtags (tenant_id)
 WHERE reading_proposed IS NOT NULL AND reading_checked_at IS NULL;
