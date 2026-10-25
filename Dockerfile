# 1枚のイメージに API と Web 版を入れる。
# TypeScript は tsx でそのまま動かす（ビルド済みの JS を作らない）。Web 版だけ esbuild でまとめる。

FROM node:22-slim AS build
WORKDIR /app

# 依存だけ先に入れて、コードだけ変えたときは入れ直さずに済むようにする
COPY package.json package-lock.json* ./
COPY packages/search-core/package.json packages/search-core/
COPY packages/qr/package.json packages/qr/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build:web

# 本番用：開発にしか使わないもの（esbuild など）を外す
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787

# マイグレーションは psql にファイルをそのまま流す（各ファイルが自分で BEGIN / COMMIT する）。
# 運用で中身を確かめるときにも使えるので、本番のイメージにも入れておく。
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/db ./db
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/apps/web/package.json ./apps/web/package.json

# root では動かさない
USER node
EXPOSE 8787

# 動いているかの確認（ロードバランサーのヘルスチェックも同じ場所を見る）
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# マイグレーションは起動時ではなく、別に流す（複数台で同時に動かさないため）
#   docker run --rm -e DATABASE_URL=... <image> npx tsx apps/api/src/cli/migrate.ts
CMD ["npx", "tsx", "apps/api/src/server.ts"]
