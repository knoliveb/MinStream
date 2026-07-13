@echo off
REM ============================================
REM  VIBE.FM - Iniciar servidor local (Windows)
REM  De dois cliques neste arquivo. Ele inicia um
REM  servidor HTTP na pasta do projeto e abre o
REM  navegador em http://localhost:8000
REM ============================================
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    start "" http://localhost:8000
    python -m http.server 8000
    goto :eof
)

where py >nul 2>nul
if %errorlevel%==0 (
    start "" http://localhost:8000
    py -m http.server 8000
    goto :eof
)

where node >nul 2>nul
if %errorlevel%==0 (
    start "" http://localhost:8000
    npx --yes serve -l 8000 .
    goto :eof
)

echo.
echo  Nenhum Python ou Node.js encontrado.
echo  Instale o Python em https://www.python.org/downloads/
echo  (marque a opcao "Add Python to PATH" na instalacao)
echo.
pause
