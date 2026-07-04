// Carrega o appearances-*.dat (Protobuf) do client 12+/15.x (formato Canary/otclient) e expõe a
// MESMA interface do dat.js (category/item/creature/spriteIndex + thing {width,height,layers,px,py,pz,
// frames,sprites[],_groups[],_primary,_attrs}). Assim o resto do editor (Object/Mapa) funciona sem mudar.
//
// Schema (canary src/protobuf/appearances.proto):
//   Appearances { repeated Appearance object=1; outfit=2; effect=3; missile=4; }
//   Appearance  { uint32 id=1; repeated FrameGroup frame_group=2; AppearanceFlags flags=3; bytes name=4; }
//   FrameGroup  { FIXED_FRAME_GROUP fixed_frame_group=1; uint32 id=2; SpriteInfo sprite_info=3; }
//   SpriteInfo  { pattern_width=1; pattern_height=2; pattern_depth=3; layers=4; repeated uint32 sprite_id=5;
//                 SpriteAnimation animation=6; bounding_square=7; bool is_opaque=8; }
//   SpriteAnimation { ... repeated SpritePhase phases=...; }  (cada phase = 1 frame)
// FIXED_FRAME_GROUP: OUTFIT_IDLE=0, OUTFIT_MOVING=1, OBJECT_INITIAL=2.

// ---- leitor protobuf mínimo (varint + wire types) ----
function reader(buf) {
  let p = 0; const len = buf.length;
  const varint = () => { let shift = 0, result = 0; while (p < len) { const b = buf[p++]; result += (b & 0x7f) * Math.pow(2, shift); if ((b & 0x80) === 0) break; shift += 7; } return result; };
  const tag = () => { const t = varint(); return { field: t >>> 3, wire: t & 7 }; };
  const bytes = () => { const n = varint(); const s = buf.subarray(p, p + n); p += n; return s; };
  const skip = (wire) => { if (wire === 0) varint(); else if (wire === 2) { const n = varint(); p += n; } else if (wire === 5) p += 4; else if (wire === 1) p += 8; };
  return { get p() { return p; }, get end() { return p >= len; }, varint, tag, bytes, skip };
}

// decodifica SpriteInfo
function readSpriteInfo(buf) {
  const r = reader(buf);
  const si = { pw: 1, ph: 1, pd: 1, layers: 1, sprites: [], phases: 1, bounding: 0, opaque: false };
  while (!r.end) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 0) si.pw = r.varint();
    else if (field === 2 && wire === 0) si.ph = r.varint();
    else if (field === 3 && wire === 0) si.pd = r.varint();
    else if (field === 4 && wire === 0) si.layers = r.varint();
    else if (field === 5) { // sprite_id (packed ou repetido)
      if (wire === 2) { const b = r.bytes(); const rr = reader(b); while (!rr.end) si.sprites.push(rr.varint()); }
      else si.sprites.push(r.varint());
    }
    else if (field === 6 && wire === 2) { const b = r.bytes(); si.phases = countPhases(b); } // animation
    else if (field === 7 && wire === 0) si.bounding = r.varint();
    else if (field === 8 && wire === 0) si.opaque = !!r.varint();
    else r.skip(wire);
  }
  return si;
}
// conta as fases (frames) dentro de SpriteAnimation (campo repetido = SpritePhase, normalmente field 6)
function countPhases(buf) {
  const r = reader(buf); let phases = 0; let loopCount = 0, mode = 0, start = 0;
  while (!r.end) {
    const { field, wire } = r.tag();
    if (field === 6 && wire === 2) { phases++; r.bytes(); }   // phases (repeated SpritePhase)
    else if (field === 5 && wire === 2) { phases++; r.bytes(); } // fallback p/ outro nº de campo
    else if (field === 3 && wire === 0) { loopCount = r.varint(); }
    else if (field === 4 && wire === 0) { mode = r.varint(); }
    else if (field === 2 && wire === 0) { start = r.varint(); }
    else r.skip(wire);
  }
  return Math.max(1, phases);
}

