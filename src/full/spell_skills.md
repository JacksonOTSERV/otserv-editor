# spell_skills.md — Base de conhecimento de SPELLS (servidor `otserv/`)

> Convenções REAIS extraídas de `otserv/data/spells/` (servidor TFS 1.x, tema Dragon Ball).
> O Spell Editor injeta este arquivo no prompt da IA → ela gera spells no estilo do SEU servidor.
> Spells registradas em **`spells.xml`** + script em `data/spells/scripts/<Pasta>/nome.lua`.
> Pastas por personagem/categoria: Attack, Healing, Support, Goku, Vegeta, Broly, Freeza, Cell, Buu…

## ⚠️ Estilo do servidor (CRÍTICO — NÃO é revscriptsys `Spell()`)
- Script usa **funções globais** `onCastSpell(creature, var)` + (opcional) `onGetFormulaValues(...)`. NÃO usa `local spell = Spell()` nem `spell:register()`.
- Registro fica no **`spells.xml`** (`<instant .../>` ou `<rune .../>`).
- Dano = **callback de fórmula** com constantes `DAMAGE_FACTOR_*`, não `setFormula`.
- Efeitos/missiles = **IDs numéricos crus** (ex: effect 35, distance 40).
- Cooldown = sistema **`exhaustion`** (storages compartilhados) + `sendSpellbarCooldownAuto`.
- Tipo de dano: quase tudo `COMBAT_PHYSICALDAMAGE` (ki = físico); cura `COMBAT_HEALING`.

## Registro no spells.xml
```xml
<!-- ataque -->
<instant spellid="120" group="attack" name="Kamehameha" words="kamehameha" lvl="100" mana="2000" magiclevel="50" script="Goku/kamehameha.lua"></instant>
<!-- cura (não-agressiva, self) -->
<instant spellid="1" group="healing" name="Regeneration" words="regeneration" lvl="1" mana="1000" aggressive="0" selftarget="1" script="Healing/regeneration.lua"></instant>
<!-- suporte -->
<instant spellid="6" group="support" name="Aura" words="aura" lvl="1" mana="10" aggressive="0" script="Support/aura.lua"></instant>
<!-- rune -->
<rune spellid="13" group="special" name="magic wall" id="13578" soul="1" range="6" allowfaruse="1" blocktype="all" script="Support/magicwall.lua"/>
```
Atributos: `spellid`, `group`(attack/healing/support/special), `name`, `words`, `lvl`, `mana`, `magiclevel`(opc), `aggressive`(0/1), `selftarget`(1), `prem`, `needlearn`(0/1), `blockwalls`, `exhaustion`(ms), `params`, `script`. Rune: `id`(item), `range`, `allowfaruse`, `blocktype`.

## Estrutura base do script (ATAQUE alvo único / multi-hit)
```lua
local waittime = 1            -- exhaustion em segundos
local storage = 1000150       -- storage do exhaustion

local combat = Combat()
combat:setParameter(COMBAT_PARAM_TYPE, COMBAT_PHYSICALDAMAGE)
combat:setParameter(COMBAT_PARAM_DISTANCEEFFECT, 8)   -- id cru (opcional)

function onGetFormulaValues(creature, level, maglevel)
    local min = -(DAMAGE_FACTOR_LEVEL100 * level + DAMAGE_FACTOR_SKILL100 * maglevel) * 0.78
    local max = -(DAMAGE_FACTOR_LEVEL100 * level + DAMAGE_FACTOR_SKILL100 * maglevel) * 0.82
    return min, max
end
combat:setCallback(CALLBACK_PARAM_LEVELMAGICVALUE, "onGetFormulaValues")

function onCastSpell(creature, variant)
    if not creature then return false end
    if exhaustion.check(creature, storage) then
        creature:sendCancelMessage("Aguarde " .. tostring(exhaustion.get(creature, storage)) .. " segundos.")
        return false
    end
    local target = creature:getTarget()
    if not target or target:isInGhostMode() then return false end
    local cid, tid = creature:getId(), target:getId()
    for k = 1, 3 do                                   -- multi-hit
        addEvent(function()
            local c, t = Creature(cid), Creature(tid)
            if c and t and not t:isInGhostMode() then
                local tile = Tile(t:getPosition())
                if tile and tile:hasFlag(TILESTATE_PROTECTIONZONE) then return end
                combat:execute(c, Variant(t:getPosition()))
            end
        end, 1 + ((k-1) * 200))
    end
    exhaustion.set(creature, storage, waittime)
    if sendSpellbarCooldownAuto then sendSpellbarCooldownAuto(creature, "Ki blast") end
    return true
end
```

## Fórmula — DAMAGE_FACTOR (lib/core/combat.lua)
`min/max = -(DAMAGE_FACTOR_LEVEL<T> * level + DAMAGE_FACTOR_SKILL<T> * maglevel) * fator`
(negativo p/ dano; positivo p/ cura). Tier `<T>` ∈ {1,50,100,150,200,250,300,400}; fatorMin≈0.78–0.98, fatorMax≈0.82–1.02.

| Tier | LEVEL | SKILL |  | Tier | LEVEL | SKILL |
|---|---|---|---|---|---|---|
| 1 | 5 | 30 |  | 200 | 25 | 200 |
| 50 | 5 | 35 |  | 250 | 28 | 205 |
| 100 | 65 | 260 |  | 300 | 30 | 205 |
| 150 | 10 | 85 |  | 400 | 45 | 240 |

