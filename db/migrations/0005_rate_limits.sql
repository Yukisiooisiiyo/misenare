-- 試行回数の制限を、サーバーが複数台でも共有できるようにする。
--
-- 会社（テナント）に属さないデータなので、このテーブルだけ行レベルセキュリティを付けない：
--   ・数えるのはログインより前なので、そのとき会社はまだ分からない
--   ・中身は「接続元の印」と回数だけで、会社のデータは入らない
-- 接続元の IP はそのまま置かず、ハッシュにして持つ（鍵は MISENARE_RATE_SALT）。

BEGIN;

CREATE TABLE rate_limits (
  key          text NOT NULL,
  -- 窓の始まり。窓の幅ごとに切り下げた時刻
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- 古い窓を捨てるとき用
CREATE INDEX rate_limits_by_window ON rate_limits (window_start);

COMMIT;
