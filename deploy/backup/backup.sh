#!/usr/bin/env bash
# DB と写真の退避（バックアップ）。compose の backup サービスが、1日1回これを走らせる。
# 使い方と戻し方は docs/deploy.md の 15 章。
#
#   backup.sh loop              … 決めた時刻（既定は日本時間の 03:00）まで寝て、once を走らせるのを繰り返す
#   backup.sh once              … いますぐ1回取る
#   backup.sh status            … いちばん新しい結果を1行で言う
#   backup.sh list              … 残っている退避を並べる
#   backup.sh verify [--strict] … いちばん新しい退避を、別の名前のデータベースに戻してみて、件数を今と比べる
#   backup.sh restore <ファイル> … 退避から戻す（いまのデータベースは名前を変えて残す）。CONFIRM=<データベース名> が要る
#   backup.sh restore-photos <場所> … 写真の写しから、<場所> に無いものだけを戻す（あるものは書き換えない）
#
# 置き場所（どれも**同じ台の中**。操作の誤りには効くが、台ごと無くす事故には効かない）:
#   $BACKUP_DIR/db/misenare-YYYYmmdd-HHMMSS.dump   pg_dump の独自形式（pg_restore で戻す）
#   $BACKUP_DIR/photos/                            写真の写し
#   $BACKUP_DIR/photos-removed/YYYY-mm-dd/         元から消えた写真（しばらく残してから消す）
#   $STATUS_DIR/status.json                        いちばん新しい結果（アプリが読んで、運営者の画面に出す）
#
# つなぎ先は PGHOST・PGUSER・PGPASSWORD・PGDATABASE で受ける。
# 行レベルセキュリティを素通りできるロール（管理用）でないと、中身が空の退避になる。
set -euo pipefail
umask 077

BACKUP_DIR="${BACKUP_DIR:-/backups}"
STATUS_DIR="${STATUS_DIR:-/status}"
PHOTO_DIR="${PHOTO_DIR:-/photos}"
DATABASE="${PGDATABASE:-misenare}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"          # DB の退避を残す日数
KEEP_MIN="${BACKUP_KEEP_MIN:-3}"             # 古くても、新しいほうからこの数は消さない（取れない日が続いたときのため）
PHOTO_GRACE_DAYS="${BACKUP_PHOTO_GRACE_DAYS:-30}"   # 元から消えた写真を、写しの側に残す日数
MIN_FREE_MB="${BACKUP_MIN_FREE_MB:-500}"     # 空きがこれを下回ったら取らない（DB と同じディスクを埋めないため）
AT_UTC="${BACKUP_AT_UTC:-18:00}"             # 取る時刻（UTC）。18:00 = 日本時間の 03:00
FRESH_HOURS=20                               # 起動したとき、これより新しい退避があれば、すぐには取らない

