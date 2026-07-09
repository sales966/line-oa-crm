@echo off
rem LINE OA 客户进度中枢 — 启动 backend(端口 4680)
cd /d "%~dp0backend"
npm run start
