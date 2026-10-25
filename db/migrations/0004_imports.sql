-- 取り込みで作った下書きを、もとの資料とつなげて見られるようにする。
-- 「この資料から来た下書きが、まだ何件残っているか」を管理画面で出すため。

BEGIN;

ALTER TABLE imports
  ADD COLUMN drafts integer NOT NULL DEFAULT 0;

ALTER TABLE knowledge
  ADD COLUMN import_id uuid REFERENCES imports(id) ON DELETE SET NULL,
  -- もとの資料のどこから来たか（「手順書.docx 12行目」など）
  ADD COLUMN import_source text;

CREATE INDEX knowledge_by_import ON knowledge (import_id) WHERE import_id IS NOT NULL;

COMMIT;
