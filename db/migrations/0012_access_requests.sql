-- 会社のアカウントで入れたが、まだ登録されていない人の申請。
--
-- いままでは、ここで行き止まりだった（「店長か本部に依頼してください」と出して終わり）。
-- 口頭やメールで頼む形になり、頼まれた側も誰のことか分からない。
--
-- この表に残るのは、**相手の IdP の署名を通り、確認済みの会社メールアドレスを持ち、
-- 登録済みのドメインに属する人だけ**。つまり「その会社の人であることは確かだが、
-- こちらに登録がない」人。だから申請として受けてよい。
--
-- 自動で作る（jit_enabled）との違いは、誰かが見て決めるかどうか。
-- 既定はこちら（人が決める）。1万人を先に登録してもらう必要はなく、
-- かつ知らない人が勝手に入ってくることもない。

BEGIN;

CREATE TABLE access_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id   uuid NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
  -- 相手の IdP が決める不変の印。これで同じ人の申請を1つに保つ
  subject       text NOT NULL,
  email         text NOT NULL,
  -- 相手の IdP が名乗った表示名。**鵜呑みにしない**ので、承認する人が直せる
  claimed_name  text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  -- 何度も入ろうとした回数。急いでいる人を先に見られるようにする
  attempts      integer NOT NULL DEFAULT 1,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  -- 承認して作った利用者
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (provider_id, subject)
);
CREATE INDEX access_requests_pending ON access_requests (tenant_id, status, last_seen_at DESC);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE access_requests FORCE ROW LEVEL SECURITY';
  EXECUTE 'CREATE POLICY tenant_isolation ON access_requests '
       || 'USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
       || 'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)';
END $$;

COMMIT;
