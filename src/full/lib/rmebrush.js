// Lê os dados de brush do RME (borders.xml + grounds.xml) e faz auto-border DIRECIONAL.
// edges: n,e,s,w (lados) · cnw/cne/csw/cse (cantos externos) · dnw/dne/dsw/dse (diagonais internos)
const fs = require('fs');
const path = require('path');
const OTBM = require('./otbm');

function parseBorders(xml) {
  const map = new Map();
  const re = /<border\s+id="(\d+)"[^>]*>([\s\S]*?)<\/border>/g; let m;
  while ((m = re.exec(xml))) {
    const id = +m[1]; const edges = {};
    const ir = /<borderitem\s+edge="(\w+)"\s+item="(\d+)"/g; let im;
    while ((im = ir.exec(m[2]))) edges[im[1]] = +im[2];
    map.set(id, edges);
  }
  return map;
}
// Porta FIEL de ground_brush_loader.cpp: cada brush guarda lista de BorderBlocks
// {outer:bool, to:'all'|'none'|<nome>, autoborder:id} + flags has*Border (p/ getBrushTo).
function parseGrounds(xml) {
  const brushes = []; const re = /<brush\s+name="([^"]+)"\s+type="ground"([^>]*?)(?:\/>|>([\s\S]*?)<\/brush>)/g; let m;
  while ((m = re.exec(xml))) {
    const name = m[1], attrs = m[2], body = m[3] || '';
    const look = attrs.match(/server_lookid="(\d+)"/) || attrs.match(/lookid="(\d+)"/);
    const zo = attrs.match(/z-order="(-?\d+)"/); const zOrder = zo ? +zo[1] : 0;
    const useOnlyOptional = /solo_optional="(?:1|true|yes)"/.test(attrs);
    const items = [];
    const ir = /<item\s+id="(\d+)"(?:\s+chance="(\d+)")?/g; let im;
    while ((im = ir.exec(body))) items.push({ id: +im[1], chance: im[2] ? +im[2] : 0 });
    // border blocks (cada <border align=.. [to=..] id=N/>)
    const borders = []; let hasOuter = false, hasInner = false, hasZilchOuter = false, hasZilchInner = false;
    const br = /<border\b([^>]*?)\/?>/g; let bm;
    while ((bm = br.exec(body))) {
      const a = bm[1]; const idM = a.match(/\sid="(\d+)"/); if (!idM) continue;
      const alignM = a.match(/align="(\w+)"/); const outer = !alignM || alignM[1] !== 'inner';
      const toM = a.match(/to="([^"]*)"/); let to = 'all';
      if (toM) to = (toM[1] === 'all') ? 'all' : (toM[1] === 'none' ? 'none' : toM[1]);
      borders.push({ outer, to, autoborder: +idM[1] });
      if (outer) { if (to === 'none') hasZilchOuter = true; else hasOuter = true; }
      else { if (to === 'none') hasZilchInner = true; else hasInner = true; }
    }
    const opt = body.match(/<optional\b[^>]*?\sid="(\d+)"/); const optional = opt ? +opt[1] : null; // cliff (mountain)
    const friends = []; let hateFriends = false;
    const fr = /<friend\s+name="([^"]+)"/g; let fm; while ((fm = fr.exec(body))) friends.push(fm[1] === 'all' ? 'all' : fm[1]);
    const er = /<enemy\s+name="([^"]+)"/g; let em; while ((em = er.exec(body))) { friends.push(em[1] === 'all' ? 'all' : em[1]); hateFriends = true; }
    if (!items.length && !look) continue; // brush vazio
    brushes.push({ name, lookid: look ? +look[1] : (items[0] && items[0].id), items: items.map((x) => x.id), itemsW: items,
      borders, optional, useOnlyOptional, zOrder, friends, hateFriends, hasOuter, hasInner, hasZilchOuter, hasZilchInner });
  }
  return brushes;
}
// accessors fiéis (ground_brush.h)
function hasOuterB(b) { return b.hasOuter || b.optional != null; }
function hasOuterZilchB(b) { return b.hasZilchOuter || b.optional != null; }
function hasInnerB(b) { return b.hasInner; }
function hasInnerZilchB(b) { return b.hasZilchInner; }
function hasOptionalB(b) { return b.optional != null; }
function friendOf(a, b) { const found = a.friends.some((f) => f === b.name || f === 'all'); return found ? !a.hateFriends : a.hateFriends; }
// getBrushTo(first,second) — porta exata de GroundBrush::getBrushTo. Retorna BorderBlock ou null.
function getBrushTo(first, second) {
  if (first) {
    if (second) {
      if (first.zOrder < second.zOrder && hasOuterB(second)) {
        if (hasInnerB(first)) for (const bb of first.borders) { if (bb.outer) continue; if (bb.to === second.name || bb.to === 'all') return bb; }
        for (const bb of second.borders) { if (!bb.outer) continue; if (bb.to === first.name) return bb; if (bb.to === 'all') return bb; }
      } else if (hasInnerB(first)) {
        for (const bb of first.borders) { if (bb.outer) continue; if (bb.to === second.name) return bb; if (bb.to === 'all') return bb; }
      }
    } else if (hasInnerZilchB(first)) {
      for (const bb of first.borders) { if (bb.outer) continue; if (bb.to === 'none') return bb; }
    }
  } else if (second && hasOuterZilchB(second)) {
    for (const bb of second.borders) { if (!bb.outer) continue; if (bb.to === 'none') return bb; }
  }
  return null;
}

