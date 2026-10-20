@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Claude Pet 제거
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

choice /c YN /m " 저장된 설정과 기록(%USERPROFILE%\.claude-pet)도 지울까요?"
if errorlevel 2 goto keep
node setup.js --uninstall --purge
goto end
:keep
node setup.js --uninstall
goto end

:nonode
echo  Node.js 를 찾지 못했어요. Node.js 를 설치한 뒤 다시 실행해 주세요.

:end
echo.
pause
