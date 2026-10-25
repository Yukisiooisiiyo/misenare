# 本番に出すまでの手引き

このファイルは「どう置くか」の案内です。ここに書いてあることを実行しても、勝手に課金は始まりません。
実際に作るかどうかは、読んだうえで自分で決めてください。

---

## 1. 必要なもの

| もの | 何に使うか | 無いとどうなるか |
| --- | --- | --- |
| PostgreSQL 16 以上 | すべてのデータ | 動かない |
| Node.js 22 以上（または Docker） | API と Web 版の配信 | 動かない |
| 置き場所（サーバー1台） | 上の2つを動かす | 動かない |
| 写真の置き場所 | ナレッジに付ける写真 | サーバーのディスクに置かれる（台を増やすと見えなくなる） |
| HTTPS の証明書 | スマホからの通信 | カメラ（バーコード読み取り）が使えない |

**HTTPS は必須**です。ブラウザはカメラを HTTPS でしか使わせません。

---

## 2. 環境変数

`.env.example` が一覧です。本番で必ず見直すもの：

| 変数 | 既定 | 本番での目安 |
| --- | --- | --- |
| `DATABASE_URL` | なし（必須） | アプリ専用のロールで。**スーパーユーザーは使わない** |
| `PORT` | 8787 | ロードバランサーに合わせる |
| `DB_DRIVER` | `pg` | `pg` のまま（`psql` は開発用） |
| `TRUST_PROXY` | `0` | ロードバランサーの後ろなら `1` |
| `PHOTO_DIR` | `./var/photos` | S3 を使わないときの置き場所 |
| `S3_BUCKET` ほか | なし | 台を2つ以上にするなら設定する |
| `PHOTO_ORIGIN` | なし | S3 を使うときに、そのバケットの URL |
| `TOKENIZER` | `Intl.Segmenter` | `kuromoji`（`npm install kuromoji` が要る。読みが取れて検索が良くなる） |
| `MISENARE_DEV_AUTH` | なし | **本番では絶対に設定しない**（認証をヘッダーだけにする開発用の仕組み） |

### データベースのロール

アプリは行レベルセキュリティ（会社ごとの仕切り）に守りを任せています。
スーパーユーザーや `BYPASSRLS` を持つロールで接続すると仕切りが効かないので、**起動時に確かめて、該当すれば止まります**。

```sql
CREATE ROLE misenare LOGIN PASSWORD '……' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE misenare OWNER misenare;
```

---

## 3. 置き方

### 3-1. まずは1台で（おすすめ）

店舗数が少ないうちは、サーバー1台とデータベース1つで十分です。

```
[スマホ] --HTTPS--> [サーバー1台：API + Web版] --> [PostgreSQL]
                            └─ 写真はそのサーバーのディスク（PHOTO_DIR）
```

- Docker があるなら `docker compose up -d` がそのまま使えます（`docker-compose.yml`）。
- HTTPS は Caddy や nginx + Let's Encrypt を前に置くのが簡単です。
- **この構成で一番大事なのはバックアップです**（下の5章）。

費用の目安：小さなサーバー1台とマネージドな PostgreSQL で、月に数千円〜1万円台。
アクセス量で値段が動く部分がほとんどないので、読み通りに収まります。

### 3-2. AWS に置く場合

従量課金が読みにくくならない組み合わせにしています。

```
[スマホ] → ALB（HTTPS） → ECS Fargate（このイメージ） → RDS for PostgreSQL
                                   └→ S3（写真。端末から直接やり取りする）
```

| サービス | 役割 | 設定のポイント |
| --- | --- | --- |
| ECR | イメージの置き場所 | `docker build` して push する |
| ECS Fargate | アプリを動かす | 0.25〜0.5 vCPU / 1GB から。タスク数は1でよい |
| ALB | HTTPS と振り分け | ヘルスチェックは `/health`。`TRUST_PROXY=1` にする |
| RDS PostgreSQL 16 | データ | db.t4g.micro から。自動バックアップを有効に |
| S3 | 写真 | バケットは**非公開**のまま。アプリが署名付きURLを作る |
| Secrets Manager | 接続文字列・鍵 | 環境変数に直接書かない |
| EventBridge Scheduler | 夜間バッチ | 1日1回、下のコマンドを ECS タスクとして動かす |

