# skills_actions.md — Cheat-sheet: gerar ACTIONS no estilo deste TFS (OTServ DBO)

Servidor TFS 1.x. Pasta: `otserv/data/actions/`. Registro em `actions.xml`, scripts em `scripts/{baus,custom,other}/`, lib em `lib/actions.lua`. Idioma das mensagens: **português** (PT-BR, com acentos).

## 1. Registro no actions.xml
Cada `<action>` mapeia um gatilho → script. Atributos (use UM por linha):
- `itemid="X"` — dispara ao usar o item X. Ex: `<action itemid="12289" script="custom/StaminaPotion.lua"/>`
- `actionid="X"` — item com aid X. Ex: `<action actionid="9999" script="baus/inicial.lua"/>`
- `uniqueid="X"` — item com uid único (alavancas/baús de mapa). Ex: `<action uniqueid="60096" script="baus/anihi1.lua"/>`
- `fromid`/`toid` — faixa contígua de itemids → mesmo script. Ex: `<action fromid="1209" toid="1214" script="other/doors.lua"/>`

Convenções de id reais: baús de quest = uid `60003..60133`; alavancas/anihi = uid `60001..60101`; itens custom = itemid `12xxx/13xxx`; storage de baú = mesmo nº do uid (ex baú uid 60087 usa storage 60087).

## 2. Assinatura
```lua
function onUse(player, item, fromPosition, target, toPosition, isHotkey)
```
- `player` — userdata Player que usou (`:getStorageValue`, `:addItem`, `:teleportTo`...)
- `item` — o item usado (`item.itemid`, `item.uid`, `item:transform()`, `item:remove(1)`)
- `fromPosition` — Position do item/uso
- `target` (= `itemEx`) — alvo do "usar com" (item/criatura/tile). Em scripts custom às vezes nomeado `itemEx`
- `toPosition` — Position do alvo
- `isHotkey` — bool
Retorne `true` se tratou, `false` p/ delegar ao default. **Sempre retorne bool.**

## 3. Padrões reais comuns

**Baú de quest (one-shot c/ storage + bag de recompensa)** — padrão dominante (`baus/*.lua`):
```lua
local firstTimeItems = {{id=12625, count=1}}
local STORAGE_CHEST = 60005
function onUse(player, item, fromPosition, target, isHotkey)
  if player:getStorageValue(STORAGE_CHEST) ~= 1 then
    local bag = doCreateItemEx(12764, 1) -- 12764 = bag padrão
    for _, r in ipairs(firstTimeItems) do doAddContainerItem(bag, r.id, r.count) end
    if doPlayerAddItemEx(player, bag, false) ~= RETURNVALUE_NOERROR then return true end
    doPlayerSendTextMessage(player, MESSAGE_EVENT_ADVANCE, "Você recebeu...")
    player:setStorageValue(STORAGE_CHEST, 1)
  else
    player:sendTextMessage(MESSAGE_INFO_DESCR, "Você já pegou os itens disponíveis nesse baú.")
  end
  return true
end
```

**Alavanca (transform toggle + abre passagem temporária)** (`baus/alavanca1.lua`):
```lua
if item.uid == 60001 and item.itemid == 9825 and getpiece1 then
  getpiece1:remove(); item:transform(9826)
  addEvent(Game.createItem, 60000, 13017, 1, piece1pos) -- recria após 1min
elseif item.itemid == 9826 then item:transform(9825) end
```

**Alavanca de quest em grupo (teleporta players + level/storage check)** (`baus/anihi1.lua`): valida `item.uid`/`item.itemid`, varre `Tile(pos):getTopCreature()` em posições fixas, exige `p:getLevel() >= questLevel` e `p:getStorageValue(storage) ~= -1`, então `p:teleportTo(newPos)` + `pos:sendMagicEffect(CONST_ME_TELEPORT)`.

**Transform/decay** (`other/decayto.lua`): tabela `[id]=id`, `item:transform(novo); item:decay()`.

**Potion/consumível c/ exhaustion** (`senzu_bean.lua`):
```lua
local STORAGE, WAIT = 50043, 1
if player:getStorageValue(STORAGE) > os.time() then player:sendCancelMessage("You are exhausted."); return false end
player:addHealth(9000); player:addMana(9000); player:say("I feel better!", TALKTYPE_SAY)
player:getPosition():sendMagicEffect(CONST_ME_MAGIC_BLUE)
player:setStorageValue(STORAGE, os.time()+WAIT); item:remove(1); return true
```

