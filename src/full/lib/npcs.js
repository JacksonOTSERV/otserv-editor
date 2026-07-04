// Carrega/salva NPCs de venda do TFS (parametros shop_buyable / shop_sellable).
// shop_buyable  = itens que o NPC VENDE  (player compra)  -> gold SAI  (ralo)
// shop_sellable = itens que o NPC COMPRA (player vende)   -> gold ENTRA (fonte)
const fs = require('fs');
const path = require('path');

const RE = {
  name:  /<npc[^>]*\bname\s*=\s*"([^"]*)"/i,
  look:  /<look[^>]*\btype\s*=\s*"(\d+)"/i,
  buy:   /key\s*=\s*"shop_buyable"\s+value\s*=\s*"([\s\S]*?)"/i,
  sell:  /key\s*=\s*"shop_sellable"\s+value\s*=\s*"([\s\S]*?)"/i,
};

function parseList(raw, role) {
  const out = [];
  if (!raw) return out;
  for (const entry of raw.split(';')) {
    const parts = entry.split(',').map((s) => s.trim());
    if (parts.length < 3) continue;
    const name = parts[0];
    const id = parseInt(parts[1], 10);
    const price = parseInt(parts[2], 10);
    if (!name || isNaN(id) || isNaN(price)) continue;
    out.push({ role, name, id, price });
  }
  return out;
}

function parse(file) {
  const raw = fs.readFileSync(file, 'latin1');
  if (/\.lua$/i.test(file)) return parseLuaNpc(raw, file); // Canary: NPC em Lua
  if (!raw.includes('<npc')) return null;
  const bm = raw.match(RE.buy);
  const sm = raw.match(RE.sell);

  const m = { file, raw };
  const nm = raw.match(RE.name);
  m.name = nm ? nm[1] : path.basename(file);
  const lk = raw.match(RE.look);
  m.looktype = lk ? parseInt(lk[1], 10) : 0;
  m.items = [
    ...parseList(bm ? bm[1] : '', 'buy'),
    ...parseList(sm ? sm[1] : '', 'sell'),
  ];
  return m; // inclui NPCs sem loja também (antes eram ignorados) → contam/aparecem
}

// NPC Lua (Canary): extrai nome + looktype; loja em Lua varia demais → vazia (somente leitura)
function parseLuaNpc(raw, file) {
  if (!/createNpcType|npcConfig|NpcType\(/i.test(raw)) return null;
  const s = raw.match(/createNpcType\s*\(\s*["']([^"']+)["']/i) || raw.match(/npcConfig\.name\s*=\s*["']([^"']+)["']/i) || raw.match(/\bnpcName\s*=\s*["']([^"']+)["']/i) || raw.match(/\bname\s*=\s*["']([^"']+)["']/i);
  const m = { file, raw, lua: true, readonly: true, items: [] };
  m.name = s ? s[1] : path.basename(file, '.lua');
  const lk = raw.match(/lookType\s*=\s*(\d+)/i);
  m.looktype = lk ? parseInt(lk[1], 10) : 0;
  return m;
}

function loadFolder(dir) {
  const arr = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(xml|lua)$/i.test(e.name)) { try { const m = parse(p); if (m) arr.push(m); } catch (err) {} }
  } };
  walk(dir);
  arr.sort((a, b) => a.name.localeCompare(b.name));
  return arr;
}

// reconstrói o value de uma role a partir dos items atuais
function buildValue(items, role) {
  const list = items.filter((i) => i.role === role);
  return list.map((i) => `${i.name},${i.id},${i.price}`).join(';');
}

function save(m) {
  if (m.lua) throw new Error('Edição de NPC Lua (Canary) ainda não suportada — edite o .lua direto no navegador de arquivos.');
  let raw = m.raw;
  // nome + looktype do NPC
  if (m.name) raw = raw.replace(/(<npc\b[^>]*\bname\s*=\s*")[^"]*(")/i, `$1${m.name}$2`);
  if (m.looktype) raw = raw.replace(/(<look\b[^>]*\btype\s*=\s*")\d+/i, `$1${m.looktype}`);
  if (RE.buy.test(raw))
    raw = raw.replace(RE.buy, `key="shop_buyable" value="${buildValue(m.items, 'buy')}"`);
  if (RE.sell.test(raw))
    raw = raw.replace(RE.sell, `key="shop_sellable" value="${buildValue(m.items, 'sell')}"`);
  m.raw = raw;
  fs.writeFileSync(m.file, raw, 'latin1');
  m._new = false;
}

const NPC_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<npc name="NAME" script="default.lua" walkinterval="2000">
\t<health now="100" max="100"/>
\t<look type="LOOK"/>
\t<parameters>
\t\t<parameter key="module_shop" value="1"/>
\t\t<parameter key="message_greet" value="Ola, |PLAYERNAME|! Diga {trade}."/>
\t\t<parameter key="shop_buyable" value=""/>
\t\t<parameter key="shop_sellable" value=""/>
\t</parameters>
</npc>
`;

function newNpc(dir, name, looktype) {
  const safe = (name || '').replace(/[^\w \-]/g, '').trim() || 'NewNpc';
  const raw = NPC_TEMPLATE.replace(/NAME/g, name || 'NewNpc').replace('LOOK', String(looktype || 1));
  const m = {
    file: path.join(dir, safe + '.xml'), raw, name: name || 'NewNpc',
    looktype: looktype || 1, items: [], _new: true,
  };
  return m;
}

function deleteNpc(m) {
  if (m._new || !m.file) return;
  try { if (fs.existsSync(m.file)) fs.unlinkSync(m.file); } catch (e) { /* ignora */ }
}

module.exports = { loadFolder, parse, save, newNpc, deleteNpc };