**S3 の CORS**（端末から直接アップロードするため）:

```json
[{
  "AllowedOrigins": ["https://<アプリのドメイン>"],
  "AllowedMethods": ["GET", "PUT"],
  "AllowedHeaders": ["content-type"],
  "ExposeHeaders": [],
  "MaxAgeSeconds": 3000
}]
```

S3 を使うときは `PHOTO_ORIGIN=https://<バケット>.s3.<リージョン>.amazonaws.com` も設定します
（Web 版が写真を読み込める先として許可するため）。

**IAM**：タスクロールには、そのバケットへの `s3:GetObject` `s3:PutObject` `s3:DeleteObject` だけを与えます。

費用の目安：Fargate 1タスク常時 + db.t4g.micro + ALB で、月におよそ 7,000〜15,000円。
このうち ALB と RDS が大半で、アクセスが増えても急には増えません。
写真は S3 の保存量ぶんだけ（1店舗あたり数百MB想定なら、月に数十円）。

### 3-3. もっと安く済ませたい場合

- ALB を使わず、Fargate に直接ドメインを向けるのは面倒なので、**Lightsail のコンテナ**か**小さな VPS 1台**のほうが安く簡単です。
- その場合も PostgreSQL はマネージド（バックアップ付き）にするか、自分で毎日バックアップを取ってください。

---

## 4. 出すまでの手順

```bash
# 1. イメージを作る
docker build -t misenare:latest .

# 2. マイグレーション（アプリを起動する前に、1回だけ。複数台で同時に流さない）
docker run --rm -e DATABASE_URL=… misenare:latest npx tsx apps/api/src/cli/migrate.ts

# 3. 最初の会社・店舗・管理者を作る（招待リンクが1本だけ出る）
docker run --rm -e DATABASE_URL=… -e APP_URL=https://<ドメイン> \
  misenare:latest npx tsx apps/api/src/cli/bootstrap.ts "会社名" "店舗名" "あなたの名前"

# 4. 起動
docker run -d -p 8787:8787 -e DATABASE_URL=… -e TRUST_PROXY=1 misenare:latest
```

3 で出てくる招待リンクを自分のスマホで開くと、その端末が administrator として登録されます。
あとは画面の「承認・管理 → スタッフを招待する」で、QRコードを見せて増やしていきます。

### 夜間バッチ（1日1回）

```bash
docker run --rm -e DATABASE_URL=… misenare:latest npx tsx apps/api/src/batch/nightly.ts
```

やること：期限切れのナレッジを外す、タグの関係の候補を作る、索引を作り直す、
タグの使用回数を数え直す、タグの読みを埋める、送りかけの写真を片付ける。

止まっても次の晩にやり直せます（取り返しのつかない操作はしません）。

---

## 5. 運用で必ず決めておくこと

1. **バックアップ**。RDS なら自動バックアップを7日以上。自前なら `pg_dump` を毎晩どこかに。
   **戻せることを一度試してください**。試していないバックアップは無いのと同じです。
2. **写真の置き場所**。サーバーのディスクに置くなら、そのディスクもバックアップの対象に入れます。
3. **招待の運用**。招待リンクは1回限り・72時間ですが、作った人が誰かに見せれば誰でも入れます。
   辞めた人の端末は「承認・管理 → スタッフ」から無効にしてください。すぐに使えなくなります。
4. **ログ**。今は標準出力に出すだけです。CloudWatch などに流しておくと、後で追えます。

---

## 6. まだやっていないこと

正直に書いておきます。

- **多言語**。日本語のみです。
- **PDF の取り込み**。Word・Excel・CSV・テキストはできます。
- **複数台で動かすときの試行回数の制限**。今はサーバーの記憶の中で数えているので、台ごとの上限になります。
  本気で守るなら Redis などに移すか、ALB の前で止めます。
- **写真の自動削除**。ナレッジを消せば写真も消えますが、古い写真の整理は手作業です。
- **監視**。`/health` はありますが、何かあったときに知らせる仕組みは入れていません。
