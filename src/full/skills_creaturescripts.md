# skills_creaturescripts.md — CreatureScripts (TFS) deste servidor

Base p/ IA gerar creaturescripts no estilo do servidor (`otserv/data/creaturescripts/`).

## 1. Registro — creaturescripts.xml
Cada script = 1 `<event>` em `<creaturescripts>`. Atributos: `type`, `name`, `script`.
```xml
<event type="login"        name="PlayerLogin"  script="others/login.lua" />
<event type="death"        name="DropLoot"     script="others/droploot.lua" />
<event type="kill"         name="TaskKill"     script="custom/task_kills.lua"/>
<event type="advance"      name="Outfits"      script="custom/outfits.lua" />
<event type="think"        name="SkullCheck"   script="others/skullcheck.lua" />
<event type="healthchange" name="AntiIk"       script="custom/antiIk.lua"/>
<event type="preparedeath" name="ArenaPvp"     script="others/playerdeath.lua"/>
<event type="logout"       name="PlayerLogout" script="others/logout.lua" />
<event type="extendedopcode" name="ExtendedPing" script="custom/extended_ping.lua"/>
```
- `script` é relativo a `scripts/` (`others/...`, `custom/...` ou raiz).
- `type` reais usados: **login, logout, death, kill, advance, think, healthchange, preparedeath, extendedopcode** (TFS tb suporta `manachange`).
- 1 arquivo pode conter VÁRIOS eventos (ex.: `outfits.lua` tem onLogin+onAdvance+onDeath) — registrar cada um com seu próprio `<event>`.

## 2. Assinaturas por tipo (MUDAM por evento!)
```lua
function onLogin(player)                          -- return true
function onLogout(player)                         -- return true p/ permitir logout
function onDeath(creature, corpse, killer, mostDamageKiller, lastHitUnjustified, mostDamageUnjustified)
function onKill(creature, target)                 -- creature = killer; checar target:isMonster()
function onAdvance(player, skill, oldLevel, newLevel)   -- skill: SKILL_LEVEL, SKILL_MAGLEVEL...
function onThink(creature, interval)             -- interval em ms
function onHealthChange(creature, attacker, primaryDamage, primaryType, secondaryDamage, secondaryType, origin)
function onManaChange(creature, attacker, primaryDamage, primaryType, secondaryDamage, secondaryType, origin)
function onPrepareDeath(creature, killer)        -- antes da morte
function onExtendedOpcode(player, opcode, buffer)
```
- **onHealthChange/onManaChange RETORNAM** `primaryDamage, primaryType, secondaryDamage, secondaryType` (modifica/anula dano). Retornar `0,...,0` bloqueia. Ex `antiIk.lua`.
- **onLogin DEVE registrar os outros eventos** via `player:registerEvent("Name")` (o `name` do xml). Só login/logout/think de player são auto; os demais (death, kill, advance, healthchange, preparedeath, extendedopcode) precisam ser registrados no onLogin.

## 3. Padrões reais
**Login — hub de registros** (`others/login.lua`):
```lua
function onLogin(player)
    player:registerEvent("PlayerDeath"); player:registerEvent("DropLoot")
    player:registerEvent("TaskKill");    player:registerEvent("AntiIk")
    player:registerEvent("Outfits")
    return true
end
```
**Login boost por storage+tempo** (`boosts.lua`): se `getStorageValue(S) > os.time()` → cria `Condition(CONDITION_ATTRIBUTES)` (SUBID, TICKS, STAT_MAGICPOINTS/SKILL_*) e `player:addCondition(c)`.
**Logout c/ delay**: comparar `getStorageValue(1000)-os.time()`; sem `return true` o logout é bloqueado.
**Death**: grava death, conta bless (`hasBlessing`), resolve killer→master se summon. `droploot.lua` aborta se `hasFlag(PlayerFlag_NotGenerateLoot)`.
**Kill/task** (`task_kills.lua`): `local p=creature:getPlayer(); if not p or not target:isMonster() then return true end`; compara `target:getName()` (lower) c/ task ativa por storage, incrementa kills.
**Think summon** (`summon_think.lua`): `creature:getMaster()`, teleporta de volta se distância>7.
**ExtendedOpcode**: `if opcode == MEU_OPCODE then ... player:sendExtendedOpcode(opcode, buffer) end`.

## 4. API mais usada
- Player: `getStorageValue/setStorageValue`, `registerEvent`, `getLevel`, `getVocation():getId()/:getName()`, `getOutfit()/setOutfit`, `addOutfit/removeOutfit/hasOutfit`, `addCondition/removeCondition`, `hasBlessing/addBlessing`, `sendTextMessage(MESSAGE_*, txt)`, `teleportTo(pos, pushMove)`, `getSlotItem(CONST_SLOT_*)`, `getInbox():addItem(id,count,true,1)`, `getGuid/getGuild`, `isPremium`, `sendExtendedOpcode`.
- Creature: `getPlayer`, `getMaster`, `isPlayer/isMonster/isCreature`, `getPosition`, `addHealth(±n)`, `getMaxHealth`, `getName`, `say`.
- Condition: `Condition(CONDITION_ATTRIBUTES)` + `setParameter(CONDITION_PARAM_SUBID/TICKS/STAT_MAGICPOINTS/SKILL_SWORD...)`; TICKS=-1 permanente.
- Position/Tile: `Position(x,y,z)`, `pos:sendMagicEffect(CONST_ME_*)`, `Tile(pos):hasFlag(TILESTATE_PROTECTIONZONE/PVPZONE)`.
- Game/db: `Game.getPlayers()`, `Game.broadcastMessage(txt, MESSAGE_*)`, `db.query/storeQuery/escapeString`, `addEvent(fn, ms)`.

## 5. Checklist
1. `<event type=... name="X" script="custom/arquivo.lua"/>` no creaturescripts.xml.
2. Função com a assinatura EXATA do tipo (params na ordem certa).
3. Se NÃO é login/logout/think → registrar no `onLogin`: `player:registerEvent("X")`.
4. Guardas no topo: `getPlayer()`/`isPlayer()`/`isMonster()` antes de usar.
5. `return true` no fim (onHealthChange/onManaChange: `return primaryDamage, primaryType, secondaryDamage, secondaryType`).
6. Estado persistente via storages; tempo via `os.time()`.
