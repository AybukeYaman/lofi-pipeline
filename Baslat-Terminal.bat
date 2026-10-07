@echo off
chcp 65001 > nul
rem Kendi klasorune gecer (bkz. Baslat-Masaustu-App.bat).
cd /d "%~dp0"
title LoFi Automation - Terminal
echo ========================================================
echo   LoFi Automation - Terminal Paneli baslatiliyor...
echo ========================================================
call npm start
if errorlevel 1 (
  echo.
  echo HATA: panel baslatilamadi. Yukaridaki mesaji oku.
  pause
)
