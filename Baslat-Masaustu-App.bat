@echo off
chcp 65001 > nul
echo ========================================================
echo   LoFi Automation - Masaüstü Arayüzü Baslatiliyor...
echo ========================================================
npm run electron:dev
pause
