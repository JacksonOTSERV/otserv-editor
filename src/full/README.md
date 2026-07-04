# Editor de Monstros & Economia (Electron)

Importa `monsters.xml` + `Tibia.dat`/`.spr` (8.60), mostra cada mob com sprite,
e edita loot/gold/exp aplicando os tiers do `ECONOMIA_PLANO.md`.

## Abrir
Dê 2 cliques em **`abrir.bat`** (instala na 1ª vez e abre o programa).

## Geral
- 4 modos (botoes na lista): **🐲 Mobs · 🛒 NPCs · 📜 Vocs · 📊 Economia**.
- **＋ Novo**: cria mob / NPC / vocation do zero (template). Mob novo é registrado no `monsters.xml`.
- Editar varios e **💾 Salvar tudo (N)** (toolbar) salva todos os alterados de uma vez (`*`=alterado).
  Faz **backup `.bak`** dos arquivos sobrescritos (checkbox no modo Economia).

### 📜 Vocs
- Lista/edita/cria vocations: name, gainhp, gainmana, gaincap, attackspeed (preserva formula/skills).

### 📊 Economia
- **Level por tier**: define o level alvo de cada tier (Trash/Comum/Forte/Elite/Boss).
- **Aplicar em massa**: Gold / Exp / Dano sugeridos a TODOS os mobs (usa o level do tier).
- **Simulador**: player lv X vs mob → gold/kill vs gasto em poção = **ralo %** (alvo por fase) + líquido/h.
- **Auditoria**: tabela de todos os mobs (exp/vida/gold/dano/ratio) com **flags** de outlier. Clique = manda pro simulador.

> Nao use `npm start` direto: o ambiente tem `ELECTRON_RUN_AS_NODE=1`, que faz o
> Electron rodar como Node puro (erro "Cannot read ... 'whenReady'").
> O `abrir.bat` limpa essa variavel antes de abrir.

## Auto-carregamento
Acha sozinho (subindo a partir da pasta): `otserv/data/monster`,
`data/things/860/Tibia.dat` + `.spr`. Senao, use os botoes no topo.

## Uso — 2 modos (botoes no topo da lista)

### 🐲 Monstros
- Lista: mobs com exp + tier. Direita: sprite, tier + gold sugerido (tabela §2).
- **⚔️ Balanceamento** (painel): escolhe vocação ref + level alvo →
  - mostra o **HP/mana do player** nesse level (do `vocations.xml`, gainhp/gainmana).
  - **Exp sugerida**: usa os `experienceStages` do `config.lua` — calcula a exp BASE pro mob
    pra dar ~150 kills/level no multiplier daquele level. Botao "→ aplicar exp".
  - **Dano sugerido**: dano max do mob = 15% do HP do player. "→ escalar dano" ajusta todos os ataques.
  - Lista de ataques com min/max editaveis.
  - Tunavel em `lib/balance.js` (HP_BASE, DANGER_PCT, KILLS_PER_LEVEL).
- Tabela de loot: id/name, chance (/100000), countmax + icone do item. ＋Item / ＋Gold / ✕.
- **Salvar XML**: regrava `<loot>`, `experience` e os `<attack>` (dano) — preserva o resto.

### 🛒 NPCs de venda
- Lista os NPCs vendedores (parametros `shop_buyable` / `shop_sellable`).
- Tabela: icone, item, id, **tipo** (Vende=ralo / Compra=fonte), preço atual e **preço sugerido**.
- Sugestao (economia boa, tunavel em `lib/economy.js`):
  - **Compra** (NPC compra loot, gold ENTRA): 25% do preço de compra do item, ou
    **15% do gold do mob que dropa** o item, senao -50%. (segura a fonte de gold)
  - **Vende** (NPC vende, gold SAI / ralo): manter alto; nunca < 2x o preço de venda (anti-arbitragem).
- **✨ Aplicar todos sugeridos** + **💾 Salvar NPC** (regrava os params do XML).

## Formato do .dat/.spr (toggles no topo, estilo Object Builder)
- **Extended** (indice/contagem u32), **Transparency** (pixel RGBA),
  **Frame Groups** (creatures), **Frame Durations** (improved anim).
- Defaults vem do `Tibia.otfi` (se existir ao lado do dat). Pro teu cliente: tudo ON.
- Mexer num toggle reparseia na hora.

## Ajustes
- IDs de gold em `lib/economy.js` (2148/2152/2160 padrao TFS).
- Comentarios dentro do `<loot>` (`<!-- nome -->`) nao sobrevivem ao save.
