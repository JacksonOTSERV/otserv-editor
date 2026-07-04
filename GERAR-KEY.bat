@echo off
title OTServ Editor - Gerador de Licenca (VENDEDOR)
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0src-tauri"

REM ====== SUA CHAVE PRIVADA (a do "keygen genkey", NUNCA compartilhe) ======
REM Fica no arquivo local src-tauri\keygen-private.key (esta no .gitignore).
REM Crie-o com a saida de: cargo run --bin keygen genkey
set "KEYFILE=%~dp0src-tauri\keygen-private.key"
if exist "%KEYFILE%" (set /p PRIVATE=<"%KEYFILE%") else set "PRIVATE=%OTSERV_KEYGEN_PRIVATE%"
if "%PRIVATE%"=="" ( echo [ERRO] Defina a chave privada em %KEYFILE% ou na var OTSERV_KEYGEN_PRIVATE. & pause & exit /b 1 )

echo ============================================================
echo  Gerador de licenca - OTServ Editor
echo ============================================================
echo.
set /p HWID="HWID do cliente (ele ve na tela de Ativacao): "
set /p DIAS="Validade em DIAS (ex: 30): "

REM calcula a data de hoje + DIAS via PowerShell
for /f %%d in ('powershell -NoProfile -Command "(Get-Date).AddDays(%DIAS%).ToString('yyyy-MM-dd')"') do set "EXP=%%d"

echo.
echo Gerando key (HWID=%HWID%  expira=%EXP%)...
echo.
cargo run --quiet --bin keygen sign "%HWID%" "%EXP%" "%PRIVATE%"
echo.
echo (Copie a LICENSE KEY acima e mande pro cliente.)
pause
