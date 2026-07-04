// Worker thread: compila .spr sem bloquear a UI thread.
const { workerData, parentPort } = require('worker_threads');
const fs = require('fs');

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

function run() {
  const { sprFile, outPath, editsArr, newCount, ext, signature, transparency, remap } = workerData;
  // reconstruir edits Map
  const edits = new Map(editsArr);

  const headSize = ext ? 8 : 6;
  const count = newCount;

  const head = Buffer.alloc(headSize);
  head.writeUInt32LE(signature >>> 0, 0);
  if (ext) head.writeUInt32LE(count, 4); else head.writeUInt16LE(count, 4);

  const table = Buffer.alloc(count * 4);
  let offset = headSize + count * 4;
  const comps = [];

  // abre o .spr original pra ler sprites não editados
  const inFd = fs.openSync(sprFile, 'r');
  const inHead = Buffer.alloc(8);
  fs.readSync(inFd, inHead, 0, 8, 0);
  const origCount = ext ? inHead.readUInt32LE(4) : inHead.readUInt16LE(4);
  const offsetBase = ext ? 8 : 6;
  const inTable = Buffer.alloc(origCount * 4);
  fs.readSync(inFd, inTable, 0, inTable.length, offsetBase);

  const ids = remap || null; // null = sequencial 1..count

  for (let k = 0; k < count; k++) {
    const id = ids ? ids[k] : k + 1;
    let comp;
    if (edits.has(id)) {
      comp = encodeSprite(edits.get(id), transparency);
    } else if (id > 0 && id <= origCount) {
      const addr = inTable.readUInt32LE((id - 1) * 4);
      if (addr === 0) { table.writeUInt32LE(0, k * 4); comps.push(null); continue; }
      const hb = Buffer.alloc(5);
      fs.readSync(inFd, hb, 0, 5, addr);
      const size = hb.readUInt16LE(3);
      if (size === 0) { table.writeUInt32LE(0, k * 4); comps.push(null); continue; }
      comp = Buffer.alloc(size);
      fs.readSync(inFd, comp, 0, size, addr + 5);
    } else {
      table.writeUInt32LE(0, k * 4); comps.push(null); continue;
    }
    table.writeUInt32LE(offset, k * 4);
    comps.push(comp);
    offset += 5 + comp.length;
    if (k % 10000 === 0) parentPort.postMessage({ progress: Math.round(k / count * 100) });
  }

  fs.closeSync(inFd);

  const outFd = fs.openSync(outPath, 'w');
  fs.writeSync(outFd, head);
  fs.writeSync(outFd, table);
  const hdr = Buffer.alloc(5); hdr[0] = 0xFF; hdr[1] = 0x00; hdr[2] = 0xFF;
  for (const comp of comps) {
    if (!comp) continue;
    hdr.writeUInt16LE(comp.length, 3);
    fs.writeSync(outFd, hdr);
    fs.writeSync(outFd, comp);
  }
  fs.closeSync(outFd);
  parentPort.postMessage({ done: true });
}

run();
