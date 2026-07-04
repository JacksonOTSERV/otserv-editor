// Carrega/salva XML de monstro do TFS (parsing por regex; save preserva o resto do arquivo).
const fs = require('fs');
const path = require('path');
const economy = require('./economy');

const RE = {
  name:   /<monster[^>]*\bname\s*=\s*"([^"]*)"/i,
  exp:    /\bexperience\s*=\s*"(\d+)"/,
  speed:  /\bspeed\s*=\s*"(\d+)"/,
  health: /<health[^>]*\bmax\s*=\s*"(\d+)"/i,
  lookT:  /<look[^>]*\btype\s*=\s*"(\d+)"/i,
  lookTx: /<look[^>]*\btypeex\s*=\s*"(\d+)"/i,
  loot:   /<loot>[\s\S]*?<\/loot>/i,
  item:   /<item\s+([^/>]*?)\s*\/?>/gi,
};

function walk(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (/\.(xml|lua)$/i.test(e.name)) out.push(p); // XML (TFS) ou Lua (Canary)
  }
  return out;
}

function num(re, s) { const m = s.match(re); return m ? parseInt(m[1], 10) : 0; }

// ---- tags genericas (edita qualquer atributo, preserva o resto) ----
function pAttrs(inner) {
  const o = []; const re = /([\w-]+)\s*=\s*"([^"]*)"/g; let m;
  while ((m = re.exec(inner)) !== null) o.push({ k: m[1], v: m[2] });
  return o;
}
function oneTag(raw, name) {
  const m = raw.match(new RegExp('<' + name + '\\b([^>]*?)(\\/?)>', 'i'));
  return m ? { name, attrs: pAttrs(m[1]), self: m[2] === '/', orig: m[0] } : null;
}
function listTags(raw, name) {
  const o = []; const re = new RegExp('<' + name + '\\b([^>]*?)(\\/?)>', 'gi'); let m;
  while ((m = re.exec(raw)) !== null) o.push({ name, attrs: pAttrs(m[1]), self: m[2] === '/', orig: m[0] });
  return o;
}
function tagText(t) { return '<' + t.name + ' ' + t.attrs.map((a) => `${a.k}="${a.v}"`).join(' ') + (t.self ? ' /' : '') + '>'; }
function tagGet(t, k) { if (!t) return null; const a = t.attrs.find((x) => x.k === k); return a ? a.v : null; }
function tagSet(t, k, v) { if (!t) return; const a = t.attrs.find((x) => x.k === k); if (a) a.v = String(v); else t.attrs.push({ k, v: String(v) }); }
function replaceTag(raw, t) {
  if (!t) return raw;
  const nt = tagText(t);
  const idx = raw.indexOf(t.orig);
  if (idx < 0) return raw;
  raw = raw.slice(0, idx) + nt + raw.slice(idx + t.orig.length);
  t.orig = nt;
  return raw;
}

