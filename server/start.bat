@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Dang cai thu vien lan dau...
  call npm install
)
node --no-warnings src\index.js
pause
