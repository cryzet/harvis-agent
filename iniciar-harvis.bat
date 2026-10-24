@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Error: Node.js no esta instalado o no esta disponible en PATH.
    echo Instala Node.js 20 o superior y vuelve a intentarlo.
    pause
    exit /b 1
)

if not exist "node_modules\@modelcontextprotocol\sdk" (
    echo No se encontraron las dependencias del proyecto.
    echo Ejecuta npm install en esta carpeta y vuelve a iniciar Harvis.
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
