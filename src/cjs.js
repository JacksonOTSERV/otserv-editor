// cjs.js — mini-loader CommonJS + shim de Buffer pro WebView do Tauri.
// Permite reusar os parsers do Electron (dat.js/bytereader.js/versions.js/otbm.js...) quase 1:1,
// sem bundler: pré-carrega o texto dos módulos (async) e resolve `require` de forma síncrona.

// ---- Buffer mínimo (estende Uint8Array → indexing/length/subarray nativos) ----
export class Buf extends Uint8Array {
  static alloc(n) { return new Buf(n); }
  static allocUnsafe(n) { return new Buf(n); }
  static from(x, enc) {
    if (typeof x === 'string') { const b = new Buf(x.length); for (let i = 0; i < x.length; i++) b[i] = x.charCodeAt(i) & 255; return b; }
    if (x instanceof Uint8Array) { const b = new Buf(x.length); b.set(x); return b; }
    if (Array.isArray(x)) return new Buf(x);
    if (x instanceof ArrayBuffer) return new Buf(x);
    return new Buf(x);
  }
  static concat(list, total) {
    if (total == null) { total = 0; for (const a of list) total += a.length; }
    const b = new Buf(total); let o = 0; for (const a of list) { b.set(a.subarray(0, Math.min(a.length, total - o)), o); o += a.length; if (o >= total) break; } return b;
  }
  static isBuffer(x) { return x instanceof Uint8Array; }
  readUInt8(o) { return this[o]; }
  readInt8(o) { const v = this[o]; return v < 128 ? v : v - 256; }
  readUInt16LE(o) { return this[o] | (this[o + 1] << 8); }
  readInt16LE(o) { const v = this[o] | (this[o + 1] << 8); return v < 32768 ? v : v - 65536; }
  readUInt32LE(o) { return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24)) >>> 0; }
  readInt32LE(o) { return this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24); } // bitwise = i32 com sinal
  writeUInt8(v, o) { this[o] = v & 255; return o + 1; }
  writeInt8(v, o) { this[o] = v & 255; return o + 1; }
  writeUInt16LE(v, o) { this[o] = v & 255; this[o + 1] = (v >> 8) & 255; return o + 2; }
  writeUInt32LE(v, o) { this[o] = v & 255; this[o + 1] = (v >>> 8) & 255; this[o + 2] = (v >>> 16) & 255; this[o + 3] = (v >>> 24) & 255; return o + 4; }
  writeInt32LE(v, o) { this[o] = v & 255; this[o + 1] = (v >> 8) & 255; this[o + 2] = (v >> 16) & 255; this[o + 3] = (v >> 24) & 255; return o + 4; }
  toString(enc, start = 0, end) { if (end == null) end = this.length; let s = ''; for (let i = start; i < end; i++) s += String.fromCharCode(this[i]); return s; } // latin1/binary
}
// subarray/slice já retornam Buf (species = construtor da subclasse). garante por via das dúvidas:
const _sub = Uint8Array.prototype.subarray;
Buf.prototype.subarray = function (s, e) { const r = _sub.call(this, s, e); Object.setPrototypeOf(r, Buf.prototype); return r; };
Buf.prototype.slice = function (s, e) { return Buf.from(_sub.call(this, s, e)); };
window.Buffer = Buf;

// ---- shims de módulos nativos ----
const fsShim = {
  // os parsers chamam readFileSync(bytes) — passamos os bytes já lidos via TFS
  readFileSync: (x) => { if (x instanceof Uint8Array) return Buf.from(x); throw new Error('fs.readFileSync indisponível no Tauri (passe os bytes)'); },
  existsSync: () => false,
  openSync: () => { throw new Error('fs.openSync indisponível no Tauri'); },
};
const pathShim = {
  join: (...a) => a.join('/').replace(/\/+/g, '/'),
  dirname: (p) => p.replace(/[\\/][^\\/]*$/, ''),
  basename: (p) => p.replace(/.*[\\/]/, ''),
  extname: (p) => { const m = p.match(/\.[^.\\/]*$/); return m ? m[0] : ''; },
};

// ---- loader ----
const _src = {}, _mod = {};
function req(name) {
  if (name === 'fs') return fsShim;
  if (name === 'path') return pathShim;
  const file = name.replace(/^\.\//, '').replace(/\.js$/, '') + '.js';
  if (_mod[file]) return _mod[file];
  if (!(file in _src)) throw new Error('módulo não pré-carregado: ' + file);
  const module = { exports: {} }; _mod[file] = module.exports;
  const fn = new Function('module', 'exports', 'require', 'Buffer', _src[file]);
  fn(module, module.exports, req, Buf);
  _mod[file] = module.exports; return module.exports;
}
export async function loadLibs(files) {
  await Promise.all(files.map(async (f) => { const fn = f.replace(/\.js$/, '') + '.js'; _src[fn] = await (await fetch('lib/' + fn)).text(); }));
}
export { req };