// walls.xml → brushes de parede {name, lookid, walls:{horizontal,vertical,pole,corner}, itemSet}
function parseWalls(xml) {
  const out = []; const re = /<brush\s+name="([^"]+)"\s+type="wall"([^>]*?)>([\s\S]*?)<\/brush>/g; let m;
  while ((m = re.exec(xml))) {
    const name = m[1]; const look = m[2].match(/server_lookid="(\d+)"/); const body = m[3];
    const walls = {}; const itemSet = new Set(); const doors = {}; // doors[orient][type] = id
    const wr = /<wall\s+type="(\w+)">([\s\S]*?)<\/wall>/g; let wm;
    while ((wm = wr.exec(body))) { const orient = wm[1]; const ids = []; const ir = /<item\s+id="(\d+)"/g; let im; while ((im = ir.exec(wm[2]))) { ids.push(+im[1]); itemSet.add(+im[1]); }
      const dr = /<door\s+id="(\d+)"(?:\s+type="(\w+)")?/g; let dm; while ((dm = dr.exec(wm[2]))) { const id = +dm[1]; const ty = dm[2] || 'normal'; itemSet.add(id); (doors[orient] = doors[orient] || {})[ty] = id; }
      walls[orient] = ids; }
    out.push({ name, lookid: look ? +look[1] : 0, walls, itemSet, doors });
  }
  return out;
}
// doodads.xml → {name, lookid, singles:[ids], composites:[[{dx,dy,id}]]}
function parseDoodads(xml) {
  const out = []; const re = /<brush\s+name="([^"]+)"\s+type="doodad"([^>]*?)>([\s\S]*?)<\/brush>/g; let m;
  while ((m = re.exec(xml))) {
    const name = m[1]; const look = m[2].match(/server_lookid="(\d+)"/); const body = m[3];
    const singles = []; const composites = [];
    // composites primeiro (e remove do body p/ não pegar os itens deles como singles)
    let rest = body; const cr = /<composite[^>]*>([\s\S]*?)<\/composite>/g; let cm;
    while ((cm = cr.exec(body))) { const tiles = []; const tr = /<tile\s+x="(-?\d+)"\s+y="(-?\d+)">\s*<item\s+id="(\d+)"/g; let tm; while ((tm = tr.exec(cm[1]))) tiles.push({ dx: +tm[1], dy: +tm[2], id: +tm[3] }); if (tiles.length) composites.push(tiles); }
    rest = body.replace(/<composite[^>]*>[\s\S]*?<\/composite>/g, '');
    const ir = /<item\s+id="(\d+)"/g; let im; while ((im = ir.exec(rest))) singles.push(+im[1]);
    out.push({ name, lookid: look ? +look[1] : (singles[0] || 0), singles, composites });
  }
  return out;
}
// carpets: <brush type="carpet"> <carpet align="n|e|s|.." id=N/> ... align center
function parseCarpets(xml) {
  const out = []; const re = /<brush\s+name="([^"]+)"\s+type="carpet"([^>]*?)>([\s\S]*?)<\/brush>/g; let m;
  while ((m = re.exec(xml))) {
    const name = m[1]; const look = m[2].match(/server_lookid="(\d+)"/); const body = m[3];
    const aligns = {}; const allIds = new Set();
    const cr = /<carpet\s+align="(\w+)"\s+id="(\d+)"/g; let cm;
    while ((cm = cr.exec(body))) { aligns[cm[1]] = +cm[2]; allIds.add(+cm[2]); }
    if (!Object.keys(aligns).length) continue;
    out.push({ name, lookid: look ? +look[1] : (aligns.center || 0), aligns, allIds });
  }
  return out;
}
// tables: <brush type="table"> <table align="north|vertical|.."> <item id chance/> </table>
function parseTables(xml) {
  const out = []; const re = /<brush\s+name="([^"]+)"\s+type="table"([^>]*?)>([\s\S]*?)<\/brush>/g; let m;
  while ((m = re.exec(xml))) {
    const name = m[1]; const look = m[2].match(/server_lookid="(\d+)"/); const body = m[3];
    const aligns = {}; const allIds = new Set();
    const tr = /<table\s+align="(\w+)"\s*>([\s\S]*?)<\/table>/g; let tm;
    while ((tm = tr.exec(body))) { const items = []; const ir = /<item\s+id="(\d+)"(?:\s+chance="(\d+)")?/g; let im; while ((im = ir.exec(tm[2]))) { items.push({ id: +im[1], chance: im[2] ? +im[2] : 10 }); allIds.add(+im[1]); } aligns[tm[1]] = items; }
    if (!Object.keys(aligns).length) continue;
    out.push({ name, lookid: look ? +look[1] : 0, aligns, allIds });
  }
  return out;
}
function parseCreatures(xml) {
  const out = []; const re = /<creature\s+name="([^"]+)"[^>]*?looktype="(\d+)"/g; let m;
  while ((m = re.exec(xml))) out.push({ name: m[1], looktype: +m[2] });
  return out;
}
// tilesets.xml → { terrain:{tilesetName:[brushNames]}, doodad:{...}, raw:{tilesetName:[itemIds]}, order:[names] }
function parseTilesets(xml) {
  const out = { terrain: {}, doodad: {}, raw: {}, order: [] };
  const tre = /<tileset\s+name="([^"]+)"\s*>([\s\S]*?)<\/tileset>/g; let tm;
  while ((tm = tre.exec(xml))) {
    const name = tm[1], body = tm[2]; if (!out.order.includes(name)) out.order.push(name);
    for (const sec of ['terrain', 'doodad']) {
      const sm = body.match(new RegExp('<' + sec + '>([\\s\\S]*?)</' + sec + '>'));
      if (sm) { const arr = (out[sec][name] = out[sec][name] || []);
        // captura <brush name> (string) E <item id/fromid-toid> (number) NA ORDEM — RME mistura os dois
        const re = /<brush\s+name="([^"]+)"|<item\s+(?:id="(\d+)"|fromid="(\d+)"(?:\s+toid="(\d+)")?)/g; let mm;
        while ((mm = re.exec(sm[1]))) { if (mm[1]) arr.push(mm[1]); else if (mm[2]) arr.push(+mm[2]); else { const a = +mm[3], b = mm[4] ? +mm[4] : a; for (let i = a; i <= b && i - a < 500; i++) arr.push(i); } }
      }
    }
    const rm = body.match(/<raw>([\s\S]*?)<\/raw>/);
    if (rm) { const arr = (out.raw[name] = out.raw[name] || []); const ir = /<item\s+(?:id="(\d+)"|fromid="(\d+)"(?:\s+toid="(\d+)")?)/g; let im; while ((im = ir.exec(rm[1]))) { if (im[1]) arr.push(+im[1]); else { const a = +im[2], b = im[3] ? +im[3] : a; for (let i = a; i <= b && i - a < 65536; i++) arr.push(i); } } } // range completo (era cap de 500 → cortava o "Others")
  }
  return out;
}

