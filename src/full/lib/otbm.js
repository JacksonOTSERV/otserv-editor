// Parser + writer do mapa .otbm (OpenTibia Binary Map) — árvore binária (0xFE/0xFF/0xFD).
// Preserva a árvore COMPLETA (props crus por nó) p/ salvar lossless, + índices p/ render/editar.
const fs = require('fs');

const NODE_START = 0xFE, NODE_END = 0xFF, ESCAPE = 0xFD;
const OTBM_MAP_DATA = 2, OTBM_TILE_AREA = 4, OTBM_TILE = 5, OTBM_ITEM = 6,
  OTBM_TOWNS = 12, OTBM_TOWN = 13, OTBM_HOUSETILE = 14, OTBM_WAYPOINTS = 15;
const ATTR_DESCRIPTION = 1, ATTR_TILE_FLAGS = 3, ATTR_EXT_SPAWN_FILE = 11, ATTR_EXT_HOUSE_FILE = 13, ATTR_ITEM = 9;

function readString(p, o) { const len = p.readUInt16LE(o); return { s: p.toString('latin1', o + 2, o + 2 + len), o: o + 2 + len }; }

// lê 1 nó (pos aponta p/ o byte de TYPE, logo após 0xFE) → {node, pos}
// otimizado: props como subarray (zero-copy) quando não há byte de escape (99% dos nós)
function readNode(b, pos) {
  const type = b[pos++];
  const start = pos; let hasEsc = false;
  while (pos < b.length) {
    const c = b[pos];
    if (c === ESCAPE) { hasEsc = true; pos += 2; continue; }
    if (c === NODE_START || c === NODE_END) break;
    pos++;
  }
  let props;
  if (!hasEsc) props = b.subarray(start, pos); // zero-copy (compartilha o buffer do arquivo)
  else { const out = []; let p = start; while (p < pos) { const c = b[p]; if (c === ESCAPE) { out.push(b[p + 1]); p += 2; } else { out.push(c); p++; } } props = Buffer.from(out); }
  const node = { type, props, children: [] };
  while (b[pos] === NODE_START) { pos++; const r = readNode(b, pos); node.children.push(r.node); pos = r.pos; }
  pos++; // consome NODE_END
  return { node, pos };
}

// lê SÓ os props de um nó (pos aponta p/ 1º byte de prop, após o TYPE) → {props, pos no NODE_START/END}
function readPropsSpan(b, pos) {
  const start = pos; let hasEsc = false;
  while (pos < b.length) { const c = b[pos]; if (c === ESCAPE) { hasEsc = true; pos += 2; continue; } if (c === NODE_START || c === NODE_END) break; pos++; }
  let props; if (!hasEsc) props = b.subarray(start, pos);
  else { const out = []; let p = start; while (p < pos) { const c = b[p]; if (c === ESCAPE) { out.push(b[p + 1]); p += 2; } else { out.push(c); p++; } } props = Buffer.from(out); }
  return { props, pos };
}
// pula a subárvore inteira SEM construir objetos (pos aponta p/ TYPE, logo após NODE_START) → pos após o NODE_END
function skipNode(b, pos) {
  pos++; // type
  while (pos < b.length) { const c = b[pos]; if (c === ESCAPE) { pos += 2; continue; } if (c === NODE_START || c === NODE_END) break; pos++; } // props
  while (b[pos] === NODE_START) pos = skipNode(b, pos + 1);
  return pos + 1; // consome NODE_END
}
// LAZY: parseia os tiles de UMA área (sob demanda) e popula st.map. Idempotente.
function ensureArea(st, area) {
  if (!area || area._parsed || !area._rawSpan) return area;
  area._parsed = true;
  const b = area._buf, s = area._rawSpan[0];
  const r = readNode(b, s + 1); // s = NODE_START; s+1 = TYPE
  area.children = r.node.children;
  const bx = area.bx, by = area.by, bz = area.bz;
  for (const tn of area.children) {
    if (tn.type !== OTBM_TILE && tn.type !== OTBM_HOUSETILE) continue;
    const x = bx + tn.props[0], y = by + tn.props[1], z = bz;
    if (tn.type === OTBM_HOUSETILE) st.houses++;
    tn._x = x; tn._y = y; tn._z = z; tn._area = area; // _area p/ remover o tile do nó certo (há bases duplicadas)
    st.map.set(x + ',' + y + ',' + z, tn);
    if (st._onTile) st._onTile(tn); // índice incremental do render (sem rebuild)
  }
  return area;
}
// garante a(s) área(s) que contêm (x,y,z) parseada(s). IMPORTANTE: pode haver VÁRIOS nós TILE_AREA com a
// MESMA base 256 (OTBM válido) → parseia TODOS (senão perde tiles → tela preta). No-op em mapas não-lazy.
function ensureAreaAt(st, x, y, z) {
  if (!st || !st._lazy || !st.lazyIndex) return;
  const lst = st.lazyIndex.get((x & 0xFF00) + ',' + (y & 0xFF00) + ',' + z);
  if (lst) for (const a of lst) if (a._rawSpan && !a._parsed) ensureArea(st, a);
}
// força TODAS as áreas parseadas (p/ operações que varrem o mapa inteiro: stats, find, export, resize…)
function ensureAll(st) { if (!st || !st._lazy || !st.mapDataNode) return; for (const a of st.mapDataNode.children) if (a.type === OTBM_TILE_AREA && a._rawSpan && !a._parsed) ensureArea(st, a); st._lazy = false; }