## Spell de ÁREA (matriz local, centro=2)
```lua
local arr = {
{0,0,0,0,0},
{0,1,1,1,0},
{0,1,2,1,0},   -- 2 = centro (caster)
{0,1,1,1,0},
{0,0,0,0,0},
}
local combat = Combat()
combat:setParameter(COMBAT_PARAM_TYPE, COMBAT_PHYSICALDAMAGE)
combat:setParameter(COMBAT_PARAM_EFFECT, 60)
combat:setArea(createCombatArea(arr))
combat:setCallback(CALLBACK_PARAM_LEVELMAGICVALUE, "onGetFormulaValues")
function onCastSpell(player, var)
    -- ...exhaustion...
    return combat:execute(player, var)
end
```

## Spell de CURA / SUPORTE
```lua
local combat = Combat()
combat:setParameter(COMBAT_PARAM_TYPE, COMBAT_HEALING)
combat:setParameter(COMBAT_PARAM_AGGRESSIVE, false)
combat:setParameter(COMBAT_PARAM_EFFECT, 88)
function onGetFormulaValues(player, level, maglevel)
    min = (level * 26 + maglevel * 60); max = (level * 39 + maglevel * 80)   -- POSITIVO
    return min, max
end
combat:setCallback(CALLBACK_PARAM_LEVELMAGICVALUE, "onGetFormulaValues")
function onCastSpell(player, var) return combat:execute(player, var) end
```

## Sistema de exhaustion (cooldown)
- `exhaustion.check(creature, storage)` → true se ainda em cooldown.
- `exhaustion.get(creature, storage)` → segundos restantes.
- `exhaustion.set(creature, storage, segundos)` → ativa.
- Storages-grupo compartilhados (cooldown global de classe): **1000150, 1000250, 1000300, 1000400** (setam vários p/ travar combos). Cada spell costuma ter storage próprio também.
- `sendSpellbarCooldownAuto(player, "Nome da Spell")` atualiza a barra do cliente.

## IDs comuns (cliente deste server)
- Effect (`COMBAT_PARAM_EFFECT`): 35, 6, 32, 10, 23, 21, 133, 130, 38, 33, 17, 8…
- Distance (`COMBAT_PARAM_DISTANCEEFFECT`): 40, 25, 46, 18, 22, 49, 36, 19, 11…
> Confira no modo Object/picker do editor.

## API-chave
`Combat()` · `combat:setParameter(...)` · `combat:setArea(createCombatArea(arr))` · `combat:setCallback(CALLBACK_PARAM_LEVELMAGICVALUE, "fn")` · `combat:execute(creature, var|Variant(pos))` ·
`onCastSpell(creature, var)` global · `onGetFormulaValues(creature, level, maglevel)` global ·
`creature:getTarget()/getId()/getPosition()/isInGhostMode()` · `Creature(id)` (revalida em addEvent) · `Variant(pos)` ·
`addEvent(fn, ms, ...)` · `Tile(pos):hasFlag(TILESTATE_PROTECTIONZONE)` · `exhaustion.*` · `sendSpellbarCooldownAuto`.

## Padrões AVANÇADOS (reais do server)
- **Combo / cooldown sincronizado**: trava vários grupos → `exhaustion.set(creature, 1000250, w); exhaustion.set(creature, 1000300, w)` além do storage próprio.
- **Transformação (forma, ex Migatte)**: `local old = creature:getOutfit(); creature:setOutfit({lookType=729, lookAura=X}); addEvent(function() Creature(id):setOutfit(old) end, dur*1000)`.
- **Summon**: `Game.createMonster("Vegeta", creature:getPosition(), true, false)` (+ `addEvent` p/ `sm:remove()` se temporário).
- **Buff de stats**: `local c = createConditionObject(CONDITION_ATTRIBUTES); c:setParameter(CONDITION_PARAM_TICKS, t); c:setParameter(CONDITION_PARAM_SKILL_SWORD, +30); c:setParameter(CONDITION_PARAM_STAT_MAGICPOINTSPERCENT, 150); creature:addCondition(c)`.
- **Regeneração**: `CONDITION_REGENERATION` + `CONDITION_PARAM_HEALTHGAIN/HEALTHTICKS/MANAGAIN/MANATICKS`.
- **Texto flutuante**: `doSendAnimatedText(creature:getPosition(), "+1 Power", TEXTCOLOR_WHITE)`.
- **Teleporte até o alvo**: `creature:teleportTo(creature:getTarget():getPosition())`.
- **Criar item (magic wall)**: `combat:setParameter(COMBAT_PARAM_CREATEITEM, 13576)`.
- **setFormula direto** (sem callback): `combat:setFormula(COMBAT_FORMULA_LEVELMAGIC, -75, 0, -100, 0)`.
- **direction** no XML p/ spells que dependem da direção do caster.

## Checklist ao gerar uma spell
1. `<instant>` no spells.xml + script em `scripts/<Pasta>/`. 2. `COMBAT_PHYSICALDAMAGE` (dano) ou `COMBAT_HEALING`.
3. fórmula via `onGetFormulaValues` + `DAMAGE_FACTOR_*` (negativo=dano, positivo=cura) + `setCallback`.
4. `onCastSpell` global (NÃO `Spell():register()`). 5. exhaustion.check/set + `sendSpellbarCooldownAuto`.
6. effect/distance = id numérico. 7. área = matriz local (centro 2). 8. multi-hit via `addEvent` + `Creature(id)`.
