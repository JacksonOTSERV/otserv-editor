# skills_movements.md — TFS Movements Cheat-Sheet

Movements = scripts disparados por movimento/posição de item (pisar tile, equipar, add/remove item). Registro em `data/movements/movements.xml`, scripts em `movements/scripts/`.

## Registro (movements.xml)
`<movevent event="..." [filtro] script="path.lua" | function="builtin"/>`

**event**: `StepIn` | `StepOut` | `Equip` | `DeEquip` | `AddItem` | `RemoveItem`

**Filtros (escolher 1 seletor)**:
- `itemid="X"` (aceita lista `;`: `itemid="1387;1392;459"`)
- `fromid="A" toid="B"` (faixa: `fromid="1746" toid="1749"`)
- `actionid="X"` (ex tile PVP `actionid="7862"`)
- `uniqueid="X"`
- `tileitem="1"` (AddItem: dispara quando item cai no tile)

**Atributos extra (Equip/DeEquip)**: `slot="head|armor|legs|feet|shield|ring|necklace|ankh..."`, `level="500"`, filho `<vocation name="..."/>`.

**script vs function**: `script="custom/x.lua"` (Lua próprio) OU `function="onEquipItem|onDeEquipItem|onStepInField|onAddField"` (builtin C++ — usado p/ equips de armor por atributos e fields).

Exemplos reais:
```xml
<movevent event="StepIn" actionid="12310" script="custom/soulTile.lua"/>
<movevent event="StepIn" fromid="1746" toid="1749" script="others/walkback.lua"/>
<movevent event="Equip" itemid="13603" slot="shield" level="500" function="onEquipItem"><vocation name="Goku Black"/></movevent>
<movevent event="AddItem" tileitem="1" itemid="1786" script="others/dough.lua"/>
```

## Assinaturas por evento
```lua
function onStepIn(creature, item, position, fromPosition) ... return true/false end
function onStepOut(creature, item, position, fromPosition) ... return true end
function onEquip(player, item, slot) ... return true end          -- ou builtin onEquipItem
function onDeEquip(player, item, slot) ... return true end
function onAddItem(moveitem, tileitem, position) ... return true end
function onRemoveItem(item, tile, position) ... return true end
```
`return false` em StepIn = bloqueia/cancela o movimento. `item` é userdata com `.itemid`, `.actionid`, `.uid`.

## Padrões reais
**Tile gatilho c/ teleport-back** — bloqueia por nível, devolve à origem:
```lua
function onStepIn(creature, item, position, fromPosition)
  if not creature:isPlayer() then return false end
  if creature:getLevel() < item.actionid - 1000 then
    creature:sendTextMessage(MESSAGE_INFO_DESCR, "Apenas o digno pode passar.")
    creature:teleportTo(fromPosition, true); return false
  end
  return true
end
```
**Tile de dano/armadilha**: `doTargetCombatHealth(0, creature, COMBAT_PHYSICALDAMAGE, -50, -100, CONST_ME_NONE)` + `item:transform(...)`.
**Tile com condition periódica (drowning)**: `Condition(CONDITION_DROWN)` + `CONDITION_PARAM_PERIODICDAMAGE/TICKS=-1/TICKINTERVAL`; StepIn `addCondition`, StepOut `removeCondition`.
**Tile addEvent recorrente (soulTile)**: StepIn arma timer (tabela global por GUID), StepOut `stopEvent`.
**AddItem transform (dough)**: massa vira pão no forno: `moveitem:transform(2689); position:sendMagicEffect(CONST_ME_HITBYFIRE)`.

## API útil
`creature:isPlayer()/isMonster()`, `:getLevel()`, `:getPosition()`, `:teleportTo(pos[,push])`, `:getStorageValue/:setStorageValue`, `:sendTextMessage(type,txt)`, `:addCondition(c)/:removeCondition(t)`, `:addItem(id,n)`. Item: `item:transform(newId[,count])`, `item.itemid`, `item.actionid`. Pos: `position:sendMagicEffect(eff)`. `doTargetCombatHealth(0,target,type,min,max,effect)`, `addEvent(fn,ms,...)`, `stopEvent(id)`.

## Checklist
1. Evento + seletor (itemid/actionid/fromid-toid/uniqueid) batendo com o tile/item real.
2. StepIn que bloqueia retorna `false` + `teleportTo(fromPosition)`.
3. Sempre checar `creature:isPlayer()` antes de API de player.
4. Equip/DeEquip: `slot` correto; usar builtin `onEquipItem` se só atributos.
5. addEvent em StepIn tem stopEvent correspondente em StepOut (evita leak).
6. Funções terminam com `return true` (exceto cancelamento).
