@echo off
cd /d C:\Users\USER\collection-app
start http://localhost:8080
python -m http.server 8080