function readMapAttrs(p, st) {
  let o = 0;
  while (o < p.length) {
    const a = p[o++];
    if (a === ATTR_DESCRIPTION) { const r = readString(p, o); st.description = (st.description || '') + r.s + '\n'; o = r.o; }
    else if (a === ATTR_EXT_SPAWN_FILE) { const r = readString(p, o); st.spawnFile = r.s; o = r.o; }
    else if (a === ATTR_EXT_HOUSE_FILE) { const r = readString(p, o); st.houseFile = r.s; o = r.o; }
    else break;
  }
}

// ground item (ATTR_ITEM) nos props do tile, se houver → {id, s, e} (faixa de bytes do attr)
function tileGround(tn) {
  const p = tn.props; let o = (tn.type === OTBM_HOUSETILE) ? 6 : 2;
  while (o < p.length) {
    const a = p[o];
    if (a === ATTR_TILE_FLAGS) o += 5;
    else if (a === ATTR_ITEM) return { id: p.readUInt16LE(o + 1), s: o, e: o + 3 };
    else break;
  }
  return null;
}

// recalcula a lista leve de itens de um tile (ground dos props + filhos OTBM_ITEM)
function tileItems(tn) {
  const items = []; const g = tileGround(tn); if (g) items.push(g.id);
  for (const c of tn.children) if (c.type === OTBM_ITEM) items.push(c.props.readUInt16LE(0));
  return items;
}

function parseTowns(node, st) { for (const tn of node.children) if (tn.type === OTBM_TOWN) { try { const id = tn.props.readUInt32LE(0); const r = readString(tn.props, 4); st.towns.push({ id, name: r.s, x: tn.props.readUInt16LE(r.o), y: tn.props.readUInt16LE(r.o + 2), z: tn.props[r.o + 4] }); } catch (e) {} } }
function parseWaypoints(node, st) { st.waypoints = st.waypoints || []; for (const wn of node.children) { try { const r = readString(wn.props, 0); st.waypoints.push({ name: r.s, x: wn.props.readUInt16LE(r.o), y: wn.props.readUInt16LE(r.o + 2), z: wn.props[r.o + 4] }); } catch (e) {} } }