**Upgrade/refine (custo + chance%)** (`upgrader.lua`,`refine.lua`):
```lua
if not player:removeMoney(10000000) then player:sendCancelMessage("Você precisa de 10.000.000..."); return true end
if math.random(1,100) <= chances[lvl] then player:setStorageValue(BUFF,lvl+1); doSendMagicEffect(player:getPosition(),122)
else doSendMagicEffect(player:getPosition(),121) end
item:remove(1)
```
Refine lê nível pelo sufixo `+N` do nome (`:getName():split('+')`) e edita atributos do `itemEx`.

**Box/scroll aleatório por peso** (`boxvocations.lua`): soma `chance`, `roll=math.random(total)`, acumula até `roll<=counter`; cria item e seta `ITEM_ATTRIBUTE_NAME`/`DESCRIPTION`; `item:remove(1)`.

**Teleport (subir/descer andar)** (`other/teleport.lua`): ajusta `fromPosition.z`/`moveUpstairs()`, checa `tile:hasFlag(TILESTATE_PROTECTIONZONE)`+`player:isPzLocked()`, `player:teleportTo(pos,false)`.

## 4. API mais usada
- Storage: `player:getStorageValue(s)` / `setStorageValue(s,v)` (default `-1`)
- Itens: `item:transform(id)`, `item:remove(n)`, `item:decay()`, `item.itemid`, `item.uid`, `item:setAttribute(ITEM_ATTRIBUTE_NAME, ...)`, `player:addItem(id,n)`
- Legacy (baús): `doCreateItemEx(id,n)`, `doAddContainerItem(c,id,n)`, `doPlayerAddItemEx(p,c,false)`, `getItemNameById(id)`, `doPlayerSendTextMessage(p,t,msg)`, `doSendMagicEffect(pos,effId)`
- Player: `removeMoney(n)`, `addHealth/addMana`, `getLevel`, `teleportTo(pos,push)`, `say(txt,type)`, `getInbox()`, `getPosition()`, `isPzLocked()`
- Mensagens: `sendTextMessage(MESSAGE_EVENT_ADVANCE|MESSAGE_INFO_DESCR|MESSAGE_STATUS_*, msg)`, `sendCancelMessage(txt)`, `Game.broadcastMessage(msg,type)`
- Pos/Tile: `Position(x,y,z)`, `Tile(pos):getTopCreature()/getItemById(id)/hasFlag(...)`, `pos:sendMagicEffect(CONST_ME_*)`
- Util: `addEvent(fn, ms, ...)`, `math.random`, `os.time()`, `os.mtime()`, `ItemType(id):getName()`
- Constantes: `RETURNVALUE_NOERROR`, `CONST_ME_TELEPORT/POFF/MAGIC_BLUE/MAGIC_GREEN`, efeitos numéricos (54,121,122), `TALKTYPE_SAY/MONSTER_SAY`

## 5. Checklist p/ gerar uma action
1. Escolher gatilho: `itemid` (consumível/custom), `uniqueid` (baú/alavanca de mapa), `actionid`, ou `fromid/toid` (faixa).
2. Adicionar 1 linha em `actions.xml` apontando p/ `scripts/{baus|custom|other}/nome.lua`.
3. Criar script com `function onUse(player, item, fromPosition, target, toPosition, isHotkey)`.
4. Validar contexto: `item.uid`/`item.itemid`, ou storage one-shot, ou level/quest, ou `removeMoney`.
5. Efeito: `addItem`/bag, `transform`+`decay`, `teleportTo`, set storage, `addHealth`...
6. Feedback PT-BR: `sendTextMessage(MESSAGE_EVENT_ADVANCE,...)` + `sendMagicEffect`; erro via `sendCancelMessage`.
7. Consumir item se aplicável: `item:remove(1)`.
8. `return true` se tratou; `return false` p/ default. Exhaustion via `setStorageValue(S, os.time()+wait)`.

**Convenções:** mensagens em português c/ acento; bag de recompensa = `12764`; custo padrão upgrade `10.000.000`; storage de baú costuma == uid; scripts de baú usam API legada `doCreateItemEx`/`doAddContainerItem`, scripts custom usam API OO (`player:`, `item:`).
