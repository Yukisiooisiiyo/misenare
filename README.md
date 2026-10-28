# ミセナレ（仮称）

店舗スタッフ向けのナレッジSaaS。接客の合間にスマホで「この店のやり方」を検索できるようにする。
仕様書：[店舗スタッフ向けナレッジSaaS 企画・仕様書](https://claude.ai/artifact/41XXzyVhS9KmMe6FnCFJBF)

入っているもの：検索の中核、API、招待QRによる認証、夜間バッチ、スマホのブラウザで使う Web 版、
写真、既存マニュアルの取り込み、連絡事項と引き継ぎ、承認・管理の画面、監視、Docker での配置。

## 構成

```
packages/search-core   検索の中核（外部依存なし。サーバーと端末の両方で使う）
  normalize.ts           NFKC・小文字化、型番（KJ-55X85L など）を1語として取り出す
  tokenizer.ts           単語分割（Intl.Segmenter）。kuromoji に差し替え可能（読みも返せる）
  tagDictionary.ts       タグ名・別名の最長一致、同義（双方向）・包含（一方向）の展開
  analyzer.ts            文書と検索文を同じ規則で検索語にする
  bm25f.ts               BM25F（タグ×3・タイトル×2・本文×1、長さ補正と飽和）
  suggest.ts             1文字ごとのタグ候補、「もしかして」、共起スコア（NPMI）
  kana.ts                ひらがな・ローマ字 → カタカナ（「てれ」「tere」で #テレビ）
packages/qr            QR コードの作成（外部依存なし。招待リンクを紙や画面で渡すため）
apps/api               API サーバー（Node.js 標準の Request/Response、依存は pg のみ）
  domain/                ナレッジ（版・承認）、検索、商品（バーコード）、タグ辞書の管理、招待と利用者、
                         写真、取り込み、連絡事項、引き継ぎ
  http/                  ルーティング、認証、試行回数の制限、Web 版の配信、node:http アダプタ
  db/                    pg 実装（本番）と psql 実装（開発・テスト用）、RLS の安全確認
  storage/               写真の保存先（ローカルのディレクトリ／S3。署名付きURLは依存なしで作る）
  import/                既存マニュアルの読み取り（ZIP・Word・Excel・CSV・テキスト・PDF）
  search/                形態素解析（kuromoji）での分割。入っていれば使う
  batch/nightly.ts       夜間バッチ
  cli/                   マイグレーション、最初の会社の作成、デモデータ
apps/web               Web 版（依存なし。esbuild で1ファイルにまとめ、API が /app/ で配信）
db/migrations          PostgreSQL 16 のスキーマ（行レベルセキュリティ付き）
docs/deploy.md         本番に出すまでの手引き（環境変数・AWS・バックアップ）
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

### ブラウザだけで触れるお試し版

```bash
node apps/web/demo/build.mjs   # apps/web/demo/dist/index.html が1枚できる
```

サーバーの代わりに端末の中の仮データを使う版（`apps/web/demo/api.ts`）。
検索・タグ候補・もしかして・共起は本物と同じ `@misenare/search-core` を使うので、
検索の手ざわりはそのまま確かめられる。書いたものは閉じると消える。

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
- 招待の受け取りは同じ接続元から10分に10回まで。無効なトークンが30回続いた接続元は、正しいトークンでも一時的に止める。
  数えかたは「ずらし窓」（窓の切れ目で上限の2倍を通さない）。`RATE_LIMIT=db` にすると PostgreSQL で数えるので、サーバーを複数台にしても全体で1つの上限になる。
  接続元の IP はそのまま残さず、鍵（`MISENARE_RATE_SALT`）付きのハッシュにして持つ。
- 招待はその場で QR コードになる。スタッフのスマホのカメラで読んでもらうか、印刷して渡す。

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

## 情報の新しさ

「古い」とみなすまでの日数は**1か所**（`apps/api/src/domain/knowledge.ts` の `STALE_DAYS`、既定180日）で決める。
承認・管理の一覧、夜間バッチの数え方、詳細画面の注意書きが、すべて同じ値・同じ見方（更新と確認の新しい方で測る）になる。
画面側は `/me` で受け取るので、サーバーの値を変えれば全部そろって変わる。

- trusted 以上は、ナレッジの詳細で「今も正しい」を押すと、中身を変えずに確認日だけを新しくできる。
- 古いものは、その場で押せるようにボタンを目立たせる。

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
6. 送りかけのまま残った写真を片付ける
7. 持ち越しの期間を過ぎた引き継ぎを閉じる、古い試行回数の記録を捨てる

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
| GET / POST | `/knowledge/:id/photos` | 写真の一覧／送り先の案内（枠を作る） |
| PUT | `/photos/:id/data` | 写真の中身（保存先がローカルのときだけ。S3 なら端末から直接 S3 へ） |
| POST | `/photos/:id/complete` | 送り終わりの記録。ここで一覧に出る |
| GET | `/photos/:id/data` | 写真を見る（権限を確かめ、S3 なら署名付きURLに飛ばす） |
| DELETE | `/photos/:id` | 写真を消す（付けた本人と承認できる人） |
| GET / POST | `/stores/:storeId/notices` | 掲示中の連絡事項／出す（trusted 以上。`?all=1` で終わったものも） |
| POST | `/notices` | 全店共通の連絡事項（本部のみ） |
| GET / PUT / DELETE | `/notices/:id` | 1件を見る／直す／消す（出した人か administrator） |
| POST | `/notices/:id/end` | 掲示をやめる（記録は残す） |
| POST | `/notices/:id/read` `ack` | 読んだ／「確認しました」 |
| GET | `/notices/:id/readers` | 誰が確認して誰がまだか（trusted 以上） |
| GET / POST | `/stores/:storeId/handovers` | その日の引き継ぎ（持ち越し込み）／書く（誰でも） |
| GET | `/stores/:storeId/handovers/history` | 操作の履歴（`?scope=actions`／`all`、`?days=`） |
| POST | `/handovers/:id/done` `reopen` `restore` | 片付いた／やり直す／消したものを戻す |
| DELETE | `/handovers/:id` | 消す（印を付けるだけ。書いた人か trusted 以上） |
| GET | `/stores/:storeId/badges` | ホームとタブに出す数（未読・未確認・残っている引き継ぎ） |
| POST | `/stores/:storeId/imports?name=` | 既存マニュアルから下書きをまとめて作る（trusted 以上） |
| GET | `/stores/:storeId/imports` | 取り込んだ資料と、残っている下書きの数 |
| POST | `/imports/:id/discard` | まだ承認していない下書きをまとめて取り下げる |

## 連絡事項と引き継ぎ

ナレッジ（ずっと使う「この店のやり方」）とは別に、その日の情報を置く場所を用意している。

| | 連絡事項 | 引き継ぎ |
| --- | --- | --- |
| 何を | 期間のあるお知らせ（営業時間、キャンペーン） | その日の申し送り（在庫、忘れ物、途中の作業） |
| 書けるのは | trusted 以上 | **誰でも**（visitor も） |
| 承認 | なし（待っていると意味が無くなる） | なし |
| 期間 | 開始・終了を決められる。終われば引っ込む | 片付くまで持ち越し（最大14日） |
| 記録 | 誰が読んだか。「要確認」なら押してもらう | 誰が書いて、誰が片付けたか |
| 検索 | 出ない | 出ない |

- 重要な連絡はいちばん上に出て、未読のものには印が付く。画面に出た時点で「読んだ」として記録する。
- 「要確認」の連絡は、押すまでホームとタブに数が残る。trusted 以上は誰がまだかを見られる。
- 全店共通の連絡事項は本部だけが出せる。
- 引き継ぎは、片付かないまま14日を過ぎると夜間バッチが閉じる（出し続けても読まれないため）。

### 引き継ぎは、誰がやったかを必ず残す

押し間違いが起きる前提で作っている。

- **削除は消さない**。印を付けるだけで、行は残る。誰でも「戻す」で元に戻せる。
- 書いた・片付けた・やり直した・消した・戻した、を**1件ずつ記録**する（`handover_events`）。
- 履歴は2通りで見られる。
  - **操作された分**：誰かが手を加えたものだけ。「誰が片付けたのか」を追うとき
  - **すべて**：まだ誰も触っていないものも含む。その日の全体を見るとき
- どちらも新しい操作の順に並び、1件ごとに「いつ・誰が・何をしたか」が付く。履歴そのものは消せない。

## 写真

- 端末で長辺 1600px に縮めてから送る（通信量と待ち時間を減らすため）。1件あたり8枚まで。
- 保存先は差し替えられる。`S3_BUCKET` が無ければサーバーのディレクトリ（`PHOTO_DIR`）、
  あれば S3 で、中身は端末と S3 が直接やり取りする（API を通らない）。S3 の署名付きURL は依存なしで作っている。
- 見るときもナレッジと同じ権限を確かめる。未公開のナレッジの写真は、書いた人と承認できる人だけ。

## 既存マニュアルの取り込み

`.txt` `.md` `.csv` `.tsv` `.docx` `.xlsx` `.pdf` を読んで、承認待ちの下書きをまとめて作る（trusted 以上）。

- Word は見出しスタイル、テキストと Markdown は見出し（`#` ■ 【】 第◯章）で区切る。見出しが無ければ空行で区切る。
- Excel と CSV は1行1件。「タイトル」「本文」の列があればそれを使い、無ければ1列目をタイトルにする。
- PDF は**文字の大きさ**で見出しを見分ける（ページの中でいちばん多い大きさを本文とみなす）。出典は「○○.pdf 3ページ目」のように残る。
  文字の対応表（ToUnicode）、UCS-2 の並び、欧文1バイトの3通りを読む。まとめて圧縮された PDF（1.5 以降）も読める。
  写真を貼っただけの PDF と鍵のかかった PDF は読めないので、その旨を返す。
- Word・Excel・PDF は中身が ZIP やオブジェクトの集まりなので、必要なところだけを読む小さな読み取りを自前で持っている（依存は増やさない）。
- 取り込んだ人が trusted でも自動では公開しない。古い記述がそのまま検索に出ないよう、1件ずつ人が確かめる。

## 本番に出す

```bash
docker build -t misenare .
docker run --rm -e DATABASE_URL=… misenare npx tsx apps/api/src/cli/migrate.ts
docker run -d -p 8787:8787 -e DATABASE_URL=… -e TRUST_PROXY=1 misenare
```

手元で一式動かすなら `docker compose up --build`。
環境変数・AWS での置き方・バックアップは [docs/deploy.md](docs/deploy.md) に書いてある。

## 監視と通知

| 場所 | 内容 |
| --- | --- |
| `/health` | 生きているか（DB は見ない） |
| `/ready` | DB につながるか。つながらなければ 503 |
| `/metrics` | Prometheus 形式。リクエスト数・応答時間・エラー数。`METRICS_TOKEN` を設定すると合言葉が要る（本番で未設定なら 404） |

- ログは1行1件の JSON。リクエストIDを付け、応答の `x-request-id` と突き合わせられる。名前や本文は書かない。
- 数え取りのラベルは経路の型（`/knowledge/:id`）。IDそのものは入れないので、種類が増え続けない。
- `ALERT_WEBHOOK_URL` を設定すると、サーバー側のエラーを Slack 互換の Webhook に知らせる。
  同じ種類は5分に1回までで、間引いた分は次に送るときにまとめて伝える。送れなくてもリクエストは止めない。

## テストと CI

- `npm test`：検索コアの単体テストと、本物の PostgreSQL に対する API テスト（430件超）
- CI（GitHub Actions）
  - `test`：psql アダプタと本番と同じ pg ドライバーの両方で、型チェック・Web 版のビルド・テスト
  - `qr`：作った QR コードを別実装の読み取り器（jsQR・ZXing）に読ませて、本当に読めるか確かめる
  - `kuromoji`：形態素解析を入れた状態で、分割と読みを確かめる
  - `docker`：イメージを組み立て、マイグレーションを流し、起動して応答を確かめる（デプロイはしない）
- `apps/web/e2e/smoke.mjs`：スマホの画面サイズでのブラウザ通し確認（Playwright。デモデータに対して実行）

## まだ無いもの

- 全店共通のナレッジを現場から提案する経路（いまは本部だけが作れる）
- ナレッジの有効期限を画面から設定する欄（API では受け付ける）
- 本部が全店をまたいで一度に引く検索（検索は「自店舗＋全店共通」の範囲）
