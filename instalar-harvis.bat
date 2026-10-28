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

npm run install:agent
if errorlevel 1 (
    echo.
    echo No se pudieron instalar las dependencias de Harvis.
    pause
    exit /b 1
)

echo.
echo Instalacion completada. Ejecuta iniciar-harvis.bat para iniciar el agente.
pause
endlocal