// PARSE LAZY (sob demanda): só lê a ESTRUTURA — cada TILE_AREA guarda só seu range de bytes (_rawSpan),
// sem parsear os tiles. As áreas são parseadas quando o viewport precisa (ensureAreaAt). Mapas grandes
// não travam mais (carrega só o que aparece). Save continua lossless (área não-parseada → bytes crus).
function parse(file) {
  const b = fs.readFileSync(file);
  const header = b.readUInt32LE(0);
  let pos = 4; if (b[pos] !== NODE_START) throw new Error('OTBM inválido (sem nó raiz)');
  pos++;
  const st = { header, root: null, map: new Map(), areaIndex: new Map(), lazyIndex: new Map(), zmin: 15, zmax: 0, towns: [], houses: 0, _dirty: false, _buf: b, _lazy: true };
  // --- nó raiz (raso) ---
  const rootType = b[pos++]; const rp = readPropsSpan(b, pos); pos = rp.pos;
  const root = { type: rootType, props: rp.props, children: [] }; st.root = root;
  if (root.props.length >= 16) { st.version = root.props.readUInt32LE(0); st.width = root.props.readUInt16LE(4); st.height = root.props.readUInt16LE(6); st.itemMajor = root.props.readUInt32LE(8); st.itemMinor = root.props.readUInt32LE(12); }
  // --- filhos do raiz ---
  while (b[pos] === NODE_START) {
    const childStart = pos; pos++; const childType = b[pos];
    if (childType === OTBM_MAP_DATA) {
      pos++; const mp = readPropsSpan(b, pos); pos = mp.pos;
      const md = { type: OTBM_MAP_DATA, props: mp.props, children: [] }; st.mapDataNode = md; root.children.push(md);
      readMapAttrs(md.props, st);
      // filhos do map_data: TILE_AREA (lazy) | TOWNS | WAYPOINTS
      while (b[pos] === NODE_START) {
        const nodeStart = pos; pos++; const t = b[pos];
        if (t === OTBM_TILE_AREA) {
          pos++; const ap = readPropsSpan(b, pos); pos = ap.pos;
          const props = ap.props; const bx = props.readUInt16LE(0), by = props.readUInt16LE(2), bz = props[4];
          let p2 = pos; while (b[p2] === NODE_START) p2 = skipNode(b, p2 + 1); const nodeEnd = p2 + 1; // pula tiles, consome NODE_END
          const area = { type: OTBM_TILE_AREA, props, children: [], _buf: b, _rawSpan: [nodeStart, nodeEnd], bx, by, bz, _parsed: false };
          md.children.push(area); const ak = bx + ',' + by + ',' + bz;
          let lst = st.lazyIndex.get(ak); if (!lst) { lst = []; st.lazyIndex.set(ak, lst); } lst.push(area); // base pode ter VÁRIOS nós
          if (!st.areaIndex.has(ak)) st.areaIndex.set(ak, area); // 1º nó (p/ ensureTile anexar tiles novos)
          if (bz < st.zmin) st.zmin = bz; if (bz > st.zmax) st.zmax = bz;
          pos = nodeEnd;
        } else { const r = readNode(b, pos); md.children.push(r.node); pos = r.pos; if (t === OTBM_TOWNS) parseTowns(r.node, st); else if (t === OTBM_WAYPOINTS) parseWaypoints(r.node, st); }
      }
      pos++; // NODE_END do map_data
    } else { const r = readNode(b, pos); root.children.push(r.node); pos = r.pos; }
  }
  if (st.zmin > st.zmax) { st.zmin = 7; st.zmax = 7; }
  return st;
}

// ---- writer (lossless) ----
function escapeInto(buf, out) { for (const x of buf) { if (x === NODE_START || x === NODE_END || x === ESCAPE) out.push(ESCAPE); out.push(x); } }
function writeNode(node, out) {
  if (node._rawSpan && !node._parsed) { const b = node._buf, s = node._rawSpan[0], e = node._rawSpan[1]; for (let i = s; i < e; i++) out.push(b[i]); return; } // área lazy → bytes originais (lossless, sem parsear)
  out.push(NODE_START, node.type & 0xFF); escapeInto(node.props, out); for (const ch of node.children) writeNode(ch, out); out.push(NODE_END);
}
function serialize(st) { const out = []; const h = Buffer.alloc(4); h.writeUInt32LE(st.header >>> 0, 0); out.push(h[0], h[1], h[2], h[3]); writeNode(st.root, out); return Buffer.from(out); }
function save(st, file) { fs.writeFileSync(file, serialize(st)); st._dirty = false; }

