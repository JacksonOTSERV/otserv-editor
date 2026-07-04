// Decode de arquivo .obd (Object Builder Data): LZMA + thing (props/geometria/durations) + sprites ARGB.
const fs = require('fs');
const V = require('./versions');
// LZMA via Rust backend (invoke) — sem dependência de JS LZMA
const _inv = () => window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
function lzmaCompress(data) {
  return _inv()('lzma_compress', { data: Array.from(data) });
}
function lzmaDecompress(data) {
  return _inv()('lzma_decompress', { data: Array.from(data) });
}

function argbToRgba(argb, n) {
  const out = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < n && i < 1024; i++) {
    const o = i * 4;
    out[o] = argb[o + 1]; out[o + 1] = argb[o + 2]; out[o + 2] = argb[o + 3]; out[o + 3] = argb[o];
  }
  return out;
}

function parse(b) {
  let p = 0;
  const u8 = () => b[p++];
  const u16 = () => { const v = b.readUInt16LE(p); p += 2; return v; };
  const u32 = () => { const v = b.readUInt32LE(p); p += 4; return v; };
  const i32 = () => { const v = b.readInt32LE(p); p += 4; return v; };
  const i8 = () => { const v = b.readInt8(p); p += 1; return v; };

  const v0 = u16();
  let obdVersion, clientVersion;
  if (v0 === 300 || v0 === 200) { obdVersion = v0; clientVersion = u16(); }
  else if (v0 >= 710) { obdVersion = 100; clientVersion = v0; }
  else throw new Error('OBD versão desconhecida: ' + v0);

  let category;
  if (obdVersion >= 200) {
    category = { 1: 'items', 2: 'outfits', 3: 'effects', 4: 'missiles' }[u8()]; // 1-based
    u32(); // skip texture patterns position
  } else {
    const len = u16(); const s = b.toString('latin1', p, p + len); p += len;
    category = { item: 'items', outfit: 'outfits', effect: 'effects', missile: 'missiles' }[s] || 'items';
  }
  if (!category) throw new Error('categoria OBD inválida');

  // propriedades (flags) — loop ate 0xFF, remap pela clientVersion
  const readFlagData = (canon) => {
    switch (canon) {
      case 0: case 8: case 9: case 29: case 32: case 34: p += 2; break;
      case 21: p += 4; break;
      case 24: if (clientVersion >= 755) p += 4; break;
      case 25: p += 2; break;
      case 28: p += 2; break;
      case 33: { p += 6; const len = b.readUInt16LE(p); p += 2 + len + 4; break; }
      case 38: p += 16; break;
      default: break;
    }
  };
  const attrs = [];
  let guard = 0;
  while (true) {
    if (++guard > 300) throw new Error('OBD props desync');
    const op = u8();
    if (op === 0xFF) break;
    const canon = V.remapFlag(op, clientVersion);
    const ds = p; readFlagData(canon);
    attrs.push({ canon, data: Buffer.from(b.subarray(ds, p)) });
  }

  const isOutfit = category === 'outfits';
  let groupCount = 1;
  if (obdVersion >= 300 && isOutfit) groupCount = u8();
  const groups = [];
  for (let g = 0; g < groupCount; g++) {
    if (obdVersion >= 300 && isOutfit) u8(); // group type
    const width = u8(), height = u8();
    let exact = 32;
    if (width > 1 || height > 1) exact = u8();
    const layers = u8(), px = u8(), py = u8(), pz = u8(), frames = u8();
    const grp = { width, height, exact, layers, px, py, pz, frames, durations: null, sprites: [], spriteIds: [] };
    if (frames > 1) {
      grp.animMode = u8(); grp.loopCount = i32(); grp.startFrame = i8();
      grp.durations = [];
      for (let i = 0; i < frames; i++) grp.durations.push({ min: u32(), max: u32() });
    }
    const total = width * height * layers * px * py * pz * frames;
    for (let i = 0; i < total; i++) {
      const sid = u32(); const sz = u32();
      const argb = b.subarray(p, p + sz); p += sz;
      grp.spriteIds.push(sid);
      grp.sprites.push(argbToRgba(argb, sz / 4));
    }
    groups.push(grp);
  }
  return { obdVersion, clientVersion, category, attrs, groups };
}

async function decodeFile(file) {
  let raw; try { raw = fs.readFileSync(file); } catch (e) { throw e; }
  const result = await lzmaDecompress(raw);
  if (!result) throw new Error('falha LZMA decompress');
  return parse(Buffer.from(result));
}

