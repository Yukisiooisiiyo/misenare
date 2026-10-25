-- ミセナレ 初期スキーマ（PostgreSQL 16）
-- すべての業務テーブルに tenant_id を持たせ、行レベルセキュリティで企業ごとに分離する。
-- アプリは接続ごとに `SET app.tenant_id = '<uuid>'` を実行してから問い合わせる。

BEGIN;

-- ---------------------------------------------------------------------------
-- 組織
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  plan        text NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial', 'lite', 'standard', 'chain')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stores (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  address    text
);

-- フロア・売場（生活家電、携帯、修理受付…）
CREATE TABLE areas (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name       text NOT NULL,
  UNIQUE (store_id, name)
);

-- 権限は雇用形態ではなく信頼レベルで決める。
--   trust_level : visitor（変更は承認待ち）/ trusted（即時反映）
--   admin_scope : none / store（店長）/ tenant（本部）
--   employment_type は表示用で、権限の判定には使わない。
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  trust_level      text NOT NULL DEFAULT 'visitor' CHECK (trust_level IN ('visitor', 'trusted')),
  admin_scope      text NOT NULL DEFAULT 'none' CHECK (admin_scope IN ('none', 'store', 'tenant')),
  employment_type  text CHECK (employment_type IN ('employee', 'part_time', 'arbeit')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- 兼務・応援に対応するため、所属店舗は複数持てる
CREATE TABLE memberships (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id   uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  area_ids   uuid[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, store_id)
);

-- ---------------------------------------------------------------------------
-- ハッシュタグとタグ辞書
-- ---------------------------------------------------------------------------

-- name は正規化済み（NFKC、先頭の # なし）。reading はカタカナの読み（任意）。
CREATE TABLE hashtags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL,
  reading      text,
  use_count    integer NOT NULL DEFAULT 0,
  state        text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'pending', 'merged')),
  merged_into  uuid REFERENCES hashtags(id),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- タグどうしの関係
--   synonym  : 同義（双方向）      #延長保証 = #長期保証
--   includes : 包含（from ⊃ to）   #冷蔵庫 → #冷凍冷蔵庫
--   alias    : 別名（単語 → タグ） 「映らない」→ #修理
CREATE TABLE tag_relations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('synonym', 'includes', 'alias')),
  from_tag_id  uuid REFERENCES hashtags(id) ON DELETE CASCADE,
  from_text    text,
  to_tag_id    uuid NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  state        text NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate', 'approved', 'rejected')),
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'picked_log', 'dictionary', 'vector')),
  evidence     integer NOT NULL DEFAULT 0,
  approved_by  uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'alias' AND from_text IS NOT NULL AND from_tag_id IS NULL) OR
    (kind <> 'alias' AND from_tag_id IS NOT NULL AND from_text IS NULL AND from_tag_id <> to_tag_id)
  )
);
CREATE UNIQUE INDEX tag_relations_tag_uniq   ON tag_relations (tenant_id, kind, from_tag_id, to_tag_id) WHERE kind <> 'alias';
CREATE UNIQUE INDEX tag_relations_alias_uniq ON tag_relations (tenant_id, from_text, to_tag_id) WHERE kind = 'alias';

-- ---------------------------------------------------------------------------
-- ナレッジ
-- ---------------------------------------------------------------------------

CREATE TABLE knowledge (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope            text NOT NULL CHECK (scope IN ('tenant', 'store')),
  store_id         uuid REFERENCES stores(id) ON DELETE CASCADE,
  current_version  integer,                -- 公開中の版。未公開なら NULL
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'expired')),
  expires_at       timestamptz,
  verified_by      uuid REFERENCES users(id),
  verified_at      timestamptz,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'store') = (store_id IS NOT NULL))
);

-- 編集のたびに1版追加する。
--   published  : 公開中（ナレッジごとに最大1つ）
--   pending    : visitor の投稿・編集で承認待ち
--   superseded : 過去版
--   rejected   : 却下
CREATE TABLE knowledge_versions (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  knowledge_id  uuid NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL DEFAULT '',
  tag_ids       uuid[] NOT NULL DEFAULT '{}',
  photo_ids     uuid[] NOT NULL DEFAULT '{}',
  area_ids      uuid[] NOT NULL DEFAULT '{}',
  state         text NOT NULL CHECK (state IN ('published', 'pending', 'superseded', 'rejected')),
  edited_by     uuid NOT NULL REFERENCES users(id),
  edited_at     timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  PRIMARY KEY (knowledge_id, version)
);
CREATE UNIQUE INDEX knowledge_versions_one_published ON knowledge_versions (knowledge_id) WHERE state = 'published';
CREATE INDEX knowledge_versions_pending ON knowledge_versions (tenant_id) WHERE state = 'pending';

