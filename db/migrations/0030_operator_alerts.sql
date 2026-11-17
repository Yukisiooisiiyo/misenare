-- 運営者への知らせ（退避が取れていない、など）を、最後に送った時刻。
--
-- 同じことを毎晩知らせ続けないために使う（直るまでは1週間に1通まで。直ったら行を消して、次に起きたらすぐ知らせる）。
-- 会社（テナント）に属さないので、0024・0029 の運営者の表と同じく行レベルセキュリティを付けない。

BEGIN;

CREATE TABLE operator_alerts (
  -- 何の知らせか（'backup' = 退避が取れていない）
  kind    text PRIMARY KEY,
  sent_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
