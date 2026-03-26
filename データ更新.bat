@echo off
cd /d %~dp0

echo --- STEP 1: Updating data.js ---
"C:\Users\USER\AppData\Local\Programs\Python\Python312\python.exe" "update_app.py"
if errorlevel 1 (
    echo [ERROR] Python script failed.
    if "%1"=="" pause
    exit /b 1
)

echo --- STEP 2: Sending to GitHub ---
git add data.js
git commit -m "auto update: %date% %time%"
git push origin main
if errorlevel 1 (
    echo [ERROR] Git push failed.
    if "%1"=="" pause
    exit /b 1
)

echo --- ALL DONE! ---
if "%1"=="" pause