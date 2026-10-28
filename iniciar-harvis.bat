@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo Error: npm no esta instalado o no esta disponible en PATH.
    echo Instala Node.js 20 o superior y vuelve a intentarlo.
    pause
    exit /b 1
)

npm start
if errorlevel 1 (
    echo.
    echo Harvis termino con un error.
    pause
    exit /b 1
)

endlocal
