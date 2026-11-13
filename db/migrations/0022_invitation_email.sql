-- 招待メールの宛先を控える。受け取った本人のメアドとして紐付け、
-- あとで「メールでログインリンクを受け取る」の宛先に使う。
-- users.email と、そのテナント内一意制約（users_email_per_tenant）は 0011_sso で既にある。

BEGIN;

ALTER TABLE invitations ADD COLUMN email text;

COMMIT;