// cria um mapa OTBM vazio do zero (compatível com o editor)
function createEmpty(width, height) {
  width = Math.max(64, Math.min(60000, width || 1024)); height = Math.max(64, Math.min(60000, height || 1024));
  const rp = Buffer.alloc(16);
  rp.writeUInt32LE(2, 0); rp.writeUInt16LE(width, 4); rp.writeUInt16LE(height, 6); rp.writeUInt32LE(3, 8); rp.writeUInt32LE(57, 12);
  const mapData = { type: OTBM_MAP_DATA, props: Buffer.alloc(0), children: [] };
  const root = { type: 0, props: rp, children: [mapData] };
  return { header: 0, root, map: new Map(), areaIndex: new Map(), zmin: 7, zmax: 7, towns: [], waypoints: [], houses: 0, version: 2, width, height, itemMajor: 3, itemMinor: 57, mapDataNode: mapData, description: '', spawnFile: '', houseFile: '', _dirty: true };
}
// redimensiona (só metadados do header — tiles são esparsos)
function resize(st, width, height) { st.width = Math.max(64, Math.min(60000, width)); st.height = Math.max(64, Math.min(60000, height)); st.root.props.writeUInt16LE(st.width, 4); st.root.props.writeUInt16LE(st.height, 6); st._dirty = true; }
// ---- edição ----
function makeItemNode(id) { const p = Buffer.alloc(2); p.writeUInt16LE(id & 0xFFFF, 0); return { type: OTBM_ITEM, props: p, children: [] }; }
function ensureTile(st, x, y, z) {
  const key = x + ',' + y + ',' + z; let tn = st.map.get(key); if (tn) return tn;
  const bx = x & 0xFF00, by = y & 0xFF00, ak = bx + ',' + by + ',' + z;
  ensureAreaAt(st, x, y, z); // área(s) lazy dessa base → parseia TODAS antes de inserir
  let area = st.areaIndex.get(ak);
  if (!area) {
    const ap = Buffer.alloc(5); ap.writeUInt16LE(bx, 0); ap.writeUInt16LE(by, 2); ap[4] = z;
    area = { type: OTBM_TILE_AREA, props: ap, children: [] }; st.areaIndex.set(ak, area);
    if (st.lazyIndex) st.lazyIndex.set(ak, [area]);
    const md = st.mapDataNode; const idx = md.children.findIndex((c) => c.type === OTBM_TOWNS || c.type === OTBM_WAYPOINTS);
    if (idx < 0) md.children.push(area); else md.children.splice(idx, 0, area);
  }
  tn = { type: OTBM_TILE, props: Buffer.from([x - bx, y - by]), children: [], _x: x, _y: y, _z: z, _area: area };
  area.children.push(tn); st.map.set(key, tn); if (st._onTile) st._onTile(tn);
  if (z < st.zmin) st.zmin = z; if (z > st.zmax) st.zmax = z;
  return tn;
}
function placeItem(st, x, y, z, id) { ensureTile(st, x, y, z).children.push(makeItemNode(id)); st._dirty = true; }
function deleteTop(st, x, y, z) {
  const tn = st.map.get(x + ',' + y + ',' + z); if (!tn) return false;
  for (let i = tn.children.length - 1; i >= 0; i--) {
    if (tn.children[i].type === OTBM_ITEM) { tn.children.splice(i, 1); st._dirty = true; return true; }
  }
  const g = tileGround(tn); if (g) { tn.props = Buffer.concat([tn.props.subarray(0, g.s), tn.props.subarray(g.e)]); st._dirty = true; return true; }
  return false;
}

function itemId(slot) { return typeof slot === 'object' ? slot.id : slot; }
function itemsOf(node) { return node ? tileItems(node) : []; } // itens de um nó de tile (sob demanda)