# 数や時刻の形でないものが入っていたら、既定に戻す（空や文字のまま計算や削除に使わない）
is_number() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
is_number "$KEEP_DAYS" || KEEP_DAYS=14
is_number "$KEEP_MIN" || KEEP_MIN=3
is_number "$PHOTO_GRACE_DAYS" || PHOTO_GRACE_DAYS=30
is_number "$MIN_FREE_MB" || MIN_FREE_MB=500
[[ "$AT_UTC" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || AT_UTC=18:00
[ "$KEEP_MIN" -ge 1 ] || KEEP_MIN=1
# 消す・動かすのは、この下だけ。場所がおかしいときは何もしない
case "$BACKUP_DIR" in /?*) ;; *) echo "BACKUP_DIR は / から始まる場所にしてください: $BACKUP_DIR" >&2; exit 2 ;; esac
case "$STATUS_DIR" in /?*) ;; *) echo "STATUS_DIR は / から始まる場所にしてください: $STATUS_DIR" >&2; exit 2 ;; esac
[[ "$DATABASE" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "データベースの名前が正しくありません: $DATABASE" >&2; exit 2; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { printf '%s %s\n' "$(now_iso)" "$*"; }
free_mb() { df -Pm "$BACKUP_DIR" | awk 'NR==2 { print $4 }'; }
# 名前に日時が入っているので、名前の順 = 古い順
dumps() { find "$BACKUP_DIR/db" -maxdepth 1 -type f -name "$DATABASE-????????-??????.dump" 2>/dev/null | sort; }
newest_dump() { dumps | tail -1; }
# JSON の文字列にする（入れるのは、この台本が決めた文と名前だけ。念のため、制御文字と引用符は落とす）
json_string() { local s; s=$(printf '%s' "$1" | tr -d '\000-\037"\\'); printf '"%s"' "$s"; }
json_or_null() { if [ -n "$1" ]; then json_string "$1"; else printf 'null'; fi; }

RUN_STARTED=""
DUMP_FILE=""; DUMP_BYTES=0; DUMP_TABLES=0
PHOTOS_ON=0; PHOTO_FILES=0; PHOTO_BYTES=0; PHOTO_COPIED=0; PHOTO_REMOVED=0

# いちばん新しい結果を書く。アプリが読むので、書きかけを見せない（別名で書いてから置き換える）
write_status() {
  local ok="$1" error="$2" last_success="" kept oldest tmp
  mkdir -p "$STATUS_DIR"
  chmod 755 "$STATUS_DIR"
  [ "$ok" = true ] && now_iso > "$STATUS_DIR/last-success"
  [ -s "$STATUS_DIR/last-success" ] && last_success=$(head -c 40 "$STATUS_DIR/last-success" | tr -cd '0-9TZ:-')
  kept=$(dumps | wc -l)
  oldest=$(dumps | head -1)
  tmp="$STATUS_DIR/.status.json.$$"
  {
    printf '{\n'
    printf '  "version": 1,\n'
    printf '  "startedAt": %s,\n' "$(json_or_null "$RUN_STARTED")"
    printf '  "finishedAt": %s,\n' "$(json_string "$(now_iso)")"
    printf '  "ok": %s,\n' "$ok"
    printf '  "error": %s,\n' "$(json_or_null "$error")"
    printf '  "lastSuccessAt": %s,\n' "$(json_or_null "$last_success")"
    printf '  "db": { "file": %s, "bytes": %s, "tables": %s },\n' "$(json_or_null "$(basename "${DUMP_FILE:-}")")" "$DUMP_BYTES" "$DUMP_TABLES"
    if [ "$PHOTOS_ON" = 1 ]; then
      printf '  "photos": { "files": %s, "bytes": %s, "copied": %s, "removed": %s },\n' "$PHOTO_FILES" "$PHOTO_BYTES" "$PHOTO_COPIED" "$PHOTO_REMOVED"
    else
      printf '  "photos": null,\n'
    fi
    printf '  "kept": %s,\n' "$kept"
    printf '  "oldestKept": %s,\n' "$(json_or_null "$(basename "${oldest:-}")")"
    printf '  "keepDays": %s,\n' "$KEEP_DAYS"
    printf '  "photoGraceDays": %s,\n' "$PHOTO_GRACE_DAYS"
    printf '  "freeMb": %s\n' "$(free_mb)"
    printf '}\n'
  } > "$tmp"
  chmod 644 "$tmp" "$STATUS_DIR/last-success" 2>/dev/null || true
  mv -f "$tmp" "$STATUS_DIR/status.json"
}

fail() {
  say "退避に失敗: $1" >&2
  write_status false "$1"
  exit 1
}

# 残す日数を過ぎた退避を消す。新しいほうから KEEP_MIN 個は、古くても残す
rotate() {
  local cutoff total index=0 file stamp
  cutoff=$(date -u -d "-$KEEP_DAYS days" +%Y%m%d-%H%M%S)
  total=$(dumps | wc -l)
  while IFS= read -r file; do
    index=$((index + 1))
    [ $((total - index)) -lt "$KEEP_MIN" ] && break
    stamp=$(basename "$file" .dump)
    stamp=${stamp#"$DATABASE"-}
    if [[ "$stamp" < "$cutoff" ]]; then
      rm -f -- "$file"
      say "古い退避を消しました: $(basename "$file")"
    fi
  done < <(dumps)
}

# 写真を写す。写真は書き換えないので、写しに無いものだけを足す。
# 元から消えたものは、すぐには消さず photos-removed に移して、PHOTO_GRACE_DAYS 日たってから消す
mirror_photos() {
  local mirror="$BACKUP_DIR/photos" removed rel cutoff dir name
  removed="$BACKUP_DIR/photos-removed/$(date -u +%Y-%m-%d)"
  mkdir -p "$mirror" "$BACKUP_DIR/photos-removed"
  find "$mirror" -type f -name '*.partial' -delete
  # 書いている途中のものを写さないよう、できて1分たったものだけを見る
  while IFS= read -r -d '' rel; do
    [ -e "$mirror/$rel" ] && continue
    mkdir -p "$(dirname "$mirror/$rel")"
    cp -p "$PHOTO_DIR/$rel" "$mirror/$rel.partial"
    mv "$mirror/$rel.partial" "$mirror/$rel"
    PHOTO_COPIED=$((PHOTO_COPIED + 1))
  done < <(cd "$PHOTO_DIR" && find . -type f -mmin +1 -print0)
  while IFS= read -r -d '' rel; do
    [ -e "$PHOTO_DIR/$rel" ] && continue
    mkdir -p "$(dirname "$removed/$rel")"
    mv "$mirror/$rel" "$removed/$rel"
    PHOTO_REMOVED=$((PHOTO_REMOVED + 1))
  done < <(cd "$mirror" && find . -type f -print0)
  cutoff=$(date -u -d "-$PHOTO_GRACE_DAYS days" +%Y-%m-%d)
  for dir in "$BACKUP_DIR/photos-removed"/*/; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir")
    # 日付の名前のものだけを、日付で比べて消す
    if [[ "$name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] && [[ "$name" < "$cutoff" ]]; then rm -rf -- "$BACKUP_DIR/photos-removed/$name"; fi
  done
  find "$mirror" -mindepth 1 -type d -empty -delete
  PHOTO_FILES=$(find "$mirror" -type f | wc -l)
  PHOTO_BYTES=$(du -sb "$mirror" | cut -f1)
}

# データベースが受け付けるようになるまで待つ（最長 DB_WAIT_SECONDS 秒）
wait_for_db() {
  local waited=0 limit="${BACKUP_DB_WAIT_SECONDS:-90}"
  is_number "$limit" || limit=90
  until pg_isready -q -d "$DATABASE"; do
    [ "$waited" -ge "$limit" ] && return 1
    sleep 3
    waited=$((waited + 3))
  done
}

run_once() {
  local free stamp partial
  RUN_STARTED=$(now_iso)
  mkdir -p "$BACKUP_DIR/db" "$STATUS_DIR"
  chmod 700 "$BACKUP_DIR"
  find "$BACKUP_DIR/db" -maxdepth 1 -type f -name '*.partial' -delete

  free=$(free_mb)
  is_number "$free" || fail "空きの大きさを調べられませんでした"
  [ "$free" -ge "$MIN_FREE_MB" ] || fail "ディスクの空きが足りません（残り ${free}MB。${MIN_FREE_MB}MB を下回ると、退避を取りません）"

  # 台を起こし直した直後は、データベースがまだ受け付けていないことがある。少し待ってから取る
  wait_for_db || fail "データベースにつながりませんでした"

  stamp=$(date -u +%Y%m%d-%H%M%S)
  DUMP_FILE="$BACKUP_DIR/db/$DATABASE-$stamp.dump"
  partial="$DUMP_FILE.partial"
  # くわしい理由は、この台の中の記録（last-error.log）にだけ残す。画面には決まった文だけを出す
  if ! pg_dump --format=custom --file="$partial" "$DATABASE" 2> "$BACKUP_DIR/last-error.log"; then
    rm -f -- "$partial"; DUMP_FILE=""
    fail "データベースを書き出せませんでした"
  fi
  # 書き出したものを読み直して、表の中身が入っていることを確かめる（壊れた退避を「取れた」と言わない）
  if ! DUMP_TABLES=$(pg_restore --list "$partial" 2>> "$BACKUP_DIR/last-error.log" | grep -c ' TABLE DATA '); then DUMP_TABLES=0; fi
  if [ "$DUMP_TABLES" -lt 1 ]; then
    rm -f -- "$partial"; DUMP_FILE=""
    fail "書き出したものを読み直せませんでした"
  fi
  mv "$partial" "$DUMP_FILE"
  DUMP_BYTES=$(stat -c %s "$DUMP_FILE")
  say "データベースを書き出しました: $(basename "$DUMP_FILE")（${DUMP_BYTES} バイト、表 ${DUMP_TABLES}）"
  rotate

  if [ -d "$PHOTO_DIR" ]; then
    PHOTOS_ON=1
    if ! mirror_photos 2>> "$BACKUP_DIR/last-error.log"; then fail "写真を写せませんでした（データベースの退避は取れています）"; fi
    say "写真を写しました: ${PHOTO_FILES} 枚（足した ${PHOTO_COPIED}、元から消えていた ${PHOTO_REMOVED}）"
  fi
  write_status true ""
}

# 表ごとの件数を「表の名前<TAB>件数」で並べる（管理用のロールなので、会社をまたいで数えられる）
table_counts() {
  psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -d "$1" -c \
    "SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
       FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
}

run_verify() {
  local strict="${1:-}" latest scratch="${DATABASE}_restore_check" live restored tables rows
  latest=$(newest_dump)
  [ -n "$latest" ] || { echo "退避がまだありません" >&2; exit 1; }
  say "戻せるかを確かめます: $(basename "$latest") → $scratch（いまのデータベースには触りません）"
  psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE IF EXISTS $scratch" -c "CREATE DATABASE $scratch"
  if ! pg_restore --exit-on-error --dbname="$scratch" "$latest"; then
    psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $scratch" || true
    echo "戻せませんでした" >&2; exit 1
  fi
  live=$(table_counts "$DATABASE")
  restored=$(table_counts "$scratch")
  psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE $scratch"
  tables=$(printf '%s\n' "$restored" | grep -c .) || tables=0
  rows=$(printf '%s\n' "$restored" | awk -F '\t' '{ n += $2 } END { print n + 0 }')
  [ "$tables" -ge 1 ] || { echo "戻したデータベースに表がありません" >&2; exit 1; }
  if [ "$live" = "$restored" ]; then
    say "戻せました。表 ${tables}・行 ${rows}。件数は、いまのデータベースと同じです"
    return 0
  fi
  echo "戻せました（表 ${tables}・行 ${rows}）。退避を取ったあとに動いた分、件数が違う表があります（表 / いま / 退避）:"
  join -t $'\t' -a 1 -a 2 -e '-' -o 0,1.2,2.2 <(printf '%s\n' "$live") <(printf '%s\n' "$restored") | awk -F '\t' '$2 != $3 { printf "  %s\t%s\t%s\n", $1, $2, $3 }'
  # --strict は、取った直後に確かめるとき用（件数が1つでも違えば失敗にする）
  [ "$strict" = "--strict" ] && { echo "件数が一致しません" >&2; exit 1; }
  return 0
}

run_restore() {
  local file="${1:-}" incoming="${DATABASE}_restoring" previous others
  previous="${DATABASE}_before_$(date -u +%Y%m%d_%H%M%S)"
  case "$file" in */*) ;; *) file="$BACKUP_DIR/db/$file" ;; esac
  [ -f "$file" ] || { echo "退避が見つかりません: $file（backup.sh list で名前を確かめてください）" >&2; exit 1; }
  if [ "${CONFIRM:-}" != "$DATABASE" ]; then
    echo "いまのデータベース（$DATABASE）を、$(basename "$file") の中身に入れ替えます。" >&2
    echo "いまの中身は ${DATABASE}_before_… の名前で残しますが、取り違えると利用者のデータが巻き戻ります。" >&2
    echo "進めるときは、CONFIRM=$DATABASE を付けて、もう一度走らせてください。" >&2
    exit 2
  fi
  others=$(psql -X -q -At -d postgres -c "SELECT count(*) FROM pg_stat_activity WHERE datname = '$DATABASE' AND pid <> pg_backend_pid()")
  if [ "$others" != "0" ]; then
    echo "データベースにつないでいるものが ${others} 本あります。先にアプリと夜間バッチを止めてください（docker compose stop api batch）。" >&2
    exit 1
  fi
  say "戻します: $(basename "$file") → $incoming"
  psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "DROP DATABASE IF EXISTS $incoming" -c "CREATE DATABASE $incoming"
  if ! pg_restore --exit-on-error --dbname="$incoming" "$file"; then
    psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $incoming" || true
    echo "戻せませんでした。いまのデータベースは、そのままです" >&2; exit 1
  fi
  # 持ち主をアプリのロールに合わせる（作りたてのデータベースは、作った管理用ロールの持ち物になる）
  psql -X -q -v ON_ERROR_STOP=1 -d postgres \
    -c "DO \$\$ BEGIN EXECUTE format('ALTER DATABASE %I OWNER TO %I', '$incoming', (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '$DATABASE')); END \$\$" \
    -c "ALTER DATABASE $DATABASE RENAME TO $previous" \
    -c "ALTER DATABASE $incoming RENAME TO $DATABASE"
  say "入れ替えました。前の中身は $previous に残っています。"
  echo "確かめたあとで要らなくなったら、次で消せます:"
  echo "  docker compose exec -T db psql -U postgres -c 'DROP DATABASE $previous'"
}

# 写真の写しから、無いものだけを戻す。いまある写真は書き換えない（写真は書き換えないものなので、あるものは同じ）
run_restore_photos() {
  local target="${1:-}" mirror="$BACKUP_DIR/photos" rel restored=0 present=0
  case "$target" in /?*) ;; *) echo "戻す先を / から始まる場所で指定してください（例: /restore）" >&2; exit 2 ;; esac
  [ -d "$target" ] || { echo "戻す先がありません: $target" >&2; exit 1; }
  [ -d "$mirror" ] || { echo "写真の写しがまだありません" >&2; exit 1; }
  while IFS= read -r -d '' rel; do
    if [ -e "$target/$rel" ]; then present=$((present + 1)); continue; fi
    mkdir -p "$(dirname "$target/$rel")"
    # 途中で止まっても半端なものを残さないよう、別名で写してから置く。持ち主と時刻も写す
    cp -p "$mirror/$rel" "$target/$rel.partial"
    mv "$target/$rel.partial" "$target/$rel"
    restored=$((restored + 1))
  done < <(cd "$mirror" && find . -type f ! -name '*.partial' -print0)
  # 足したフォルダの持ち主を、戻す先のいちばん上に合わせる（アプリが、あとから同じ場所に書けるように）
  find "$target" -mindepth 1 -type d ! -user "$(stat -c %u "$target")" -exec chown --reference="$target" {} + 2>/dev/null || true
  say "写真を戻しました: ${restored} 枚（もともとあった ${present} 枚には触っていません）"
}

