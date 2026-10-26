-- タグの読みを複数持てるようにする。
--
-- 「下取」は シタドリ とも シタトリ とも打たれる。「売り場」は ウリバ。
-- どちらが正しいかを決めようとすると必ず外すし、決める必要もない。
-- **両方持てば、どちらで打っても当たる。**
--
-- reading（1つ）を readings（複数）に変える。中身はそのまま移す。

ALTER TABLE hashtags ADD COLUMN readings text[] NOT NULL DEFAULT '{}';

-- hashtags は行レベルセキュリティの対象なので、会社ごとに app.tenant_id を立てて回す。
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE hashtags SET readings = ARRAY[reading] WHERE reading IS NOT NULL AND reading <> '';
  END LOOP;
END $$;

ALTER TABLE hashtags DROP COLUMN reading;
