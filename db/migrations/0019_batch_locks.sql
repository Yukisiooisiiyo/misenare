-- 夜間バッチの二重起動を止めるための鍵。
--
-- cron の重なりや手動実行との重なりで2本同時に動くと、利用の申請の知らせが二重に送られ、
-- 読みの案の作成が一意索引で衝突して片方のテナントの処理が丸ごと巻き戻っていた。
-- advisory lock はセッション単位で、接続プールを挟むと取った接続と離す接続が違ってしまうので、
-- 行で持つ。6時間経っても残っている鍵は、落ちたまま置き去りにされたものとして奪ってよい。
-- 会社のデータは入らないので、行レベルセキュリティは掛けない。

BEGIN;

CREATE TABLE batch_locks (
  name      text PRIMARY KEY,
  locked_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