CREATE TABLE knowledge_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  knowledge_id  uuid NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  url           text NOT NULL,
  sort_order    integer NOT NULL DEFAULT 0
);

-- 公開中の版に付いているタグ（検索用の非正規化）
CREATE TABLE knowledge_tags (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  knowledge_id  uuid NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  hashtag_id    uuid NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (knowledge_id, hashtag_id)
);
CREATE INDEX knowledge_tags_by_tag ON knowledge_tags (hashtag_id);

-- ---------------------------------------------------------------------------
-- 検索索引（BM25F）
-- ---------------------------------------------------------------------------

-- 公開中の版だけを索引する。field = tag / title / body
CREATE TABLE postings (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  knowledge_id  uuid NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  field         text NOT NULL CHECK (field IN ('tag', 'title', 'body')),
  term          text NOT NULL,
  tf            integer NOT NULL CHECK (tf > 0),
  PRIMARY KEY (knowledge_id, field, term)
);
CREATE INDEX postings_by_term ON postings (tenant_id, term);

-- 欄ごとの長さ（語数）。平均は問い合わせ時に集計する。
CREATE TABLE knowledge_stats (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  knowledge_id  uuid PRIMARY KEY REFERENCES knowledge(id) ON DELETE CASCADE,
  tag_len       integer NOT NULL DEFAULT 0,
  title_len     integer NOT NULL DEFAULT 0,
  body_len      integer NOT NULL DEFAULT 0
);

CREATE TABLE search_logs (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id             uuid REFERENCES stores(id) ON DELETE SET NULL,
  user_id              uuid REFERENCES users(id) ON DELETE SET NULL,
  query                text NOT NULL,
  result_count         integer NOT NULL,
  opened_knowledge_id  uuid REFERENCES knowledge(id) ON DELETE SET NULL,
  suggested_tag_id     uuid REFERENCES hashtags(id) ON DELETE SET NULL,
  picked_tag_id        uuid REFERENCES hashtags(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX search_logs_zero_hits ON search_logs (tenant_id, created_at) WHERE result_count = 0;

-- ---------------------------------------------------------------------------
-- 商品（バーコード）
-- ---------------------------------------------------------------------------

-- 商品マスタは企業単位。JAN は企業内で一意。
CREATE TABLE products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  jan_code    text NOT NULL CHECK (jan_code ~ '^[0-9]{8}$|^[0-9]{13}$'),
  name        text NOT NULL,
  maker       text,
  state       text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'pending', 'merged')),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, jan_code)
);

CREATE TABLE product_tags (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  hashtag_id  uuid NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, hashtag_id)
);

-- 売場は店舗ごと。移動したら更新する。
CREATE TABLE store_products (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id    uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  area_id     uuid REFERENCES areas(id) ON DELETE SET NULL,
  note        text,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, product_id)
);

CREATE TABLE product_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id    uuid REFERENCES stores(id) ON DELETE CASCADE,
  field       text NOT NULL,
  before      jsonb,
  after       jsonb,
  edited_by   uuid NOT NULL REFERENCES users(id),
  edited_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_products (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  knowledge_id  uuid NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (knowledge_id, product_id)
);
CREATE INDEX knowledge_products_by_product ON knowledge_products (product_id);

-- visitor による商品・タグの変更は、ここに承認待ちとして積む
-- （ナレッジの承認待ちは knowledge_versions.state = 'pending' で表す）
CREATE TABLE change_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id      uuid REFERENCES stores(id) ON DELETE CASCADE,
  entity_type   text NOT NULL CHECK (entity_type IN ('product', 'store_product', 'hashtag')),
  entity_id     uuid,
  payload       jsonb NOT NULL,
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected')),
  requested_by  uuid NOT NULL REFERENCES users(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz
);
CREATE INDEX change_requests_pending ON change_requests (tenant_id, store_id) WHERE state = 'pending';

CREATE TABLE imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id    uuid REFERENCES stores(id) ON DELETE CASCADE,
  file_name   text NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'done', 'failed')),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 行レベルセキュリティ（tenants 以外のすべての業務テーブル）
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stores', 'areas', 'users', 'memberships', 'hashtags', 'tag_relations',
    'knowledge', 'knowledge_versions', 'knowledge_photos', 'knowledge_tags',
    'postings', 'knowledge_stats', 'search_logs', 'products', 'product_tags',
    'store_products', 'product_history', 'knowledge_products', 'change_requests', 'imports'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
  END LOOP;
END $$;

COMMIT;
