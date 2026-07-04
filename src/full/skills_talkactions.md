# skills_talkactions.md — Base de conhecimento p/ gerar TALKACTIONS no estilo deste servidor TFS

Servidor: TFS 1.x C++ em `otserv/`. Scripts: `otserv/data/talkactions/scripts/`. Registro: `otserv/data/talkactions/talkactions.xml`.

## 1. Registro no `talkactions.xml`
Cada talkaction = 1 tag dentro de `<talkactions>`. Atributos:
- `words` — gatilho. Prefixo `/` = comando staff, `!` = comando player (convenção). Múltiplos gatilhos: separar por `;` → `words="!bol;!aol"`.
- `separator=" "` — define o caractere que separa words do `param`. Sem ele, tudo após words vira `param` cru (e geralmente comandos sem param: `/up`, `/ghost`, `!online`).
- `script="arquivo.lua"` — relativo a `scripts/`.
- (Não usado aqui, mas suportado: `access`/`group` no XML; neste servidor o controle de acesso é feito DENTRO do script via `player:getGroup():getAccess()`.)

Exemplos reais:
```xml
<talkaction words="/goto"      separator=" " script="teleport_to_creature.lua" />
<talkaction words="/i"         separator=" " script="create_item.lua" />
<talkaction words="!autoloot"  separator=" " script="autoloot.lua" />
<talkaction words="!bol;!aol"               script="aol.lua" />
<talkaction words="!online"                 script="online.lua" />
```

## 2. Assinatura
```lua
function onSay(player, words, param)        -- (channel opcional como 4º arg)
```
- `player` — userdata do Player que falou.
- `words` — o gatilho efetivo digitado (ex: `!aol` vs `!bol`).
- `param` — string após o separador (vazia `""` se nada). SEMPRE validar.
- Retorno: `return false` = consome o comando (não ecoa no chat). `return true` = deixa passar (usado quando sem acesso).

## 3. Padrões reais

**Checar acesso de staff** (topo de quase todo `/comando`):
```lua
if not player:getGroup():getAccess() then return true end
```

**Validar param vazio:**
```lua
if param == "" then player:sendCancelMessage("Use: /goto playerName | x,y,z"); return false end
```

**Parse por vírgula** (autoloot, create_item):
```lua
local split = param:split(",")
local action, arg = split[1], split[2]
local nome = split[2]:gsub("^%s*(.-)%s*$", "%1")   -- trim manual
```

**ItemType por nome OU id** (padrão `/i`, autoloot):
```lua
local itemType = ItemType(name)
if itemType:getId() == 0 then itemType = ItemType(tonumber(name)) end
if not itemType or itemType:getId() == 0 then player:sendCancelMessage("No item."); return false end
```

**Pegar player alvo** (online):
```lua
local target = Player(param)               -- nil se offline
if not target then player:sendCancelMessage("Player Offline."); return false end
```

**Posição via /goto** (creature OU coords):
```lua
local target = Creature(param)
if target then player:teleportTo(target:getPosition())
else
  local x,y,z = param:match("(%d+)[,%s]+(%d+)[,%s]+(%d+)")
  local pos = Position(tonumber(x), tonumber(y), tonumber(z))
  if Tile(pos) then player:teleportTo(pos); pos:sendMagicEffect(CONST_ME_TELEPORT) end
end
```

**Criar item / spawn:**
```lua
player:addItem(itemType:getId(), count)                          -- /i
Game.createMonster(param, player:getPosition(), false, false)    -- /m
```

**Storage toggle / lista** (autoloot usa range `AUTOLOOT_STORAGE_START..END`):
```lua
for i = AUTOLOOT_STORAGE_START, AUTOLOOT_STORAGE_END do
  if player:getStorageValue(i) <= 0 then player:setStorageValue(i, itemType:getId()); break end
end
```

**Cooldown / exhaustion** (aol.lua):
```lua
if exhaustion.check(player, 55555) then player:sendTextMessage(...); return false end
exhaustion.set(player, 55555, 2)   -- 2 segundos
```

**Cobrar dinheiro** (aol):
```lua
if player:removeMoney(20000) then player:addItem(12757, 1) else ... end
```

**Broadcast a todos:**
```lua
for _, p in ipairs(Game.getPlayers()) do p:sendPrivateMessage(player, param, TALKTYPE_BROADCAST) end
```

**Mensagens** (preferências do servidor):
- `player:sendCancelMessage("...")` — erro curto (staff cmds).
- `player:sendTextMessage(MESSAGE_STATUS_CONSOLE_ORANGE, "...")` — feedback player. Cores: `_ORANGE`, `_RED`, `_BLUE`; info: `MESSAGE_INFO_DESCR`.
- `player:popupFYI("texto")` — janela de ajuda.
- `player:showTextDialog(itemId, texto)` — diálogo com ícone de item (autoloot list, scouter).
- `player:say("texto", TALKTYPE_MONSTER_SAY)` — fala na cabeça.

## 4. API mais usada
- Player: `getGroup():getAccess()`, `isPremium()`, `getStorageValue/setStorageValue`, `getPosition`, `teleportTo`, `addItem`, `removeMoney`, `getName/getLevel/getMagicLevel/getMaxHealth/getMaxMana/getVocation():getName`, `getGuild`, `addExperience/removeExperience`, `getItemCount`.
- `ItemType(name|id)` → `:getId()`, `:getName()`, `:isStackable()`, `:isFluidContainer()`.
- `Player(name)` (só online), `Creature(name)`, `Position(x,y,z)`, `Tile(pos)`.
- `Game.getPlayers()`, `Game.createMonster()`, `Game.reload(RELOAD_TYPE_*)`.
- `pos:sendMagicEffect(CONST_ME_TELEPORT)`, `exhaustion.check/set`.
- String: `param:split(",")`, `:splitTrimmed(",")`, `:match(...)`, `:trim()`, `:gsub(...)`, `tonumber`.

## 5. Checklist — gerar uma talkaction
1. Escolher prefixo: `/` staff, `!` player. Decidir se precisa `separator=" "` (tem param?).
2. Registrar 1 linha no `talkactions.xml` apontando pro `script="x.lua"`.
3. No script: `function onSay(player, words, param)`.
4. Se staff → 1ª linha `if not player:getGroup():getAccess() then return true end`.
5. Validar `param == ""` com mensagem de uso (`sendCancelMessage`).
6. Parsear: vírgula (`split`), nome-vs-id (`ItemType`), alvo (`Player`/`Creature`), coords (`match`).
7. Executar ação + dar feedback (`sendTextMessage`/`sendCancelMessage`/efeito mágico).
8. Sempre `return false` no fim (consome o comando). `return true` só p/ "sem acesso".
9. (Opcional) `exhaustion` p/ cooldown; storage p/ estado persistente.