// decodifica AppearanceFlags → canônico do editor (só o essencial p/ render/ordem; resto vem depois)
function readFlags(buf) {
  const r = reader(buf); const f = {};
  while (!r.end) {
    const { field, wire } = r.tag();
    // números prováveis (canary appearances.proto): bank=1 ground/clip/bottom/top/...; lê só os úteis
    if (wire === 2) { const b = r.bytes(); if (field === 1) { const rr = reader(b); while (!rr.end) { const t = rr.tag(); if (t.field === 1 && t.wire === 0) f.groundSpeed = rr.varint(); else rr.skip(t.wire); } f.ground = true; } }
    else { const v = r.varint(); f['f' + field] = v; }
  }
  return f;
}

// decodifica 1 Appearance
function readAppearance(buf, spriteSizeOf) {
  const r = reader(buf);
  let id = 0; const fgroups = []; let flags = {}; let name = null;
  while (!r.end) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 0) id = r.varint();
    else if (field === 2 && wire === 2) { // FrameGroup
      const b = r.bytes(); const rg = reader(b); let fixed = 0, si = null;
      while (!rg.end) { const t = rg.tag(); if (t.field === 1 && t.wire === 0) fixed = rg.varint(); else if (t.field === 3 && t.wire === 2) si = readSpriteInfo(rg.bytes()); else rg.skip(t.wire); }
      if (si) fgroups.push({ fixed, si });
    }
    else if (field === 3 && wire === 2) flags = readFlags(r.bytes());
    else if (field === 4 && wire === 2) name = r.bytes().toString('latin1');
    else r.skip(wire);
  }
  if (!fgroups.length) return null;
  // monta os _groups no formato do dat.js.
  // No formato novo cada sprite_id é a imagem INTEIRA (ex: 64x64). O composeThing trabalha com tiles 32x32,
  // então EXPANDIMOS: cada sprite WxH vira wTiles*hTiles "sprites virtuais" 32x32 (id = realId*16 + sub).
  // Ordem do sprite_id novo: ((((a*pz+z)*py+y)*px+x)*layers+l). Reordenamos p/ a fórmula do spriteIndex (w/h innermost).
  const groups = fgroups.map((fg) => {
    const si = fg.si;
    let wTiles = 1, hTiles = 1, exact = 32;
    const sz = spriteSizeOf && si.sprites.length ? spriteSizeOf(si.sprites[0]) : null;
    if (sz) { wTiles = Math.max(1, Math.round(sz.w / 32)); hTiles = Math.max(1, Math.round(sz.h / 32)); exact = Math.max(sz.w, sz.h); }
    const layers = si.layers || 1, px = si.pw || 1, py = si.ph || 1, pz = si.pd || 1, frames = si.phases || 1;
    const total = wTiles * hTiles * layers * px * py * pz * frames;
    const sprites = new Array(total).fill(0);
    for (let a = 0; a < frames; a++) for (let z = 0; z < pz; z++) for (let y = 0; y < py; y++) for (let x = 0; x < px; x++) for (let l = 0; l < layers; l++) {
      const newIdx = ((((a * pz + z) * py + y) * px + x) * layers + l);
      const realId = si.sprites[newIdx] || 0;
      for (let h = 0; h < hTiles; h++) for (let w = 0; w < wTiles; w++) {
        const oldIdx = ((((((a * pz + z) * py + y) * px + x) * layers + l) * hTiles + h) * wTiles + w);
        // composeThing desenha sprites[w] em (width-1-w)*32 (origem canto inf-direito do Tibia). O sprite novo é
        // top-left normal → o tile (w,h) deve apontar pro sub-tile (col=wTiles-1-w, row=hTiles-1-h) da imagem.
        const sub = (hTiles - 1 - h) * 4 + (wTiles - 1 - w);
        sprites[oldIdx] = realId ? (realId * 16 + sub) : 0;
      }
    }
    return { type: fg.fixed, width: wTiles, height: hTiles, exact, layers, px, py, pz, frames, animMode: 0, loopCount: 0, startFrame: 0, durations: null, sprites };
  });
  // primário = grupo com mais frames (anima o walk)
  let pi = 0; for (let i = 1; i < groups.length; i++) if (groups[i].frames > groups[pi].frames) pi = i;
  const p = groups[pi];
  return {
    id, width: p.width, height: p.height, exact: p.exact, layers: p.layers, px: p.px, py: p.py, pz: p.pz, frames: p.frames,
    sprites: p.sprites, _groups: groups, _primary: pi, _attrs: [], _flags: flags, _name: name,
    _animMode: 0, _loopCount: 0, _startFrame: 0, _durations: null,
  };
}

