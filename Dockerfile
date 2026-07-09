# LINE OA 客戶進度中樞 — 後端容器映像(多階段)
# 執行方式:tsx 直接跑 TypeScript(無需 tsc 產物);tsx 已列於 backend dependencies。
# better-sqlite3 為原生模組,需在 builder 階段以編譯工具 build,再把成品 node_modules 複製到 runtime。

# ---------- 階段 1:builder(安裝相依 + 編譯 better-sqlite3)----------
FROM node:22-alpine AS builder
WORKDIR /app/backend

# better-sqlite3 需 node-gyp:python3 / make / g++ 才能編譯原生附加元件
RUN apk add --no-cache python3 make g++

# 先只複製 lock 檔以善用 layer 快取;--omit=dev 不裝 devDependencies(tsx 在 deps 內)
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# ---------- 階段 2:runtime(精簡映像,只帶原始碼 + 已編譯 node_modules)----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# 由 builder 複製已編譯好的相依(含 better-sqlite3 原生 .node,同為 alpine 故可直接沿用)
COPY --from=builder /app/backend/node_modules ./backend/node_modules

# 後端原始碼與前端靜態站(webui 由 backend 以 ../webui 同源服務)
COPY backend/package.json backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
COPY webui ./webui

# data(SQLite)與 storage(客戶檔案)以 volume 掛載持久化;先建目錄避免首啟權限問題
RUN mkdir -p /app/backend/data /app/backend/storage

WORKDIR /app/backend
EXPOSE 4680

# npm start = tsx src/server.ts(見 backend/package.json);監聽 0.0.0.0:4680
CMD ["npm", "start"]