// carrega todos os materiais de uma pasta (data/<ver>/)
// monta o objeto final de brushes a partir dos XMLs já parseados (comum aos 2 loaders)
function _build(dir, borders, brushes, walls, doodads, carpets, tables, creatures, tilesets) {
  const byName = new Map(); const groundToBrush = new Map();
  for (const b of brushes) { byName.set(b.name, b); for (const id of b.items) if (!groundToBrush.has(id)) groundToBrush.set(id, b.name); if (b.lookid && !groundToBrush.has(b.lookid)) groundToBrush.set(b.lookid, b.name); }
  // borderItemSet = TODOS os ids de itens de borda (limpeza = cleanBorders fiel do RME)
  const borderItemSet = new Set();
  for (const edges of borders.values()) for (const id of Object.values(edges)) borderItemSet.add(id);
  const wallByName = new Map(); for (const w of walls) wallByName.set(w.name, w);
  const doodadByName = new Map(); for (const d of doodads) doodadByName.set(d.name, d);
  const carpetByName = new Map(); for (const c of carpets) carpetByName.set(c.name, c);
  const tableByName = new Map(); for (const t of tables) tableByName.set(t.name, t);
  return { dir, borders, brushes, byName, groundToBrush, walls, wallByName, doodads, doodadByName, carpets, carpetByName, tables, tableByName, creatures, tilesets, borderItemSet };
}

// segue <include file="..."/> RECURSIVO a partir de um .xml, concatenando todo o conteúdo.
// (Canary: materials.xml → borders.xml/brushs.xml/tilesets.xml → borders/*.xml, brushs/*.xml)
function collectIncludes(rootFile, _seen) {
  _seen = _seen || new Set();
  const abs = path.resolve(rootFile);
  if (_seen.has(abs)) return ''; _seen.add(abs);
  let xml; try { xml = fs.readFileSync(abs, 'latin1'); } catch (e) { return ''; }
  const baseDir = path.dirname(abs);
  return xml.replace(/<include\s+file\s*=\s*"([^"]+)"\s*\/?>/gi, (m, f) => '\n' + collectIncludes(path.join(baseDir, f), _seen) + '\n');
}

// loader CLÁSSICO: arquivos soltos na pasta (grounds.xml/walls.xml/...)
function load(dir) {
  const rd = (f) => { const p = path.join(dir, f); return fs.existsSync(p) ? fs.readFileSync(p, 'latin1') : null; };
  const gx = rd('grounds.xml'); if (!gx) throw new Error('grounds.xml não achado em ' + dir);
  const borders = parseBorders(rd('borders.xml') || '');
  // grounds/walls/doodads.xml MISTURAM todos os tipos de brush — parseia cada tipo dos 3 juntos
  const allMat = gx + '\n' + (rd('walls.xml') || '') + '\n' + (rd('doodads.xml') || '');
  return _build(dir, borders, parseGrounds(allMat), parseWalls(allMat), parseDoodads(allMat), parseCarpets(allMat), parseTables(allMat), parseCreatures(rd('creatures.xml') || ''), parseTilesets(rd('tilesets.xml') || ''));
}

