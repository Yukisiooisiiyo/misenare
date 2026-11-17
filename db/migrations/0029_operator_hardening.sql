-- 運営者の管理画面の守りを足す。
--
--   ・2段階の確認（認証アプリの6桁のコード）と、予備のコード
--   ・ログインの記録（成功も失敗も）。アドレスごとの失敗の数え取りにも使う
--   ・前に入ったことのあるブラウザーの印（知らないブラウザーからのログインを知らせる／外からの締め出しを防ぐ）
--   ・プランは「試用」と「契約」の2つにする（料金を店舗数にかかわらず一律にしたので、段階の名前が要らなくなった）
--
-- どれも会社（テナント）に属さないので、0024 の運営者の表と同じく行レベルセキュリティを付けない。

BEGIN;

-- 認証アプリと分け合う鍵（secretBox で包んだ値）。totp_enabled_at が入るまでは、設定の途中
ALTER TABLE operators ADD COLUMN totp_secret text;
ALTER TABLE operators ADD COLUMN totp_enabled_at timestamptz;
-- 最後に通したコードの、時刻の刻み。同じコードをもう一度使わせない
ALTER TABLE operators ADD COLUMN totp_last_step bigint;
-- 「受け付けを止めました」の知らせを最後に送った時刻（打たれ続けても、知らせは1日に1通まで）
ALTER TABLE operators ADD COLUMN lock_notified_at timestamptz;

-- 認証アプリを使えないときのための、1回限りのコード
CREATE TABLE operator_recovery_codes (
  code_hash   text PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  used_at     timestamptz
);
CREATE INDEX operator_recovery_codes_by_operator ON operator_recovery_codes (operator_id);

-- 前に入ったことのあるブラウザーの印。ブラウザーには HttpOnly のクッキーで持たせ、ここにはハッシュを置く。
-- これだけでは入れない（パスワードと確認コードは毎回要る）。
CREATE TABLE operator_devices (
  token_hash   text PRIMARY KEY,
  operator_id  uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  -- この印を付けたまま続けて間違えた回数。重なったら印を捨てる
  failures     integer NOT NULL DEFAULT 0
);
CREATE INDEX operator_devices_by_operator ON operator_devices (operator_id);

-- ログインの記録。90日たったものは夜間バッチが消す
CREATE TABLE operator_logins (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  -- 打ち込まれたアドレス（小文字）。アドレスの形をしていないものは残さない（パスワードの打ち間違いを控えないため）
  email       text NOT NULL,
  operator_id uuid REFERENCES operators(id) ON DELETE SET NULL,
  -- ok: 入れた / password: アドレスかパスワードが違う / code: 確認コードが違う / locked: 受け付けを止めている間に来た
  outcome     text NOT NULL CHECK (outcome IN ('ok', 'password', 'code', 'locked')),
  -- 前に入ったことのあるブラウザーからか
  known       boolean NOT NULL DEFAULT false,
  ip          text,
  agent       text
);
CREATE INDEX operator_logins_by_email ON operator_logins (email, at);
CREATE INDEX operator_logins_by_time ON operator_logins (at);

-- プラン：試用（trial）と契約（standard）の2つにまとめる
ALTER TABLE tenants DROP CONSTRAINT tenants_plan_check;
UPDATE tenants SET plan = 'standard' WHERE plan IN ('lite', 'chain');
ALTER TABLE tenants ADD CONSTRAINT tenants_plan_check CHECK (plan IN ('trial', 'standard'));

COMMIT;
