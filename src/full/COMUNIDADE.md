# 🛠️ OTServ Editor — de um "editor de mob" pra uma ferramenta completa de servidor

E aí pessoal! 👋

Começou pequeno: eu só queria um **editorzinho pra mexer no loot dos meus monstros** sem ficar abrindo XML por XML na mão. Aí fui adicionando uma coisa... outra... e quando vi tinha um **editor completo de OTServ (TFS)**. Resolvi compartilhar com vocês de graça.

Funciona com **TFS 1.x + cliente OTCv8/8.60** (lê seu `.dat`/`.spr`/`items.otb` de verdade e mostra os sprites). É **portátil** — não precisa instalar nada, é só abrir o `.exe` e apontar pra pasta do seu server.

---

## ⚙️ O que ele faz

### 🐲 Mobs (monstros)
- Lista **todos os mobs** com sprite renderizado direto do seu `.dat`/`.spr`
- Edita **TODOS os campos do XML**: vida, speed, race, flags, defenses, immunities, elements
- **Loot** com ícone de cada item (mapeado pelo `items.otb`), editar id/chance/countmax
- **Ataques/spells**: adicionar, editar (min/max) e remover
- **Seletor visual de outfit** — escolhe o looktype clicando no sprite
- **Criar mob do zero** (template completo, já registra no `monsters.xml`) e **remover**

### ⚔️ Balanceamento automático
- Lê o **`vocations.xml`** (quanto de HP/mana o player ganha por level) e o **`config.lua`** (exp stages)
- Sugere **exp** e **dano** equilibrados pro level alvo de cada mob
- Sugere **gold por tier** de dificuldade

### 🛒 NPCs de venda
- Lista os vendedores (`shop_buyable`/`shop_sellable`)
- **Preço sugerido** pra economia saudável (ancora a venda no gold do mob que dropa o item, anti-arbitragem)
- Criar/remover NPC, editar looktype

### 📜 Vocations
- Editor **completo**: todos os atributos da vocation + `<formula>` (dano/defesa) + `<skill>`
- Criar/remover vocation

### 🗺️ Spawns
- Acha seu spawn automático e lista os monstros
- Edita o **respawn (segundos)** por monstro — ótimo pra setar respawn de boss

### 📊 Economia
- **Aplicar em massa**: gold / exp / dano sugeridos pra TODOS os mobs de uma vez
- **Simulador**: player lv X caçando mob Y → gold ganho vs gasto em poção = **% de ralo** (te diz se tá equilibrado)
- **Auditoria**: tabela de todos os mobs com flags de outlier (exp demais, sem gold, etc.)

### 📁 Arquivos (editor de código)
- **Explorador da pasta inteira** do seu otserv
- Editor com **abas estilo VS Code** + **syntax highlight** de `.lua` e `.xml` (CodeMirror)
- Abre vários arquivos, Ctrl+S salva

### 🔎 Qualidade de vida
- **Validar**: aponta erros — loot com id que não existe no OTB, looktype inválido, ataque com dano positivo (cura por engano), name diferente do `monsters.xml`
- **Salvar tudo** de uma vez (edita vários e salva no fim) com **backup `.bak`**
- **Logs de erro** integrados
- Lembra os caminhos do seu server entre sessões
- UI dark moderna 🌙

---

## ▶️ Como usar
1. Baixa e abre o `OTServ Editor.exe` (portátil)
2. Clica em **📂 Servidor** e aponta a raiz do teu server (ou cada caminho na mão: `config.lua`, pasta `monster`, `vocations.xml`, `.dat`/`.spr`/`items.otb`)
3. Pronto — edita, e no fim **💾 Salvar tudo**

---

É 100% grátis. Se ajudar alguém já valeu! Feedback e sugestões são bem-vindos. 🚀
