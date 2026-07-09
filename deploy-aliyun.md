# 阿里雲 ECS 公網部署指南(Docker + 自動 HTTPS)

把原本只在區域網路跑的「LINE OA 客戶進度中樞」搬上阿里雲,讓同仁在任何地方都能用網域 + HTTPS 安全登入。全程約 30–40 分鐘。

> 核心安全原則(務必遵守):
> 1. **對外只開 80/443**,4680 埠**絕不**對公網開放(僅本機迴環 + 反代)。
> 2. `.env` 必設 **`PUBLIC_MODE=1`** — 登入頁不再把插件 Token 印給任何訪客;需登入後於後台取得。
> 3. `.env`(含金鑰)、`data/`、`storage/`(客戶資料)**永遠不進 git**,只在伺服器上存在。

---

## 0. 事前準備

- 一台阿里雲 **ECS**,作業系統選 **Ubuntu 22.04 LTS**(1 vCPU / 2GB 起步即可,檔案多建議 40GB+ 系統盤或另掛資料盤)。
- 一個**網域**(可在阿里雲或任意註冊商購買),例如 `crm.example.com`。
- 本機現有的資料:`backend/data/app.db`(資料庫)與 `backend/storage/`(客戶檔案)。
- 你的 **OpenAI API Key** 與現用的 **EXTENSION_TOKEN**(見本機 `backend/.env`)。

---

## 1. 設定阿里雲安全組(只開 80 / 443 / 22)

到 **ECS 控制台 → 網路與安全 → 安全組 → 設定規則 → 入方向**,只保留:

| 協定 | 埠 | 授權對象 | 用途 |
|---|---|---|---|
| TCP | 22 | 你的辦公室固定 IP(建議)或 0.0.0.0/0 | SSH 管理 |
| TCP | 80 | 0.0.0.0/0 | HTTP(自動導向 HTTPS + 憑證申請) |
| TCP | 443 | 0.0.0.0/0 | HTTPS(同仁存取) |

**不要**新增 4680 的規則。後端只綁在容器內與本機迴環,對外一律經反代。

---

## 2. 網域解析(DNS)

到網域的 DNS 管理,新增一筆 **A 記錄**:

```
主機記錄:crm      (即最終網址 crm.example.com)
記錄類型:A
記錄值:  <你的 ECS 公網 IP>
TTL:     10 分鐘
```

等解析生效(`ping crm.example.com` 回你的 ECS IP 即可)。憑證申請前 DNS 必須已指向本機。

---

## 3. SSH 登入伺服器並安裝 Docker

```bash
ssh root@<你的 ECS 公網 IP>

# 安裝 Docker(官方一鍵腳本)
curl -fsSL https://get.docker.com | sh

# 啟用並開機自啟
systemctl enable --now docker

# 驗證(會顯示版本 + compose v2)
docker --version
docker compose version
```

> Docker Desktop 以外的 Linux 版內建 `docker compose`(v2 外掛),指令是 `docker compose`(中間空格),非舊版 `docker-compose`。

---

## 4. 取得程式碼

本公開庫**只含程式碼**,不含任何金鑰或客戶資料(見 `.gitignore`),可放心 clone:

```bash
mkdir -p /opt && cd /opt
git clone <你的公開庫 URL> lineoa
cd /opt/lineoa
```

之後專案根目錄即 `/opt/lineoa`,以下指令都在此執行。

---

## 5. 建立 .env(關鍵:PUBLIC_MODE=1)

複製範本並填入正式值:

```bash
cp backend/.env.example .env
nano .env
```

`.env`(放在**專案根目錄**,`docker-compose.yml` 以 `env_file` 讀它)至少要有:

```ini
# 公網加固開關 —— 公網部署務必設 1(登入頁不再顯示 Token,改為需登入後取得)
PUBLIC_MODE=1

# 插件同步金鑰 —— 沿用本機 backend/.env 內的同一串,否則現有插件會失聯
EXTENSION_TOKEN=<與本機相同的那一串>

# OpenAI 金鑰(留空則 AI 總結停用,其餘照常)
OPENAI_API_KEY=sk-...

# 模型與埠(維持預設即可)
LLM_MODEL=gpt-5.5
PORT=4680

# admin 初始密碼(僅首次、users 表為空時生效;登入後請立刻改)
ADMIN_INITIAL_PASSWORD=<自訂一組強密碼>
```

存檔:`Ctrl+O` → Enter → `Ctrl+X`。

> `.env` 已被 `.gitignore` 排除,不會被 `git` 追蹤;請勿 commit。

---

## 6. 啟動後端容器

```bash
cd /opt/lineoa
docker compose up -d --build
```

- 首次會建置映像(含編譯 better-sqlite3,約數分鐘)。
- 起來後 `data/` 與 `storage/` 目錄會自動出現在專案根(對應容器內的 volume)。

檢查狀態與日誌:

```bash
docker compose ps
docker compose logs -f backend      # 看到 "backend listening on http://0.0.0.0:4680" 即成功;Ctrl+C 退出

# 本機自我測試(容器綁在 127.0.0.1:4680)
curl -s http://127.0.0.1:4680/api/health
```

此時**還不能**用網域存取——需先架反代 + HTTPS(下一步)。

---

## 7. 網域 + HTTPS(方案 A:Caddy,推薦最簡)

Caddy 會**自動**申請並續期 Let's Encrypt 憑證,零手動維護。

### 7A-1. 安裝 Caddy

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

### 7A-2. 套用本專案附的 Caddyfile

專案根已附 `Caddyfile` 範例(反代 `127.0.0.1:4680` + 自動 HTTPS + 放寬 300MB 上傳)。把網域改成你的,再覆蓋系統設定:

```bash
# 把 Caddyfile 內的 crm.example.com 改成你的網域
nano /opt/lineoa/Caddyfile

# 套用
cp /opt/lineoa/Caddyfile /etc/caddy/Caddyfile
mkdir -p /var/log/caddy
systemctl reload caddy

# 看狀態(Active: running 即可)
systemctl status caddy --no-pager
```

打開 `https://crm.example.com` 應能看到登入頁,瀏覽器顯示有效憑證鎖頭。完成。

---

## 7B. 網域 + HTTPS(方案 B:Nginx + certbot,擇一即可)

若你偏好 Nginx:

```bash
apt install -y nginx
```

建立 `/etc/nginx/sites-available/lineoa`:

```nginx
server {
    listen 80;
    server_name crm.example.com;

    client_max_body_size 300M;   # 契約檔案上限

    location / {
        proxy_pass http://127.0.0.1:4680;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

啟用並套憑證:

```bash
ln -s /etc/nginx/sites-available/lineoa /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 用 certbot 自動改寫成 443 + 申請憑證 + 設定自動續期
apt install -y certbot python3-certbot-nginx
certbot --nginx -d crm.example.com
```

certbot 會自動加 443 server 區塊、把 80 導向 443,並設好續期定時任務。

---

## 8. 遷移本機既有資料(對話 / 檔案)

把本機累積的資料庫與檔案搬到伺服器對應的 volume 目錄(`/opt/lineoa/data` 與 `/opt/lineoa/storage`)。

### 8-1. 本機:先乾淨匯出(避免 WAL 未落盤)

在本機**先停掉後端**(關掉 `start.bat` 視窗 / 結束 node 行程),讓 SQLite 的 WAL 併回主檔,再打包:

- 資料庫:`backend/data/app.db`(停機後 `app.db-wal`、`app.db-shm` 可忽略;若後端還在跑則三個檔一起帶)。
- 檔案庫:整個 `backend/storage/` 資料夾。

用 PowerShell 打包(在本機專案根 `C:\Users\tomor\Desktop\lineoa` 執行):

```powershell
Compress-Archive -Path backend\data\app.db, backend\storage -DestinationPath lineoa-data.zip -Force
```

### 8-2. 上傳到伺服器

```bash
# 在「本機」執行(scp 隨 Git for Windows / OpenSSH 附帶)
scp lineoa-data.zip root@<ECS 公網 IP>:/opt/lineoa/
```

### 8-3. 伺服器:先停容器,解壓到 volume,再起

```bash
cd /opt/lineoa
docker compose down                 # 停容器,釋放 app.db 檔鎖

