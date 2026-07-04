# Publica uma nova versão do OTServ Editor para os players (auto-update via R2).
# O QUE FAZ:
#   1) Builda o instalador ASSINADO (tauri build).
#   2) Gera o latest.json (com a versão, assinatura e o link do R2).
#   3) Deixa os 2 arquivos prontos em .\publish\ pra você subir no bucket R2.
#
# ANTES DE RODAR: aumente a "version" em src-tauri\tauri.conf.json (ex: 0.1.0 -> 0.1.1),
# senão o app dos players não vai achar a versão "mais nova".

$ErrorActionPreference = 'Stop'
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:APPDATA\npm;$env:Path"
Set-Location $PSScriptRoot

# >>> URL pública do seu bucket R2 <<< (defina na var de ambiente OTSERV_R2_URL)
$R2 = if ($env:OTSERV_R2_URL) { $env:OTSERV_R2_URL } else { "https://SEU-BUCKET.r2.dev" }
# >>> senha da chave do updater (a mesma usada no 'tauri signer generate') <<<
# defina na var de ambiente OTSERV_UPDATER_PASSWORD (NUNCA comitar a senha real)
$KEY_PASS = $env:OTSERV_UPDATER_PASSWORD

# assina o build com a chave privada
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "src-tauri\updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $KEY_PASS

$ver = (Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
Write-Host "==================================================="
Write-Host " Publicando OTServ Editor v$ver"
Write-Host "==================================================="
# gera ./dist ofuscado (o JS do cliente vai ofuscado no instalador)
Write-Host "Gerando frontend ofuscado (dist)..."
node build-frontend.js
if ($LASTEXITCODE -ne 0) { Write-Host "[ERRO] ofuscacao/node falhou."; Read-Host "Enter p/ sair"; exit 1 }

# IMPORTANTE: o frontend (dist) e embutido no .exe via generate_context!, que NAO detecta
# mudanca de CONTEUDO do dist — so do lib.rs. "Toca" o lib.rs p/ forcar re-embed do dist ATUAL.
try { (Get-Item "src-tauri\src\lib.rs").LastWriteTime = Get-Date } catch {}

Write-Host "Buildando instalador assinado (pode demorar)..."
tauri build
if ($LASTEXITCODE -ne 0) { Write-Host "[ERRO] build falhou."; Read-Host "Enter p/ sair"; exit 1 }

# acha o instalador NSIS + a assinatura
$nsis = "src-tauri\target\release\bundle\nsis"
# pega o instalador da VERSAO ATUAL ($ver). IMPORTANTE: se sobrarem setups de versoes
# antigas na pasta, o "Select -First 1" pegava o mais antigo por ordem alfabetica (bug do 0.1.0).
$setup = Get-ChildItem "$nsis\*$($ver)_*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $setup) { $setup = Get-ChildItem "$nsis\*-setup.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }
if (-not $setup) { Write-Host "[ERRO] nao achei o *-setup.exe em $nsis"; Read-Host "Enter"; exit 1 }
Write-Host ("Instalador escolhido: " + $setup.Name)
$sigFile = "$($setup.FullName).sig"
$sig = (Get-Content $sigFile -Raw).Trim()
$fname = $setup.Name
$url = "$R2/" + [uri]::EscapeDataString($fname)

# notas da versao: usa NOTAS-VERSAO.txt se existir; senao pergunta.
if (Test-Path "NOTAS-VERSAO.txt") {
  $notes = (Get-Content "NOTAS-VERSAO.txt" -Raw).Trim()
  Write-Host "Notas (de NOTAS-VERSAO.txt): $notes"
} else {
  $notes = Read-Host "Notas da versao (o que mudou)"
}
if (-not $notes) { $notes = "Atualizacao v$ver" }

$latest = [ordered]@{
  version   = $ver
  notes     = $notes
  pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{ "windows-x86_64" = [ordered]@{ signature = $sig; url = $url } }
}
New-Item -ItemType Directory -Force "publish" | Out-Null
($latest | ConvertTo-Json -Depth 6) | Set-Content "publish\latest.json" -Encoding utf8
Copy-Item $setup.FullName "publish\$fname" -Force
# copia com NOME FIXO p/ o botao "Baixar" do site (link estavel, nao muda a cada versao)
Copy-Item $setup.FullName "publish\OTServEditor-Setup.exe" -Force

Write-Host ""
Write-Host "==================================================="
Write-Host " PRONTO! Suba estes 3 arquivos no R2 (bucket otserv-updates):"
Write-Host "   publish\latest.json                (auto-update)"
Write-Host "   publish\$fname   (auto-update)"
Write-Host "   publish\OTServEditor-Setup.exe     (botao Baixar do site)"
Write-Host ""
Write-Host " Os players ja instalados recebem a v$ver sozinhos no proximo boot."
Write-Host " O botao do site sempre baixa a versao mais nova (nome fixo)."
Write-Host "==================================================="
Read-Host "Enter p/ fechar"