function parse(file) {
  const raw = fs.readFileSync(file, 'latin1');
  if (/\.lua$/i.test(file)) { // Canary: monstro em Lua (Game.createMonsterType + tabela monster)
    if (!/createMonsterType|monster\.health|monster\.maxHealth|monster\s*=\s*\{/i.test(raw)) return null;
    return parseLua(raw, file);
  }
  if (!raw.includes('<monster')) return null;
  return parseText(raw, file);
}

// parser de monstro Lua (Canary/TFS 1.3+). Extrai os campos principais p/ listar/contar/visualizar.
// Edição/salvamento de Lua não é suportado (marcado readonly) — preserva o arquivo.
function parseLua(raw, file) {
  const m = { file, raw, lua: true, readonly: true };
  const sName = raw.match(/createMonsterType\s*\(\s*["']([^"']+)["']/i) || raw.match(/monster\.name\s*=\s*["']([^"']+)["']/i);
  m.name = sName ? sName[1] : path.basename(file, '.lua');
  const numL = (re) => { const x = raw.match(re); return x ? parseInt(x[1], 10) : 0; };
  m.exp = numL(/monster\.experience\s*=\s*(\d+)/i);
  m.health = numL(/monster\.maxHealth\s*=\s*(\d+)/i) || numL(/monster\.health\s*=\s*(\d+)/i);
  m.speed = numL(/monster\.speed\s*=\s*(\d+)/i);
  m.looktype = numL(/lookType\s*=\s*(\d+)/i);
  m.typeex = numL(/lookTypeEx\s*=\s*(\d+)/i);
  m.tier = economy.tierName(m.exp);
  m.loot = [];
  const lb = raw.match(/monster\.loot\s*=\s*\{([\s\S]*?)\n\}/i);
  if (lb) { const re = /\{([^{}]*)\}/g; let im; while ((im = re.exec(lb[1])) !== null) { const s = im[1].trim(); if (s) m.loot.push(s); } }
  return m;
}

function parseText(raw, file) {
  const m = { file, raw };
  const nm = raw.match(RE.name);
  m.name = nm ? nm[1] : path.basename(file);
  m.exp = num(RE.exp, raw);
  m.speed = num(RE.speed, raw);
  m.health = num(RE.health, raw);
  m.looktype = num(RE.lookT, raw);
  m.typeex = num(RE.lookTx, raw);
  m.tier = economy.tierName(m.exp);

  m.loot = [];
  const lb = raw.match(RE.loot);
  if (lb) {
    let im;
    RE.item.lastIndex = 0;
    while ((im = RE.item.exec(lb[0])) !== null) m.loot.push(im[1].trim());
  }

  // ataques (dano)
  m.attacks = [];
  const ab = raw.match(/<attacks>([\s\S]*?)<\/attacks>/i);
  if (ab) {
    const re = /<attack\s+([^>]*?)\s*(\/?)>/gi;
    let am;
    while ((am = re.exec(ab[1])) !== null)
      m.attacks.push({ attrs: am[1].trim(), selfClose: am[2] === '/', orig: am[0] });
  }

  // tags de atributos (editar tudo)
  m.rootTag = oneTag(raw, 'monster');
  m.healthTag = oneTag(raw, 'health');
  m.lookTag = oneTag(raw, 'look');
  m.strategyTag = oneTag(raw, 'strategy');
  m.defensesTag = oneTag(raw, 'defenses');
  m.flagTags = listTags(raw, 'flag');
  m.immunityTags = listTags(raw, 'immunity');
  m.elementTags = listTags(raw, 'element');
  return m;
}

function loadFolder(dir) {
  const arr = [];
  for (const f of walk(dir)) { try { const m = parse(f); if (m) arr.push(m); } catch (e) { /* arquivo ilegível/não-cacheado → ignora, segue */ } }
  arr.sort((a, b) => a.name.localeCompare(b.name));
  return arr;
}

function save(m) {
  if (m.lua) throw new Error('Edição de monstro Lua (Canary) ainda não suportada — edite o .lua direto no navegador de arquivos.');
  let raw = m.raw;
  // root tag (com a exp sincronizada) + demais tags de atributos in-place
  if (m.rootTag) { tagSet(m.rootTag, 'experience', m.exp); raw = replaceTag(raw, m.rootTag); }
  else raw = raw.replace(RE.exp, `experience="${m.exp}"`);
  for (const t of [m.healthTag, m.lookTag, m.strategyTag, m.defensesTag]) raw = replaceTag(raw, t);
  for (const t of [...(m.flagTags || []), ...(m.immunityTags || []), ...(m.elementTags || [])]) raw = replaceTag(raw, t);

  // ataques: edita os existentes in-place + insere os novos no bloco <attacks>
  if (m.attacks && m.attacks.length) {
    let cursor = 0;
    const news = [];
    for (const at of m.attacks) {
      const newTag = `<attack ${at.attrs}${at.selfClose ? ' /' : ''}>`;
      if (!at.orig) { news.push({ at, newTag }); continue; }
      const idx = raw.indexOf(at.orig, cursor);
      if (idx < 0) continue;
      if (newTag !== at.orig) raw = raw.slice(0, idx) + newTag + raw.slice(idx + at.orig.length);
      cursor = idx + newTag.length;
      at.orig = newTag;
    }
    if (news.length) {
      const block = news.map((n) => `\t\t${n.newTag}\n`).join('');
      const ai = raw.search(/<\/attacks>/i);
      if (ai >= 0) raw = raw.slice(0, ai) + block + raw.slice(ai);
      else {
        const mi = raw.lastIndexOf('</monster>');
        if (mi >= 0) raw = raw.slice(0, mi) + `\t<attacks>\n${block}\t</attacks>\n` + raw.slice(mi);
      }
      for (const n of news) n.at.orig = n.newTag;
    }
  }

  let block = '<loot>\n';
  for (const a of m.loot) block += `\t\t<item ${a}/>\n`;
  block += '\t</loot>';

  const lm = raw.match(RE.loot);
  if (lm) {
    raw = raw.slice(0, lm.index) + block + raw.slice(lm.index + lm[0].length);
  } else if (m.loot.length) {
    const i = raw.lastIndexOf('</monster>');
    if (i >= 0) raw = raw.slice(0, i) + '\t' + block + '\n' + raw.slice(i);
  }
  m.raw = raw;
  fs.writeFileSync(m.file, raw, 'latin1');
  if (m._new) { registerInIndex(m); m._new = false; }
}

// registra o mob novo no monster/monsters.xml (se nao estiver)
function registerInIndex(m) {
  const idx = path.join(path.dirname(m.file), 'monsters.xml');
  if (!fs.existsSync(idx)) return;
  let raw = fs.readFileSync(idx, 'latin1');
  const base = path.basename(m.file);
  if (raw.includes(`file="${base}"`)) return;
  const line = `\t<monster name="${m.name}" file="${base}" />\n`;
  const i = raw.lastIndexOf('</monsters>');
  if (i >= 0) { raw = raw.slice(0, i) + line + raw.slice(i); fs.writeFileSync(idx, raw, 'latin1'); }
}

const MON_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<monster name="NAME" nameDescription="a NAME" race="blood" experience="100" speed="200" manacost="0">
\t<health now="200" max="200" />
\t<look type="LOOK" head="0" body="0" legs="0" feet="0" addons="0" corpse="0" />
\t<targetchange interval="4000" chance="10" />
\t<strategy attack="100" defense="0" />
\t<flags>
\t\t<flag summonable="0" />
\t\t<flag attackable="1" />
\t\t<flag hostile="1" />
\t\t<flag illusionable="0" />
\t\t<flag convinceable="0" />
\t\t<flag pushable="1" />
\t\t<flag canpushitems="1" />
\t\t<flag canpushcreatures="0" />
\t\t<flag targetdistance="1" />
\t\t<flag staticattack="90" />
\t\t<flag runonhealth="0" />
\t</flags>
\t<attacks>
\t\t<attack name="melee" interval="2000" min="-10" max="-50" />
\t</attacks>
\t<defenses armor="0" defense="0">
\t</defenses>
\t<immunities>
\t\t<immunity physical="0" />
\t\t<immunity energy="0" />
\t\t<immunity fire="0" />
\t\t<immunity poison="0" />
\t\t<immunity lifedrain="0" />
\t\t<immunity paralyze="0" />
\t\t<immunity outfit="0" />
\t\t<immunity invisible="0" />
\t</immunities>
\t<voices interval="5000" chance="10">
\t</voices>
\t<loot>
\t</loot>
</monster>
`;

// remove o mob: apaga o arquivo e tira a linha do monsters.xml (se nao for novo)
function deleteMonster(m) {
  if (m._new || !m.file) return;
  try { if (fs.existsSync(m.file)) fs.unlinkSync(m.file); } catch (e) { /* ignora */ }
  const idx = path.join(path.dirname(m.file), 'monsters.xml');
  if (fs.existsSync(idx)) {
    const base = path.basename(m.file);
    const raw = fs.readFileSync(idx, 'latin1');
    const out = raw.split('\n').filter((l) => !l.includes(`file="${base}"`)).join('\n');
    if (out !== raw) fs.writeFileSync(idx, out, 'latin1');
  }
}

function newMonster(dir, name, looktype) {
  const safe = (name || '').replace(/[^\w \-]/g, '').trim() || 'NewMonster';
  const raw = MON_TEMPLATE.replace(/NAME/g, name || 'NewMonster').replace('LOOK', String(looktype || 1));
  const m = parseText(raw, path.join(dir, safe + '.xml'));
  m._new = true;
  return m;
}

// ---- helpers de atributo de loot (operam na string crua) ----
function lget(attrs, k) {
  const m = attrs.match(new RegExp('\\b' + k + '\\s*=\\s*"([^"]*)"'));
  return m ? m[1] : null;
}
function lset(attrs, k, v) {
  const re = new RegExp('(\\b' + k + '\\s*=\\s*")[^"]*(")');
  if (re.test(attrs)) return attrs.replace(re, `$1${v}$2`);
  return attrs.trim() + ` ${k}="${v}"`;
}
function lremove(attrs, k) {
  return attrs.replace(new RegExp('\\s*\\b' + k + '\\s*=\\s*"[^"]*"'), '').trim();
}
function ldisplay(attrs) {
  const id = lget(attrs, 'id');
  if (id != null) return 'id ' + id;
  const n = lget(attrs, 'name');
  return n != null ? n : '?';
}

module.exports = { loadFolder, parse, parseText, save, newMonster, deleteMonster, tagGet, tagSet, lget, lset, lremove, ldisplay };
