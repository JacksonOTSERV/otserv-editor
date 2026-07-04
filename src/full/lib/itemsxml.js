// Parser + serializer do items.xml (TFS). Modelo por serverId com atributos.
// Preserva preâmbulo/rodapé e itens não editados (regenera só o necessário).
const fs = require('fs');

function decode(s) { return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
function encode(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function parseTagAttrs(tag) {
  const o = {}; const re = /([\w:-]+)\s*=\s*"([^"]*)"/g; let m;
  while ((m = re.exec(tag))) o[m[1]] = decode(m[2]);
  return o;
}

// Retorna { pre, post, items: [{ id, fromid, toid, tagAttrs, attributes:[{key,value}] }] }
function parse(text) {
  const items = [];
  const re = /<item\b([^>]*?)(\/>|>([\s\S]*?)<\/item\s*>)/gi;
  let m, firstStart = -1, lastEnd = -1;
  while ((m = re.exec(text))) {
    if (firstStart < 0) firstStart = m.index;
    lastEnd = m.index + m[0].length;
    const tagAttrs = parseTagAttrs(m[1]);
    const inner = m[3] || '';
    const attributes = [];
    const ar = /<attribute\b([^>]*?)\/?>/gi; let am;
    while ((am = ar.exec(inner))) { const a = parseTagAttrs(am[1]); if (a.key != null) attributes.push({ key: a.key, value: a.value, extra: a }); }
    items.push({
      id: tagAttrs.id != null ? parseInt(tagAttrs.id, 10) : null,
      fromid: tagAttrs.fromid != null ? parseInt(tagAttrs.fromid, 10) : null,
      toid: tagAttrs.toid != null ? parseInt(tagAttrs.toid, 10) : null,
      tagAttrs, attributes,
    });
  }
  const pre = firstStart >= 0 ? text.slice(0, firstStart) : '<?xml version="1.0" encoding="UTF-8"?>\n<items>\n';
  const post = lastEnd >= 0 ? text.slice(lastEnd) : '\n</items>\n';
  return { pre, post, items };
}

function itemTag(it) {
  // ordem comum: id/fromid/toid, article, name, plural, depois o resto
  const ta = { ...it.tagAttrs };
  if (it.id != null) ta.id = it.id; if (it.fromid != null) ta.fromid = it.fromid; if (it.toid != null) ta.toid = it.toid;
  const order = ['id', 'fromid', 'toid', 'article', 'name', 'plural', 'editorsuffix'];
  const keys = Object.keys(ta).sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
  const attrStr = keys.map((k) => `${k}="${encode(ta[k])}"`).join(' ');
  if (!it.attributes.length) return `\t<item ${attrStr}/>`;
  let s = `\t<item ${attrStr}>\n`;
  for (const a of it.attributes) s += `\t\t<attribute key="${encode(a.key)}" value="${encode(a.value)}"/>\n`;
  s += '\t</item>';
  return s;
}

function serialize(model) {
  return model.pre + model.items.map(itemTag).join('\n') + (model.items.length ? '\n' : '') + model.post.replace(/^\n/, '');
}

function load(file) { return parse(fs.readFileSync(file, 'utf8')); }
function save(model, file) { fs.writeFileSync(file, serialize(model)); }

// índice serverId -> entry (expande ranges fromid/toid)
function indexById(model) {
  const idx = new Map();
  for (const it of model.items) {
    if (it.id != null) idx.set(it.id, it);
    else if (it.fromid != null && it.toid != null) for (let i = it.fromid; i <= it.toid; i++) if (!idx.has(i)) idx.set(i, it);
  }
  return idx;
}

module.exports = { parse, serialize, load, save, indexById, encode, decode };
