// Modelo de balanceamento: dano vs HP do player (vocations) e exp vs stages (config).
// Constantes tunaveis:
const HP_BASE = 185;          // HP aproximado no level 1
const DANGER_PCT = 0.15;      // dano max do mob = % do HP do player no level alvo
const KILLS_PER_LEVEL = 150;  // quantos kills p/ subir 1 level (ritmo alvo)
const HP_MULT = 1.5;          // HP do mob "equivalente" = múltiplo do HP do player no level alvo

// HP/Mana do player no level (gainhp/gainmana do vocations.xml)
function playerHP(level, gainhp) { return HP_BASE + gainhp * (Math.max(1, level) - 1); }
function playerMana(level, gainmana) { return gainmana * (Math.max(1, level) - 1); }

// Formula EXATA do servidor (Player::getExpForLevel)
function expForLevel(L) { return Math.floor((((L - 6) * L + 17) * L - 12) / 6) * 100; }
function expToAdvance(L) { return Math.max(1, expForLevel(L + 1) - expForLevel(L)); }

// dano max sugerido (abs) = % do HP do player
function suggestMaxHit(level, gainhp) { return Math.round(playerHP(level, gainhp) * DANGER_PCT); }

// HP sugerido do mob = múltiplo do HP do player no level alvo (mob "equivalente" ao level)
function suggestHealth(level, gainhp, mult) { return Math.round(playerHP(level, gainhp) * (mult || HP_MULT)); }

// exp BASE sugerida no mob: ao aplicar o multiplier do stage, dá KILLS_PER_LEVEL kills/level
function suggestExp(level, mult) {
  if (!mult || mult <= 0) return 0;
  return Math.max(1, Math.round(expToAdvance(level) / KILLS_PER_LEVEL / mult));
}

module.exports = {
  HP_BASE, DANGER_PCT, KILLS_PER_LEVEL, HP_MULT,
  playerHP, playerMana, expForLevel, expToAdvance, suggestMaxHit, suggestExp, suggestHealth,
};