// ---- map info (descrição / spawn file / house file) ----
function setMapInfo(st, info) {
  const parts = [];
  const pushStr = (type, s) => { const b = Buffer.from(s, 'latin1'); const d = Buffer.alloc(3 + b.length); d[0] = type; d.writeUInt16LE(b.length, 1); b.copy(d, 3); parts.push(d); };
  const desc = info.description != null ? info.description : (st.description || '');
  for (const line of String(desc).split('\n')) if (line.trim()) pushStr(1, line.trim());
  const sf = info.spawnFile != null ? info.spawnFile : st.spawnFile; if (sf) pushStr(11, sf);
  const hf = info.houseFile != null ? info.houseFile : st.houseFile; if (hf) pushStr(13, hf);
  st.mapDataNode.props = Buffer.concat(parts);
  st.description = desc; st.spawnFile = sf; st.houseFile = hf; st._dirty = true;
}
// ---- towns ----
function townsNode(st, create) { let n = st.mapDataNode.children.find((c) => c.type === 12); if (!n && create) { n = { type: 12, props: Buffer.alloc(0), children: [] }; const i = st.mapDataNode.children.findIndex((c) => c.type === 15); if (i < 0) st.mapDataNode.children.push(n); else st.mapDataNode.children.splice(i, 0, n); } return n; }
function addTown(st, id, name, x, y, z) {
  const tn = townsNode(st, true); const u32 = Buffer.alloc(4); u32.writeUInt32LE(id >>> 0, 0);
  const pos = Buffer.alloc(5); pos.writeUInt16LE(x, 0); pos.writeUInt16LE(y, 2); pos[4] = z;
  tn.children.push({ type: 13, props: Buffer.concat([u32, strBuf(name), pos]), children: [] });
  st.towns.push({ id, name, x, y, z }); st._dirty = true;
}
function removeTown(st, id) { const tn = townsNode(st, false); if (!tn) return; tn.children = tn.children.filter((c) => { try { return c.props.readUInt32LE(0) !== id; } catch (e) { return true; } }); st.towns = st.towns.filter((t) => t.id !== id); st._dirty = true; }

// ---- waypoints (árvore) ----
function strBuf(s) { const b = Buffer.from(s, 'latin1'); const d = Buffer.alloc(2 + b.length); d.writeUInt16LE(b.length, 0); b.copy(d, 2); return d; }
function waypointsNode(st, create) {
  let wn = st.mapDataNode.children.find((c) => c.type === 15);
  if (!wn && create) { wn = { type: 15, props: Buffer.alloc(0), children: [] }; st.mapDataNode.children.push(wn); }
  return wn;
}
function addWaypoint(st, name, x, y, z) {
  const wn = waypointsNode(st, true);
  const pos = Buffer.alloc(5); pos.writeUInt16LE(x, 0); pos.writeUInt16LE(y, 2); pos[4] = z;
  wn.children.push({ type: 16, props: Buffer.concat([strBuf(name), pos]), children: [] });
  st.waypoints = st.waypoints || []; st.waypoints.push({ name, x, y, z }); st._dirty = true;
}
function removeWaypointAt(st, x, y, z) {
  const wn = waypointsNode(st, false); if (!wn) return false;
  const before = wn.children.length;
  wn.children = wn.children.filter((c) => { try { const r = readString(c.props, 0); return !(c.props.readUInt16LE(r.o) === x && c.props.readUInt16LE(r.o + 2) === y && c.props[r.o + 4] === z); } catch (e) { return true; } });
  if (wn.children.length !== before) { st.waypoints = (st.waypoints || []).filter((w) => !(w.x === x && w.y === y && w.z === z)); st._dirty = true; return true; }
  return false;
}

