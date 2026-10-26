-- パスキー（WebAuthn）。端末の指紋・顔・画面ロックで入れるようにする。
--
-- 招待QRは「最初の1回」のためのもので、機種変更や PC からの管理のたびに発行し直すのは手間。
-- パスキーを登録しておけば、本人が自分で入り直せる。
--
-- 合言葉（challenge）は会社が決まる前にも作るので、行レベルセキュリティを付けない。
-- 中身は乱数と有効期限だけで、会社のデータは入らない。使ったら消す（使い回しを防ぐため）。

BEGIN;

CREATE TABLE webauthn_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 認証器が決める鍵の名前。会社をまたいで重なることはない
  credential_id  bytea NOT NULL UNIQUE,
  public_key     bytea NOT NULL,
  algorithm      integer NOT NULL,
  sign_count     bigint NOT NULL DEFAULT 0,
  -- 利用者が分かるように付ける名前（例：店長のiPhone）
  name           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  -- 鍵が複製された疑いが出たら止める
  disabled_at    timestamptz
);
CREATE INDEX webauthn_credentials_by_user ON webauthn_credentials (user_id);

CREATE TABLE webauthn_challenges (
  challenge   text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('register', 'login')),
  -- 登録のときだけ、誰のためのものかが決まっている
  tenant_id   uuid,
  user_id     uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX webauthn_challenges_expiry ON webauthn_challenges (expires_at);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE webauthn_credentials FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY tenant_isolation ON webauthn_credentials '
       || 'USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
       || 'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)';
END $$;

COMMIT;
