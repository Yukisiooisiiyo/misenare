-- 承認待ちの知らせを、メールではなく**連絡機能（notices）**に載せる。
--
-- 0015 ではメールで送るつもりだったが、**現場の人はメールアドレスを持っていない。**
-- 招待QRで入った人に email は入らず（domain/users.ts）、入るのは会社アカウント（SSO）で
-- 入った人だけ。承認するベテランの大半はQRで入るので、メールでは届かない。
-- 毎日開くアプリの連絡事項に出すのが、唯一確実に届く場所。

BEGIN;

-- 0015 で足した印は使わない。連絡事項そのものが残り続けるので、
-- 「前にいつ送ったか」を覚える必要がない
ALTER TABLE stores  DROP COLUMN approvals_notified_at;
ALTER TABLE tenants DROP COLUMN approvals_notified_at;

-- ミセナレが自動で出す連絡事項には、出した人がいない
ALTER TABLE notices ALTER COLUMN created_by DROP NOT NULL;

-- 誰に見せるか。承認待ちは承認できる人にしか意味がないので、visitor には出さない
ALTER TABLE notices ADD COLUMN audience text NOT NULL DEFAULT 'all'
  CHECK (audience IN ('all', 'trusted'));

-- 人が書いたものと、ミセナレが自動で出すものを分ける。
-- 自動のものは人が直せない（直しても次の投稿で書き換わるため）
ALTER TABLE notices ADD COLUMN kind text NOT NULL DEFAULT 'manual'
  CHECK (kind IN ('manual', 'approvals'));

-- 承認待ちの知らせは、店舗ごとに**1件だけ**。
-- 投稿のたびに増やすと、連絡事項が承認依頼で埋まって本来の連絡が沈む。
-- 1件を残して件数を書き換える。
CREATE UNIQUE INDEX notices_one_approvals
  ON notices (tenant_id, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE kind = 'approvals';

COMMIT;
