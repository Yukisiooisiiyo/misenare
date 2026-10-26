#!/usr/bin/env bash
# CI の結果を 1 つの Markdown にまとめる。
#
# 見張り役のエージェントは、この台本を回して出来上がった .md を読むだけでよい。
# LLM を使わずに取れるものは全部ここで取る（毎回エージェントに同じ手順を
# 思い出させるのは無駄だし、思い出し方を間違える）。
#
#   使い方: tools/ci-report.sh <ブランチ名> [待つ秒数（既定 1800）] [出力先]
#
# ここに埋め込んである知識（毎回ハマるので台本側に持たせる）:
#   * ログの実体（blob ストレージ）はこの環境の外向き通信で弾かれる。
#     だから `gh run view --log` は使えない。失敗の中身は
#     `gh api repos/{owner}/{repo}/check-runs/<id>/annotations` から取る。
#     ワークフローが `::error::` を出していれば、これで理由まで分かる。
#   * GraphQL も使えない。`gh repo view` も GraphQL なので使えないので、
#     リポジトリ名は git のリモート URL から取る。`gh api` と `gh run` は使える。

set -uo pipefail

branch="${1:?使い方: tools/ci-report.sh <ブランチ名> [待つ秒数] [出力先]}"
wait_for="${2:-1800}"
out="${3:-.ci/report.md}"

# gh repo view は GraphQL なので使えない。リモート URL から owner/repo を切り出す。
repo="$(git remote get-url origin 2>/dev/null \
  | sed -E 's#^(https://[^/]+/|git@[^:]+:)##; s#\.git$##')"
[ -n "$repo" ] || { echo "リポジトリが分かりません（git remote origin を見てください）" >&2; exit 2; }

mkdir -p "$(dirname "$out")"
deadline=$(( $(date +%s) + wait_for ))
started="$(date -Is)"

# --- 対象の実行を1つ選ぶ ------------------------------------------------------
# 直前に push した直後は実行がまだ現れないので、少しのあいだ待つ。
run_id=""
for _ in $(seq 1 10); do
  run_id="$(gh run list --branch "$branch" -L 1 --json databaseId -q '.[0].databaseId' 2>/dev/null)"
  [ -n "$run_id" ] && break
  sleep 6
done
if [ -z "$run_id" ]; then
  {
    echo "# CI: $branch"
    echo
    echo "**結論: 実行が見つからない**（$started 時点）"
    echo
    echo "このブランチで走った実行がない。ワークフローの \`on:\` が"
    echo "このブランチを拾っていない可能性がある（例: main と pull_request だけ）。"
  } > "$out"
  echo "no-run"
  exit 0
fi

# --- 終わるまで待つ -----------------------------------------------------------
status=""; conclusion=""
while :; do
  read -r status conclusion < <(
    gh run view "$run_id" --json status,conclusion -q '[.status, (.conclusion // "")] | @tsv' 2>/dev/null
  )
  [ "$status" = "completed" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then conclusion="timed_out"; break; fi
  sleep 20
done

url="$(gh run view "$run_id" --json url -q .url 2>/dev/null)"
sha="$(gh run view "$run_id" --json headSha -q .headSha 2>/dev/null)"

# --- まとめを書く -------------------------------------------------------------
{
  echo "# CI: $branch"
  echo
  if [ "$conclusion" = "success" ]; then
    echo "**結論: 緑**"
  elif [ "$conclusion" = "timed_out" ]; then
    echo "**結論: 時間切れ（まだ走っている）**"
  else
    echo "**結論: 赤（$conclusion）**"
  fi
  echo
  echo "- 実行: [$run_id]($url)"
  echo "- コミット: \`${sha:0:12}\`"
  echo "- 見た時刻: $started 〜 $(date -Is)"
  echo
  echo "## ジョブ"
  echo
  echo "| ジョブ | 結論 |"
  echo "| --- | --- |"
  gh run view "$run_id" --json jobs \
    -q '.jobs[] | "| \(.name) | \(.conclusion // .status) |"' 2>/dev/null
  echo
} > "$out"

# --- 失敗したジョブだけ、理由を取りに行く ------------------------------------
if [ "$conclusion" != "success" ] && [ "$conclusion" != "timed_out" ]; then
  {
    echo "## 失敗したところ"
    echo
  } >> "$out"
  gh run view "$run_id" --json jobs \
    -q '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped" and .conclusion != null) | "\(.databaseId)\t\(.name)"' 2>/dev/null |
  while IFS=$'\t' read -r job_id job_name; do
    {
      echo "### $job_name"
      echo
      # 注記は1件ずつ「パス:行 レベル 本文」で出す。本文は改行を含むので潰す。
      count="$(gh api "repos/$repo/check-runs/$job_id/annotations" \
        -q 'length' 2>/dev/null || echo 0)"
      if [ "${count:-0}" -gt 0 ]; then
        echo '```'
        gh api "repos/$repo/check-runs/$job_id/annotations" \
          -q '.[] | "\(.path):\(.start_line) [\(.annotation_level)] \(.message)"' 2>/dev/null |
          tr '\r' ' ' | head -60
        echo '```'
      else
        echo "注記なし。ワークフローが \`::error::\` を出していないと、"
        echo "この環境からは理由を取れない（ログの実体は外向き通信で弾かれる）。"
        echo "対処: 失敗した手順に \`::error::\` を出す行を足すか、手元で同じコマンドを回す。"
      fi
      echo
      echo "失敗した手順:"
      echo
      gh run view "$run_id" --json jobs \
        -q ".jobs[] | select(.databaseId == $job_id) | .steps[] | select(.conclusion == \"failure\") | \"- \(.name)\"" 2>/dev/null
      echo
    } >> "$out"
  done
fi

echo "$conclusion"
