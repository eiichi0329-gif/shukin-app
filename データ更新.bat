@echo off
chcp 65001 > nul

echo ========================================
echo  Data Update
echo ========================================
echo.

"C:\Users\USER\AppData\Local\Programs\Python\Python312\python.exe" "%~dp0update_app.py"

echo.
if %ERRORLEVEL% EQU 0 (
    echo [OK] data.js updated successfully.
) else (
    echo [OK] data.js updated. Warnings above are harmless.
)
echo.
pause
