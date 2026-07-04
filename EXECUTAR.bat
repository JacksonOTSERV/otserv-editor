@echo off
title OTServ Editor (Tauri) - build + run
echo ========================================================
echo  OTServ Editor (Tauri) - compilando e abrindo atualizado
echo ========================================================
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

REM [1/2] Gera ./dist a partir de ./src e OFUSCA o JS proprio (o que vai pro .exe).
echo Gerando frontend (ofuscado)...
cd /d "%~dp0"
node build-frontend.js
if errorlevel 1 (
  echo.
  echo [ERRO] ofuscacao/node falhou. Veja as mensagens acima.
  pause
  exit /b 1
)

cd /d "%~dp0src-tauri"

REM IMPORTANTE: o frontend (../dist) e EMBUTIDO no .exe em tempo de compilacao (generate_context!).
REM O cargo nao detecta mudanca de CONTEUDO dos arquivos do frontend, so do .rs.
REM Por isso "tocamos" o lib.rs (onde esta o generate_context!) p/ forcar re-embed do HTML/JS/CSS atual.
copy /b "src\lib.rs"+,, >nul
REM RELEASE: otimizado (decode rápido, menos RAM). 1ª compilação demora ~2-3min; depois é rápido.
cargo run --release --bin otserv-editor
if errorlevel 1 (
  echo.
  echo [ERRO] build/exec falhou. Veja as mensagens acima.
  pause
)
