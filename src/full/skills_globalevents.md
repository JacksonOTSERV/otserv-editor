# skills_globalevents.md — TFS GlobalEvents Cheat-Sheet

GlobalEvents = scripts disparados pelo servidor por tempo/intervalo/ciclo de vida (sem jogador gatilho). Registro em `data/globalevents/globalevents.xml`, scripts em `globalevents/scripts/`.

## Registro (globalevents.xml)
`<globalevent name="X" [interval=ms | time="HH:MM[:SS]" | type=...] script="path.lua"/>`

**name**: obrigatório, único.

**Modo de disparo (escolher 1)**:
- `interval="3300000"` → chama `onThink(interval)` a cada N ms (loop). Ex: Aviso 3300000ms, Save 1800000, Clean 1011000, indicator 2000.
- `time="10:00"` ou `"HH:MM:SS"` → chama `onTime(interval)` 1x/dia naquele horário. Ex: BossSpawn 10:00/20:00, pvp_event 19:00.
- `type="startup"` → `onStartup()` ao ligar. `type="shutdown"` → `onShutdown()`. `type="record"` → `onRecord(current, old)`.

Exemplos reais:
```xml
<globalevent name="Aviso"   interval="3300000" script="custom/aviso.lua"/>
<globalevent name="Save"    interval="1800000" script="custom/save.lua"/>
<globalevent name="Clean"   interval="1011000" script="custom/clean.lua"/>
<globalevent name="BossSpawnMorning" time="10:00" script="custom/boss_spawn.lua"/>
<globalevent type="startup"  name="presencePointsReset" script="others/presencePointsReset.lua"/>
```

## Assinaturas
```lua
function onThink(interval, lastExecution) ... return true end   -- interval
function onTime(interval) ... return true end                   -- time="HH:MM"
function onStartup() ... return true end                        -- type=startup
function onShutdown() return true end                           -- type=shutdown
function onRecord(current, old) return true end                 -- type=record
```
Mesmo arquivo pode ser registrado por vários `<globalevent>` (boss_spawn.lua usa onTime p/ 10:00 e 20:00).

## Padrões reais
**Aviso periódico** — broadcast simples:
```lua
function onThink(interval, lastExecution)
  Game.broadcastMessage("DBO TV: ...", 22)
  return true
end
```
**Save/Clean com contagem regressiva** — onThink agenda avisos escalonados com addEvent + ação final:
```lua
function onThink(interval)
  Game.broadcastMessage('O servidor sera salvo em 5 minutos.', MESSAGE_STATUS_WARNING)
  addEvent(Game.broadcastMessage, 240000, '...1 minuto.',  MESSAGE_STATUS_WARNING)
  addEvent(saveServer, 5*60*1000)   -- clean.lua usa cleanMap
  return true
end
```
**Spawn de boss por horário** — onTime, evita duplicar varrendo a área antes de criar:
```lua
function onTime(interval)
  if not isBossAliveInArea(boss.name, boss.fromPos, boss.toPos) then
    Game.createMonster(boss.name, boss.spawnPos)
    for _,p in ipairs(Game.getPlayers()) do p:sendChannelMessage("","[INVADER]...",TALKTYPE_CHANNEL_O,8) end
  end
  return true
end
```
**Sorteio / lottery** — escolhe player e prêmio aleatório:
```lua
function onThink(interval)
  local players = Game.getPlayers()
  if #players > 0 then
    local g = players[math.random(1,#players)]; local r = rewards[math.random(1,#rewards)]
    g:addItem(r[1], r[2]); Game.broadcastMessage('[LOTTERY] Ganhador: '..g:getName(), MESSAGE_STATUS_WARNING)
  end
  return true
end
```
**Startup** — semeia DB/storage na subida: `function onStartup() ... return true end`.

## API útil
`Game.broadcastMessage(txt[, type])`, `Game.getPlayers()`, `Game.createMonster(name, pos)`, `Game.getPlayerCount()`. Player: `:addItem(id,n)`, `:getName()`, `:say(txt, TALKTYPE_MONSTER_SAY)`, `:sendChannelMessage(author,txt,type,channelId)`. `Tile(pos):getCreatures()`, `creature:isMonster()`. `addEvent(fn, ms, ...)`, `saveServer()`, `cleanMap()`, `os.time()`. Tipos msg: `MESSAGE_STATUS_WARNING`, número (22), `TALKTYPE_CHANNEL_O`.

## Checklist
1. Escolher 1 modo: `interval` (onThink), `time` (onTime), `type` (onStartup/Shutdown/Record).
2. `name` único; mesmo script pode ter vários registros (vários horários).
3. Função casa com o modo (interval→onThink, time→onTime, startup→onStartup).
4. interval em ms (1min=60000, 1h=3600000); time em `HH:MM` 24h.
5. Ações longas/escalonadas via `addEvent` dentro de onThink.
6. Antispawn/duplicata: checar estado (área/storage) antes de criar boss/recompensa. `return true` ao fim.