// loader CANARY/novo: materials.xml com <include> aninhados. Concatena TUDO e parseia por tag
// (cada parser pega só as suas tags: parseBorders→<border>, parseGrounds→<brush>, parseTilesets→<tileset>).
function loadFromMaterials(materialsPath) {
  const all = collectIncludes(materialsPath);
  if (!all.trim()) throw new Error('materials.xml vazio/não lido: ' + materialsPath);
  return _build(path.dirname(materialsPath), parseBorders(all), parseGrounds(all), parseWalls(all), parseDoodads(all), parseCarpets(all), parseTables(all), parseCreatures(all), parseTilesets(all));
}

// ---- wall brush (auto-walling) — porta FIEL de wall_border_calculator.cpp ----
// tiledata 4-bit (vizinhos da MESMA wall): N=1 W=2 E=4 S=8
const WALL_FULL = (function () { const N = 1, W = 2, E = 4, S = 8; const t = new Array(16).fill(0);
  t[0] = 0/*pole*/; t[N] = 1/*south end*/; t[W] = 2/*east end*/; t[N | W] = 3/*corner=NW diag*/; t[E] = 4/*west end*/; t[N | E] = 5/*NE diag*/; t[W | E] = 6/*horizontal*/; t[N | W | E] = 7/*south T*/; t[S] = 8/*north end*/; t[N | S] = 9/*vertical*/; t[W | S] = 10/*SW diag*/; t[N | W | S] = 11/*east T*/; t[E | S] = 12/*SE diag*/; t[N | E | S] = 13/*west T*/; t[W | E | S] = 14/*north T*/; t[N | W | E | S] = 15/*intersection*/; return t; })();
const WALL_HALF = (function () { const N = 1, W = 2; const t = new Array(16).fill(0); for (let i = 0; i < 16; i++) { const b = i & (N | W); t[i] = b === (N | W) ? 3 : b === N ? 9 : b === W ? 6 : 0; } return t; })();
// WALL_ alignment → string de tipo do walls.xml
const WALL_ALIGN_TYPE = { 0: 'pole', 1: 'south end', 2: 'east end', 3: 'corner', 4: 'west end', 5: 'northeast diagonal', 6: 'horizontal', 7: 'south T', 8: 'north end', 9: 'vertical', 10: 'southwest diagonal', 11: 'east T', 12: 'southeast diagonal', 13: 'west T', 14: 'north T', 15: 'intersection' };
function wallSegment(bd, x, y, z, wall) {
  const same = (nx, ny) => { const nb = bd._st.map.get(nx + ',' + ny + ',' + z); if (!nb) return false; for (const id of OTBM.itemsOf(nb)) if (wall.itemSet.has(OTBM.itemId(id))) return true; return false; };
  const td = (same(x, y - 1) ? 1 : 0) | (same(x - 1, y) ? 2 : 0) | (same(x + 1, y) ? 4 : 0) | (same(x, y + 1) ? 8 : 0);
  const pick = (bt) => { const ids = wall.walls[WALL_ALIGN_TYPE[bt]]; return ids && ids.length ? ids[0] : null; };
  let id = pick(WALL_FULL[td]); if (id == null) id = pick(WALL_HALF[td]); // full → cai p/ half (só pole/h/v/corner)
  if (id == null) { const ids = wall.walls.pole || wall.walls.horizontal || wall.walls.vertical || Object.values(wall.walls)[0]; id = ids && ids[0]; }
  return id;
}
function paintWall(bd, st, x, y, z, wallName) {
  const wall = bd.wallByName.get(wallName); if (!wall) return; bd._st = st;
  const apply = (xx, yy) => { const tn = st.map.get(xx + ',' + yy + ',' + z); const isWall = tn && OTBM.itemsOf(tn).some((id) => wall.itemSet.has(OTBM.itemId(id)));
    if (xx === x && yy === y || isWall) { const seg = wallSegment(bd, xx, yy, z, wall); if (seg == null) return; const t = OTBM.ensureTile(st, xx, yy, z); for (const id of wall.itemSet) OTBM.removeItemId(st, t, id); t.children.push({ type: 6, props: itemBuf(seg), children: [] }); } };
  apply(x, y); apply(x - 1, y); apply(x + 1, y); apply(x, y - 1); apply(x, y + 1);
  st._dirty = true;
}
// ---- doodad brush ----
let _seed = 1; function rnd(n) { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed % n; }
function paintDoodad(bd, st, x, y, z, name, variant) {
  const d = bd.doodadByName.get(name); if (!d) return;
  if (d.composites.length) { const i = variant != null ? (variant % d.composites.length) : rnd(d.composites.length); const c = d.composites[i]; for (const t of c) { const tile = OTBM.ensureTile(st, x + t.dx, y + t.dy, z); tile.children.push({ type: 6, props: itemBuf(t.id), children: [] }); } }
  else if (d.singles.length) { const i = variant != null ? (variant % d.singles.length) : rnd(d.singles.length); OTBM.ensureTile(st, x, y, z).children.push({ type: 6, props: itemBuf(d.singles[i]), children: [] }); }
  st._dirty = true;
}

