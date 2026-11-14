-- 運営者（ツギガミを提供する側）の管理画面のための土台。
--
--   ・会社（tenants）に、利用の状態と契約の控えを足す
--   ・運営者のアカウント・ログイン・操作の記録
--
-- 運営者の表は、会社（テナント）に属さないので行レベルセキュリティを付けない
-- （rate_limits・contact_inquiries と同じ扱い）。アプリの画面からは読ませず、/operator/ の口だけが触る。

BEGIN;

-- 利用の状態。suspended（停止）にすると、その会社の利用者は何もできなくなる（データは残る）。
-- 完全に消せるのは、停止してからだけ。
ALTER TABLE tenants ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'));
ALTER TABLE tenants ADD COLUMN suspended_at timestamptz;

-- 契約の控え（骨子）。いまは運営者が手で書くだけで、どれも動きを縛らない。
ALTER TABLE tenants ADD COLUMN contracted_stores integer CHECK (contracted_stores IS NULL OR contracted_stores >= 0);
ALTER TABLE tenants ADD COLUMN period_end date;
ALTER TABLE tenants ADD COLUMN billing_note text;
-- 決済（Stripe など）をつないだときに、相手側の顧客・契約の ID を入れる場所。いまは使わない
ALTER TABLE tenants ADD COLUMN billing_customer_id text;
ALTER TABLE tenants ADD COLUMN billing_subscription_id text;

CREATE TABLE operators (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  -- 「scrypt$<salt>$<hash>」。設定リンクから本人が決めるまでは NULL（＝入れない）
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX operators_email ON operators (lower(email));

-- パスワードを決める（決め直す）ための、短命・1回限りのリンク
CREATE TABLE operator_tokens (
  token_hash  text PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE operator_sessions (
  token_hash  text PRIMARY KEY,
  operator_id uuid NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

-- だれが・いつ・どの会社に何をしたか。会社を消したあとも読めるよう、名前を写しておく
CREATE TABLE operator_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  operator_id uuid REFERENCES operators(id) ON DELETE SET NULL,
  action      text NOT NULL,
  tenant_id   uuid,
  tenant_name text,
  detail      text
);
CREATE INDEX operator_log_by_time ON operator_log (at);

COMMIT;
