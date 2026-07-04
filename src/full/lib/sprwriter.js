// Compila sprites de volta pro .spr (espelho do SpriteStorage.compile do Object Builder).
const fs = require('fs');

// RGBA 32x32 -> bytes RLE comprimidos (transparent run + colored run + pixels)
function encodeSprite(px, transparency) {
  const out = [];
  const n = 32 * 32;
  const u16 = (v) => { out.push(v & 0xFF, (v >> 8) & 0xFF); };
  let i = 0;
  while (i < n) {
    let transparent = 0, colored = 0, j = i;
    while (j < n && px[j * 4 + 3] === 0) { transparent++; j++; }
    while (j < n && px[j * 4 + 3] !== 0) { colored++; j++; }
    u16(transparent); u16(colored);
    for (let c = 0; c < colored; c++) {
      const o = (i + transparent + c) * 4;
      out.push(px[o], px[o + 1], px[o + 2]);
      if (transparency) out.push(px[o + 3]);
    }
    i += transparent + colored;
  }
  return Buffer.from(out);
}

// spr = instancia do Spr (loaded). rgbaEdits = Map(spriteId -> Uint8ClampedArray) | null
// newCount = total de sprites a escrever (>= spr.count p/ sprites adicionados)
function compileSpr(spr, outPath, rgbaEdits, newCount) {
  const ext = spr.ext, sig = spr.signature, transparency = spr.transparency;
  const count = newCount || spr.count;
  const headSize = ext ? 8 : 6;
  const head = Buffer.alloc(headSize);
  head.writeUInt32LE(sig >>> 0, 0);
  if (ext) head.writeUInt32LE(count, 4); else head.writeUInt16LE(count, 4);

  const table = Buffer.alloc(count * 4);
  let offset = headSize + count * 4;
  // primeira passada: calcular offsets e encodar sprites editados
  const edits = [];
  for (let id = 1; id <= count; id++) {
    let comp;
    if (rgbaEdits && rgbaEdits.has(id)) comp = encodeSprite(rgbaEdits.get(id), transparency);
    else comp = spr.getCompressed(id);
    if (!comp || comp.length === 0) { table.writeUInt32LE(0, (id - 1) * 4); edits.push(null); continue; }
    table.writeUInt32LE(offset, (id - 1) * 4);
    edits.push(comp);
    offset += 5 + comp.length;
  }
  // escrever com stream para não alocar buffer gigante de uma vez
  const fd = fs.openSync(outPath, 'w');
  fs.writeSync(fd, head);
  fs.writeSync(fd, table);
  const hdr = Buffer.alloc(5); hdr[0] = 0xFF; hdr[1] = 0x00; hdr[2] = 0xFF;
  for (const comp of edits) {
    if (!comp) continue;
    hdr.writeUInt16LE(comp.length, 3);
    fs.writeSync(fd, hdr);
    fs.writeSync(fd, comp);
  }
  fs.closeSync(fd);
}

// compila remapeando: keptOldIds[k] = id antigo que vira o novo id (k+1).
// rgbaEdits indexado por id ANTIGO. Escreve count = keptOldIds.length.
function compileSprRemap(spr, outPath, rgbaEdits, keptOldIds) {
  const ext = spr.ext, sig = spr.signature, transparency = spr.transparency;
  const count = keptOldIds.length;
  const headSize = ext ? 8 : 6;
  const head = Buffer.alloc(headSize);
  head.writeUInt32LE(sig >>> 0, 0);
  if (ext) head.writeUInt32LE(count, 4); else head.writeUInt16LE(count, 4);
  const table = Buffer.alloc(count * 4);
  let offset = headSize + count * 4;
  const comps = [];
  for (let k = 0; k < count; k++) {
    const oldId = keptOldIds[k];
    let comp;
    if (rgbaEdits && rgbaEdits.has(oldId)) comp = encodeSprite(rgbaEdits.get(oldId), transparency);
    else comp = spr.getCompressed(oldId);
    if (!comp || comp.length === 0) { table.writeUInt32LE(0, k * 4); comps.push(null); continue; }
    table.writeUInt32LE(offset, k * 4);
    comps.push(comp);
    offset += 5 + comp.length;
  }
  const fd = fs.openSync(outPath, 'w');
  fs.writeSync(fd, head);
  fs.writeSync(fd, table);
  const hdr = Buffer.alloc(5); hdr[0] = 0xFF; hdr[1] = 0x00; hdr[2] = 0xFF;
  for (const comp of comps) {
    if (!comp) continue;
    hdr.writeUInt16LE(comp.length, 3);
    fs.writeSync(fd, hdr);
    fs.writeSync(fd, comp);
  }
  fs.closeSync(fd);
}

