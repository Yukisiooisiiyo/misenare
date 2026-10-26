-- メールアドレスのドメインを、本当にその会社のものか確かめる。
--
-- なぜ要るか：入口は「打たれたアドレスのドメイン」で会社を決めている。
-- ドメインは世界で1社にしか割り当てられないので、**先に登録した会社が、
-- そのドメインの人の行き先を決められる**。
--
--   悪意のある（あるいは間違えた）会社 A が kdenki.co.jp を登録する
--     → ケーズデンキの社員がアドレスを打つと、A の IdP の画面へ送られる
--     → そこが本物に似せた入力欄なら、合言葉を取られる
--
-- 会社を作るのはこちら（運営）なので自己登録ではないが、
-- 複数のチェーンが同じサーバーに乗る以上、1社の管理者が他社の経路に手を伸ばせる
-- 状態は残せない。**DNS に印を置けた会社だけ**、そのドメインを使えるようにする。
-- （Google や Microsoft が同じことをしているのと同じ理由）

BEGIN;

-- 確かめるための印。ドメインごとに違う値
-- 乱数は gen_random_uuid から取る（pgcrypto を足さずに済む。122ビットあれば足りる）
ALTER TABLE sso_domains ADD COLUMN verify_token text NOT NULL
  DEFAULT replace(gen_random_uuid()::text, '-', '');
ALTER TABLE sso_domains ADD COLUMN verified_at timestamptz;
-- 最後に確かめに行った時刻（連打を止めるため）
ALTER TABLE sso_domains ADD COLUMN checked_at timestamptz;

-- すでに入っているものは、確かめ済みにしておく（この版より前に登録したぶん）。
-- 新しく足すものは、確かめるまで使えない。
UPDATE sso_domains SET verified_at = now() WHERE verified_at IS NULL;

COMMIT;
