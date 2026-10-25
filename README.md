# ミセナレ（仮称）

店舗スタッフ向けのナレッジSaaS。接客の合間にスマホで「この店のやり方」を検索できるようにする。
仕様書：[店舗スタッフ向けナレッジSaaS 企画・仕様書](https://claude.ai/artifact/41XXzyVhS9KmMe6FnCFJBF)

このリポジトリには、まず**検索の中核とAPI**が入っています。スマホアプリと管理画面はこれから作ります。

## 構成

```
packages/search-core   検索の中核（外部依存なし。サーバーと端末の両方で使う）
  normalize.ts           NFKC・小文字化、型番（KJ-55X85L など）を1語として取り出す
  tokenizer.ts           単語分割（Intl.Segmenter）。kuromoji 等に差し替え可能
  tagDictionary.ts       タグ名・別名の最長一致、同義（双方向）・包含（一方向）の展開
  analyzer.ts            文書と検索文を同じ規則で検索語にする
  bm25f.ts               BM25F（タグ×3・タイトル×2・本文×1、長さ補正と飽和）
  suggest.ts             1文字ごとのタグ候補、「もしかして」、共起スコア（NPMI）
  kana.ts                ひらがな・ローマ字 → カタカナ（「てれ」「tere」で #テレビ）
apps/api               API サーバー（Node.js 標準の Request/Response、依存は pg のみ）
  domain/                ナレッジ（版・承認）、検索、商品（バーコード）、タグ
  http/                  ルーティング、認証、node:http アダプタ
  db/                    pg 実装（本番）と psql 実装（開発・テスト用）
db/migrations          PostgreSQL 16 のスキーマ（行レベルセキュリティ付き）
```

## はじめかた

Node.js 22 以上と PostgreSQL 16 が必要です。

```bash
npm install
cp .env.example .env            # 接続先を編集

createdb misenare
createdb misenare_test
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql

npm test                        # 検索コアの単体テスト＋本物のDBを使うAPIテスト
npm run typecheck
npm run dev:api                 # http://localhost:8787
```

テストは `TEST_DATABASE_URL`（既定 `misenare_test`）のスキーマを毎回作り直します。名前が `_test` で終わらないDBを指定すると、誤って消さないよう起動を止めます。

### 開発用の認証

本番用の認証（招待QR＋パスキー／ワンタイムコード、チェーンはSSO）は**まだ実装していません**。
今は開発用に、次のヘッダーで利用者を指定します。`NODE_ENV=production` ではサーバーが起動しません。

```bash
curl -H 'x-dev-tenant-id: <tenant uuid>' -H 'x-dev-user-id: <user uuid>' \
  "http://localhost:8787/stores/<store uuid>/search?q=%23冷蔵庫"
```

## 検索の仕組み（要点）

- 書き手が付けた**ハッシュタグ**と、本文の**全単語**を索引する。トークン数の上限や、位置による重み付けは設けない。
- 採点は **BM25F**。同じ語を何度書いても点数は頭打ちになり、長い欄ほど1語あたりの点数が下がる。
- **同義**（#延長保証 ＝ #長期保証）は双方向、**包含**（#冷蔵庫 → #冷凍冷蔵庫）は一方向に展開し、展開した語は 0.7 倍で数える。
  1つのタグから展開した語は「1つの概念」として扱い、文書ごとに一番高い1語だけを数える（二重に数えない）。
  概念の珍しさ（IDF）は、検索した元のタグで測る。これで「元のタグが直接付いたナレッジが上」になる。
- 検索文側では、タグとして認識した部分をさらに単語に分けない。#冷凍冷蔵庫 の検索が「冷蔵庫」経由で #冷蔵庫 全般に広がらないようにするため。
- **別名**（「映らない」→ #修理）で、話し言葉をタグに読み替える。
- **バーコード**を読むと、商品に直接紐づいたナレッジを最上位に、その下に商品のタグ・商品名・型番で探した結果を並べる。

## 権限

雇用形態ではなく信頼レベルで決める。

| | visitor | trusted | administrator（店長・本部） |
| --- | --- | --- | --- |
| ナレッジ・商品・タグの追加と編集 | 承認待ち | 即時反映 | 即時反映 |
| 承認・却下・過去版への戻し | — | ○ | ○ |
| 商品の削除、ユーザー管理 | — | — | ○ |

店舗をまたぐ分離はアプリ側で、企業（テナント）をまたぐ分離は PostgreSQL の行レベルセキュリティで行う。

## API

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/stores/:storeId/search?q=` | 検索（結果・絞り込みチップ・ログID） |
| POST | `/search-logs/:logId/feedback` | 結果を開いた／「もしかして」で選んだ、の記録 |
| GET | `/tags/dictionary` | 端末に同期するタグ辞書（タグ・関係・共起スコア） |
| POST | `/stores/:storeId/knowledge` | 投稿（visitor は承認待ち） |
| POST | `/knowledge` | 全店共通ナレッジの投稿（本部のみ） |
| GET / PUT | `/knowledge/:id` | 閲覧／編集（編集のたびに版を追加） |
| GET | `/knowledge/:id/versions` | 版の一覧 |
| POST | `/knowledge/:id/versions/:v/approve` `reject` `revert` | 承認・却下・過去版に戻す |
| GET | `/stores/:storeId/pending` | 承認待ちの一覧 |
| GET | `/stores/:storeId/zero-hits` | 0件だった検索ワード |
| GET | `/stores/:storeId/barcode/:jan` | 商品カードと関連ナレッジ（未登録なら unknown） |
| POST | `/stores/:storeId/products` | 商品の登録 |
| PATCH | `/stores/:storeId/products/:id` | 商品名・売場・タグの編集（visitor は承認待ち） |
| GET | `/stores/:storeId/products/:id/history` | 商品情報の変更履歴 |
| POST | `/product-changes/:id/approve` | visitor の商品編集を承認 |
| POST | `/knowledge/:id/products/:productId` | ナレッジと商品の紐づけ |

## まだ無いもの

- 本番用の認証、ユーザー招待（QR）
- スマホアプリ（React Native / Expo）、管理画面（Next.js）
- 写真のアップロード（端末で縮小して S3 へ直接）
- 夜間バッチ（索引の再計算 `reindexAll`、共起スコア、同義・包含の候補出し、鮮度チェック）
- 既存マニュアル（PDF・Word・Excel）の取込
- タグの統合（merged）の画面と処理
- 形態素解析器の kuromoji / Lindera への切り替え（`Tokenizer` を実装して差し替える）
