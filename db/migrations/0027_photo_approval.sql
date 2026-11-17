-- 写真にも承認を通す。
--
-- これまで、写真は付けた時点で全員に見えていた。本文の修正案は承認待ちになるのに、
-- 新人（visitor）が修正案を出している間に付けた写真だけは、承認を通らずに公開中のナレッジに出ていた
-- （修正案を却下しても残った）。
--
--   pending_version … その写真がどの修正案（版）に付いて待っているか。NULL なら待っていない（全員に見える）
--   discarded       … 案が通らなかった写真。一覧からは消え、実体は夜間バッチが片付ける

BEGIN;

ALTER TABLE knowledge_photos ADD COLUMN pending_version integer;

ALTER TABLE knowledge_photos DROP CONSTRAINT knowledge_photos_state_check;
ALTER TABLE knowledge_photos ADD CONSTRAINT knowledge_photos_state_check
  CHECK (state IN ('uploading', 'active', 'discarded'));

COMMIT;
