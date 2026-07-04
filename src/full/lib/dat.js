// Carrega Tibia.dat. Suporta o formato do OTCv8/Object Builder:
// extended (indice u32), frame-durations (improved anim) e frame-groups (creatures).
// Le items + creatures (igual RME). Outfit looktype L = thing no id (itemCount + L).
const fs = require('fs');
const ByteReader = require('./bytereader');
const V = require('./versions');

class Dat {
  // opts: { extended, frameDurations, frameGroups, version } — version p/ remap de atributos
  constructor(file, opts = {}) {
    this.ext = opts.extended !== false;
    this.fdur = opts.frameDurations !== false;
    this.fgrp = opts.frameGroups !== false;
    this.version = opts.version || 860;

    const d = fs.readFileSync(file);
    const r = new ByteReader(d);
    this.signature = r.u32(); // assinatura
    this.itemCount = r.u16();
    this.creatureCount = r.u16();
    this.effectCount = r.u16();
    this.missileCount = r.u16();
    this._dirty = false;

    // 4 categorias: items 100..itemCount, depois outfits/effects/missiles 1..N
    this.items = new Map();
    this.outfits = new Map();
    this.effects = new Map();
    this.missiles = new Map();
    // le 1 thing capturando os bytes crus (p/ recompilar lossless)
    const rd = (isCreature) => {
      const start = r.p;
      const t = this.readThing(r, isCreature);
      t._raw = Buffer.from(r.b.subarray(start, r.p));
      t._geomStart = (t._geomAbsStart || 0) - start;     // onde comeca a geometria no _raw
      for (const g of t._groups) g._spriteRel = (g._spriteAbsStart || 0) - start; // offset por grupo
      t._spriteRel = t._groups[t._primary]._spriteRel;   // onde comecam os indices do grupo primario
      t._spriteRelToGeom = t._spriteRel - t._geomStart;  // constante mesmo mudando atributos
      t._spriteBits = this.ext ? 32 : 16;
      return t;
    };
    for (let id = 100; id <= this.itemCount; id++) this.items.set(id, rd(false));
    for (let i = 1; i <= this.creatureCount; i++) this.outfits.set(i, rd(true));
    for (let i = 1; i <= this.effectCount; i++) this.effects.set(i, rd(false));
    for (let i = 1; i <= this.missileCount; i++) this.missiles.set(i, rd(false));
    this.creatures = this.outfits; // alias (compat)
  }

  // reconstrói os bytes de atributo (op cru + dados) + terminador 0xFF
  rebuildAttrs(thing) {
    const parts = [];
    for (const a of thing._attrs) { parts.push(Buffer.from([a.op]), a.data); }
    parts.push(Buffer.from([255]));
    return Buffer.concat(parts);
  }
  // aplica os atributos editados de volta no _raw (reajusta offsets de sprite)
  applyAttrs(thing) {
    const attr = this.rebuildAttrs(thing);
    const delta = attr.length - thing._geomStart; // deslocamento aplicado a tudo após os atributos
    thing._raw = Buffer.concat([attr, thing._raw.subarray(thing._geomStart)]);
    thing._geomStart = attr.length;
    for (const g of thing._groups) g._spriteRel += delta;
    thing._spriteRel = thing._groups[thing._primary]._spriteRel;
    this._dirty = true;
  }

  // reaponta o slot i de um thing pra outro sprite id (patcha os bytes crus).
  // group opcional = qual frame group editar (default: primário).
  setSpriteId(thing, i, id, group) {
    group = group || thing._groups[thing._primary];
    if (!thing._raw || i < 0 || i >= group.sprites.length) return;
    group.sprites[i] = id >>> 0;
    if (group === thing._groups[thing._primary]) thing.sprites[i] = id >>> 0;
    const off = group._spriteRel + i * (thing._spriteBits / 8);
    if (thing._spriteBits === 32) thing._raw.writeUInt32LE(id >>> 0, off);
    else thing._raw.writeUInt16LE(id & 0xFFFF, off);
    this._dirty = true;
  }