// ---- tabela de auto-border do RME (porta de ground_brush_arrays.cpp) ----
// bits dos vizinhos: NW=1 N=2 NE=4 W=8 E=16 SW=32 S=64 SE=128 (TileAlignement)
// BorderType: 1=n 2=e 3=s 4=w 5=cnw 6=cne 7=csw 8=cse 9=dnw 10=dne 11=dse 12=dsw
const BORDER_EDGE = { 1: 'n', 2: 'e', 3: 's', 4: 'w', 5: 'cnw', 6: 'cne', 7: 'csw', 8: 'cse', 9: 'dnw', 10: 'dne', 11: 'dse', 12: 'dsw' };
const BORDER_TABLE = (function () {
  const N = 2, S = 64, E = 16, W = 8, NW = 1, NE = 4, SW = 32, SE = 128;
  const t = new Array(256).fill(0);
  for (let i = 0; i < 256; i++) {
    let result = 0, shift = 0; const add = (v) => { result |= (v << (shift * 8)); shift++; };
    const hn = !!(i & N), hs = !!(i & S), he = !!(i & E), hw = !!(i & W);
    const nw = hn && hw && !hs && !he, ne = hn && he && !hs && !hw, sw = hs && hw && !hn && !he, se = hs && he && !hn && !hw;
    let nu = false, su = false, eu = false, wu = false;
    if (nw) { add(9); nu = wu = true; } if (ne) { add(10); nu = eu = true; }
    if (sw) { add(12); su = wu = true; } if (se) { add(11); su = eu = true; }
    if (hn && !nu) add(1); if (hs && !su) add(3); if (he && !eu) add(2); if (hw && !wu) add(4);
    if ((i & NW) && !hn && !hw) add(5); if ((i & NE) && !hn && !he) add(6);
    if ((i & SW) && !hs && !hw) add(7); if ((i & SE) && !hs && !he) add(8);
    t[i] = result >>> 0;
  }
  return t;
})();

