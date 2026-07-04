@echo off
title OTServ Editor - Key de TESTE (curinga, qualquer maquina)
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0src-tauri"

REM ====== a MESMA chave privada do GERAR-KEY.bat (NUNCA compartilhe) ======
REM Fica no arquivo local src-tauri\keygen-private.key (esta no .gitignore).
set "KEYFILE=%~dp0src-tauri\keygen-private.key"
if exist "%KEYFILE%" (set /p PRIVATE=<"%KEYFILE%") else set "PRIVATE=%OTSERV_KEYGEN_PRIVATE%"
if "%PRIVATE%"=="" ( echo [ERRO] Defina a chave privada em %KEYFILE% ou na var OTSERV_KEYGEN_PRIVATE. & pause & exit /b 1 )

echo ============================================================
echo  Key de TESTE (curinga) - OTServ Editor
echo  - Uma key so, vale em QUALQUER maquina.
echo  - Cada maquina ganha X dias a partir da 1a ativacao.
echo  - Depois disso a maquina NAO testa mais (nem reinstalando).
echo ============================================================
echo.
set /p TRIAL="Dias de teste POR MAQUINA (Enter = 5): "
if "%TRIAL%"=="" set "TRIAL=5"
set /p JANELA="Janela p/ ativar - dias ate a key parar de aceitar novos (Enter = 30): "
if "%JANELA%"=="" set "JANELA=30"

for /f %%d in ('powershell -NoProfile -Command "(Get-Date).AddDays(%JANELA%).ToString('yyyy-MM-dd')"') do set "EXP=%%d"

echo.
echo Gerando key de teste: %TRIAL% dias por maquina, ativavel ate %EXP%...
echo.
cargo run --quiet --bin keygen sign "*%TRIAL%" "%EXP%" "%PRIVATE%"
echo.
echo ============================================================
echo  Copie a LICENSE KEY acima e mande pros testers.
echo  Cada PC ganha %TRIAL% dias a partir de quando ativar.
echo ============================================================
pause
