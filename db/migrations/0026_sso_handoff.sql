-- 会社のアカウント（SSO）で入るとき、**始めたブラウザーだけ**が端末セッションを受け取れるようにする。
--
-- これまでは、相手から戻ってきたところで端末セッションの鍵を作り、画面の URL に載せて渡していた。
-- URL に載った鍵は、開いた端末がそのまま使えてしまう。
-- これからは、入口でブラウザーが作った合言葉の指紋（client_challenge）を覚えておき、
-- 戻りでは「引換の符丁」だけを渡す。符丁を鍵に替えられるのは、合言葉そのものを持っているブラウザーだけ。

BEGIN;

ALTER TABLE sso_states ADD COLUMN client_challenge text;

-- 相手との確かめが済んだあと、ブラウザーが受け取りに来るまでの短い預かり。
-- sso_states と同じく、ログイン前に引くので行レベルセキュリティの対象にしない（中身は符丁の指紋と行き先だけ）
CREATE TABLE sso_handoffs (
  -- 符丁そのものは持たない（指紋だけ）
  code_hash        text PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL,
  client_challenge text NOT NULL,
  return_to        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX sso_handoffs_expiry ON sso_handoffs (expires_at);

COMMIT;