// ---- carpet_types (porta de carpet_brush_arrays.cpp) → 1 align por tiledata ----
const CARPET_ALIGN = { 0: 'center', 1: 'n', 2: 'e', 3: 's', 4: 'w', 5: 'cnw', 6: 'cne', 7: 'csw', 8: 'cse', 9: 'dnw', 10: 'dne', 11: 'dse', 12: 'dsw' };
const CARPET_TABLE = (function () {
  const N = 2, S = 64, E = 16, W = 8, NW = 1, NE = 4, SW = 32, SE = 128;
  const NH = 1, EH = 2, SH = 3, WH = 4, CNW = 5, CNE = 6, CSW = 7, CSE = 8, DNW = 9, DNE = 10, DSE = 11, DSW = 12, CTR = 0;
  const t = new Array(256).fill(0);
  for (let i = 0; i < 256; i++) {
    const nw = !!(i & NW), n = !!(i & N), ne = !!(i & NE), w = !!(i & W), e = !!(i & E), sw = !!(i & SW), s = !!(i & S), se = !!(i & SE);
    let v;
    if (n && s && e && w) { const md = (!nw) + (!ne) + (!sw) + (!se); if (md === 1) { v = !nw ? DSE : !ne ? DSW : !sw ? DNE : DNW; } else v = CTR; }
    else if (n && s && w) { v = (sw && nw) ? WH : sw ? CSW : nw ? CNW : WH; }
    else if (n && s && e) { v = EH; }
    else if (n && w && e) { v = sw ? CNW : NH; }
    else if (s && w && e) { v = SH; }
    else if (n && w) v = CNW;
    else if (n && e) v = CNE;
    else if (s && w) v = CSW;
    else if (s && e) v = CSE;
    else if (n && s) { v = (nw && sw) ? WH : nw ? CNW : sw ? CSW : ne ? CNE : se ? CSE : CTR; }
    else if (w && e) { const ns = nw || ne, ss = sw || se; v = (sw && e && w) ? CSW : (ns && ss) ? CTR : ns ? NH : ss ? SH : CTR; }
    else if (n) { v = nw ? CNW : ne ? CNE : sw ? CSW : se ? CSE : CTR; }
    else if (s) { v = sw ? CSW : se ? CSE : nw ? CNW : ne ? CNE : CSW; }
    else if (w) { v = nw ? WH : sw ? CSW : se ? SH : CTR; }
    else if (e) { v = nw ? CNE : ne ? CNE : se ? SH : CTR; }
    else { v = (nw && ne) ? NH : (sw && se) ? SH : (nw && sw) ? WH : (ne && se) ? EH : ne ? CNE : se ? CSE : sw ? CSW : CTR; }
    t[i] = v;
  }
  return t;
})();
// ---- table_types (porta de table_brush_arrays.cpp) — só N/S/E/W ----
const TABLE_TABLE = (function () {
  const N = 2, S = 64, E = 16, W = 8; const t = new Array(256).fill('alone');
  for (let i = 0; i < 256; i++) {
    const hn = !!(i & N), hs = !!(i & S), he = !!(i & E), hw = !!(i & W);
    if (hn && hs && !he && !hw) t[i] = 'vertical';
    else if (he && hw && !hn && !hs) t[i] = 'horizontal';
    else if (hn && !hs && !he && !hw) t[i] = 'south';
    else if (hs && !hn && !he && !hw) t[i] = 'north';
    else if (he && !hw && !hn && !hs) t[i] = 'west';
    else if (hw && !he && !hn && !hs) t[i] = 'east';
    else t[i] = 'alone';
  }
  return t;
})();
let _crpSeed = 7; function crpRand(n) { _crpSeed = (_crpSeed * 1103515245 + 12345) & 0x7fffffff; return _crpSeed % n; }
function tableTiledata(st, x, y, z, allIds) { let td = 0; for (let k = 0; k < 8; k++) { const [dx, dy] = OFF[k]; const t = st.map.get((x + dx) + ',' + (y + dy) + ',' + z); if (!t) continue; for (const c of t.children) if (c.type === 6 && allIds.has(c.props.readUInt16LE(0))) { td |= (1 << k); break; } } return td; }
function recomputeCarpet(bd, st, x, y, z, carpet) {
  const tn = st.map.get(x + ',' + y + ',' + z); if (!tn) return;
  let has = false; for (const c of tn.children) if (c.type === 6 && carpet.allIds.has(c.props.readUInt16LE(0))) { has = true; break; }
  if (!has) return;
  const td = tableTiledata(st, x, y, z, carpet.allIds); const align = CARPET_ALIGN[CARPET_TABLE[td]]; const id = carpet.aligns[align] || carpet.aligns.center; if (!id) return;
  for (const c of tn.children) if (c.type === 6 && carpet.allIds.has(c.props.readUInt16LE(0))) c.props.writeUInt16LE(id, 0);
}
function paintCarpet(bd, st, x, y, z, name) {
  const carpet = bd.carpetByName.get(name); if (!carpet) return;
  const tn = OTBM.ensureTile(st, x, y, z);
  for (const idr of carpet.allIds) OTBM.removeItemId(st, tn, idr);
  tn.children.push({ type: 6, props: itemBuf(carpet.aligns.center || carpet.lookid), children: [] });
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) recomputeCarpet(bd, st, x + dx, y + dy, z, carpet);
  st._dirty = true;
}
function recomputeTable(bd, st, x, y, z, table) {
  const tn = st.map.get(x + ',' + y + ',' + z); if (!tn) return;
  let has = false; for (const c of tn.children) if (c.type === 6 && table.allIds.has(c.props.readUInt16LE(0))) { has = true; break; }
  if (!has) return;
  const td = tableTiledata(st, x, y, z, table.allIds); const align = TABLE_TABLE[td]; const grp = table.aligns[align] || table.aligns.alone || table.aligns.vertical; if (!grp || !grp.length) return;
  const id = grp[crpRand(grp.length)].id;
  for (const c of tn.children) if (c.type === 6 && table.allIds.has(c.props.readUInt16LE(0))) c.props.writeUInt16LE(id, 0);
}
function paintTable(bd, st, x, y, z, name) {
  const table = bd.tableByName.get(name); if (!table) return;
  const tn = OTBM.ensureTile(st, x, y, z);
  for (const idr of table.allIds) OTBM.removeItemId(st, tn, idr);
  const al = table.aligns.alone || table.aligns.vertical || Object.values(table.aligns)[0];
  tn.children.push({ type: 6, props: itemBuf(al[0].id), children: [] });
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) recomputeTable(bd, st, x + dx, y + dy, z, table);
  st._dirty = true;
}
// coloca os edges de UM border (alignment 8-bit → border_types → até 4 edges) no tile
function placeBorderEdges(tn, border, alignment) {
  const packed = BORDER_TABLE[alignment];
  for (let sh = 0; sh < 4; sh++) { const eid = (packed >>> (sh * 8)) & 0xFF; if (!eid) break; const edge = BORDER_EDGE[eid]; if (border[edge]) tn.children.push({ type: 6, props: itemBuf(border[edge]), children: [] }); }
}
// offsets RME (ordem fixa): índice i → bit (1<<i). NW,N,NE,W,E,SW,S,SE
const OFF = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
// remove TODOS os itens de borda do tile (cleanBorders fiel)
function clearBorders(tn, borderItemSet) {
  if (!tn.children || !tn.children.length) return;
  tn.children = tn.children.filter((c) => !(c.type === 6 && c.props && c.props.length >= 2 && borderItemSet.has(c.props.readUInt16LE(0))));
}
// porta FIEL de GroundBorderCalculator::calculate — recalcula bordas de UM tile (até void)
function recomputeTile(brushData, st, x, y, z) {
  const tn = st.map.get(x + ',' + y + ',' + z); if (!tn) return;
  const B = brushData.byName, G = brushData.groundToBrush;
  const gid = OTBM.getGround(tn); const bn = gid ? (G.get(gid) || null) : null;
  const borderBrush = bn ? B.get(bn) : null;
  const opFlag = true; // optional/mountain habilitado (RME usa flag por-tile via ferramenta; aqui sempre on)
  // vizinhos: {visited, brush}
  const nb = OFF.map(([dx, dy]) => { const t = st.map.get((x + dx) + ',' + (y + dy) + ',' + z); const ng = t ? OTBM.getGround(t) : 0; const nn = ng ? (G.get(ng) || null) : null; return { visited: false, brush: nn ? B.get(nn) : null }; });
  const list = []; // {alignment, z, border:id}
  const addB = (id, td, zz, force) => { for (const c of list) { if (c.border === id) { c.alignment |= td; if (force) c.z = zz; else if (c.z < zz) c.z = zz; return; } } list.push({ alignment: td, z: zz, border: id }); };
  for (let i = 0; i < 8; i++) {
    if (nb[i].visited) continue;
    const other = nb[i].brush;
    if (borderBrush) {
      if (other) {
        if (other !== borderBrush) {
          if (hasOuterB(other) || hasInnerB(borderBrush)) {
            let only_mountain = false, skip = false;
            if (friendOf(other, borderBrush) || friendOf(borderBrush, other)) { if (!hasOptionalB(other)) skip = true; else only_mountain = true; }
            if (!skip) {
              let td = 0; for (let j = i; j < 8; j++) { if (!nb[j].visited && nb[j].brush === other) { nb[j].visited = true; td |= (1 << j); } }
              if (td) {
                if (hasOptionalB(other) && opFlag) addB(other.optional, td, 0x7FFFFFFF);
                if (!only_mountain) { const bb = getBrushTo(borderBrush, other); if (bb) addB(bb.autoborder, td, other.zOrder); }
              }
            }
            if (skip) continue;
          }
        } else { continue; }
        // borda contra o nada (vizinhos vazios restantes)
        let td2 = 0; for (let j = i; j < 8; j++) { if (!nb[j].visited && !nb[j].brush) { nb[j].visited = true; td2 |= (1 << j); } }
        if (td2) { const bb = getBrushTo(borderBrush, null); if (bb) addB(bb.autoborder, td2, -1000, true); }
        continue;
      } else {
        let td2 = 0; for (let j = i; j < 8; j++) { if (!nb[j].visited && !nb[j].brush) { nb[j].visited = true; td2 |= (1 << j); } }
        if (td2) { const bb = getBrushTo(borderBrush, null); if (bb) addB(bb.autoborder, td2, -1000, true); }
        continue;
      }
    } else if (other && hasOuterZilchB(other)) {
      let td = 0; for (let j = i; j < 8; j++) { if (!nb[j].visited && nb[j].brush === other) { nb[j].visited = true; td |= (1 << j); } }
      if (td) { const bb = getBrushTo(null, other); if (bb) addB(bb.autoborder, td, other.zOrder); if (hasOptionalB(other) && opFlag) addB(other.optional, td, 0x7FFFFFFF); }
    }
  }
  clearBorders(tn, brushData.borderItemSet);
  list.sort((a, b) => a.z - b.z); // z-order crescente; aplica do menor → topo (RME aplica do fim p/ início = maior z primeiro? não: pop_back = maior z primeiro)
  // RME: ordena asc e aplica de trás p/ frente (pop_back) → maior z aplicado PRIMEIRO. Replicamos:
  for (let k = list.length - 1; k >= 0; k--) { const c = list[k]; const border = brushData.borders.get(c.border); if (border) placeBorderEdges(tn, border, c.alignment); }
}
function tileEmpty(tn) { return tn && !OTBM.getGround(tn) && !tn.children.some((c) => c.type === 6) && tn.type !== 14; }
// recalcula as bordas de um tile DO JEITO CERTO: garante os 8 vizinhos (p/ receberem outer border),
// recalcula o 3x3 e limpa os vizinhos que ficaram vazios. (sem isso, as bordas — que ficam nos tiles
// vizinhos — nunca apareciam ao usar a ferramenta BORDER avulsa)
function borderize(brushData, st, x, y, z) {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (dx === 0 && dy === 0) continue; OTBM.ensureTile(st, x + dx, y + dy, z); }
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) recomputeTile(brushData, st, x + dx, y + dy, z);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (dx === 0 && dy === 0) continue; const k = (x + dx) + ',' + (y + dy) + ',' + z; const t = st.map.get(k); if (tileEmpty(t)) OTBM.setTile(st, k, null); }
}
function itemBuf(id) { const p = Buffer.alloc(2); p.writeUInt16LE(id & 0xFFFF, 0); return p; }

