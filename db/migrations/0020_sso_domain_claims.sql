-- ドメインは「確かめ済みのものだけ」世界で1つにする。
--
-- これまでは domain が主キーで、**確かめていない登録でも**その名前を占有できた。
-- 他社（あるいは間違えた誰か）が kdenki.example.co.jp を未確認のまま登録すると、
-- 本物のケーズが同じドメインを登録できず（409）、消す口は先に登録した側にしかなかった。
--
-- 確かめられるのは DNS に印を置ける持ち主だけなので、未確認の登録は会社ごとに持ててよく、
-- 確かめ済みのものだけが1つであれば入口（ログイン時の引き当て）は曖昧にならない。
-- 主キーを (tenant_id, domain) にし、確かめ済みの domain に部分ユニーク索引を張る。

BEGIN;

ALTER TABLE sso_domains DROP CONSTRAINT sso_domains_pkey;
ALTER TABLE sso_domains ADD PRIMARY KEY (tenant_id, domain);
CREATE UNIQUE INDEX sso_domains_verified_uniq ON sso_domains (domain) WHERE verified_at IS NOT NULL;

COMMIT;