const BATCH = 5000; // sprites por tick — ajuste conforme necessário
function yieldTick() { return new Promise((r) => setTimeout(r, 0)); }

// Async: processa em batches com yields (não bloqueia a UI thread).
async function compileSprAsync(spr, outPath, rgbaEdits, newCount, onProgress) {
  const ext = spr.ext, sig = spr.signature, transparency = spr.transparency;
  const count = newCount || spr.count;
  const headSize = ext ? 8 : 6;
  const head = Buffer.alloc(headSize);
  head.writeUInt32LE(sig >>> 0, 0);
  if (ext) head.writeUInt32LE(count, 4); else head.writeUInt16LE(count, 4);

  const table = Buffer.alloc(count * 4);
  let offset = headSize + count * 4;
  const comps = new Array(count);

  // primeira passada: encodar em batches com yield
  for (let i = 0; i < count; i += BATCH) {
    const end = Math.min(i + BATCH, count);
    for (let k = i; k < end; k++) {
      const id = k + 1;
      let comp;
      if (rgbaEdits && rgbaEdits.has(id)) comp = encodeSprite(rgbaEdits.get(id), transparency);
      else comp = spr.getCompressed(id);
      if (!comp || comp.length === 0) { table.writeUInt32LE(0, k * 4); comps[k] = null; continue; }
      table.writeUInt32LE(offset, k * 4);
      comps[k] = comp;
      offset += 5 + comp.length;
    }
    if (onProgress) onProgress(Math.round((i + BATCH) / count * 80));
    await yieldTick();
  }

  // segunda passada: escrever em batches com yield
  const fd = fs.openSync(outPath, 'w');
  fs.writeSync(fd, head);
  fs.writeSync(fd, table);
  const hdr = Buffer.alloc(5); hdr[0] = 0xFF; hdr[1] = 0x00; hdr[2] = 0xFF;
  for (let i = 0; i < count; i += BATCH) {
    const end = Math.min(i + BATCH, count);
    for (let k = i; k < end; k++) {
      const comp = comps[k]; if (!comp) continue;
      hdr.writeUInt16LE(comp.length, 3);
      fs.writeSync(fd, hdr);
      fs.writeSync(fd, comp);
    }
    if (onProgress) onProgress(80 + Math.round((i + BATCH) / count * 20));
    await yieldTick();
  }
  fs.closeSync(fd);
}

async function compileSprRemapAsync(spr, outPath, rgbaEdits, keptOldIds, onProgress) {
  const ext = spr.ext, sig = spr.signature, transparency = spr.transparency;
  const count = keptOldIds.length;
  const headSize = ext ? 8 : 6;
  const head = Buffer.alloc(headSize);
  head.writeUInt32LE(sig >>> 0, 0);
  if (ext) head.writeUInt32LE(count, 4); else head.writeUInt16LE(count, 4);

  const table = Buffer.alloc(count * 4);
  let offset = headSize + count * 4;
  const comps = new Array(count);

  for (let i = 0; i < count; i += BATCH) {
    const end = Math.min(i + BATCH, count);
    for (let k = i; k < end; k++) {
      const oldId = keptOldIds[k];
      let comp;
      if (rgbaEdits && rgbaEdits.has(oldId)) comp = encodeSprite(rgbaEdits.get(oldId), transparency);
      else comp = spr.getCompressed(oldId);
      if (!comp || comp.length === 0) { table.writeUInt32LE(0, k * 4); comps[k] = null; continue; }
      table.writeUInt32LE(offset, k * 4);
      comps[k] = comp;
      offset += 5 + comp.length;
    }
    if (onProgress) onProgress(Math.round((i + BATCH) / count * 80));
    await yieldTick();
  }

  const fd = fs.openSync(outPath, 'w');
  fs.writeSync(fd, head);
  fs.writeSync(fd, table);
  const hdr = Buffer.alloc(5); hdr[0] = 0xFF; hdr[1] = 0x00; hdr[2] = 0xFF;
  for (let i = 0; i < count; i += BATCH) {
    const end = Math.min(i + BATCH, count);
    for (let k = i; k < end; k++) {
      const comp = comps[k]; if (!comp) continue;
      hdr.writeUInt16LE(comp.length, 3);
      fs.writeSync(fd, hdr);
      fs.writeSync(fd, comp);
    }
    if (onProgress) onProgress(80 + Math.round((i + BATCH) / count * 20));
    await yieldTick();
  }
  fs.closeSync(fd);
}

module.exports = { encodeSprite, compileSpr, compileSprRemap, compileSprAsync, compileSprRemapAsync };
