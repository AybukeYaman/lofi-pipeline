@echo off
chcp 65001 > nul
rem Kendi klasorune gecer: kisayoldan, masaustunden, baska surucuden
rem calistirildiginda da npm dogru projede calisir.
cd /d "%~dp0"
title LoFi Automation
echo ========================================================
echo   LoFi Automation - Masaustu Arayuzu baslatiliyor...
echo   (arayuz derleniyor, ilk acilis birkac saniye surer)
echo ========================================================
call npm run electron:dev
if errorlevel 1 (
  echo.
  echo HATA: uygulama baslatilamadi. Yukaridaki mesaji oku.
  pause
)
