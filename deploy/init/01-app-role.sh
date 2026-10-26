#!/bin/sh
# アプリがつなぐロールを作る。**管理用のロールではアプリは起動しない。**
#
# PostgreSQL のスーパーユーザーと BYPASSRLS を持つロールは、
# FORCE ROW LEVEL SECURITY でも行レベルセキュリティを素通りする。
# その接続でアプリを動かすと会社をまたいでデータが見えるので、
# アプリは起動時に自分の権限を見て、素通りする接続なら起動を拒否する
# （apps/api/src/db/safety.ts）。
#
# postgres のイメージは POSTGRES_USER をスーパーユーザーとして作るので、
# それとは別に、素通りしないロールをここで用意する。
set -eu
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD を決めてください}"

# 合言葉は psql に :'pw' で渡す（引用符が入っていても壊れない形）
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=pw="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE misenare LOGIN PASSWORD :'pw'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE misenare OWNER misenare;
SQL

echo "アプリ用のロール misenare とデータベース misenare を作りました（NOSUPERUSER NOBYPASSRLS）"
