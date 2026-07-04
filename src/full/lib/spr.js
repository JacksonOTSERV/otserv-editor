// Carrega Tibia.spr SEM jogar o arquivo inteiro na RAM.
// Guarda só header + tabela de offsets; lê cada sprite sob demanda (fd) + cache LRU.
// Suporta extended (count/indice u32) e transparency (pixel RGBA).
const fs = require('fs');
const path = require('path');

// ---- decoder nativo (Rust → wasm). carrega 1x; null se indisponível (cai no JS) ----
let _wasm = null, _wasmTried = false;
function sprWasm() {
  if (_wasmTried) return _wasm; _wasmTried = true;
  if (process.env.SPR_NO_WASM === '1') return null;
  try {
    const cands = [path.join(__dirname, '..', 'spr_wasm.wasm'), path.join(process.cwd(), 'spr_wasm.wasm')];
    let bytes = null; for (const p of cands) { if (fs.existsSync(p)) { bytes = fs.readFileSync(p); break; } }
    if (!bytes) return null;
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    const e = inst.exports;
    _wasm = { mem: e.memory, inPtr: e.input_ptr(), inCap: e.input_cap(), outPtr: e.output_ptr(), decode: e.decode };
  } catch (err) { _wasm = null; }
  return _wasm;
}
function sprWasmActive() { return !!sprWasm(); }

class Spr {
  // opts: { extended, transparency } — default tudo true (cliente atual)
  constructor(file, opts = {}) {
    this.ext = opts.extended !== false;
    this.transparency = opts.transparency !== false;
    this.file = file;
    this.fd = fs.openSync(file, 'r');

    const head = Buffer.alloc(8);
    fs.readSync(this.fd, head, 0, 8, 0);
    this.signature = head.readUInt32LE(0);
    this.count = this.ext ? head.readUInt32LE(4) : head.readUInt16LE(4);
    this.offsetBase = this.ext ? 8 : 6;                 // tabela: count * u32
    // lê a tabela de offsets inteira (count*4 bytes — pequeno) p/ acesso rápido
    this.table = Buffer.alloc(this.count * 4);
    fs.readSync(this.fd, this.table, 0, this.table.length, this.offsetBase);

    this.cache = new Map();
    this.maxCache = 6000; // LRU: limita RAM (cada sprite ~4KB decodificado)
  }

  close() { if (this.fd != null) { try { fs.closeSync(this.fd); } catch (e) {} this.fd = null; } }

  // bytes RLE crus de um sprite (pra reescrever sem recomprimir os nao-editados)
  getCompressed(id) {
    if (id <= 0 || id > this.count) return null;
    const addr = this.table.readUInt32LE((id - 1) * 4);
    if (addr === 0) return null;
    const hb = Buffer.alloc(5);                          // 3 color key + u16 size
    fs.readSync(this.fd, hb, 0, 5, addr);
    const size = hb.readUInt16LE(3);
    if (size === 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(size);
    fs.readSync(this.fd, buf, 0, size, addr + 5);
    return buf;
  }

  // Retorna Uint8ClampedArray RGBA (32*32*4) ou null se vazio. (cache LRU)
  sprite(id) {
    if (id <= 0 || id > this.count) return null;
    if (this.cache.has(id)) { const v = this.cache.get(id); this.cache.delete(id); this.cache.set(id, v); return v; }
    if (this.cache.size >= this.maxCache) { const it = this.cache.keys().next().value; this.cache.delete(it); }

    const comp = this.getCompressed(id);
    if (!comp || comp.length === 0) { this.cache.set(id, null); return null; }

    let px;
    const w = sprWasm();
    if (w && comp.length <= w.inCap) {
      // fast-path nativo (Rust/wasm): escreve comprimido na memória do wasm, decodifica, copia RGBA de volta
      new Uint8Array(w.mem.buffer, w.inPtr, comp.length).set(comp);
      w.decode(comp.length, this.transparency ? 1 : 0);
      px = new Uint8ClampedArray(new Uint8Array(w.mem.buffer, w.outPtr, 32 * 32 * 4)); // cópia (OUTPUT é reusado)
    } else {
      px = new Uint8ClampedArray(32 * 32 * 4); // 0 = transparente
      const bpp = this.transparency ? 4 : 3;
      let write = 0, read = 0; const size = comp.length;
      while (read < size && write < 32 * 32) {
        const transparent = comp.readUInt16LE(read); read += 2;
        write += transparent;
        const colored = comp.readUInt16LE(read); read += 2;
        for (let i = 0; i < colored && write < 32 * 32; i++) {
          const o = write * 4;
          px[o] = comp[read]; px[o + 1] = comp[read + 1]; px[o + 2] = comp[read + 2];
          px[o + 3] = this.transparency ? comp[read + 3] : 255;
          read += bpp; write++;
        }
      }
    }
    this.cache.set(id, px);
    return px;
  }
}
Spr.wasmActive = sprWasmActive;
module.exports = Spr;
