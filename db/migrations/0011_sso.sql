-- 会社のアカウントで入る（OpenID Connect）。本部の情報システム部が求める入口。
--
-- なぜ要るか：社員が1万人いる会社に「招待QRを1人ずつ配ってください」とは言えない。
-- 入退社の管理は相手の人事システムが持っているので、そこに乗る。
-- 一方、パート・アルバイトは会社のアカウントを持たないことが多い。だから
-- **招待QRとパスキーは残したまま、社員の入口だけを増やす**。
--
-- 設定は会社ごと。相手の IdP（Entra ID・Google Workspace・Okta など）の
-- 発行元（issuer）だけを登録すれば、残りは相手が公開している設定から取る。

BEGIN;

-- 会社のメールアドレス。パート・アルバイトは持たないので NULL を許す。
-- SSO で入ってきた人を、すでに登録済みの人と結びつけるときの手がかりになる。
ALTER TABLE users ADD COLUMN email text;
CREATE UNIQUE INDEX users_email_per_tenant ON users (tenant_id, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE sso_providers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 相手の発行元。https で始まり、末尾に / を付けない（ID トークンの iss と突き合わせる）
  issuer             text NOT NULL,
  client_id          text NOT NULL,
  -- 内緒の鍵。PKCE だけで足りる設定（公開クライアント）なら NULL
  client_secret      text,
  -- どのメールアドレスの人をこの設定に通すか（example.co.jp の形で小文字）。
  -- 入口を選ばせずに、打ったアドレスから会社を決めるために使う
  email_domains      text[] NOT NULL DEFAULT '{}',
  -- 登録済みでない人を、初回に自動で作ってよいか。既定は作らない（安全側）
  jit_enabled        boolean NOT NULL DEFAULT false,
  -- 自動で作るときの配属先と権限
  default_store_id   uuid REFERENCES stores(id) ON DELETE SET NULL,
  default_trust      text NOT NULL DEFAULT 'visitor' CHECK (default_trust IN ('visitor', 'trusted')),
  disabled_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, issuer, client_id)
);
CREATE INDEX sso_providers_by_tenant ON sso_providers (tenant_id);

-- 相手の IdP が返してきた「この人」と、こちらの利用者の結び付け。
-- subject（sub）は相手が決める不変の印。メールアドレスは変わりうるので、こちらを鍵にする。
CREATE TABLE sso_identities (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id  uuid NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
  subject      text NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  PRIMARY KEY (provider_id, subject)
);
CREATE INDEX sso_identities_by_user ON sso_identities (user_id);

-- 行きと帰りをつなぐ覚え。会社が決まる前（戻ってくる前）にも引くので、
-- 行レベルセキュリティは付けない。中身は乱数と、どの設定へ戻すかだけ。
-- 使ったら消す（使い回しと差し替えを防ぐため）。
CREATE TABLE sso_states (
  state          text PRIMARY KEY,
  provider_id    uuid NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL,
  -- PKCE の検証子。相手に渡すのはこれを SHA-256 したものだけ
  code_verifier  text NOT NULL,
  -- ID トークンに同じものが入って戻ってくる（差し替え対策）
  nonce          text NOT NULL,
  -- 入った後に戻す画面（#/k/<id> など）。外に飛ばさないよう、経路だけを入れる
  return_to      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
CREATE INDEX sso_states_expiry ON sso_states (expires_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sso_providers', 'sso_identities'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      || 'USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
      || 'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
  END LOOP;
END $$;

COMMIT;
