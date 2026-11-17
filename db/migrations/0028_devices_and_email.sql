-- 自分の端末を自分で見られるようにする。メールアドレスは、届くことを確かめてから登録する。
--
-- 端末（sessions）
--   origin          … どうやって増えたか。invite＝招待で登録／added＝管理者が端末を足した／self＝自分で出したリンク／
--                     email＝メールのログインリンク／passkey／sso。前からある行は NULL（分からない）
--   issued_by       … その鍵を出した人（招待・端末の追加）
--   devices_seen_at … この端末で「ほかの端末が増えたこと」をどこまで見たか。**端末ごと**に持つ。
--                     利用者ごとに持つと、こっそり足された端末の側で「見た」を押せば、本人の端末から知らせが消えてしまう
--
-- 招待（invitations）
--   purpose … 本人あてのメールで出したログインリンクは email_login（端末の一覧で見分けるため）
--
-- メールアドレスの確認（email_verifications）
--   打たれたアドレスに確認のリンクを送り、開かれたら登録する。届かないアドレス・他人のアドレスは登録されない
--
-- 利用者（users）
--   email_set_at / email_set_by_session … 本人の操作でメールアドレスが登録された日時と、申し込んだ端末。
--     登録したアドレスには、ログイン用のリンクが届く。ほかの端末に「登録されました」と知らせて、
--     身に覚えがなければ外せるようにする（申し込んだ端末には知らせない）

BEGIN;

ALTER TABLE sessions ADD COLUMN origin text CHECK (origin IN ('invite', 'added', 'self', 'email', 'passkey', 'sso'));
ALTER TABLE sessions ADD COLUMN issued_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN devices_seen_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE invitations ADD COLUMN purpose text CHECK (purpose IN ('email_login'));

ALTER TABLE users ADD COLUMN email_set_at timestamptz;
ALTER TABLE users ADD COLUMN email_set_by_session uuid;

CREATE TABLE email_verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       text NOT NULL,
  -- リンクに載せる鍵そのものは持たない（指紋だけ）
  token_hash  text NOT NULL UNIQUE,
  -- 申し込んだ端末（その端末には「登録されました」の知らせを出さない）
  session_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX email_verifications_by_user ON email_verifications (user_id);

ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_verifications
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMIT;