// ---- atributos genéricos (flags de tile + props de item) ----
const ATTR_LEN = { 3: 4, 4: 2, 5: 2, 6: 'str', 7: 'str', 8: 5, 9: 2, 10: 2, 12: 1, 14: 1, 15: 1, 16: 4, 17: 1, 18: 4, 19: 'str', 20: 4, 21: 4, 22: 2 };
function parseAttrList(buf, start) {
  const list = []; let o = start;
  while (o < buf.length) {
    const t = buf[o]; const L = ATTR_LEN[t];
    if (L === undefined) return { list, tail: Buffer.from(buf.subarray(o)) };
    o++; let len; if (L === 'str') len = 2 + buf.readUInt16LE(o); else len = L;
    list.push({ type: t, data: Buffer.from(buf.subarray(o, o + len)) }); o += len;
  }
  return { list, tail: Buffer.alloc(0) };
}
function buildProps(head, list, tail) { const parts = [head]; for (const a of list) parts.push(Buffer.from([a.type]), a.data); parts.push(tail); return Buffer.concat(parts); }
function tileHeadLen(n) { return n.type === OTBM_HOUSETILE ? 6 : 2; }

function getTileFlags(node) { const p = node.props; let o = tileHeadLen(node); while (o + 1 < p.length) { const t = p[o]; if (t === 3) return p.readUInt32LE(o + 1); if (t === 9) { o += 3; continue; } break; } return 0; }
function setTileFlags(st, node, flags) {
  const head = node.props.subarray(0, tileHeadLen(node)); const r = parseAttrList(node.props, tileHeadLen(node));
  let list = r.list.filter((x) => x.type !== 3);
  if (flags) { const d = Buffer.alloc(4); d.writeUInt32LE(flags >>> 0, 0); list.unshift({ type: 3, data: d }); } // flags antes do ground
  node.props = buildProps(head, list, r.tail); st._dirty = true;
}
// props de item: {actionId, uniqueId, text, count}
function getItemProps(itemNode) {
  const r = parseAttrList(itemNode.props, 2); const o = {};
  for (const a of r.list) { if (a.type === 4) o.actionId = a.data.readUInt16LE(0); else if (a.type === 5) o.uniqueId = a.data.readUInt16LE(0); else if (a.type === 6) o.text = a.data.toString('latin1', 2); else if (a.type === 15) o.count = a.data[0]; }
  return o;
}
function setItemProps(st, itemNode, props) {
  const head = itemNode.props.subarray(0, 2); const r = parseAttrList(itemNode.props, 2);
  let list = r.list.filter((x) => ![4, 5, 6, 15].includes(x.type));
  const u16 = (v) => { const d = Buffer.alloc(2); d.writeUInt16LE(v & 0xFFFF, 0); return d; };
  if (props.count != null) list.push({ type: 15, data: Buffer.from([props.count & 0xFF]) });
  if (props.actionId) list.push({ type: 4, data: u16(props.actionId) });
  if (props.uniqueId) list.push({ type: 5, data: u16(props.uniqueId) });
  if (props.text) { const s = Buffer.from(props.text, 'latin1'); const d = Buffer.alloc(2 + s.length); d.writeUInt16LE(s.length, 0); s.copy(d, 2); list.push({ type: 6, data: d }); }
  itemNode.props = buildProps(head, list, r.tail); st._dirty = true;
}
// nós de item (filhos OTBM_ITEM) de um tile
function itemNodes(node) { return node ? node.children.filter((c) => c.type === OTBM_ITEM) : []; }
// destino de teleporte de um item (attr type 8 = TELE_DEST: x u16, y u16, z u8) ou null
function getTeleportDest(itemNode) { const r = parseAttrList(itemNode.props, 2); for (const a of r.list) { if (a.type === 8 && a.data.length >= 5) return { x: a.data.readUInt16LE(0), y: a.data.readUInt16LE(2), z: a.data[4] }; } return null; }

