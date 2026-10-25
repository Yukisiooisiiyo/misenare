-- 引き継ぎの操作履歴。
--
-- もとは「片付いた」を押し間違えても誰が押したか分からず、
-- 削除にいたっては行ごと消えて取り返しがつかなかった。
--   ・削除は印を付けるだけにして、消さない（戻せる）
--   ・誰がいつ何をしたかを、1件1行で残す
-- 責任の所在をはっきりさせるのが目的なので、履歴そのものは消さない。

BEGIN;

ALTER TABLE handovers
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES users(id);

-- 消えていないものを引くとき用
CREATE INDEX handovers_alive ON handovers (tenant_id, store_id, for_date) WHERE deleted_at IS NULL;

CREATE TABLE handover_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  handover_id uuid NOT NULL REFERENCES handovers(id) ON DELETE CASCADE,
  -- created：書いた / done：片付いた / reopened：やり直した / deleted：消した / restored：戻した
  action      text NOT NULL CHECK (action IN ('created', 'done', 'reopened', 'deleted', 'restored')),
  actor_id    uuid NOT NULL REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handover_events_by_time ON handover_events (tenant_id, at DESC);
CREATE INDEX handover_events_by_handover ON handover_events (handover_id, at);

-- すでにあるものには「書いた」記録を入れておく（履歴が途中から始まらないように）。
-- handovers は行レベルセキュリティが効いているので、会社ごとに読み直す。
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    INSERT INTO handover_events (tenant_id, handover_id, action, actor_id, at)
    SELECT tenant_id, id, 'created', created_by, created_at FROM handovers;
    INSERT INTO handover_events (tenant_id, handover_id, action, actor_id, at)
    SELECT tenant_id, id, 'done', coalesce(done_by, created_by), done_at
      FROM handovers WHERE state = 'done' AND done_at IS NOT NULL;
  END LOOP;
END $$;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE handover_events ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE handover_events FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY tenant_isolation ON handover_events '
       || 'USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
       || 'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)';
END $$;

COMMIT;
