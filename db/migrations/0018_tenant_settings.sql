-- 会社ごとの設定（知らせの送り先）を、行レベルセキュリティの効く表に移す。
--
-- tenants には tenant_id 列が無く、行レベルセキュリティも掛けていない
-- （夜間バッチが会社の一覧を引くため）。ところが notify_email はそこに置かれていて、
-- しかも UPDATE に WHERE が無かった。本部の管理者が送り先を決めると、
-- **全社の送り先がその宛先に書き換わり**、翌晩のバッチは他社の利用申請（申請者のメールと名前）を
-- その宛先に送っていた。
--
-- 直し方は2つあった。tenants に行レベルセキュリティを掛けるか、設定を別の表に出すか。
-- 前者は夜間バッチの「会社の一覧」が引けなくなり、例外の穴を作ることになる。
-- 後者なら tenants には秘密の列が残らず、設定の表は他の業務表と同じ規則（tenant_id で切る）に乗る。
-- 後者にした。

BEGIN;

CREATE TABLE tenant_settings (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  notify_email         text,
  -- 利用の申請について、最後に知らせた時刻
  requests_notified_at timestamptz
);

INSERT INTO tenant_settings (tenant_id, notify_email, requests_notified_at)
SELECT id, notify_email, requests_notified_at FROM tenants;

ALTER TABLE tenants DROP COLUMN notify_email;
ALTER TABLE tenants DROP COLUMN requests_notified_at;

ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_settings
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

COMMIT;
