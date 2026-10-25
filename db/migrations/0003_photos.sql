-- 写真。端末で縮小してから送り、中身は保存先（ローカル or S3）に置く。
-- 0001 で作った knowledge_photos は URL をそのまま持つ形だったが、
-- 保存先を差し替えられるように「保存先のキー」を持つ形に変える（まだ誰も使っていないテーブル）。

BEGIN;

ALTER TABLE knowledge_photos
  DROP COLUMN url,
  ADD COLUMN storage_key  text NOT NULL,
  ADD COLUMN content_type text NOT NULL,
  ADD COLUMN bytes        integer NOT NULL,
  -- uploading：枠だけ作った状態。端末が中身を送り終えると active になる。
  ADD COLUMN state        text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading', 'active')),
  ADD COLUMN caption      text,
  ADD COLUMN created_by   uuid NOT NULL REFERENCES users(id),
  ADD COLUMN created_at   timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX knowledge_photos_key ON knowledge_photos (storage_key);
CREATE INDEX knowledge_photos_by_knowledge ON knowledge_photos (knowledge_id, sort_order, created_at);

COMMIT;