apt install -y unzip
unzip -o lineoa-data.zip -d _restore

# 放到 compose 掛載的 volume 位置
mkdir -p data storage
cp _restore/backend/data/app.db data/app.db
cp -r _restore/backend/storage/* storage/    # 客戶檔案

rm -rf _restore lineoa-data.zip

docker compose up -d                # 重新啟動,即載入遷移後的資料
docker compose logs -f backend
```

打開 `https://crm.example.com` 登入,應看到既有客戶、對話、檔案都在。

> 帳號沿用資料庫內既有帳號;`ADMIN_INITIAL_PASSWORD` 只在 users 表為空時才會種子建立,遷移既有庫後不會覆蓋現有密碼。

---

## 9. 更新插件設定(改填 https 網域)

同仁的 Chrome 插件原本填的是內網 IP,改成正式網域:

1. 點插件圖示 →「開啟設定」。
2. **後端網址**改為 `https://crm.example.com`(注意是 https、不帶結尾斜線也可)。
3. **API Token** 維持 `.env` 內同一串 `EXTENSION_TOKEN`(未變則不用動)。
4. 儲存 → 到 `chat.line.biz` 重新整理,手動「立即同步」驗證能推送成功。

> 公網模式下,登入頁不再顯示 Token(改顯示「請登入後於設定取得」)。若同仁需要 Token,請登入後台後由管理員從 `.env` 提供,或於後台設定頁取得。

---

## 10. 日常維運速查

```bash
cd /opt/lineoa

# 看狀態 / 日誌
docker compose ps
docker compose logs -f backend

# 更新程式碼後重建
git pull
docker compose up -d --build

# 停 / 起 / 重啟
docker compose down
docker compose up -d
docker compose restart backend

# 備份(強烈建議設 cron 定期備份 data 與 storage)
tar czf /root/lineoa-backup-$(date +%F).tar.gz -C /opt/lineoa data storage
```

### 建議:每日自動備份(cron)

```bash
crontab -e
# 加一行:每天 03:00 打包 data + storage 到 /root/backups(保留最近 14 天)
0 3 * * * mkdir -p /root/backups && tar czf /root/backups/lineoa-$(date +\%F).tar.gz -C /opt/lineoa data storage && find /root/backups -name 'lineoa-*.tar.gz' -mtime +14 -delete
```

---

## 疑難排解

| 症狀 | 檢查 |
|---|---|
| 網域打不開、憑證失敗 | DNS A 記錄是否已指向本機 IP;安全組 80/443 是否放行;`systemctl status caddy` / `nginx -t` |
| 登入頁出現但 API 502 | `docker compose ps` 後端是否 Up;`curl http://127.0.0.1:4680/api/health` 是否回 ok |
| 插件同步 401 | 插件 Token 與 `.env` 的 `EXTENSION_TOKEN` 是否完全一致;網址是否已改 https 網域 |
| 上傳大檔失敗 | 反代體積上限:Caddy 的 `max_size` / Nginx 的 `client_max_body_size` 是否為 300MB |
| 遷移後資料沒出現 | `app.db` 是否確實放到 `/opt/lineoa/data/app.db`;是否 `docker compose down` 後才覆蓋、再 `up` |
| AI 總結 503 | `.env` 的 `OPENAI_API_KEY` 是否填了、`docker compose up -d` 是否已重載 env |