// remove itens-filho que são de CHÃO (sand/grass colocados via RAW) — o ground brush os substitui
// (igual RME: item de chão vira o ground do tile, não fica empilhado por cima escondendo o novo)
function cleanGroundItems(brushData, st, x, y, z) {
  const tn = st.map.get(x + ',' + y + ',' + z); if (!tn || !tn.children || !brushData.groundToBrush) return;
  for (const c of [...tn.children]) { if (c.type === 6) { const id = c.props.readUInt16LE(0); if (brushData.groundToBrush.has(id)) OTBM.removeItemId(st, tn, id); } }
}
// pinta o ground do brush no tile e re-borda ele + 8 vizinhos (cria vazios p/ receber outer border)
function paintGround(brushData, st, x, y, z, brushName) {
  const brush = brushData.byName.get(brushName); if (!brush) return;
  cleanGroundItems(brushData, st, x, y, z); // tira sand/grass colocado via RAW (item-filho de chão) → novo chão fica visível (igual RME Tile::addItem)
  OTBM.setGround(st, x, y, z, (brush.items && brush.items[0]) || brush.lookid); // item de chão real
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy;
    if (!(dx === 0 && dy === 0)) OTBM.ensureTile(st, nx, ny, z); // vizinho vazio recebe outer border
    recomputeTile(brushData, st, nx, ny, z);
  }
  // limpa vizinhos que ficaram totalmente vazios (sem ground e sem borda)
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (dx === 0 && dy === 0) continue; const k = (x + dx) + ',' + (y + dy) + ',' + z; const t = st.map.get(k); if (tileEmpty(t)) OTBM.setTile(st, k, null); }
}