// converte tile <-> housetile (houseId=0 → volta a tile normal)
function getHouseId(node) { return node && node.type === OTBM_HOUSETILE ? node.props.readUInt32LE(2) : 0; }
function setHouseTile(st, x, y, z, houseId) {
  const tn = ensureTile(st, x, y, z); const dx = tn.props[0], dy = tn.props[1];
  if (houseId > 0) {
    const hb = Buffer.alloc(4); hb.writeUInt32LE(houseId >>> 0, 0);
    const rest = tn.props.subarray(tn.type === OTBM_HOUSETILE ? 6 : 2);
    tn.props = Buffer.concat([Buffer.from([dx, dy]), hb, rest]); tn.type = OTBM_HOUSETILE;
  } else if (tn.type === OTBM_HOUSETILE) {
    tn.props = Buffer.concat([Buffer.from([dx, dy]), tn.props.subarray(6)]); tn.type = OTBM_TILE;
  }
  st._dirty = true;
}

// ---- ground brush + auto-border ----
function getGround(node) { const g = node ? tileGround(node) : null; return g ? g.id : 0; }
function setGround(st, x, y, z, id) {
  const tn = ensureTile(st, x, y, z); const head = tn.props.subarray(0, tileHeadLen(tn)); const r = parseAttrList(tn.props, tileHeadLen(tn));
  const list = r.list.filter((a) => a.type !== 9); // tira ground antigo
  if (id) { const d = Buffer.alloc(2); d.writeUInt16LE(id & 0xFFFF, 0); list.push({ type: 9, data: d }); }
  tn.props = buildProps(head, list, r.tail); st._dirty = true;
}
function removeItemId(st, node, id) { const before = node.children.length; node.children = node.children.filter((c) => !(c.type === OTBM_ITEM && c.props.readUInt16LE(0) === id)); if (node.children.length !== before) st._dirty = true; }
// recalcula a borda (borderId) de um tile com base nos 4 vizinhos com mesmo ground
function autoBorder(st, x, y, z, groundId, borderId) {
  const tn = st.map.get(x + ',' + y + ',' + z); if (!tn) return;
  removeItemId(st, tn, borderId);
  if (getGround(tn) !== groundId) return; // só borda tiles desse ground
  const sides = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  let need = false;
  for (const [dx, dy] of sides) { const nb = st.map.get((x + dx) + ',' + (y + dy) + ',' + z); if (!nb || getGround(nb) !== groundId) { need = true; break; } }
  if (need) tn.children.push(makeItemNode(borderId));
}

// ---- undo/redo + seleção (snapshots de tile) ----
function cloneNode(n) { return { type: n.type, props: Buffer.from(n.props), children: n.children.map(cloneNode), _x: n._x, _y: n._y, _z: n._z }; }
function snapTile(st, key) { const n = st.map.get(key); return n ? cloneNode(n) : null; } // null = tile não existe
// restaura um tile pro estado snap (null = remover o tile)
function setTile(st, key, snap) {
  const cur = st.map.get(key);
  if (!snap) {
    if (cur) { const area = cur._area || st.areaIndex.get((cur._x & 0xFF00) + ',' + (cur._y & 0xFF00) + ',' + cur._z); if (area) { const i = area.children.indexOf(cur); if (i >= 0) area.children.splice(i, 1); } st.map.delete(key); if (st._offTile) st._offTile(cur); }
    st._dirty = true; return;
  }
  if (cur) { cur.props = Buffer.from(snap.props); cur.children = snap.children.map(cloneNode); }
  else { const p = key.split(',').map(Number); const tn = ensureTile(st, p[0], p[1], p[2]); tn.props = Buffer.from(snap.props); tn.children = snap.children.map(cloneNode); }
  st._dirty = true;
}
// limpa todo o conteúdo de um tile (itens filhos + ground)
function clearTile(st, key) {
  const tn = st.map.get(key); if (!tn) return;
  tn.children = tn.children.filter((c) => c.type !== OTBM_ITEM);
  const g = tileGround(tn); if (g) tn.props = Buffer.concat([tn.props.subarray(0, g.s), tn.props.subarray(g.e)]);
  st._dirty = true;
}
// adiciona itens (lista de ids) num tile, na ordem (1º vira ground se o tile não tiver)
function setTileItems(st, x, y, z, ids) {
  const tn = ensureTile(st, x, y, z);
  for (const id of ids) tn.children.push(makeItemNode(id));
  st._dirty = true;
}

