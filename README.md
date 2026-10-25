# ミセナレ（仮称）

店舗スタッフ向けのナレッジSaaS。接客の合間にスマホで「この店のやり方」を検索できるようにする。
仕様書：[店舗スタッフ向けナレッジSaaS 企画・仕様書](https://claude.ai/artifact/41XXzyVhS9KmMe6FnCFJBF)

入っているもの：検索の中核、API、招待QRによる認証、夜間バッチ、スマホのブラウザで使う Web 版。

## 構成

```
packages/search-core   検索の中核（外部依存なし。サーバーと端末の両方で使う）
  normalize.ts           NFKC・小文字化、型番（KJ-55X85L など）を1語として取り出す
  tokenizer.ts           単語分割（Intl.Segmenter）。kuromoji 等に差し替え可能（読みも返せる）
  tagDictionary.ts       タグ名・別名の最長一致、同義（双方向）・包含（一方向）の展開
  analyzer.ts            文書と検索文を同じ規則で検索語にする
  bm25f.ts               BM25F（タグ×3・タイトル×2・本文×1、長さ補正と飽和）
  suggest.ts             1文字ごとのタグ候補、「もしかして」、共起スコア（NPMI）
  kana.ts                ひらがな・ローマ字 → カタカナ（「てれ」「tere」で #テレビ）
apps/api               API サーバー（Node.js 標準の Request/Response、依存は pg のみ）
  domain/                ナレッジ（版・承認）、検索、商品（バーコード）、タグ辞書の管理、招待と利用者
  http/                  ルーティング、認証、Web 版の配信、node:http アダプタ
  db/                    pg 実装（本番）と psql 実装（開発・テスト用）、RLS の安全確認
  batch/nightly.ts       夜間バッチ
  cli/                   マイグレーション、最初の会社の作成、デモデータ
apps/web               Web 版（依存なし。esbuild で1ファイルにまとめ、API が /app/ で配信）
db/migrations          PostgreSQL 16 のスキーマ（行レベルセキュリティ付き）
```

## はじめかた

Node.js 22 以上と PostgreSQL 16 が必要です。

```bash
npm install
cp .env.example .env            # 接続先を編集

# アプリは一般ロールで接続する（スーパーユーザーは行レベルセキュリティを素通りするため、起動を拒否する）
psql -U postgres -c "CREATE ROLE misenare LOGIN PASSWORD 'misenare' NOSUPERUSER NOBYPASSRLS"
createdb -U postgres -O misenare misenare
createdb -U postgres -O misenare misenare_test

npm run db:migrate              # db/migrations を番号順に適用（適用済みは飛ばす）
npm test                        # 検索コアの単体テスト＋本物のDBを使うAPIテスト
npm run typecheck
npm run build:web
npm run dev:api                 # http://localhost:8787/app/
```

テストは `TEST_DATABASE_URL`（既定 `misenare_test`）のスキーマを毎回作り直します。名前が `_test` で終わらないDBを指定すると、誤って消さないよう起動を止めます。

### お試し（デモデータ）

```bash
npm run seed:demo               # 家電量販店1社・2店舗のデモ。店長・ベテラン・新人の招待リンクを表示
npm run dev:api
```

表示された招待リンクをスマホやブラウザで開くと、その人として使い始められます（リンクは1回限り・72時間有効）。

### 本番の最初の1社

```bash
npm run bootstrap -- --tenant "会社名" --store "最初の店舗" --admin "本部担当者の名前"
```

表示された招待トークンを `https://<ホスト>/app/#invite=<トークン>` として開くと、本部の administrator として端末が登録されます。以降のスタッフは、Web 版の「承認・管理」から招待リンクを作ります。

## 認証

- administrator が招待を作るとトークンが発行され、スタッフの端末が開くと端末セッションが作られる。
- トークンは `<会社ID>.<ランダム32バイト>`。DB には SHA-256 のハッシュだけを保存する。
- 店長は自店舗のスタッフだけを招待でき、店長・本部の権限は付けられない（本部のみ）。
- 無効化した利用者の端末は即座に使えなくなる。180日使われなかった端末セッションは無効。
- 開発用に `MISENARE_DEV_AUTH=1` でヘッダー認証（`x-dev-tenant-id` / `x-dev-user-id`）を使える。本番環境では作れない。

## 検索の仕組み（要点）

- 書き手が付けた**ハッシュタグ**と、本文の**全単語**を索引する。トークン数の上限や、位置による重み付けは設けない。
- 採点は **BM25F**。同じ語を何度書いても点数は頭打ちになり、長い欄ほど1語あたりの点数が下がる。
- **同義**（#延長保証 ＝ #長期保証）は双方向、**包含**（#冷蔵庫 → #冷凍冷蔵庫）は一方向に展開し、展開した語は 0.7 倍で数える。
  1つのタグから展開した語は「1つの概念」として扱い、文書ごとに一番高い1語だけを数える（二重に数えない）。
  概念の珍しさ（IDF）は、検索した元のタグで測る。これで「元のタグが直接付いたナレッジが上」になる。
- 検索文側では、タグとして認識した部分をさらに単語に分けない。#冷凍冷蔵庫 の検索が「冷蔵庫」経由で #冷蔵庫 全般に広がらないようにするため。
- **別名**（「映らない」→ #修理）で、話し言葉をタグに読み替える。
- **バーコード**を読むと、商品に直接紐づいたナレッジを最上位に、その下に商品のタグ・商品名・型番で探した結果を並べる。
- タグ候補と「もしかして」は端末内で計算する。端末に配るタグ辞書は店舗の範囲（自店舗＋全店共通の公開ナレッジと商品）に絞る。

## 権限

雇用形態ではなく信頼レベルで決める。

| | visitor | trusted | administrator（店長・本部） |
| --- | --- | --- | --- |
| ナレッジ・商品・タグの追加と編集 | 承認待ち | 即時反映 | 即時反映 |
| 承認・却下・過去版への戻し、タグの関係の承認 | — | ○ | ○ |
| タグの統合、商品の削除、招待・利用者管理 | — | — | ○（商品マスタの削除は本部のみ） |

- 承認待ちの案や却下された案は、書いた本人と承認できる人にしか見えない。
- 期限（expiresAt）も版に持たせ、公開（承認）されるまで効かない。
- 店舗をまたぐ分離はアプリ側で、企業（テナント）をまたぐ分離は PostgreSQL の行レベルセキュリティで行う。
  外部キーの検査は行レベルセキュリティを無視するため、受け取った店舗・商品などの ID は RLS の効いた SELECT で存在を確かめてから使う。
- スーパーユーザーや BYPASSRLS を持つロールで接続すると、サーバーもテストも起動しない。

## 夜間バッチ

`npm run batch:nightly` を毎晩1回（cron や EventBridge から）実行する。会社ごとに別トランザクション。

1. 期限切れのナレッジを expired にして索引から外す
2. 「もしかして」で3回以上選ばれた組み合わせを同義の候補にする（承認は人）
3. 外部の候補提供元（Sudachi の同義語辞書・日本語WordNet・単語ベクトル）を `CandidateProvider` で差し込める
4. 公開ナレッジを索引し直す（未索引を優先、1社あたり上限つき）、タグの使用回数を数え直す
5. トークナイザーが読みを返せるなら、タグに読みを付ける

## API

Web 版からは `/api` を付けて呼ぶ（例：`/api/me`）。付けずに呼んでも同じ。

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/auth/accept` | 招待トークンを端末のセッショントークンに交換（ログイン前に呼べる唯一の API） |
| POST | `/auth/logout` | この端末のセッションを失効 |
| GET | `/me` | 自分の名前・権限・所属店舗 |
| POST | `/invitations` | 招待を作る（administrator） |
| GET | `/stores/:storeId/users` | 店舗の利用者一覧（administrator） |
| PATCH | `/users/:id` | trusted の付与・解除、無効化（administrator） |
| DELETE | `/sessions/:id` | 端末セッションの失効 |
| GET | `/stores/:storeId/search?q=` | 検索（結果・絞り込みチップ・ログID） |
| POST | `/search-logs/:logId/feedback` | 結果を開いた／「もしかして」で選んだ、の記録 |
| GET | `/stores/:storeId/tags/dictionary` | 端末に同期するタグ辞書（店舗の範囲） |
| POST | `/stores/:storeId/knowledge` | 投稿（visitor は承認待ち） |
| POST | `/knowledge` | 全店共通ナレッジの投稿（本部のみ） |
| GET / PUT | `/knowledge/:id` | 閲覧／編集（編集のたびに版を追加） |
| GET | `/knowledge/:id/versions` | 版の一覧 |
| POST | `/knowledge/:id/versions/:v/approve` `reject` `revert` | 承認・却下・過去版に戻す |
| POST | `/knowledge/:id/verify` | 内容を変えずに「今も正しい」と確認する |
| GET | `/stores/:storeId/pending` | 承認待ちの一覧 |
| GET | `/stores/:storeId/stale` | 半年以上確認されていないナレッジ |
| GET | `/stores/:storeId/zero-hits` | 0件だった検索ワード |
| GET | `/stores/:storeId/barcode/:jan` | 商品カードと関連ナレッジ（未登録なら unknown） |
| POST | `/stores/:storeId/products` | 商品の登録 |
| PATCH | `/stores/:storeId/products/:id` | 商品名・売場・タグの編集（visitor は承認待ち） |
| DELETE | `/stores/:storeId/products/:id` | 本部は商品ごと削除、店長は自店舗の売場情報だけ外す |
| GET | `/stores/:storeId/products/:id/history` | 商品情報の変更履歴 |
| GET | `/stores/:storeId/pending-products` | 承認待ちの商品と、商品情報の変更依頼 |
| POST | `/products/:id/approve` | visitor が登録した商品を承認（登録された店舗の trusted 以上） |
| POST | `/product-changes/:id/approve` `reject` | visitor の商品編集を承認・却下 |
| POST | `/knowledge/:id/products/:productId` | ナレッジと商品の紐づけ |
| GET / POST | `/tag-relations` | タグの関係の一覧（`?state=`）／提案（trusted 以上は即承認） |
| POST | `/tag-relations/:id/approve` `reject` | タグの関係の承認・却下 |
| DELETE | `/tag-relations/:id` | タグの関係の削除 |
| POST | `/tags/merge` | タグの統合（administrator） |

## テストと CI

- `npm test`：検索コアの単体テストと、本物の PostgreSQL に対する API テスト（約100件）
- CI（GitHub Actions）：psql アダプタと本番と同じ pg ドライバーの両方で、型チェック・Web 版のビルド・テストを実行
- `apps/web/e2e/smoke.mjs`：スマホの画面サイズでのブラウザ通し確認（Playwright。デモデータに対して実行）

## まだ無いもの

- 形態素解析器の kuromoji / Lindera への切り替え（`Tokenizer` を実装して差し替える）。今の Intl.Segmenter では読みが取れないため、
  「れいぞうこ」と打っても #冷蔵庫 は出ない（カタカナのタグは、ひらがな・ローマ字でも出る）
- 写真のアップロード（端末で縮小して S3 へ直接）
- 既存マニュアル（PDF・Word・Excel）の取込
- 招待の QR コード表示（今はリンクをコピーして送る）
- パスキー、チェーン向けの SSO
- 管理画面のうち、タグ辞書の管理・利用者一覧・商品の承認待ちの画面（API はある）
- 招待受け取りなど、認証まわりの試行回数の制限（レート制限）
- AWS へのデプロイ設定
