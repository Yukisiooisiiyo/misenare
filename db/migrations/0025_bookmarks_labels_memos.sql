-- ブックマーク・引き継ぎのラベル・個人メモ。
--
--   ブックマーク … 「これは役に立つ」と思ったナレッジに、自分用の印を付ける。
--                  いくつ付いたかは**書いた本人にだけ**見せる（人気投票にしない。書いた人の励みにする）
--   ラベル       … 引き継ぎに、店がその場で作る札（お客様対応・落とし物など）。忙しい日に札で絞れる
--   個人メモ     … 自分だけが読めるメモ。「今日だけ」（会員番号の控え・やること）と「残す」の2種類。
--                  「今日だけ」は翌日の夜間バッチで消す（お客様の番号を残し続けない）

BEGIN;

CREATE TABLE knowledge_bookmarks (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  knowledge_id uuid NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (knowledge_id, user_id)
);
-- 自分のブックマークを新しい順に出すため
CREATE INDEX knowledge_bookmarks_by_user ON knowledge_bookmarks (tenant_id, user_id, created_at DESC);

-- ラベルは引き継ぎの行にそのまま持つ。札の一覧を別に管理しない：
-- 最近その店で使われた札が候補に出て、使われなくなった札は自然に消える
ALTER TABLE handovers ADD COLUMN labels text[] NOT NULL DEFAULT '{}';

CREATE TABLE personal_memos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- today … 書いた日だけのもの（翌日に消える）／keep … 自分で消すまで残る
  kind       text NOT NULL CHECK (kind IN ('today', 'keep')),
  body       text NOT NULL,
  -- 書いた日（店の時間帯で数える）。today のメモが消える日を決める
  for_date   date NOT NULL,
  done_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX personal_memos_by_user ON personal_memos (tenant_id, user_id, kind, created_at DESC);
-- 夜間バッチが、過ぎた「今日だけ」を拾うため
CREATE INDEX personal_memos_expiring ON personal_memos (tenant_id, for_date) WHERE kind = 'today';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_bookmarks', 'personal_memos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
  END LOOP;
END $$;

COMMIT;
