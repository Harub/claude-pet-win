@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Claude Pet 설치
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode
where npm >nul 2>nul
if errorlevel 1 goto nonode

node setup.js
goto end

:nonode
echo  Node.js 가 필요해요. 방금 열린 사이트에서 LTS 버전을 설치한 뒤, 이 파일을 다시 실행해 주세요.
start "" "https://nodejs.org/ko"

:end
echo.
pause
