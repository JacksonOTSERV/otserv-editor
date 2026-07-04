// Tiers de economia (ECONOMIA_PLANO.md §2). Classifica mob pela exp e sugere gold.

function tierName(exp) {
  if (exp < 5000) return 'Trash';
  if (exp < 20000) return 'Comum';
  if (exp < 50000) return 'Forte';
  if (exp < 80000) return 'Elite';
  return 'Boss';
}

function goldRange(exp) {
  if (exp < 5000) return [50, 150];
  if (exp < 20000) return [200, 600];
  if (exp < 50000) return [600, 2000];
  if (exp < 80000) return [2000, 5000];
  return [30000, 100000];
}

// id="X" countmax="N" chance="100000" p/ atingir a media do tier.
// 2148 gold(1) | 2152 platinum(100) | 2160 crystal(10000).
function suggestedGoldAttrs(exp) {
  const [mn, mx] = goldRange(exp);
  const avg = Math.floor((mn + mx) / 2);
  let id, unit;
  if (avg < 200) { id = 2148; unit = 1; }
  else if (avg < 50000) { id = 2152; unit = 100; }
  else { id = 2160; unit = 10000; }
  let countmax = Math.max(1, Math.round(avg / unit * 2));
  if (countmax > 100) countmax = 100;
  return `id="${id}" countmax="${countmax}" chance="100000"`;
}

// =================== PRECOS DE NPC ===================
// Modelo de economia (tunavel). Regras:
//  - sellable (NPC compra loot = gold ENTRA): preço baixo, ancorado no que o item
//    custa pra comprar (se houver) ou no gold do mob que dropa.
//  - buyable (NPC vende = gold SAI / ralo): manter alto; nunca < 2x o preço de venda
//    (senao vira arbitragem: compra barato no NPC e vende caro).
const NPC = {
  SELL_FROM_BUY: 0.25,    // NPC compra a 25% do preço que ele (ou outro) vende
  SELL_FROM_DROP: 0.15,   // ou 15% do gold medio do mob que dropa o item
  SELL_DEFAULT: 0.5,      // sem ancora -> corta o preço atual pela metade
  BUY_MIN_OVER_SELL: 2,   // NPC sempre vende por >= 2x o que compra (anti-arbitragem)
};

// monta o contexto a partir dos NPCs + monstros carregados
function buildNpcContext(npcs, monsters) {
  const buyMin = new Map();  // id -> menor preço que algum NPC VENDE (buyable)
  const sellMax = new Map(); // id -> maior preço que algum NPC COMPRA (sellable)
  for (const n of npcs) {
    for (const it of n.items) {
      if (it.role === 'buy') buyMin.set(it.id, Math.min(buyMin.get(it.id) ?? Infinity, it.price));
      else sellMax.set(it.id, Math.max(sellMax.get(it.id) ?? 0, it.price));
    }
  }
  // id do item -> maior exp de mob que o dropa
  const dropExp = new Map();
  for (const m of (monsters || [])) {
    for (const attrs of (m.loot || [])) {
      const mt = attrs.match(/\bid\s*=\s*"(\d+)"/);
      if (!mt) continue;
      const id = parseInt(mt[1], 10);
      if ((m.exp || 0) > (dropExp.get(id) || 0)) dropExp.set(id, m.exp || 0);
    }
  }
  return {
    buyOf: (id) => (buyMin.has(id) ? buyMin.get(id) : null),
    sellOf: (id) => (sellMax.has(id) ? sellMax.get(id) : null),
    dropGold: (id) => {
      if (!dropExp.has(id)) return null;
      const [mn, mx] = goldRange(dropExp.get(id));
      return Math.round((mn + mx) / 2);
    },
  };
}

// sugere preço p/ um item de NPC. Retorna { price, reason }.
function npcSuggest(item, ctx) {
  const cur = item.price;
  if (item.role === 'sell') { // NPC compra (gold entra)
    const buy = ctx.buyOf(item.id);
    if (buy) return { price: Math.round(buy * NPC.SELL_FROM_BUY), reason: `25% do preço de compra (${buy})` };
    const g = ctx.dropGold(item.id);
    if (g) return { price: Math.round(g * NPC.SELL_FROM_DROP), reason: `15% do gold do mob (~${g})` };
    return { price: Math.round(cur * NPC.SELL_DEFAULT), reason: 'sem ancora: -50%' };
  }
  // buyable: NPC vende (ralo de gold)
  const sell = ctx.sellOf(item.id);
  if (sell != null && cur < sell * NPC.BUY_MIN_OVER_SELL)
    return { price: sell * NPC.BUY_MIN_OVER_SELL, reason: `anti-arbitragem: >= 2x venda (${sell})` };
  return { price: cur, reason: 'ralo: manter alto' };
}

module.exports = { tierName, goldRange, suggestedGoldAttrs, NPC, buildNpcContext, npcSuggest };