status_line() {
  local file="$STATUS_DIR/status.json" field
  [ -s "$file" ] || { echo "退避: まだ1回も取っていません"; return 0; }
  field() { sed -n "s/^  \"$1\": \\(.*\\),\\{0,1\\}\$/\\1/p" "$file" | head -1 | sed 's/,$//'; }
  if [ "$(field ok)" = true ]; then
    echo "退避: 成功 $(field finishedAt | tr -d '"')（DB $(sed -n 's/.*"bytes": \([0-9]*\), "tables": \([0-9]*\).*/\1 バイト・表 \2/p' "$file" | head -1)、残してある数 $(field kept)、空き $(field freeMb)MB）"
  else
    echo "退避: 失敗 $(field finishedAt | tr -d '"') $(field error | tr -d '"')（最後に取れたのは $(field lastSuccessAt | tr -d '"')）"
  fi
}

seconds_until_next() {
  local now target
  now=$(date -u +%s)
  target=$(date -u -d "today $AT_UTC" +%s)
  [ "$target" -gt "$now" ] || target=$(date -u -d "tomorrow $AT_UTC" +%s)
  echo $((target - now))
}

# 輪。起動したときは「取り逃していないか」を見てから、次の時刻まで待つ。
# 1回取るたびに、この台本を読み込み直して続きをする（resume）。台本が新しくなっていれば、輪の中身ごと新しくなる。
# 続きのときは、取り逃しの確かめをしない（失敗した直後にすぐ取り直して、回り続けないように）
run_loop() {
  local resume="${1:-}" newest age wait_for
  trap 'kill "${sleeper:-}" 2>/dev/null; exit 0' TERM INT
  mkdir -p "$BACKUP_DIR/db"
  if [ "$resume" != resume ]; then
    # 入れ替え（デプロイ）や起こし直しのたびに取り直さないよう、新しい退避があるときは次の時刻まで待つ
    newest=$(newest_dump)
    age=$((FRESH_HOURS * 3600 + 1))
    [ -n "$newest" ] && age=$(( $(date -u +%s) - $(stat -c %Y "$newest") ))
    if [ "$age" -gt $((FRESH_HOURS * 3600)) ]; then
      bash "$0" once || say "退避に失敗しました（次の時刻にやり直します）"
    fi
  fi
  while true; do
    wait_for=$(seconds_until_next)
    say "次の退避まで ${wait_for} 秒待ちます（毎日 ${AT_UTC} UTC）"
    sleep "$wait_for" &
    sleeper=$!
    wait "$sleeper" || true
    bash "$0" once || say "退避に失敗しました（次の時刻にやり直します）"
    # 台本が読める形なら、読み込み直して続ける。書き間違えた台本が置かれていたら、いまの輪のまま続ける
    if bash -n "$0" 2>/dev/null; then exec bash "$0" loop resume; fi
    say "台本を読み込み直せませんでした。いまの輪のまま続けます"
  done
}

case "${1:-}" in
  loop) run_loop "${2:-}" ;;
  once) run_once ;;
  status) status_line ;;
  list) dumps | while IFS= read -r f; do printf '%s\t%s バイト\n' "$(basename "$f")" "$(stat -c %s "$f")"; done ;;
  verify) run_verify "${2:-}" ;;
  restore) run_restore "${2:-}" ;;
  restore-photos) run_restore_photos "${2:-}" ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
