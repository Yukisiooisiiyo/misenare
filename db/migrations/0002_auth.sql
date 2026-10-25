-- 認証：招待（QR）と端末セッション
--
-- トークンは「<tenant_id>.<ランダム32バイト>」の形。tenant_id は秘密ではなく、
-- 行レベルセキュリティを効かせたまま照合するために先頭に付けている。DB にはハッシュ（SHA-256）だけを保存する。

BEGIN;

-- 招待。user_id が NULL なら新しい利用者を作る。既存の利用者の機種変更・端末追加にも使う。
CREATE TABLE invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  store_id     uuid REFERENCES stores(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  name         text,                       -- 新しい利用者の表示名
  trust_level  text NOT NULL DEFAULT 'visitor' CHECK (trust_level IN ('visitor', 'trusted')),
  admin_scope  text NOT NULL DEFAULT 'none' CHECK (admin_scope IN ('none', 'store', 'tenant')),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,  -- 初期設定スクリプトで作る最初の招待は NULL
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  used_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (user_id IS NOT NULL OR name IS NOT NULL)
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  device_name   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX sessions_by_user ON sessions (user_id) WHERE revoked_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invitations', 'sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
  END LOOP;
END $$;

COMMIT;