// ---- encode (.obd V3) ----
function rgbaToArgb(rgba) {
  const out = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < 1024; i++) {
    const o = i * 4;
    out[o] = rgba[o + 3] || 0; out[o + 1] = rgba[o] || 0; out[o + 2] = rgba[o + 1] || 0; out[o + 3] = rgba[o + 2] || 0;
  }
  return out;
}
const CAT_VAL = { items: 1, outfits: 2, effects: 3, missiles: 4 };

function encodeThing(t) {
  // usa Buffer dinâmico p/ backfill do offset de sprites (igual OB)
  const chunks = [];
  let byteLen = 0;
  const push = (b) => { chunks.push(b); byteLen += b.length; };
  const u8  = (v) => push(Buffer.from([v & 0xFF]));
  const i8  = (v) => { const b = Buffer.alloc(1); b.writeInt8(v);    push(b); };
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v >>> 0); push(b); };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); push(b); };
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v);  push(b); };

  const ov = t.obdVersion === 1 ? 100 : t.obdVersion === 2 ? 200 : 300;
  const isOutfit = t.category === 'outfits';
  const groups = t.groups || [t.group]; // suporta array (multi) ou objeto único (legado)

  // ---- cabeçalho ----
  if (ov >= 200) {
    u16(ov); u16(t.clientVersion); u8(CAT_VAL[t.category] || 1);
    // reserva 4 bytes para o offset de sprites (backfill depois)
    const offsetIdx = byteLen; u32(0); // placeholder
    // ---- attrs / flags ----
    for (const a of t.attrs) { u8(a.canon != null ? a.canon : (a.op || 0)); push(Buffer.from(a.data)); }
    u8(0xFF); // fim das props
    // backfill: escreve o offset real no placeholder
    const spritesOffset = byteLen;
    const flat = Buffer.concat(chunks); flat.writeUInt32LE(spritesOffset, offsetIdx);
    // reconstrói chunks com o flat corrigido (mais simples que manter referência mutável)
    chunks.length = 0; byteLen = 0; push(flat);
  } else {
    // V1: clientVersion + categoria como string UTF
    u16(t.clientVersion);
    const name = { items: 'item', outfits: 'outfit', effects: 'effect', missiles: 'missile' }[t.category] || 'item';
    u16(name.length); push(Buffer.from(name, 'latin1'));
    for (const a of t.attrs) { u8(a.canon != null ? a.canon : (a.op || 0)); push(Buffer.from(a.data)); }
    u8(0xFF);
  }

  // ---- grupos ----
  // V3 outfits: escreve groupCount antes dos grupos
  if (ov >= 300 && isOutfit) u8(groups.length);

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (ov >= 300 && isOutfit) {
      // OB: se só 1 grupo de outfit, escreve type=1 (WALKING); senão gi
      u8(groups.length < 2 ? 1 : gi);
    }
    u8(g.width||1); u8(g.height||1);
    if ((g.width||1) > 1 || (g.height||1) > 1) u8(g.exact || 32);
    u8(g.layers||1); u8(g.px||1); u8(g.py||1); u8(g.pz||1); u8(g.frames||1);
    // animação: V3 verifica isAnimation (frames > 1); V2 idem; V1 não tem
    if ((g.frames||1) > 1 && ov >= 200) {
      u8(g.animMode || 0); i32(g.loopCount || 0); i8(g.startFrame || 0);
      for (let i = 0; i < (g.frames||1); i++) {
        const d = (g.durations && g.durations[i]) || { min: 100, max: 100 };
        u32(d.min); u32(d.max);
      }
    }
    // sprites: V2 = só pixels (sem prefixo tamanho); V3 = spriteId + u32(size) + pixels
    const total = (g.width||1)*(g.height||1)*(g.layers||1)*(g.px||1)*(g.py||1)*(g.pz||1)*(g.frames||1);
    for (let i = 0; i < total; i++) {
      const argb = rgbaToArgb((g.spriteRgbaList && g.spriteRgbaList[i]) || new Uint8ClampedArray(4096));
      if (ov >= 200) u32((g.spriteIds && g.spriteIds[i]) || 0); // V1 também escreve id
      if (ov >= 300) u32(argb.length);  // V3: prefixo de tamanho; V2: sem prefixo
      push(argb);
    }
  }
  return Buffer.concat(chunks);
}
async function encodeFile(t) {
  const raw = encodeThing(t);
  const result = await lzmaCompress(raw);
  if (!result) throw new Error('falha LZMA compress');
  return Buffer.from(result);
}

module.exports = { decodeFile, parse, encodeThing, encodeFile };
