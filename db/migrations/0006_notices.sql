-- 連絡事項と引き継ぎ。
--
-- ナレッジとは別のものとして持つ。
--   ナレッジ … ずっと使う「この店のやり方」。承認して育てる。検索に出る
--   連絡事項 … 期間が決まった「お知らせ」。掲示板。読んだか・確認したかを記録する
--   引き継ぎ … その日の申し送り。すぐ消える前提。承認はしない（遅くなると意味がない）
-- 引き継ぎだけは visitor も書ける。バイトが次の人に残すメモが、この機能の中心だから。

BEGIN;

CREATE TABLE notices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- NULL なら全店共通（本部だけが作れる）
  store_id      uuid REFERENCES stores(id) ON DELETE CASCADE,
  title         text NOT NULL,
  body          text NOT NULL,
  priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'important')),
  -- 「読んだ」だけでなく「確認しました」を押してもらうか
  requires_ack  boolean NOT NULL DEFAULT false,
  starts_at     timestamptz NOT NULL DEFAULT now(),
  -- NULL なら期限なし
  ends_at       timestamptz,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX notices_by_store ON notices (tenant_id, store_id, starts_at DESC);

CREATE TABLE notice_reads (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  notice_id   uuid NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at     timestamptz NOT NULL DEFAULT now(),
  -- 「確認しました」を押した日時
  acked_at    timestamptz,
  PRIMARY KEY (notice_id, user_id)
);

CREATE TABLE handovers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  body        text NOT NULL,
  state       text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done')),
  -- どの日の申し送りか（開店日で数える）
  for_date    date NOT NULL DEFAULT current_date,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  done_by     uuid REFERENCES users(id),
  done_at     timestamptz
);
CREATE INDEX handovers_by_store ON handovers (tenant_id, store_id, for_date DESC, created_at);
-- 片付いていないものを拾うため
CREATE INDEX handovers_open ON handovers (tenant_id, store_id, for_date) WHERE state = 'open';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notices', 'notice_reads', 'handovers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
  END LOOP;
END $$;

COMMIT;
