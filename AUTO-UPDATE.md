# Auto-update (Tauri + Cloudflare R2)

O app checa atualização **sozinho no boot**. Se tem versão nova no seu R2, baixa o
instalador (assinado/verificado) e reinicia. Ninguém injeta update falso (assinatura Ed25519/minisign).

## Já configurado
- **Chave de assinatura**: `src-tauri\updater.key` (privada, **NÃO compartilhe**) + `updater.key.pub` (pública).
  - Senha da chave: defina na var de ambiente `OTSERV_UPDATER_PASSWORD` (não fica no repo).
- **Endpoint** (no `tauri.conf.json`): `https://SEU-BUCKET.r2.dev/latest.json`
- **Chave pública** embutida no app (verifica o instalador).

## Como publicar uma nova versão (cada att sua)
1. **Suba a versão** em `src-tauri\tauri.conf.json` → campo `"version"` (ex: `0.1.0` → `0.1.1`).
2. Rode **`PUBLICAR-UPDATE.bat`** (2 cliques).
   - Ele builda o instalador assinado e gera o `latest.json`.
   - Digite as "notas da versão" quando pedir.
3. No fim, ele deixa 2 arquivos em **`publish\`**:
   - `OTServ Editor_X.Y.Z_x64-setup.exe`
   - `latest.json`
4. **Suba os 2 no R2** (bucket `otserv-updates`):
   - Painel Cloudflare → R2 → `otserv-updates` → aba **Objects** → **Upload** → arrasta os 2 arquivos.
   - ⚠️ Mantenha o nome do `latest.json` igual (o endpoint aponta pra ele).
5. Pronto. Os players recebem a v X.Y.Z no próximo boot (aceita → baixa → reinicia atualizado).

## Importante
- **Não perca** o `updater.key` nem a senha — sem eles você não consegue assinar updates (e o auto-update para).
- A **1ª vez** que o player instala é manual (você manda o instalador). Dali pra frente é automático.
- O instalador (`-setup.exe`) é o que você distribui pros novos clientes também.

## Distribuir a 1ª versão pros clientes
1. Rode `PUBLICAR-UPDATE.bat` uma vez → pega o `publish\OTServ Editor_..._x64-setup.exe`.
2. É esse instalador que o cliente baixa e instala (depois de pagar/ativar).
3. As próximas versões chegam sozinhas via R2.
