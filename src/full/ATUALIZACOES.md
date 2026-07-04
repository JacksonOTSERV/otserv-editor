# 🚀 OTServ Editor — Apresentação das Atualizações

Resumo de tudo que foi implementado/melhorado nesta leva de desenvolvimento.

---

## 🪄 SPELL EDITOR (modo 🪄 Spell)
Gera spells **no estilo real do seu servidor** (`otserv/`, TFS clássico tema DBZ): `onCastSpell` global + `onGetFormulaValues` (callback `DAMAGE_FACTOR_*`) + `exhaustion` + `sendSpellbarCooldownAuto`, registro no `spells.xml`.

- **Form completo**: spellid, pasta, grupo, tipo de dano, effect/distance (id + picker visual do .dat), área, level/mana/magiclevel/exhaustion, aggressive/selftarget/needTarget+range, **tier + fatorMin/Max**, multi-hit+delay
- **Simulador de dano** com a fórmula real (`DAMAGE_FACTOR_LEVEL<tier>*lvl + SKILL<tier>*mlvl`)
- **Editor de área customizada** (grid clicável) + direção (rotação)
- **Condições**: DOT (fogo/veneno/energia/gelo/holy/death), paralisia, haste, **ATTRIBUTES** (buff skill/stat), **REGENERATION**, **OUTFIT**
- **Avançado**: transform/forma (ex Migatte), **summon**, teleporte ao alvo, **dash** (a outfit avança), animatedText, createItem, multi-cooldown (combos), setFormula direto
- **Gera 2 coisas**: linha do `spells.xml` + script `.lua` completo, com **syntax highlight**
- **🤖 IA** gera a spell via descrição (lê o `spell_skills.md` do seu server) → preenche os campos → preview
- **📂 Abrir do servidor** (navega/importa), 📋 copiar, 💾 exportar, 📚 biblioteca, templates

### 🎬 Preview animado (chamativo!)
- **Caster** (outfit do .dat) com **idle/andar** (grupos corretos: idle=grupo 0, walk=grupo 1), **direção** (gira), **arrastável** no grid
- **Alvo** (player/monstro) que **anda/esquiva** e **leva a spell** — missile e área perseguem ele
- **Missile** aponta pra **direção de viagem** (padrões direcionais do .dat)
- **Condição** acerta o alvo → **aura pulsante** da cor da condição
- **Visual**: fundo gradiente + vinheta, **glow** nos efeitos/missile, **flash radial de impacto** (anel + sparkles), sombras no chão, números de dano com contorno

---

## 📜 SCRIPT STUDIO (modo 📜 Scripts) — NOVO
Editor unificado pros 5 tipos de revscript que **não tinham editor**:
- **Actions** (baús, alavancas, quest items) · **Movements** (equip/step) · **Talkactions** (comandos) · **Creaturescripts** (login/death/kill/think) · **Globalevents** (eventos por horário)
- Cada tipo: form (gatilho/evento/modo) → **linha de registro XML + esqueleto Lua** com a assinatura certa
- **🤖 IA** gera o script completo lendo um **skills.md do tipo** (extraído dos scripts reais do seu server): `skills_actions.md`, `skills_movements.md`, `skills_talkactions.md`, `skills_creaturescripts.md`, `skills_globalevents.md`
- Browse/import do servidor, copiar, exportar

---

## 🗺 EDITOR DE MAPA — melhorias
- **▦ BORDER funcional**: o `borderize` cria os vizinhos pra receber as bordas externas (antes não pegava)
- **Preview de borda** (snapshot→simula→restaura, sem sujar o mapa) + brush ghost + cursor amarelo (espessura constante de tela)
- **Projeção de andar estilo Tibia/RME** (andar de baixo → SE, de cima → NW) — empilhamento 3D correto
- **Ver todos os andares abaixo** (opaco, empilhado) · efeito 3D (displacement) toggle
- **Scroll contínuo e suave** com as setas (sub-tile, não mais "tile em tile")
- **Otimização de zoom out**: varre só os tiles existentes (não o retângulo gigante) + render **GPU (WebGL2)** opcional pra fluidez
- **Houses manager** (rent/town/entrada) · **Teleports manager** (origem→destino, ir até)
- **Undo 200→400** · zoom out até 8% · toggles do menu Ver **persistem** entre sessões · **Tamanho livre** (redimensiona o canvas)

---

## 🧩 OBJECT EDITOR
- **Idle/Walk correto**: usa o frame-group certo (idle=grupo 0 parado, walk=grupo 1 animado) — no grid e no inspector
- Invalidação de cache separada (pixel × estrutura) → edição não re-decodifica os ~4000 sprites

---

## 🐲 OUTROS EDITORES
- **Monster**: seção Scripts/Eventos (`<script><event/>`)
- **Spawn**: ✓ validar mobs inexistentes
- **Economia**: 📈 curva de progressão (gráfico exp/gold log + detecção de saltos)
- **Command Palette** (Ctrl+P), **Dashboard** (📊 stats), **auto-save** toggle

---

## ⚡ PERFORMANCE + NATIVO
- **Decoder de sprite em Rust → WebAssembly** (`spr_wasm.wasm`, 736 bytes) com fallback JS — verificado byte-a-byte. Dashboard mostra `⚡ Rust/wasm`
- **Render WebGL2** do mapa (atlas + instancing) — opcional
- Otimizações JS: spell preview RAF para quando pausado, econ debounce, AI stream incremental (O(n²)→O(n)), cache de ground/flags por tile, gfx cache granular

---

## 🛠 STACK ATUAL
- **Electron** (nodeIntegration) · parsers JS: `.dat`/`.spr`/`.otb`/`.otbm`/RME brushes
- **Rust** instalado (toolchain + wasm32) — base pro caminho nativo
- **Próximo passo**: migração pra **Tauri** (tamanho ~600MB→~10MB, RAM menor, render GPU nativo) — ver `tools/otserv-editor-tauri/MIGRATION.md`