  // ---- criar / duplicar thing (append no fim da categoria) ----
  _normGroup(g, gi) {
    return {
      type: g.type != null ? g.type : gi, width: g.width, height: g.height, exact: g.exact || 32,
      layers: g.layers, px: g.px, py: g.py, pz: g.pz, frames: g.frames,
      animMode: g.animMode || 0, loopCount: g.loopCount || 0, startFrame: g.startFrame || 0,
      durations: g.durations ? g.durations.map((d) => ({ min: d.min, max: d.max })) : null,
      sprites: (g.sprites || []).slice(),
    };
  }
  _cloneThing(src, cat) {
    const attrs = src._attrs.map((a) => ({ canon: a.canon, data: Buffer.from(a.data) }));
    const groups = src._groups.map((g, i) => this._normGroup(g, i));
    return this._serializeFull(cat, attrs, groups, src._primary);
  }
  _blankThing(isCreature, cat) {
    const blank = { type: 0, width: 1, height: 1, exact: 32, layers: 1, px: 1, py: 1, pz: 1, frames: 1, animMode: 0, loopCount: 0, startFrame: 0, durations: null, sprites: [0] };
    return this._serializeFull(cat || (isCreature ? 'outfits' : 'effects'), [], [blank], 0);
  }
  // compat: serializa 1 grupo (attrs + group + ids) — usado por addImported
  _serializeThing(cat, attrs, group, spriteIds) {
    const grp = this._normGroup({ ...group, sprites: spriteIds, type: group.type || 0 }, 0);
    return this._serializeFull(cat, attrs, [grp], 0);
  }
  // serializa um thing COMPLETO (inverso do readThing): attrs + N frame groups.
  _serializeFull(cat, attrs, groups, primary) {
    const isCreature = cat === 'outfits';
    const useGroups = this.fgrp && isCreature;
    const parts = [];
    for (const a of attrs) parts.push(Buffer.from([V.inverseRemap(a.canon, this.version)]), Buffer.from(a.data));
    parts.push(Buffer.from([255]));
    const attrLen = parts.reduce((s, b) => s + b.length, 0);
    if (useGroups) parts.push(Buffer.from([groups.length]));
    const outGroups = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      if (useGroups) parts.push(Buffer.from([group.type != null ? group.type : gi]));
      const geom = [group.width, group.height];
      if (group.width > 1 || group.height > 1) geom.push((group.exact || 32) & 0xFF);
      geom.push(group.layers, group.px, group.py);
      if (this.version >= 755) geom.push(group.pz);
      geom.push(group.frames);
      parts.push(Buffer.from(geom));
      if (group.frames > 1 && this.fdur) {
        const d = Buffer.alloc(1 + 4 + 1 + group.frames * 8);
        let o = 0;
        d.writeUInt8(group.animMode != null ? group.animMode : 0, o); o += 1;
        d.writeInt32LE(group.loopCount != null ? group.loopCount : 0, o); o += 4;
        d.writeInt8(group.startFrame != null ? group.startFrame : 0, o); o += 1;
        for (let i = 0; i < group.frames; i++) {
          const dur = (group.durations && group.durations[i]) || { min: 100, max: 100 };
          d.writeUInt32LE(dur.min >>> 0, o); o += 4; d.writeUInt32LE(dur.max >>> 0, o); o += 4;
        }
        parts.push(d);
      }
      const spriteRel = parts.reduce((s, b) => s + b.length, 0);
      const total = group.width * group.height * group.layers * group.px * group.py * group.pz * group.frames;
      const sp = Buffer.alloc(total * (this.ext ? 4 : 2));
      for (let i = 0; i < total; i++) {
        const sid = (group.sprites[i] || 0) >>> 0;
        if (this.ext) sp.writeUInt32LE(sid, i * 4); else sp.writeUInt16LE(sid & 0xFFFF, i * 2);
      }
      parts.push(sp);
      const og = this._normGroup(group, gi); og.sprites = group.sprites.slice(0, total);
      while (og.sprites.length < total) og.sprites.push(0);
      og._spriteRel = spriteRel;
      outGroups.push(og);
    }
    const pi = (primary != null && primary < outGroups.length) ? primary : (() => { let b = 0; for (let i = 1; i < outGroups.length; i++) if (outGroups[i].frames > outGroups[b].frames) b = i; return b; })();
    const p = outGroups[pi];
    const t = {
      width: p.width, height: p.height, exact: p.exact, layers: p.layers, px: p.px, py: p.py, pz: p.pz, frames: p.frames,
      sprites: p.sprites, _animMode: p.animMode, _loopCount: p.loopCount, _startFrame: p.startFrame, _durations: p.durations,
      _groups: outGroups, _primary: pi,
    };
    t._raw = Buffer.concat(parts);
    t._geomStart = attrLen;
    t._spriteRel = p._spriteRel;
    t._spriteRelToGeom = p._spriteRel - attrLen;
    t._spriteBits = this.ext ? 32 : 16;
    t._attrs = attrs.map((a) => ({ op: V.inverseRemap(a.canon, this.version), canon: a.canon, data: Buffer.from(a.data) }));
    return t;
  }
  // altera a geometria de um thing (w/h/layers/patterns/frames) e reconstrói _raw.
  // redimensiona a lista de sprites: mantém os existentes, completa com 0, corta sobra.
  // altera geometria de UM grupo (default primário); preserva os demais grupos.
  setGeometry(thing, cat, geom, groupIdx) {
    const gi = groupIdx != null ? groupIdx : thing._primary;
    const cl = (v, d) => { v = parseInt(v, 10); if (isNaN(v) || v < 1) v = d; return Math.min(255, v); };
    const cur = thing._groups[gi];
    const frames = cl(geom.frames, cur.frames);
    const ng = {
      type: cur.type, width: cl(geom.width, cur.width), height: cl(geom.height, cur.height),
      exact: cl(geom.exact != null ? geom.exact : cur.exact, 32),
      layers: cl(geom.layers, cur.layers), px: cl(geom.px, cur.px), py: cl(geom.py, cur.py),
      pz: this.version >= 755 ? cl(geom.pz, cur.pz) : 1, frames,
      animMode: cur.animMode || 0, loopCount: cur.loopCount || 0, startFrame: cur.startFrame || 0,
      durations: frames > 1 ? Array(frames).fill(0).map((_, i) => (cur.durations && cur.durations[i]) || { min: 100, max: 100 }) : null,
      sprites: [],
    };
    const total = ng.width * ng.height * ng.layers * ng.px * ng.py * ng.pz * ng.frames;
    for (let i = 0; i < total; i++) ng.sprites[i] = cur.sprites[i] || 0;
    const groups = thing._groups.map((g, i) => (i === gi ? ng : this._normGroup(g, i)));
    const attrs = thing._attrs.map((a) => ({ canon: a.canon, data: a.data }));
    Object.assign(thing, this._serializeFull(cat, attrs, groups, thing._primary));
    this._dirty = true;
    return thing;
  }

  // altera animação de UM grupo (default primário); preserva os demais.
  setAnimation(thing, cat, anim, groupIdx) {
    const gi = groupIdx != null ? groupIdx : thing._primary;
    const cur = thing._groups[gi];
    if (cur.frames <= 1 || !this.fdur) return thing;
    const ng = this._normGroup(cur, gi);
    if (anim.animMode != null) ng.animMode = anim.animMode;
    if (anim.loopCount != null) ng.loopCount = anim.loopCount;
    if (anim.startFrame != null) ng.startFrame = anim.startFrame;
    if (anim.durations) ng.durations = anim.durations.map((d) => ({ min: d.min, max: d.max }));
    const groups = thing._groups.map((g, i) => (i === gi ? ng : this._normGroup(g, i)));
    const attrs = thing._attrs.map((a) => ({ canon: a.canon, data: a.data }));
    Object.assign(thing, this._serializeFull(cat, attrs, groups, thing._primary));
    this._dirty = true;
    return thing;
  }

  // adiciona um frame group (só outfit + fgrp). Duplica o grupo atual como novo tipo.
  addFrameGroup(thing, cat) {
    if (!(this.fgrp && cat === 'outfits')) return thing;
    if (thing._groups.length >= 2) return thing; // OB usa no máx 2 (idle+walking)
    const groups = thing._groups.map((g, i) => this._normGroup(g, i));
    groups[0].type = 0; // idle
    const nw = this._normGroup(groups[0], 1); nw.type = 1; // walking (duplica idle)
    groups.push(nw);
    const attrs = thing._attrs.map((a) => ({ canon: a.canon, data: a.data }));
    Object.assign(thing, this._serializeFull(cat, attrs, groups, groups.length - 1));
    this._dirty = true;
    return thing;
  }

  // remove um frame group (mantém ao menos 1).
  removeFrameGroup(thing, cat, groupIdx) {
    if (thing._groups.length <= 1) return thing;
    const groups = thing._groups.filter((_, i) => i !== groupIdx).map((g, i) => this._normGroup(g, i));
    const attrs = thing._attrs.map((a) => ({ canon: a.canon, data: a.data }));
    Object.assign(thing, this._serializeFull(cat, attrs, groups, 0));
    this._dirty = true;
    return thing;
  }

  addImported(cat, attrs, group, spriteIds) {
    let id;
    if (cat === 'items') id = (this.itemCount += 1);
    else if (cat === 'outfits') id = (this.creatureCount += 1);
    else if (cat === 'effects') id = (this.effectCount += 1);
    else id = (this.missileCount += 1);
    const t = this._serializeThing(cat, attrs, group, spriteIds);
    this.category(cat).set(id, t);
    this._dirty = true;
    return { id, t };
  }

  // adiciona um thing COMPLETO (attrs + N grupos) no fim da categoria
  addFull(cat, attrs, groups) {
    let id;
    if (cat === 'items') id = (this.itemCount += 1);
    else if (cat === 'outfits') id = (this.creatureCount += 1);
    else if (cat === 'effects') id = (this.effectCount += 1);
    else id = (this.missileCount += 1);
    const t = this._serializeFull(cat, attrs.map((a) => ({ canon: a.canon, data: Buffer.from(a.data) })), groups, null);
    this.category(cat).set(id, t);
    this._dirty = true;
    return { id, t };
  }
  // substitui os grupos (patterns) de um thing existente, mantendo attrs
  setGroups(thing, cat, groups) {
    const attrs = thing._attrs.map((a) => ({ canon: a.canon, data: a.data }));
    Object.assign(thing, this._serializeFull(cat, attrs, groups, null));
    this._dirty = true;
    return thing;
  }

  // remove o ULTIMO id da categoria (seguro: nao desloca ids dos outros)
  removeLast(cat) {
    let id;
    if (cat === 'items') { id = this.itemCount; this.itemCount -= 1; }
    else if (cat === 'outfits') { id = this.creatureCount; this.creatureCount -= 1; }
    else if (cat === 'effects') { id = this.effectCount; this.effectCount -= 1; }
    else { id = this.missileCount; this.missileCount -= 1; }
    this.category(cat).delete(id);
    this._dirty = true;
    return id;
  }

  // remove QUALQUER id (renumera os seguintes p/ baixo). ATENÇÃO: desloca ids → quebra refs externas.
  removeAt(cat, id) {
    const map = this.category(cat);
    const min = cat === 'items' ? 100 : 1;
    let max;
    if (cat === 'items') max = this.itemCount; else if (cat === 'outfits') max = this.creatureCount;
    else if (cat === 'effects') max = this.effectCount; else max = this.missileCount;
    if (id < min || id > max) return null;
    for (let i = id; i < max; i++) map.set(i, map.get(i + 1)); // shift down
    map.delete(max);
    if (cat === 'items') this.itemCount -= 1; else if (cat === 'outfits') this.creatureCount -= 1;
    else if (cat === 'effects') this.effectCount -= 1; else this.missileCount -= 1;
    this._dirty = true;
    return id;
  }

  addThing(cat, src) {
    let id;
    if (cat === 'items') id = (this.itemCount += 1);
    else if (cat === 'outfits') id = (this.creatureCount += 1);
    else if (cat === 'effects') id = (this.effectCount += 1);
    else id = (this.missileCount += 1);
    const t = src ? this._cloneThing(src, cat) : this._blankThing(cat === 'outfits', cat);
    this.category(cat).set(id, t);
    this._dirty = true;
    return { id, t };
  }

  // converte p/ outra versão de cliente: muda formato (extended/durations/groups) + assinatura,
  // re-serializa TODOS os things no novo formato. Retorna avisos.
  convertTo(version) {
    const fmt = V.formatFor(version);
    const sig = V.sigForVersion(version);
    const warn = [];
    if (sig == null) warn.push('sem assinatura conhecida p/ ' + version + ' (mantida a atual)');
    const oldFmt = { ext: this.ext, fdur: this.fdur, fgrp: this.fgrp, version: this.version };
    this.version = version; this.ext = fmt.extended; this.fdur = fmt.frameDurations; this.fgrp = fmt.frameGroups;
    if (sig != null) this.signature = sig;
    if (this.ext !== oldFmt.ext) warn.push('extended ' + oldFmt.ext + '→' + this.ext + ' (ids de sprite ' + (this.ext ? '32' : '16') + ' bits)');
    if (!this.fgrp && oldFmt.fgrp) warn.push('frame groups removidos (outfits perdem idle/walk separado)');
    for (const cat of ['items', 'outfits', 'effects', 'missiles']) {
      const map = this.category(cat);
      for (const [id, t] of map) {
        const attrs = t._attrs.map((a) => ({ canon: a.canon, data: a.data }));
        const groups = (this.fgrp && cat === 'outfits') ? t._groups.map((g, i) => this._normGroup(g, i)) : [this._normGroup(t._groups[t._primary], 0)];
        map.set(id, this._serializeFull(cat, attrs, groups, null));
      }
    }
    this._dirty = true;
    return warn;
  }

  // recompila o .dat (header + bytes crus de cada thing, na ordem)
  compile(outPath) {
    const head = Buffer.alloc(12);
    head.writeUInt32LE(this.signature >>> 0, 0);
    head.writeUInt16LE(this.itemCount, 4);
    head.writeUInt16LE(this.creatureCount, 6);
    head.writeUInt16LE(this.effectCount, 8);
    head.writeUInt16LE(this.missileCount, 10);
    const parts = [head];
    for (let id = 100; id <= this.itemCount; id++) parts.push(this.items.get(id)._raw);
    for (let i = 1; i <= this.creatureCount; i++) parts.push(this.outfits.get(i)._raw);
    for (let i = 1; i <= this.effectCount; i++) parts.push(this.effects.get(i)._raw);
    for (let i = 1; i <= this.missileCount; i++) parts.push(this.missiles.get(i)._raw);
    fs.writeFileSync(outPath, Buffer.concat(parts));
    this._dirty = false;
  }

  creature(looktype) { return this.outfits.get(looktype); }
  item(clientId) { return this.items.get(clientId); }
  creatureCountLoaded() { return this.outfits.size; }
  // categoria -> Map
  category(cat) { return { items: this.items, outfits: this.outfits, effects: this.effects, missiles: this.missiles }[cat]; }

  readThing(r, isCreature) {
    // --- flags (ate 255) — captura op cru + canonico + bytes de dados ---
    const attrs = [];
    let guard = 0;
    while (true) {
      if (r.p >= r.b.length) throw new Error('dat eof (formato nao bate)');
      if (++guard > 300) throw new Error('dat desync (formato nao bate)');
      const raw = r.u8();
      if (raw === 255) break;
      const a = V.remapFlag(raw, this.version); // canoniza p/ a versao
      const ds = r.p;
      switch (a) {
        case 0: case 8: case 9: case 29: case 32: case 34: r.u16(); break; // Ground/Writable/WritableOnce/LensHelp/Cloth/Usable
        case 21: r.u16(); r.u16(); break;                  // Light
        case 24: if (this.version >= 755) { r.u16(); r.u16(); } break; // Displacement (so >=7.55)
        case 25: r.u16(); break;                           // Elevation
        case 28: r.u16(); break;                           // MinimapColor
        case 33: r.skip(6); r.str(); r.skip(4); break;     // Market
        case 38: r.skip(16); break;                        // Wings
        default: break;                                    // flag sem dados
      }
      attrs.push({ op: raw, canon: a, data: Buffer.from(r.b.subarray(ds, r.p)) });
    }
    const geomAbsStart = r.p;

    // --- frame groups (so creatures com fgrp) ---
    const useGroups = this.fgrp && isCreature;
    let groupCount = 1;
    if (useGroups) groupCount = r.u8();

    const groups = [];
    for (let g = 0; g < groupCount; g++) {
      const type = useGroups ? r.u8() : 0; // 0=idle, 1=walking
      const grp = { type, width: r.u8(), height: r.u8() };
      grp.exact = (grp.width > 1 || grp.height > 1) ? r.u8() : 32; // realSize
      grp.layers = r.u8();
      grp.px = r.u8();
      grp.py = r.u8();
      grp.pz = this.version >= 755 ? r.u8() : 1; // patternZ so >=7.55
      grp.frames = r.u8();

      if (grp.frames > 1 && this.fdur) {
        grp.animMode = r.u8();          // async/sync
        grp.loopCount = r.b.readInt32LE(r.p); r.skip(4); // loop count (i32)
        grp.startFrame = r.b.readInt8(r.p); r.skip(1);   // start frame (i8)
        grp.durations = [];
        for (let i = 0; i < grp.frames; i++) { grp.durations.push({ min: r.u32(), max: r.u32() }); }
      } else { grp.animMode = 0; grp.loopCount = 0; grp.startFrame = 0; grp.durations = null; }

      const total = grp.width * grp.height * grp.layers * grp.px * grp.py * grp.pz * grp.frames;
      grp._spriteAbsStart = r.p; // posicao dos indices deste grupo
      grp.sprites = new Array(total);
      for (let i = 0; i < total; i++) grp.sprites[i] = this.ext ? r.u32() : r.u16();
      groups.push(grp);
    }
    // primário = grupo com MAIS frames (anima o walk no preview)
    let pi = 0; for (let i = 1; i < groups.length; i++) if (groups[i].frames > groups[pi].frames) pi = i;
    const p = groups[pi];
    const t = {
      width: p.width, height: p.height, exact: p.exact, layers: p.layers, px: p.px, py: p.py, pz: p.pz, frames: p.frames,
      sprites: p.sprites, _animMode: p.animMode, _loopCount: p.loopCount, _startFrame: p.startFrame, _durations: p.durations,
      _groups: groups, _primary: pi, _attrs: attrs, _geomAbsStart: geomAbsStart, _spriteAbsStart: p._spriteAbsStart,
    };
    return t;
  }

  spriteIndex(t, w, h, l, x, y, z, a) {
    return ((((((a % t.frames) * t.pz + z) * t.py + y) * t.px + x) * t.layers + l) * t.height + h) * t.width + w;
  }
}
module.exports = Dat;
