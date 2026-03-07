@echo off
cd /d %~dp0

echo --- STEP 1: Updating data.js ---
"C:\Users\USER\AppData\Local\Programs\Python\Python312\python.exe" "update_app.py"

echo --- STEP 2: Sending to GitHub ---
git add .
git commit -m "update"
git push origin main

echo --- ALL DONE! ---
pause