class Appearances {
  // buf = bytes do appearances-*.dat; opts.spriteSizeOf(spriteId) -> {w,h} (do catalog/sheets)
  constructor(buf, opts = {}) {
    this.version = opts.version || 1500;
    this.items = new Map(); this.outfits = new Map(); this.effects = new Map(); this.missiles = new Map();
    const r = reader(buf);
    const ssz = opts.spriteSizeOf;
    while (!r.end) {
      const { field, wire } = r.tag();
      if (wire === 2 && field >= 1 && field <= 4) {
        const ap = readAppearance(r.bytes(), ssz);
        if (ap) { const map = [null, this.items, this.outfits, this.effects, this.missiles][field]; map.set(ap.id, ap); }
      } else r.skip(wire);
    }
    this.creatures = this.outfits;
    this.itemCount = this.items.size ? Math.max(...this.items.keys()) : 0;
    this.creatureCount = this.outfits.size ? Math.max(...this.outfits.keys()) : 0;
    this.effectCount = this.effects.size ? Math.max(...this.effects.keys()) : 0;
    this.missileCount = this.missiles.size ? Math.max(...this.missiles.keys()) : 0;
    this.signature = 0; this._dirty = false; this._appearances = true;
  }
  category(cat) { return { items: this.items, outfits: this.outfits, effects: this.effects, missiles: this.missiles }[cat]; }
  item(id) { return this.items.get(id); }
  creature(id) { return this.outfits.get(id); }
  spriteIndex(t, w, h, l, x, y, z, a) {
    return ((((((a % t.frames) * t.pz + z) * t.py + y) * t.px + x) * t.layers + l) * t.height + h) * t.width + w;
  }
  creatureCountLoaded() { return this.outfits.size; }
  _normGroup(g, gi) {
    return { type: g.type != null ? g.type : gi, width: g.width, height: g.height, exact: g.exact || 32, layers: g.layers, px: g.px, py: g.py, pz: g.pz, frames: g.frames, animMode: g.animMode || 0, loopCount: g.loopCount || 0, startFrame: g.startFrame || 0, durations: g.durations ? g.durations.map((d) => ({ min: d.min, max: d.max })) : null, sprites: (g.sprites || []).slice() };
  }
  // edição do formato 15.x ainda não suportada (somente visualização) — stubs seguros p/ não crashar
  _noEdit() { console.warn('edição de assets 15.x ainda não suportada (só visualização)'); return null; }
  setSpriteId() { return this._noEdit(); }
  setGeometry(t) { this._noEdit(); return t; }
  setAnimation(t) { this._noEdit(); return t; }
  addFrameGroup(t) { this._noEdit(); return t; }
  removeFrameGroup(t) { this._noEdit(); return t; }
  applyAttrs() { return this._noEdit(); }
  rebuildAttrs() { return Buffer.alloc(0); }
  compile() { throw new Error('Salvar assets 15.x ainda não suportado (só visualização).'); }
  convertTo() { return ['conversão não suportada no formato 15.x']; }
  addImported() { return this._noEdit(); }
  addFull() { return this._noEdit(); }
  addThing() { return this._noEdit(); }
  _cloneThing(src) { return src; }
  setGroups(t) { this._noEdit(); return t; }
  removeLast() { return this._noEdit(); }
  removeAt() { return this._noEdit(); }
}
module.exports = Appearances;
