#!/usr/bin/env bash
# 新しいサーバー1台に、ミセナレを動く状態まで持っていく。
#
# 想定：Ubuntu 24.04（ARM / x86 どちらでも）。root になれる利用者で動かす。
#   curl -fsSL https://raw.githubusercontent.com/Yukisiooisiiyo/misenare/main/deploy/setup.sh -o setup.sh
#   less setup.sh        # 何をするか読んでから
#   sudo bash setup.sh app.misenare.com
#
# **先に済ませておくこと（この台本からはできない）**
#   1. クラウド側の入口（Oracle なら VCN のセキュリティリスト）で 80 と 443 を開ける
#   2. そのドメインの A レコードを、この台の公開 IP に向ける
# どちらかが無いと、証明書の取得で必ず失敗する。
set -euo pipefail

HOST="${1:-}"
if [ -z "$HOST" ]; then
  echo "使い方: sudo bash setup.sh <ドメイン名>   例) sudo bash setup.sh app.misenare.com" >&2
  exit 2
fi
if [ "$(id -u)" != "0" ]; then
  echo "root で動かしてください（sudo bash setup.sh ...）" >&2
  exit 2
fi

REPO="${MISENARE_REPO:-https://github.com/Yukisiooisiiyo/misenare.git}"
DIR="${MISENARE_DIR:-/opt/misenare}"

say() { printf '\n==> %s\n' "$1"; }

say "1/7 必要なものを入れる"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
docker --version

say "2/7 この台の 80 と 443 を開ける"
# Oracle の Ubuntu イメージは、22 以外を拒否する規則が最初から入っている。
# クラウド側のセキュリティリストを開けても、ここを開けないと届かない。
for port in 80 443; do
  if iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    echo "  $port は既に開いています"
  else
    iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
    echo "  $port を開けました"
  fi
done
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save >/dev/null
  echo "  再起動後も残るように保存しました"
else
  echo "  注意: netfilter-persistent が無いので、再起動すると元に戻ります" >&2
fi

say "3/7 ソースを置く"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR/deploy"

say "4/7 設定を作る"
if [ -f .env ]; then
  echo "  .env が既にあるので、作り直しません（消したい場合は手で消してください）"
else
  rand() { openssl rand -hex 24; }
  key() { openssl rand -base64 32; }
  umask 077
  cat > .env <<ENV
# setup.sh が作ったもの。**この中身は外に出さない。**
MISENARE_HOST=$HOST
APP_URL=https://$HOST
WEBAUTHN_RP_ID=$HOST
WEBAUTHN_ORIGINS=https://$HOST
METRICS_TOKEN=$(rand)
DB_ADMIN_PASSWORD=$(rand)
DB_APP_PASSWORD=$(rand)
MISENARE_SECRET_KEYS=k1:$(key)
MISENARE_SECRET_KEY_ID=k1
SSO_REDIRECT_URI=https://$HOST/api/auth/sso/callback
MISENARE_RATE_SALT=$(openssl rand -hex 16)
# 知らせのメールを送るなら、この4つを埋めて docker compose up -d api を打ち直す
#SMTP_HOST=
#SMTP_PORT=587
#SMTP_USER=
#SMTP_PASS=
#MAIL_FROM=misenare@$HOST
ENV
  echo "  合言葉と鍵は、この台で作りました（$DIR/deploy/.env）"
fi

say "5/7 イメージを作る（数分かかります）"
docker compose build

say "6/7 データベースを用意して、表を作る"
docker compose up -d db
for i in $(seq 1 60); do
  if docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 2
  if [ "$i" = "60" ]; then echo "データベースが立ち上がりませんでした" >&2; exit 1; fi
done
docker compose run --rm api npx tsx apps/api/src/cli/migrate.ts

say "7/7 動かす"
docker compose up -d
echo
echo "----------------------------------------------------------------"
echo "あとは、最初の管理者を作るだけです。次を打ってください："
echo
echo "  cd $DIR/deploy"
echo "  docker compose run --rm api npx tsx apps/api/src/cli/bootstrap.ts \"会社名\" \"店舗名\" \"あなたの名前\""
echo
echo "出てくる招待URLは**その場で開いて**ください（最初の管理者はこれでしか入れません）。"
echo
echo "証明書が取れたかの確認：  curl -i https://$HOST/health"
echo "うまくいかないときは：    cd $DIR/deploy && docker compose logs caddy --tail 50"
echo "----------------------------------------------------------------"
