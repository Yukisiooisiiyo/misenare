-- 紹介サイト（tsugigami.app）の問い合わせフォームから届いた内容を控える。
--
-- メールで知らせるのが本筋だが、送信に失敗しても問い合わせを失わないよう、先にここへ残す。
-- 会社（テナント）に属さないデータなので、rate_limits と同じく行レベルセキュリティを付けない：
--   ・送ってくるのは利用者になる前の人で、会社はまだ無い
--   ・アプリの画面からは読ませない（読むのは運営だけ。psql で見る）
-- 1年たったものは夜間バッチが消す。

BEGIN;

CREATE TABLE contact_inquiries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  name       text NOT NULL,
  company    text,
  email      text NOT NULL,
  message    text NOT NULL,
  -- 知らせのメールを出せたか（出せていないものを後から拾えるように）
  mailed     boolean NOT NULL DEFAULT false
);

-- 古いものを消すとき・新しい順に見るとき用
CREATE INDEX contact_inquiries_by_time ON contact_inquiries (created_at);

COMMIT;
