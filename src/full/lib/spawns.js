// Carrega/salva spawns do TFS. Edita o spawntime (respawn) por monstro, in-place.
const fs = require('fs');

function loadSpawn(file) {
  const raw = fs.readFileSync(file, 'latin1');
  const entries = [];
  const re = /<monster\b([^>]*?)\/?>/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const inner = m[1];
    const nm = inner.match(/\bname\s*=\s*"([^"]*)"/i);
    const st = inner.match(/\bspawntime\s*=\s*"(\d+)"/i);
    entries.push({
      name: nm ? nm[1] : '?',
      spawntime: st ? parseInt(st[1], 10) : 0,
      inner, orig: m[0],
    });
  }
  return { file, raw, entries, _dirty: false };
}

function save(store) {
  let raw = store.raw;
  let cursor = 0;
  for (const e of store.entries) {
    let inner = e.inner;
    if (/\bspawntime\s*=/.test(inner)) inner = inner.replace(/(\bspawntime\s*=\s*")\d+(")/i, `$1${e.spawntime}$2`);
    else inner = inner.replace(/\s*$/, '') + ` spawntime="${e.spawntime}" `;
    const nt = `<monster${inner}/>`;
    const idx = raw.indexOf(e.orig, cursor);
    if (idx < 0) continue;
    if (nt !== e.orig) raw = raw.slice(0, idx) + nt + raw.slice(idx + e.orig.length);
    cursor = idx + nt.length;
    e.orig = nt; e.inner = inner;
  }
  store.raw = raw;
  fs.writeFileSync(store.file, raw, 'latin1');
}

// re-parseia entries a partir do raw (após mutações)
function reparse(store) {
  const entries = []; const re = /<monster\b([^>]*?)\/?>/gi; let m;
  while ((m = re.exec(store.raw)) !== null) {
    const inner = m[1];
    const nm = inner.match(/\bname\s*=\s*"([^"]*)"/i);
    const st = inner.match(/\bspawntime\s*=\s*"(\d+)"/i);
    entries.push({ name: nm ? nm[1] : '?', spawntime: st ? parseInt(st[1], 10) : 0, inner, orig: m[0] });
  }
  store.entries = entries;
}

// remove um <monster> específico do raw (engole o whitespace/linha em volta)
function removeMonster(store, entry) {
  const idx = store.raw.indexOf(entry.orig);
  if (idx < 0) return false;
  let s = idx; const e = idx + entry.orig.length;
  while (s > 0 && (store.raw[s - 1] === ' ' || store.raw[s - 1] === '\t')) s--;
  if (s > 0 && store.raw[s - 1] === '\n') s--;
  store.raw = store.raw.slice(0, s) + store.raw.slice(e);
  reparse(store); store._dirty = true; return true;
}
function removeAllOfName(store, name) {
  let n = 0;
  for (const ent of store.entries.filter((x) => x.name === name)) if (removeMonster(store, ent)) n++;
  return n;
}

// adiciona um <monster> no MESMO bloco <spawn> de refEntry (ou no 1º bloco se não houver)
function addMonster(store, name, spawntime, refEntry) {
  let insertAt = -1, z = 7, xOff = 0, yOff = 0;
  if (refEntry) {
    const idx = store.raw.indexOf(refEntry.orig);
    if (idx >= 0) {
      insertAt = idx + refEntry.orig.length;
      const zm = refEntry.inner.match(/\bz\s*=\s*"(-?\d+)"/i); if (zm) z = parseInt(zm[1], 10);
      const xm = refEntry.inner.match(/\bx\s*=\s*"(-?\d+)"/i); if (xm) xOff = parseInt(xm[1], 10) + 1;
      const ym = refEntry.inner.match(/\by\s*=\s*"(-?\d+)"/i); if (ym) yOff = parseInt(ym[1], 10);
    }
  }
  if (insertAt < 0) {
    const close = store.raw.search(/<\/spawn\s*>/i);
    if (close < 0) return false;
    const open = store.raw.slice(0, close).lastIndexOf('<spawn');
    const zm = store.raw.slice(open, close).match(/\bcenterz\s*=\s*"(-?\d+)"/i); if (zm) z = parseInt(zm[1], 10);
    insertAt = close;
  }
  const tag = `\n\t\t<monster name="${name}" x="${xOff}" y="${yOff}" z="${z}" spawntime="${spawntime || 60}"/>`;
  store.raw = store.raw.slice(0, insertAt) + tag + store.raw.slice(insertAt);
  reparse(store); store._dirty = true; return true;
}

module.exports = { loadSpawn, save, reparse, removeMonster, removeAllOfName, addMonster };
