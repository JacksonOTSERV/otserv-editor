# HANDOFF — OTServ Editor (Tauri) — contexto pra continuar em qualquer sessão/conta

> Cole/abra este arquivo numa sessão nova do Claude Code pra dar todo o contexto.
> Comunicação: **/caveman ultra**, responder em **português**. Nunca copiar arquivos inteiros (usar Edit).

## O que é
Editor comercial de OTServer (TFS) + cliente (OTClient/OTCv8), **portado de Electron → Tauri**.
Pasta: `c:\otcv8-dev-master\tools\otserv-editor-tauri\`. Frontend embutido no .exe (`generate_context!`).
Build/rodar: **`EXECUTAR.bat`** (toca lib.rs + `cargo run --release`). Win10, Rust toolchain instalado.

## Arquitetura
- **Rust** (`src-tauri/src/lib.rs`): comandos FS, .spr nativo (decode lazy), sheet 15.x (lzma+bmp), licença (Ed25519+HWID), **segurança** (`security.rs`), `tmp_dir` (Live).
- **Front** (`src/full/`): `shim.js` (compat Electron→Tauri + licença + ban), `renderer.js` (~6900 linhas, TODO o app), `app.html`, libs em `src/full/lib/` (otbm, dat, rmebrush, balance, ai, assets, appearances…).
- Bridge JS↔Rust: `src/bridge.js` (TFS/TSPR/TDLG/ipcRenderer shim).

## Módulos do app (modos)
mon (monstros) · npc · voc · spawn · econ · **map (RME)** · **obj (Object Builder)** · files · ai · **spell** · script.

## Estado dos sistemas (tudo implementado)
- **Object Builder**: paridade c/ OB original. Drag-drop PNG, abas Sprite/Propriedades/**Flags** separadas, Compile As, pixel editor, frame groups, optimizers, slicer, viewer. Fix: spr aparece sem trocar de modo (`reloadGraphics` invalida cache).
- **Map (RME)**: pintura/borracha/bordas/Automagic, palettes, casas/spawns/towns, GPU. **Data Editor (🧱 Montar brush)** monta 7 tipos: borda/piso/parede/montanha/**doodad/carpete/mesa** → salva no materials (borders/grounds/walls/doodads.xml + tileset Custom). **🔍 Scan da seleção** (menu Border Options): analisa tiles selecionados, identifica ground/borda(12 edges)/parede/doodad pela geometria e pré-monta o brush.
- **Config de paths** (botão 🗄 Servidor): carrega config/mon/npc/voc/spells/dat/spr/otb/**mapa/spawn/materiais RME** + checkbox auto-load (recarrega tudo no boot; mapa = carga preguiçosa ao abrir o modo Mapa).
- **Spell Editor**: form completo (vocações, cooldown nativo TFS, needlearn/premium/soul, blockarmor/dispel…), preview animado (player centralizado, monstro = offset arrastável), gera Lua+XML. **Base de conhecimento IA**: botão "📚 Base IA" gera o skills.md do SERVIDOR do usuário (OTX/Canary/custom) com IA paga/local, ou usa a padrão TFS. Idem Script Studio.
- **Monster**: escalar life (`B.suggestHealth`, botão "→ escalar life", `HP_MULT=1.5`) além de dano/exp.
- **Live (colaboração tempo real)**: botão 👥 Live (canto sup. dir). Sala na nuvem (relay WebSocket em `license-server/server.js` rota `/live`, Node puro). Sincroniza mapa(edição+cursores)/spell/object + presença/chat. **Enviar/Pedir arquivo base** (chunks via `read_file_chunk`, salva em `%TEMP%\otserv-editor-live`), barra de progresso, botão "❔ Como funciona". Doc: `LIVE.md`.
- **Licença**: online (email→Stripe via Render `SEU-SERVIDOR.onrender.com`) + offline (key Ed25519 master, sempre entra). `validateKey` em shim.js. Anti-rollback registro.
- **Proteção** (`security.rs` + shim.js): HARD (debug/injeção direto no processo → **ban HWID**), SOFT (ferramenta RE aberta / **DevTools** → avisa+fecha, sem ban). Servidor: `/ban`, `/verify` checa ban, **refund/chargeback Stripe → ban**. Doc: `PROTECAO.md`.
- **Auto-update**: tauri-updater + Cloudflare R2 (`SEU-BUCKET.r2.dev/latest.json`) + minisign. Publicar: `PUBLICAR-UPDATE.bat`. Doc: `AUTO-UPDATE.md`.
- **Loja/pagamento**: `license-server/loja-modelo.html` (doação R$30/mês, termos de doação não-reembolsável, injeção/reembolso = ban). Stripe (link no painel). Servidor no Render (DB-less, Stripe = fonte da verdade, HWID no metadata do customer).

## Pendências do usuário (infra — fora do código)
1. **Subir `license-server/server.js` novo** no GitHub (repo do servidor) → Render redeploya (~2min). Ativa: Live `/live`, ban, refund→ban.
2. **Stripe ▸ Webhooks**: já tem invoice.paid etc. **FALTA adicionar**: `charge.refunded`, `refund.created`, `charge.dispute.created`, `charge.dispute.funds_withdrawn`.
3. Quando for produção: Stripe sair do Test mode (produto+link+webhook+`sk_live_` no Render).
4. (Opcional) Plano pago Render (.spr grande no Live passa melhor; sem "dormir").
5. (Opcional) Packear o .exe final (VMProtect/Themida) p/ travar análise estática.
6. **1ª publicação auto-update**: `PUBLICAR-UPDATE.bat` → subir os 2 arquivos no R2.

## Chaves/segredos (privados — não commitar)
- Updater signing: `src-tauri/updater.key` (gitignored) + senha na var `OTSERV_UPDATER_PASSWORD`.
- License keygen privado: `src-tauri/keygen-private.key` (gitignored, Ed25519). Pubkey no `lib.rs`.
- Backup local dos valores reais: `SEGREDOS-LOCAIS.txt` (gitignored).
- Render env: `ADMIN_TOKEN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PRICE_DAYS=35`.

## Convenções de validação
- JS: `node --check src/full/renderer.js` (e shim.js, server.js).
- Rust: `cargo check --bin otserv-editor` em `src-tauri/`.
