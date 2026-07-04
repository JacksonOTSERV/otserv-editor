// Lê/edita/cria vocations completas: TODOS os atributos da <vocation>,
// a <formula> e os <skill>. Preserva ordem dos atributos.
const fs = require('fs');

// "k="v" k2="v2"" -> [{k,v}]
function parseAttrs(inner) {
  const out = [];
  const re = /([\w]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(inner)) !== null) out.push({ k: m[1], v: m[2] });
  return out;
}

function attrGet(v, k) { const a = v.attrs.find((x) => x.k === k); return a ? a.v : null; }
function attrSet(v, k, val) {
  const a = v.attrs.find((x) => x.k === k);
  if (a) a.v = String(val); else v.attrs.push({ k, v: String(val) });
}

function loadVocations(file) {
  const raw = fs.readFileSync(file, 'latin1');
  const list = [];
  const re = /<vocation\b([^>]*)>([\s\S]*?)<\/vocation>/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const attrs = parseAttrs(m[1]);
    const idA = attrs.find((a) => a.k === 'id');
    const id = idA ? parseInt(idA.v, 10) : NaN;
    if (isNaN(id)) continue;
    const body = m[2];
    const fm = body.match(/<formula\b([^>]*?)\/?>/i);
    const formula = fm ? parseAttrs(fm[1]) : [];
    const skills = [];
    const sre = /<skill\b([^>]*?)\/?>/gi;
    let sm;
    while ((sm = sre.exec(body)) !== null) {
      const sa = parseAttrs(sm[1]);
      const idk = sa.find((x) => x.k === 'id');
      const mk = sa.find((x) => x.k === 'multiplier');
      skills.push({ id: idk ? idk.v : '', multiplier: mk ? mk.v : '' });
    }
    list.push({
      id,
      name: (attrs.find((a) => a.k === 'name') || {}).v || ('voc' + id),
      attrs, formula, skills, blockOrig: m[0], _new: false,
    });
  }
  return { file, raw, list };
}

function buildBlock(v) {
  let s = '\t<vocation ' + v.attrs.map((a) => `${a.k}="${a.v}"`).join(' ') + '>\n';
  if (v.formula && v.formula.length)
    s += '\t\t<formula ' + v.formula.map((a) => `${a.k}="${a.v}"`).join(' ') + '/>\n';
  for (const sk of (v.skills || []))
    s += `\t\t<skill id="${sk.id}" multiplier="${sk.multiplier}" />\n`;
  s += '\t</vocation>';
  return s;
}

function newVocation(id) {
  const attrs = [
    { k: 'id', v: String(id) }, { k: 'clientid', v: String(id) }, { k: 'name', v: 'NovaVoc' },
    { k: 'description', v: 'uma NovaVoc' }, { k: 'gaincap', v: '100' }, { k: 'gainhp', v: '500' },
    { k: 'gainmana', v: '400' }, { k: 'gainhpticks', v: '2' }, { k: 'gainhpamount', v: '100' },
    { k: 'gainmanaticks', v: '2' }, { k: 'gainmanaamount', v: '100' }, { k: 'manamultiplier', v: '1.1' },
    { k: 'attackspeed', v: '2000' }, { k: 'soulmax', v: '250' }, { k: 'gainsoulticks', v: '15' },
    { k: 'fromvoc', v: String(id) },
  ];
  const formula = [
    { k: 'meleeDamage', v: '1.0' }, { k: 'distDamage', v: '1.0' }, { k: 'wandDamage', v: '1.0' },
    { k: 'magDamage', v: '1.0' }, { k: 'magHealingDamage', v: '1.0' }, { k: 'defense', v: '1.0' },
    { k: 'magDefense', v: '1.0' }, { k: 'armor', v: '1.0' },
  ];
  const skills = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ id: String(i), multiplier: '1.1' }));
  return { id, name: 'NovaVoc', attrs, formula, skills, blockOrig: '', _new: true };
}

function saveVocations(store) {
  let raw = store.raw;
  const news = [];
  for (const v of store.list) {
    if (v._new) { news.push(v); continue; }
    const block = buildBlock(v);
    const idx = raw.indexOf(v.blockOrig);
    if (idx < 0) continue;
    raw = raw.slice(0, idx) + block + raw.slice(idx + v.blockOrig.length);
    v.blockOrig = block;
  }
  for (const v of news) {
    const block = buildBlock(v);
    const i = raw.lastIndexOf('</vocations>');
    if (i >= 0) raw = raw.slice(0, i) + block + '\n' + raw.slice(i);
    v._new = false;
    v.blockOrig = block;
  }
  store.raw = raw;
  fs.writeFileSync(store.file, raw, 'latin1');
}

// remove a vocation do store (tira o bloco do raw se nao for nova)
function deleteVocation(store, v) {
  if (!v._new && v.blockOrig) {
    const idx = store.raw.indexOf(v.blockOrig);
    if (idx >= 0) {
      let raw = store.raw.slice(0, idx) + store.raw.slice(idx + v.blockOrig.length);
      raw = raw.replace(/\n[\t ]*\n/g, '\n');
      store.raw = raw;
    }
  }
  store.list = store.list.filter((x) => x !== v);
}

module.exports = { loadVocations, saveVocations, newVocation, deleteVocation, attrGet, attrSet };