// apaga ground+itens+bordas do tile e re-borda 8 vizinhos (cura as bordas em volta)
function eraseTile(brushData, st, x, y, z) {
  const tn = st.map.get(x + ',' + y + ',' + z); if (!tn) return;
  OTBM.setGround(st, x, y, z, 0); // tira chão
  tn.children = tn.children.filter((c) => c.type !== 6); // tira todos itens/bordas
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) recomputeTile(brushData, st, x + dx, y + dy, z);
  const t2 = st.map.get(x + ',' + y + ',' + z); if (tileEmpty(t2)) OTBM.setTile(st, x + ',' + y + ',' + z, null);
}
// porta de door brush: converte a parede do tile numa porta do tipo escolhido (orientação da parede)
function paintDoor(brushData, st, x, y, z, wallName, doorType) {
  const wall = brushData.wallByName.get(wallName); if (!wall || !wall.doors) return;
  const tn = OTBM.ensureTile(st, x, y, z);
  // detecta orientação pela parede presente (ou vizinhos)
  let orient = null;
  for (const c of tn.children) { if (c.type !== 6) continue; const id = c.props.readUInt16LE(0); for (const o of Object.keys(wall.walls)) if (wall.walls[o].includes(id)) { orient = o; break; } if (orient) break; }
  if (!orient) { const w = same(st, x - 1, y, z, wall) || same(st, x + 1, y, z, wall); orient = w ? 'horizontal' : 'vertical'; }
  const set = wall.doors[orient] || wall.doors.horizontal || wall.doors.vertical; if (!set) return;
  const id = set[doorType] || set.normal || Object.values(set)[0]; if (!id) return;
  for (const idr of wall.itemSet) OTBM.removeItemId(st, tn, idr); // tira parede/porta antiga
  tn.children.push({ type: 6, props: itemBuf(id), children: [] });
  st._dirty = true;
}
function same(st, x, y, z, wall) { const nb = st.map.get(x + ',' + y + ',' + z); if (!nb) return false; for (const id of OTBM.itemsOf(nb)) if (wall.itemSet.has(OTBM.itemId(id))) return true; return false; }
// Ctrl+arrastar: apaga só os itens do brush atual + re-tila os vizinhos (igual RME undraw)
function eraseWall(bd, st, x, y, z, name) {
  const wall = bd.wallByName.get(name); if (!wall) return; bd._st = st;
  const tn = st.map.get(x + ',' + y + ',' + z); if (!tn) return;
  for (const id of wall.itemSet) OTBM.removeItemId(st, tn, id);
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { const nx = x + dx, ny = y + dy; const t2 = st.map.get(nx + ',' + ny + ',' + z); if (t2 && OTBM.itemsOf(t2).some((id) => wall.itemSet.has(OTBM.itemId(id)))) { const seg = wallSegment(bd, nx, ny, z, wall); if (seg != null) { for (const id of wall.itemSet) OTBM.removeItemId(st, t2, id); t2.children.push({ type: 6, props: itemBuf(seg), children: [] }); } } }
  if (tileEmpty(tn)) OTBM.setTile(st, x + ',' + y + ',' + z, null); st._dirty = true;
}
function eraseSet(bd, st, x, y, z, allIds, recompute) {
  const tn = st.map.get(x + ',' + y + ',' + z); if (!tn) return;
  for (const id of allIds) OTBM.removeItemId(st, tn, id);
  if (recompute) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) recompute(bd, st, x + dx, y + dy, z);
  if (tileEmpty(tn)) OTBM.setTile(st, x + ',' + y + ',' + z, null); st._dirty = true;
}
function eraseCarpet(bd, st, x, y, z, name) { const c = bd.carpetByName.get(name); if (c) eraseSet(bd, st, x, y, z, c.allIds, (b, s, X, Y, Z) => recomputeCarpet(b, s, X, Y, Z, c)); }
function eraseTable(bd, st, x, y, z, name) { const t = bd.tableByName.get(name); if (t) eraseSet(bd, st, x, y, z, t.allIds, (b, s, X, Y, Z) => recomputeTable(b, s, X, Y, Z, t)); }
function eraseDoodad(bd, st, x, y, z, name) { const d = bd.doodadByName.get(name); if (!d) return; const ids = new Set([...d.singles, ...d.composites.flat().map((t) => t.id)]); eraseSet(bd, st, x, y, z, ids, null); }

module.exports = { load, loadFromMaterials, collectIncludes, paintGround, cleanGroundItems, recomputeTile, borderize, paintWall, paintDoodad, paintDoor, paintCarpet, paintTable, eraseTile, eraseWall, eraseCarpet, eraseTable, eraseDoodad, BORDER_TABLE, CARPET_TABLE, TABLE_TABLE };
