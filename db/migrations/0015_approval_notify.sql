-- 承認待ちが溜まっていることを、承認できる人（trusted 以上）に知らせるための印。
--
-- **1件ごとには送らない。** 忙しい売場で1件ごとにメールが飛ぶと、通知を切られる。
-- 切られた時点で仕組みごと死ぬので、利用の申請（0013）と同じ考え方にする：
-- 「新しい承認待ちが来たとき」と「週に1回の念押し」だけ。
-- そのために、前回いつ知らせたかを覚えておく。
--
-- 店舗ナレッジは店舗ごと、全店共通ナレッジは会社ごとに数える（承認できる人が違うため）。

BEGIN;

ALTER TABLE stores  ADD COLUMN approvals_notified_at timestamptz;
ALTER TABLE tenants ADD COLUMN approvals_notified_at timestamptz;

COMMIT;
