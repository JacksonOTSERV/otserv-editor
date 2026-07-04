// Calculos de economia: gold por kill, DPS do mob, stats e flags de auditoria.
const GOLD_UNIT = { 2148: 1, 2152: 100, 2160: 10000 }; // server ids -> valor

function lget(attrs, k) {
  const m = attrs.match(new RegExp('\\b' + k + '\\s*=\\s*"([^"]*)"'));
  return m ? m[1] : null;
}

// gold medio esperado por kill (itens de gold no loot)
function goldPerKill(m) {
  let g = 0;
  for (const a of (m.loot || [])) {
    const id = parseInt(lget(a, 'id') || '0', 10);
    const unit = GOLD_UNIT[id];
    if (!unit) continue;
    const cm = parseInt(lget(a, 'countmax') || '1', 10);
    const chance = parseInt(lget(a, 'chance') || '100000', 10);
    const avgCount = cm > 1 ? (cm + 1) / 2 : 1;
    g += avgCount * unit * (chance / 100000);
  }
  return Math.round(g);
}

function maxHit(m) {
  let mx = 0;
  for (const a of (m.attacks || [])) {
    const v = Math.abs(parseInt(lget(a.attrs, 'max') || '0', 10));
    if (v > mx) mx = v;
  }
  return mx;
}

// dano por segundo do mob (avg dano * prob de acerto / intervalo)
function mobDPS(m) {
  let d = 0;
  for (const a of (m.attacks || [])) {
    const mn = Math.abs(parseInt(lget(a.attrs, 'min') || '0', 10));
    const mx = Math.abs(parseInt(lget(a.attrs, 'max') || '0', 10));
    if (!mn && !mx) continue;
    const avg = (mn + mx) / 2;
    const ch = lget(a.attrs, 'chance');
    const p = ch ? parseInt(ch, 10) / 100 : 1;
    const iv = (parseInt(lget(a.attrs, 'interval') || '2000', 10)) / 1000 || 1;
    d += avg * p / iv;
  }
  return Math.round(d);
}

// mediana de exp/vida do conjunto (p/ detectar outliers)
function expHealthStats(monsters) {
  const r = [];
  for (const m of monsters) if (m.health > 0 && m.exp > 0) r.push(m.exp / m.health);
  r.sort((a, b) => a - b);
  return { median: r.length ? r[Math.floor(r.length / 2)] : 0 };
}

// flags de problema p/ a auditoria
function flags(m, stats) {
  const f = [];
  if (goldPerKill(m) <= 0) f.push('sem gold');
  if (m.health > 0 && m.exp > 0 && stats.median > 0) {
    const ratio = m.exp / m.health;
    if (ratio > stats.median * 3) f.push('exp alta');
    else if (ratio < stats.median / 3) f.push('exp baixa');
  }
  if ((m.attacks || []).length === 0) f.push('sem ataque');
  return f;
}

module.exports = { GOLD_UNIT, lget, goldPerKill, maxHit, mobDPS, expHealthStats, flags };
