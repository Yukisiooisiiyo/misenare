#!/usr/bin/env bash
# この台を、いま取り出してある版（git の作業ツリー）に入れ替える。
#
#   sudo bash deploy/deploy.sh
#
# .github/workflows/deploy.yml が、git pull のあとに呼ぶ。手で入れ替えるときも、同じものを使う。
# CI（docker の仕事）が、compose の中でこの台本をそのまま走らせて確かめている
# （何も変わっていなければ何も作り直さない／Caddyfile が変われば Caddy を作り直す／
#   書き間違えた Caddyfile では何も入れ替えずに止まる／アプリが変わればアプリを作り直す）。
#
# 順番：
#   1. Caddyfile が変わっていたら、入れ替える前に確かめる（書き間違いで入口ごと落とさない）
#   2. 新しいイメージを作る
#   3. マイグレーションを、新しいイメージで流す（通らなければ、ここで止まる。アプリは古い版のまま）
#   4. アプリ・夜間バッチ・退避を、新しいイメージと設定で起こす（変わっていないものは、そのまま）
#   5. Caddyfile が変わっていたら、Caddy を作り直す（証明書は caddy_data に残る）
#   6. 新しいアプリが起きて DB につながっていること、入口（https）が応えることを確かめる
#   7. 退避の、いちばん新しい結果を言う
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n==> %s\n' "$1"; }

# --- 1. Caddyfile -------------------------------------------------------------------
# Caddyfile は1ファイルだけを差し込んでいるので、書き換えても、動いている Caddy には届かない（作り直すまで前のまま）。
# 作り直したときに「どの中身で作ったか」をコンテナの中に書き残しておき、いまのファイルと比べる。
# git の差分は見ない（入れ替えが途中で止まったあとや、手で直したあとでも、次の入れ替えで揃うように）。
CADDY_MARK=/tmp/caddyfile.applied
wanted=$(sha256sum Caddyfile | cut -d' ' -f1)
applied=$(docker compose exec -T caddy cat "$CADDY_MARK" 2>/dev/null | tr -cd 'a-f0-9' || true)
caddy_changed=no
if [ "$applied" != "$wanted" ]; then
  caddy_changed=yes
  say "Caddyfile が、動いている Caddy のものと違う。入れ替える前に確かめる"
  # この台に置いてある Caddy で読んでみる。書き間違いがあれば、ここで止まる（何も入れ替わらない）
  docker run --rm -e MISENARE_HOST=check.example.com -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
fi

# --- 2〜4. イメージ・マイグレーション・入れ替え ------------------------------------------
say "新しいイメージを作る"
docker compose build
say "DB を起こす（すでに動いていれば、何もしない）"
docker compose up -d db
say "マイグレーションを、新しいイメージで流す"
docker compose run --rm api npx tsx apps/api/src/cli/migrate.ts
say "入れ替える（変わっていないものは、そのまま）"
docker compose up -d

# --- 5. Caddy ----------------------------------------------------------------------
if [ "$caddy_changed" = yes ]; then
  say "Caddy を作り直す"
  docker compose up -d --force-recreate caddy
  # どの中身で作ったかを、コンテナの中に書き残す（作り直すと消えるので、次に比べたときに「違う」と分かる）
  for _ in $(seq 1 15); do docker compose exec -T caddy sh -c "echo $wanted > $CADDY_MARK" && break; sleep 1; done
fi
docker image prune -f > /dev/null

# --- 6. 確かめる --------------------------------------------------------------------
say "新しいアプリが起きて、DB につながっていること"
ready() { docker compose exec -T api node -e "fetch('http://127.0.0.1:8787/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; }
for _ in $(seq 1 30); do ready && break; sleep 2; done
docker compose exec -T api node -e "fetch('http://127.0.0.1:8787/ready').then(async (r) => { console.log('アプリ: /ready', r.status, await r.text()); process.exit(r.ok ? 0 : 1); }).catch((e) => { console.log('アプリ: 応答なし', String(e)); process.exit(1); })"

say "入口（https）が応えること"
# .env の MISENARE_HOST の、最初の名前で確かめる。この台の Caddy に直接つなぐ（外を回らない）
host=$(sed -n 's/^MISENARE_HOST=//p' .env | tr -d '"'"'" | tr ',' ' ' | awk 'NR == 1 { print $1 }')
headers=""
for _ in $(seq 1 30); do
  headers=$(curl -sk -o /dev/null -D - --max-time 10 --resolve "$host:443:127.0.0.1" "https://$host/health" 2>/dev/null | tr -d '\r' || true)
  case "${headers%%$'\n'*}" in *' 200'*) break ;; esac
  sleep 2
done
# 入口が返した守りの見出しを、記録に残す
grep -iE '^(HTTP/|strict-transport-security:|x-frame-options:|referrer-policy:)' <<< "$headers" | sed 's/^/入口: /' || true
case "${headers%%$'\n'*}" in
  *' 200'*) ;;
  *) echo "入口（https://$host/health）が 200 を返しません" >&2; exit 1 ;;
esac

say "動いているもの"
docker compose ps

# --- 7. 退避 -----------------------------------------------------------------------
say "退避（退避が1つも無いときは、起動してすぐに1回取る）"
for _ in $(seq 1 45); do docker compose exec -T backup test -s /status/status.json && break; sleep 2; done
docker compose exec -T backup bash /opt/backup/backup.sh status
