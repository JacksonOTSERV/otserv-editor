# ⚔️ OTServ Editor — Módulos & Features

## 🐲 Editor de Monstros
- Edição visual do XML de monstro
- Loot (item · chance · count)
- Spells / ataques / defesas
- Atributos (HP, exp, speed, immunities, elements…)
- Seletor de sprite + compositor de outfit
- Calculadora de balanceamento (exp/gold por level)
- Criar / clonar / deletar · editar XML cru · validação

## 🛒 Editor de NPCs
- Edição do XML de NPC + Lua
- Loja (comprar / vender)
- Sugestão de preço

## 📜 Editor de Vocações
- Edição do XML de vocação
- Atributos (HP/mana/cap, multipliers, skills…)

## 🗺 Editor de Spawns
- Parse / edição de spawn.xml
- Adicionar / remover centros de spawn e monstros
- Ajuste de raio

## 📁 Navegador de Arquivos
- Árvore dupla (Pasta A / Pasta B)
- Editor de texto com syntax highlight (Lua / XML)
- Diff entre pastas
- Abas · salvar / reverter

## 🧩 Editor de Objetos (.dat / .spr / .otb)
- Edição binária de .dat · .spr · items.otb · items.xml
- Geometria (width/height/layers/pattern/frames)
- Animação + frame groups (idle/walk) + durações
- Editor de pixel · sprite sheet · slicer · optimizer
- Colorização de outfit
- Import/export OBD V1/V2/V3 · import PNG
- Browser de Items / Outfits / Effects / Missiles
- Editor de flags (100+ atributos)
- Conversão de versão de cliente

## 📊 Economia
- Simulador de economia do servidor
- Tabela de auditoria

## 🤖 Assistente de IA
- 9+ provedores (OpenAI · Anthropic · Gemini · DeepSeek · Groq · Mistral · xAI · OpenRouter · Ollama · LM Studio)
- Gera scripts TFS (monstro, spell, action, movement, talkaction, NPC)
- Usa o arquivo/seleção atual como contexto
- Templates · explica código · acha bugs

## 🗺 Editor de Mapa (RME)
- **Brushes:** Ground (auto-border) · Wall (auto-tiling) · Door (Normal/Locked/Magic/Quest/Hatch/Window) · Carpet · Table · House · Doodad · Raw · Optional border
- **Paletas:** Terrain · Doodad · Wall · Door · Carpet · Table · Creature · House · Raw (com "Todos os itens" e "Others")
- **Tool Options:** preview do brush · Brush/Erase/Border/Fill · Zonas (PZ/No-PVP/No-Logout/PVP) · portas tipadas · Size · Forma · Lock Doors
- **Tile Properties:** lista de itens (mover ↑↓ / apagar) · Map Flags · Action/Unique ID · House ID
- **Ferramentas:** Pan · Select · Paint · Bucket · Erase · Zone · Spawn · Waypoint · Walk
- **Atalhos:** A (auto-border) · X (girar) · Ctrl+arrasta (apaga) · Shift+arrasta (preenche) · bolinha (zoom) · Ctrl+bolinha (andar) · setas (rolar) · Copy/Paste/Flip/Rotate/Undo/Redo
- **Visual:** iluminação 2D · ghost dos andares · grid · tooltips · modo in-game · minimap · preview do brush no cursor
- **Operações:** Borderize · Randomize · Find/Replace/Remove item · Achar itens similares · Cleanup · Estatísticas · Import/merge .otbm · Export PNG (minimap e mapa completo)
- **Walk:** player anda com as setas (animado), respeita colisão, nome + looktype configuráveis
