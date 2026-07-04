# OTServ Editor

Editor completo para servidores de **Open Tibia (OTServ / TFS / OTX / Canary)**, construído com
**Tauri (Rust + WebView)**. Reúne, em um só app nativo para Windows, os editores que normalmente
ficam espalhados em várias ferramentas: mapas (estilo RME), objetos/sprites (estilo Object Builder),
monstros, NPCs, spells, vocações, economia e um assistente de IA.

> Portado de Electron → Tauri (binário leve, frontend embutido no `.exe`).

---

## ✨ Recursos

- **Editor de Mapa (RME)** — pintura, borracha, bordas automáticas (Automagic), casas, spawns e towns.
  Render por GPU (WebGL), carregamento de `.otbm` **sob demanda** por área (abre mapas grandes na hora),
  Data Editor pra montar brushes (borda/piso/parede/montanha/doodad/carpete/mesa) e scan da seleção.
- **Editor de Objetos / Assets** — paridade com o Object Builder: `.dat`/`.spr`/`items.otb`/`items.xml`,
  Assets 12+/15.x (`.bmp.lzma` + `appearances.dat`), editor de pixel, frame groups, otimizadores,
  slicer, import de PNG, edição de flags em massa e Compile As (conversão de versão).
- **Spell Editor** — formulário completo (vocações, cooldown, needlearn/premium/soul, etc.),
  preview animado e geração de Lua + XML. Lê spells de TFS/OTX e Canary (revscript).
- **Monstros / NPCs / Vocações / Economia** — editores XML/Lua com loot, ataques, balanceamento,
  loja de NPC, simulador de economia e auditoria.
- **Navegador de Arquivos** — árvore dupla, editor com syntax highlight (Lua/XML), diff entre pastas, abas.
- **Assistente de IA** — gera scripts TFS, explica código e acha bugs (vários provedores, pago ou local).
- **Live (colaboração em tempo real)** — salas na nuvem via WebSocket próprio; sincroniza mapa/spell/objeto,
  com presença, cursores e chat.
- **Suporte nativo em Rust** — leitura/escrita de `.spr`, decode de sprite sheet 15.x (LZMA+BMP), LZMA e FS.

---

## 🧱 Stack

| Camada | Tecnologia |
|---|---|
| Backend nativo | Rust + Tauri v2 (`src-tauri/`) |
| Frontend | HTML/CSS/JS puro, embutido no `.exe` (`src/`) |
| Servidor de licença (opcional) | Node puro, sem dependências (`license-server/`) |
| Plataforma | Windows 10/11 |

---

## 🚀 Build / rodar

**Pré-requisitos:** [Rust toolchain](https://rustup.rs/) e [Node.js](https://nodejs.org/).

```bash
npm install          # instala @tauri-apps/cli e utilitários de build
npm run dev          # roda em modo desenvolvimento
npm run build        # gera o instalador (NSIS)
```

No Windows há também os atalhos `.bat`:

- **`EXECUTAR.bat`** — gera o frontend (ofuscado) e roda o app em release.
- **`PUBLICAR-UPDATE.bat`** — builda o instalador assinado e prepara o auto-update (ver `AUTO-UPDATE.md`).

---

## 📁 Estrutura

```
src/                 Frontend (editor). full/ = app principal; lib/ = libs (otbm, dat, brush, ai...)
src-tauri/           Backend Rust (Tauri): FS, .spr, sheet 15.x, licença, segurança
license-server/      Servidor de licença/pagamento (Node) — opcional
build-frontend.js    Gera ./dist ofuscado a partir de ./src
```

Docs adicionais no repositório: `HANDOFF.md`, `AUTO-UPDATE.md`, `PROTECAO.md`, `LIVE.md`, `MIGRATION.md`.

---

## 🔐 Configuração de segredos (importante)

Este repositório é **público** e **não contém chaves nem infraestrutura pessoal**. Os valores foram
substituídos por placeholders (`SEU-SERVIDOR`, `SEU-BUCKET`, `seu-email@exemplo.com`, etc.).
Para rodar com sua própria infra, configure:

| Segredo | Onde |
|---|---|
| Chave privada do keygen (Ed25519) | `src-tauri/keygen-private.key` (gitignored) |
| Chave privada do updater + senha | `src-tauri/updater.key` + var `OTSERV_UPDATER_PASSWORD` |
| URL do bucket R2 (auto-update) | var `OTSERV_R2_URL` / `tauri.conf.json` |
| URL do servidor de licença | `src/full/shim.js` (`LICENSE_SERVER`) |
| Chaves do license-server | variáveis de ambiente (`ADMIN_TOKEN`, `STRIPE_SECRET_KEY`, ...) — ver `license-server/README.md` |

O sistema de licença funciona **offline** (key assinada Ed25519) mesmo sem servidor configurado.

---

## 📄 Licença

Projeto proprietário. Todos os direitos reservados ao autor.