// substitui um id por outro num tile (copy-on-write: props podem ser subarray do arquivo)
function nodeReplace(st, node, from, to) {
  let ch = false;
  const g = tileGround(node);
  if (g && g.id === from) { const np = Buffer.from(node.props); np.writeUInt16LE(to & 0xFFFF, g.s + 1); node.props = np; ch = true; }
  for (const c of node.children) { if (c.type === OTBM_ITEM && c.props.readUInt16LE(0) === from) { const np = Buffer.from(c.props); np.writeUInt16LE(to & 0xFFFF, 0); c.props = np; ch = true; } }
  if (ch) st._dirty = true; return ch;
}
// keys de tiles que contêm o item id (ground ou empilhado)
function findItem(st, id) { ensureAll(st);
  const out = [];
  for (const [k, n] of st.map) { const g = tileGround(n); if (g && g.id === id) { out.push(k); continue; } for (const c of n.children) { if (c.type === OTBM_ITEM && c.props.readUInt16LE(0) === id) { out.push(k); break; } } }
  return out;
}
// remove itens duplicados (mesmo id repetido) num tile
function dedupeTile(st, node) { const seen = new Set(); let rm = 0; node.children = node.children.filter((c) => { if (c.type !== OTBM_ITEM) return true; const id = c.props.readUInt16LE(0); if (seen.has(id)) { rm++; return false; } seen.add(id); return true; }); if (rm) st._dirty = true; return rm; }
// remove tiles totalmente vazios (sem ground e sem itens e não-house)
function removeEmptyTiles(st) {
  ensureAll(st); let rm = 0; for (const [k, n] of [...st.map]) { if (n.type === OTBM_HOUSETILE) continue; if (!getGround(n) && !n.children.some((c) => c.type === OTBM_ITEM)) { const area = n._area || st.areaIndex.get((n._x & 0xFF00) + ',' + (n._y & 0xFF00) + ',' + n._z); if (area) { const i = area.children.indexOf(n); if (i >= 0) area.children.splice(i, 1); } st.map.delete(k); if (st._offTile) st._offTile(n); rm++; } }
  if (rm) st._dirty = true; return rm;
}
// copia os tiles de outro mapa (other) p/ este, com deslocamento
function mergeRegion(st, other, offX, offY, offZ) { ensureAll(st); ensureAll(other);
  let n = 0;
  for (const on of other.map.values()) { const x = on._x + offX, y = on._y + offY, z = on._z + offZ; if (z < 0 || z > 15) continue; const tn = ensureTile(st, x, y, z); const g = getGround(on); if (g) setGround(st, x, y, z, g); for (const id of (function () { const out = []; for (const c of on.children) if (c.type === OTBM_ITEM) out.push(c.props.readUInt16LE(0)); return out; })()) tn.children.push(makeItemNode(id)); n++; }
  st._dirty = true; return n;
}
// estatísticas rápidas (contagem de itens, tiles)
function stats(st) { ensureAll(st);
  let items = 0; const counts = new Map();
  for (const n of st.map.values()) { for (const id of tileItems(n)) { items++; counts.set(id, (counts.get(id) || 0) + 1); } }
  return { tiles: st.map.size, items, counts };
}

module.exports = { parse, serialize, save, createEmpty, resize, placeItem, deleteTop, ensureTile, ensureArea, ensureAreaAt, ensureAll, itemId, itemsOf, cloneNode, snapTile, setTile, clearTile, setTileItems, getTileFlags, setTileFlags, getItemProps, setItemProps, itemNodes, getTeleportDest, getGround, setGround, removeItemId, autoBorder, nodeReplace, findItem, stats, addWaypoint, removeWaypointAt, getHouseId, setHouseTile, setMapInfo, addTown, removeTown, dedupeTile, removeEmptyTiles, mergeRegion };
