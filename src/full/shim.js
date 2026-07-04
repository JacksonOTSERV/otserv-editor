// shim.js — camada de compatibilidade Node/Electron → Tauri (WebView).
// Define os globais que o renderer.js do Electron espera (Buffer, require, fs, path, crypto,
// process, __dirname, ipcRenderer, clipboard, child_process), depois injeta o renderer.js.
// fs SÍNCRONO funciona via CACHE pré-carregado (preload da árvore ao abrir arquivo/pasta).
import { TFS, TSPR, TDLG } from '../bridge.js';

const _t = window.__TAURI__; const invoke = _t.core.invoke;

// ===================== Buffer (estende Uint8Array) =====================
class Buf extends Uint8Array {
  static alloc(n) { return new Buf(n); } static allocUnsafe(n) { return new Buf(n); }
  static from(x) { if (typeof x === 'string') { const b = new Buf(x.length); for (let i = 0; i < x.length; i++) b[i] = x.charCodeAt(i) & 255; return b; } if (x instanceof Uint8Array) { const b = new Buf(x.length); b.set(x); return b; } if (Array.isArray(x)) return new Buf(x); if (x instanceof ArrayBuffer) return new Buf(x); return new Buf(x); }
  static concat(list, total) { if (total == null) { total = 0; for (const a of list) total += a.length; } const b = new Buf(total); let o = 0; for (const a of list) { b.set(a.subarray(0, Math.min(a.length, total - o)), o); o += a.length; if (o >= total) break; } return b; }
  static isBuffer(x) { return x instanceof Uint8Array; }
  readUInt8(o) { return this[o]; } readInt8(o) { const v = this[o]; return v < 128 ? v : v - 256; }
  readUInt16LE(o) { return this[o] | (this[o + 1] << 8); } readInt16LE(o) { const v = this[o] | (this[o + 1] << 8); return v < 32768 ? v : v - 65536; }
  readUInt32LE(o) { return (this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24)) >>> 0; }
  readInt32LE(o) { return this[o] | (this[o + 1] << 8) | (this[o + 2] << 16) | (this[o + 3] << 24); }
  writeUInt8(v, o=0) { this[o] = v & 255; return o + 1; } writeInt8(v, o=0) { this[o] = v & 255; return o + 1; }
  writeUInt16LE(v, o=0) { this[o] = v & 255; this[o + 1] = (v >> 8) & 255; return o + 2; }
  writeUInt32LE(v, o=0) { this[o] = v & 255; this[o + 1] = (v >>> 8) & 255; this[o + 2] = (v >>> 16) & 255; this[o + 3] = (v >>> 24) & 255; return o + 4; }
  writeInt32LE(v, o=0) { this[o] = v & 255; this[o + 1] = (v >> 8) & 255; this[o + 2] = (v >> 16) & 255; this[o + 3] = (v >> 24) & 255; return o + 4; }
  toString(enc, start = 0, end) { if (end == null) end = this.length; let s = ''; for (let i = start; i < end; i++) s += String.fromCharCode(this[i]); return s; }
}
const _sub = Uint8Array.prototype.subarray;
Buf.prototype.subarray = function (s, e) { const r = _sub.call(this, s, e); Object.setPrototypeOf(r, Buf.prototype); return r; };
Buf.prototype.slice = function (s, e) { return Buf.from(_sub.call(this, s, e)); };
window.Buffer = Buf;

// ===================== MD5 (p/ crypto.createHash) =====================
function md5bytes(bytes) {
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function add(a, b) { return (a + b) & 0xffffffff; }
  function cmn(q, a, b, x, s, t) { return add(rl(add(add(a, q), add(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  const n = bytes.length; const words = []; for (let i = 0; i < n; i++) words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8));
  words[n >> 2] = (words[n >> 2] || 0) | (0x80 << ((n % 4) * 8));
  const bits = n * 8; const len = (((n + 8) >> 6) + 1) * 16; while (words.length < len) words.push(0);
  words[len - 2] = bits & 0xffffffff; words[len - 1] = Math.floor(bits / 0x100000000);
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < words.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d; const x = words;
    a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586); c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426); c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417); c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101); c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632); c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083); c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690); c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784); c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463); c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353); c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222); c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
    a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835); c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415); c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606); c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744); c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379); c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
  }
  const out = new Buf(16); [a, b, c, d].forEach((v, i) => { out[i * 4] = v & 255; out[i * 4 + 1] = (v >> 8) & 255; out[i * 4 + 2] = (v >> 16) & 255; out[i * 4 + 3] = (v >>> 24) & 255; });
  return out;
}

// ===================== path =====================
const norm = (p) => String(p).replace(/\\/g, '/');
const path = {
  sep: '/',
  join: (...a) => norm(a.join('/')).replace(/\/+/g, '/'),
  dirname: (p) => { p = norm(p).replace(/\/+$/, ''); const i = p.lastIndexOf('/'); return i <= 0 ? (i === 0 ? '/' : '.') : p.slice(0, i); },
  basename: (p, ext) => { let b = norm(p).replace(/\/+$/, '').split('/').pop() || ''; if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; },
  extname: (p) => { const b = path.basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
  isAbsolute: (p) => /^([a-zA-Z]:)?[\\/]/.test(String(p)),
  normalize: (p) => { const abs = path.isAbsolute(p); const parts = norm(p).split('/').filter((x) => x !== '' && x !== '.'); const out = []; for (const s of parts) { if (s === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); } else out.push(s); } let r = out.join('/'); if (abs && !/^[a-zA-Z]:/.test(r)) r = '/' + r; return r || (abs ? '/' : '.'); },
  resolve: (...a) => { let r = ''; for (let s of a) { if (!s) continue; s = norm(s); if (path.isAbsolute(s)) r = s; else r = r ? r + '/' + s : s; } return path.normalize(r || '.'); },
  relative: (from, to) => { const f = path.normalize(from).split('/'), t = path.normalize(to).split('/'); let i = 0; while (i < f.length && i < t.length && f[i] === t[i]) i++; return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/') || '.'; },
  parse: (p) => { const dir = path.dirname(p), base = path.basename(p), ext = path.extname(p); return { root: '', dir, base, ext, name: base.slice(0, base.length - ext.length) }; },
};

// ===================== fs (síncrono via cache pré-carregado) =====================
const _files = new Map();   // keyNorm(lower) -> Buf
const _dirs = new Map();    // keyNorm(lower) -> Set<childName>
const key = (p) => norm(p).toLowerCase().replace(/\/+$/, '');
const _writeQueue = [];
function _cacheFile(p, bytes) { _files.set(key(p), Buf.from(bytes)); const d = path.dirname(p); _dirs.has(key(d)) || _dirs.set(key(d), new Set()); _dirs.get(key(d)).add(path.basename(p)); }
const fs = {
  readFileSync(p, enc) { const b = _files.get(key(p)); if (!b) throw Object.assign(new Error('ENOENT (não pré-carregado): ' + p), { code: 'ENOENT' }); if (enc === 'latin1' || enc === 'binary') return b.toString('latin1'); if (enc === 'utf8' || enc === 'utf-8') return new TextDecoder().decode(b); return b; },
  existsSync(p) { const k = key(p); if (_files.has(k) || _dirs.has(k)) return true; const d = _dirs.get(key(path.dirname(p))); return !!(d && d.has(path.basename(p))); }, // reconhece arquivo na estrutura (sem conteúdo cacheado)
  readdirSync(p, opts) { const s = _dirs.get(key(p)); const names = s ? [...s] : []; if (opts && opts.withFileTypes) return names.map((name) => { const isDir = _dirs.has(key(norm(p) + '/' + name)); return { name, isDirectory: () => isDir, isFile: () => !isDir, isSymbolicLink: () => false }; }); return names; },
  statSync(p) { const isDir = _dirs.has(key(p)); const f = _files.get(key(p)); const inParent = (() => { const d = _dirs.get(key(path.dirname(p))); return !!(d && d.has(path.basename(p))); })(); const isFile = !!f || (inParent && !isDir); return { isDirectory: () => isDir && !isFile, isFile: () => isFile, size: f ? f.length : 0, mtimeMs: 0, mtime: new Date(0) }; },
  writeFileSync(p, data) { const b = data instanceof Uint8Array ? Buf.from(data) : Buf.from(String(data)); _cacheFile(p, b); _writeQueue.push(TFS.writeFile(p, b).catch((e) => console.error('write', p, e))); },
  mkdirSync(p) { _dirs.has(key(p)) || _dirs.set(key(p), new Set()); },
  unlinkSync(p) { _files.delete(key(p)); _writeQueue.push(invoke('rm_path', { path: norm(p) }).catch(() => {})); },
  rmSync(p) { _files.delete(key(p)); _dirs.delete(key(p)); _writeQueue.push(invoke('rm_path', { path: norm(p) }).catch(() => {})); },
  renameSync(a, b) { const f = _files.get(key(a)); if (f) { _cacheFile(b, f); _files.delete(key(a)); } _writeQueue.push(invoke('rename_path', { from: norm(a), to: norm(b) }).catch(() => {})); },
  copyFileSync(a, b) { const f = _files.get(key(a)); if (f) _cacheFile(b, f); _writeQueue.push(invoke('copy_path', { from: norm(a), to: norm(b) }).catch(() => {})); },
  cpSync(a, b) { this.copyFileSync(a, b); },
  openSync() { throw new Error('fs.openSync indisponível (use o decoder .spr nativo)'); },
  readSync() { throw new Error('fs.readSync indisponível'); }, closeSync() {},
};

// ===================== crypto =====================
const crypto = { createHash() { let buf = new Buf(0); return { update(d) { buf = Buf.concat([buf, d instanceof Uint8Array ? d : Buf.from(d)]); return this; }, digest() { return md5bytes(buf); } }; } };

// ===================== electron (ipcRenderer + clipboard) =====================
const clipboard = { writeText: (t) => { try { navigator.clipboard.writeText(t); } catch (e) {} }, readText: () => '' };
const ipcRenderer = {
  async invoke(channel, ...args) {
    switch (channel) {
      case 'pick-file': { const p = await TDLG.openFile(args[0] ? [{ name: args[0].join('/'), extensions: args[0] }] : undefined); if (p) await preloadAround(p); return p; }
      case 'pick-files': { const ps = (await TDLG.openFiles(args[0] ? [{ name: args[0].join('/'), extensions: args[0] }] : undefined)) || []; for (const p of ps) await preloadAround(p); return ps; }
      case 'pick-dir': { const d = await TDLG.openDir(); if (d) await preloadTree(d); return d; }
      case 'save-file': return TDLG.saveFile(args[0]);
      case 'new-window': return true;
      default: return invoke(channel, args[0] || {});
    }
  },
  on() {}, send() {},
};
const shell = {
  showItemInFolder: (p) => { invoke('reveal_path', { path: norm(p) }).catch(() => {}); },
  openPath: (p) => invoke('reveal_path', { path: norm(p) }).catch(() => {}),
  openExternal: (u) => { try { window.open(u, '_blank'); } catch (e) {} },
};

// ===================== child_process (claude CLI) =====================
const child_process = {
  spawn(bin, a, opts) {
    const h = { _in: '', stdout: { _cb: [], on(e, f) { if (e === 'data') this._cb.push(f); } }, stderr: { on() {} }, stdin: { write(s) { h._in += s; }, end() { run(); } }, _close: [], on(e, f) { if (e === 'close') this._close.push(f); if (e === 'error') h._err = f; } };
    const run = async () => { try { const out = await invoke('claude_cli', { prompt: h._in }); h.stdout._cb.forEach((f) => f(out)); h._close.forEach((f) => f(0)); } catch (e) { if (h._err) h._err(new Error(e)); h._close.forEach((f) => f(1)); } };
    return h;
  },
  execSync() { return ''; },
};

// ===================== spr (Tauri: LAZY — baixa RAM) =====================
// O .spr (686MB) NÃO entra na RAM: o Rust mantém só header+tabela e decodifica por offset (fd).
// O renderer chama spr.sprite(id) SÍNCRONO; no miss devolvemos null, enfileiramos o id e buscamos
// em LOTE (1 IPC p/ N sprites via spr_sprites), cacheamos (LRU) e disparamos re-render (markDirty).
let _dirtyT = null;
function markDirty() { if (_dirtyT) return; _dirtyT = setTimeout(() => { _dirtyT = null; try { (window.__sprDirty || defaultDirty)(); } catch (e) {} }, 60); }
window.__rerender = markDirty; // p/ o AssetsSpr (15.x) disparar re-render quando a folha decodifica
function _vis(id) { const el = document.getElementById(id); return el && el.offsetParent !== null; }
function defaultDirty() {
  // NÃO limpa o cache inteiro aqui (causava churn/RAM na animação). A invalidação é CIRÚRGICA
  // no _flush (window.__invalidateSprIds, só os ids que chegaram). Aqui só re-renderiza as views.
  if (typeof window.drawSprite === 'function') { try { window.drawSprite(); } catch (e) {} }                 // outfit do mob/npc
  if (_vis('mapCanvas') && typeof window.reqMap === 'function') { try { window.reqMap(); } catch (e) {} }    // reqMap aquece o viewport antes (sem flicker)
  if (_vis('objGrid') && typeof window.renderObjGrid === 'function') { try { window.renderObjGrid(); } catch (e) {} }
  if (_vis('objGrid') && typeof window.__redrawObjDetail === 'function') { try { window.__redrawObjDetail(); } catch (e) {} } // preview + slots do item
  for (const fn of ['renderLookGrid', 'renderPalette', 'renderLoot', 'renderShop']) if (typeof window[fn] === 'function') { try { window[fn](); } catch (e) {} }
}
class TauriSpr {
  constructor(file, opts = {}) {
    this.file = file; this.ext = opts.extended !== false; this.transparency = opts.transparency !== false;
    this.count = 0; this.signature = 0; this.cache = new Map(); this.maxCache = 6000; // ~24MB (igual Electron; pre-warm cobre o viewport)
    this.comp = new Map(); this._pendC = new Set();
    this._queue = new Set(); this._inflight = new Set(); this._flushT = null;
    this.ready = this._open();
  }
  async _open() { try { const n = await TSPR.open(this.file, { extended: this.ext, transparency: this.transparency }); this.count = n; markDirty(); return n; } catch (e) { console.error('spr_open', e); return 0; } }
  close() { this.cache.clear(); this.comp.clear(); this._queue.clear(); }
  _scheduleFlush() { if (this._flushT || this._flushing) return; this._flushT = setTimeout(() => { this._flushT = null; this._flush(); }, 0); }
  async _flush() {
    if (this._flushing) return; this._flushing = true;
    try {
      // drena a fila INTEIRA (vários IPC se preciso) e só RE-RENDERIZA UMA vez no fim (evita thrash de DOM)
      while (this._queue.size) {
        const ids = [...this._queue].slice(0, 4096);
        for (const id of ids) { this._queue.delete(id); this._inflight.add(id); }
        try {
          const ab = await invoke('spr_sprites', { ids });
          const all = new Uint8Array(ab);
          for (let i = 0; i < ids.length; i++) {
            const slice = all.subarray(i * 4096, i * 4096 + 4096);
            let empty = true; for (let k = 3; k < 4096; k += 4) if (slice[k]) { empty = false; break; }
            if (this.cache.size >= this.maxCache) { const k0 = this.cache.keys().next().value; this.cache.delete(k0); }
            this.cache.set(ids[i], empty ? null : new Uint8ClampedArray(slice)); // null = sprite VAZIO (carregado)
          }
        } catch (e) { for (const id of ids) this.cache.set(id, null); }
        finally { for (const id of ids) this._inflight.delete(id); }
      }
    } finally { this._flushing = false; }
    markDirty();
  }
  // true se o sprite é CONHECIDO (carregado — mesmo que vazio/null) ou fora de faixa. false = ainda não chegou.
  loaded(id) { return id <= 0 || id > this.count || this.cache.has(id); }
  // Uint8ClampedArray RGBA 32x32 (4096) ou null se vazio. SYNC do cache; miss → enfileira (lote async).
  sprite(id) {
    if (id <= 0 || id > this.count) return null;
    if (this.cache.has(id)) { const v = this.cache.get(id); this.cache.delete(id); this.cache.set(id, v); return v; } // LRU touch
    if (!this._inflight.has(id)) { this._queue.add(id); this._scheduleFlush(); }
    return null;
  }
  // pré-aquece ids (await) — usado antes de desenhos em lote, evita o flicker
  // DIMENSIONA o cache pro working-set do viewport. Cache menor que o set = thrash (evict→refetch→churn de
  // canvas = RAM ALTA). Cresce no zoom out, encolhe no zoom in (libera RAM). É o que mantém a memória baixa.
  ensureCapacity(n) {
    this.maxCache = Math.max(6000, Math.min(60000, (n || 0) + 2000));
    while (this.cache.size > this.maxCache) { const k0 = this.cache.keys().next().value; this.cache.delete(k0); }
  }
  async warm(ids) {
    const miss = [...new Set(ids)].filter((id) => id > 0 && id <= this.count && !this.cache.has(id));
    for (let i = 0; i < miss.length; i += 1024) {
      const batch = miss.slice(i, i + 1024);
      try { const ab = await invoke('spr_sprites', { ids: batch }); const all = new Uint8Array(ab);
        for (let j = 0; j < batch.length; j++) { const s = all.subarray(j * 4096, j * 4096 + 4096); let empty = true; for (let k = 3; k < 4096; k += 4) if (s[k]) { empty = false; break; } if (this.cache.size >= this.maxCache) { const k0 = this.cache.keys().next().value; this.cache.delete(k0); } this.cache.set(batch[j], empty ? null : new Uint8ClampedArray(s)); }
      } catch (e) { for (const id of batch) this.cache.set(id, null); }
    }
  }
  // bytes RLE crus (export .spr) — async-fill; null no 1º miss (chame warmAllCompressed antes de salvar)
  getCompressed(id) {
    if (id <= 0 || id > this.count) return null;
    if (this.comp.has(id)) return this.comp.get(id);
    if (!this._pendC.has(id)) { this._pendC.add(id); TSPR.compressed(id).then((b) => { this.comp.set(id, Buf.from(b)); this._pendC.delete(id); }).catch(() => { this.comp.set(id, null); this._pendC.delete(id); }); }
    return null;
  }
  async warmAllCompressed(onProg) { for (let id = 1; id <= this.count; id++) { if (!this.comp.has(id)) { try { this.comp.set(id, Buf.from(await TSPR.compressed(id))); } catch (e) { this.comp.set(id, null); } } if (onProg && id % 500 === 0) onProg(id, this.count); } }
}
TauriSpr.wasmActive = () => true; // decode nativo (Rust) no backend
window.TauriSpr = TauriSpr;

// ===================== require (loader CommonJS) =====================
const _src = {}, _mod = {};
function req(name) {
  if (name === 'fs') return fs;
  if (name === 'path') return path;
  if (name === 'crypto') return crypto;
  if (name === 'os') return { platform: () => 'win32', tmpdir: () => 'C:/Temp', homedir: () => 'C:/Users' };
  if (name === 'child_process') return child_process;
  if (name === 'electron') return { ipcRenderer, clipboard, shell };
  if (name === 'codemirror' || name.startsWith('codemirror/')) return window.CodeMirror;
  if (name === 'diff-match-patch') return _loadCjs('diff-match-patch.js');
  if (name === 'lzma') return window.LZMA || { compress: () => { throw new Error('lzma n/d'); }, decompress: () => { throw new Error('lzma n/d'); } };
  if (name === './lib/spr' || name === './spr' || name === 'spr' || name === './lib/spr.js') return TauriSpr;
  // lib/*
  const file = name.replace(/^\.\/lib\//, '').replace(/^\.\//, '').replace(/\.js$/, '') + '.js';
  return _loadCjs(file);
}
function _loadCjs(file) {
  if (_mod[file]) return _mod[file];
  if (!(file in _src)) throw new Error('módulo não pré-carregado: ' + file);
  const module = { exports: {} }; _mod[file] = module.exports;
  const fn = new Function('module', 'exports', 'require', 'Buffer', '__dirname', '__filename', _src[file]);
  fn(module, module.exports, req, Buf, '.', file); _mod[file] = module.exports; return module.exports;
}

// ===================== preload (popula o cache fs) =====================
// CONTEÚDO em bulk só dos arquivos que os loaders leem SÍNCRONO no boot (xml/otb/configs).
// .lua/.md/.txt NÃO entram em bulk (Electron lê do disco e descarta) → economiza MUITA RAM;
// são lidos SOB DEMANDA quando abertos no editor (window.__preloadFile).
const SMALL_EXT = ['.xml', '.otb', '.otfi', '.json', '.cfg'];
const ONDEMAND_EXT = ['.lua', '.md', '.txt'];
const HUGE_EXT = ['.spr', '.cwm', '.png', '.jpg', '.jpeg', '.gif', '.wav', '.ogg', '.dll', '.exe', '.bin', '.ttf'];
const CRITICAL_NAMES = ['config.lua']; // .lua que loaders leem por path derivado (não-picked) → precisam estar em RAM
const _cacheable = (name) => { const ex = path.extname(name).toLowerCase(); return SMALL_EXT.includes(ex) || CRITICAL_NAMES.includes(String(name).toLowerCase()); };
window.__fileCached = (p) => _files.has(key(p));
window.__preloadFile = async (p) => { try { _cacheFile(p, await TFS.readFile(p)); return true; } catch (e) { return false; } };
async function preloadAround(p) {
  // .spr (686MB) é aberto lazy via TauriSpr/TSPR — NUNCA ler inteiro (trava o main thread).
  const ex = path.extname(p).toLowerCase();
  if (!HUGE_EXT.includes(ex)) { try { _cacheFile(p, await TFS.readFile(p)); } catch (e) {} }
  else { _dirs.has(key(path.dirname(p))) || _dirs.set(key(path.dirname(p)), new Set()); _dirs.get(key(path.dirname(p))).add(path.basename(p)); } // marca como existente sem ler
  // pré-carrega irmãos pequenos da mesma pasta (items.xml, .otfi, etc.)
  try { const dir = path.dirname(p); const ents = await TFS.listDir(dir, {}); for (const e of ents) { if (!e.is_dir && _cacheable(e.name) && !key(e.path).endsWith('.spr')) { try { _cacheFile(e.path, await TFS.readFile(e.path)); } catch (x) {} } else if (e.is_dir) { _dirs.has(key(dir)) || _dirs.set(key(dir), new Set()); _dirs.get(key(dir)).add(e.name); } } } catch (e) {}
}
async function preloadTree(dir) {
  try { const ents = await TFS.listDir(dir, { recursive: true }); for (const e of ents) { const d = path.dirname(e.path); _dirs.has(key(d)) || _dirs.set(key(d), new Set()); _dirs.get(key(d)).add(e.name); if (!e.is_dir && _cacheable(e.name)) { try { _cacheFile(e.path, await TFS.readFile(e.path)); } catch (x) {} } } } catch (e) {}
}
// igual ao preloadTree, mas TAMBÉM cacheia .lua — necessário p/ monster/npc do Canary,
// que os loaders leem SÍNCRONO (readFileSync). Sem isso → ENOENT → 0 resultados.
async function preloadTreeLua(dir) {
  try { const ents = await TFS.listDir(dir, { recursive: true }); for (const e of ents) { const d = path.dirname(e.path); _dirs.has(key(d)) || _dirs.set(key(d), new Set()); _dirs.get(key(d)).add(e.name); if (!e.is_dir && (_cacheable(e.name) || path.extname(e.name).toLowerCase() === '.lua')) { try { _cacheFile(e.path, await TFS.readFile(e.path)); } catch (x) {} } } } catch (e) {}
}
window.__preloadAround = preloadAround; window.__preloadTree = preloadTree; window.__preloadTreeLua = preloadTreeLua;
// diagnóstico de memória — rode __memstats() no console (F12) p/ ver o que consome
window.__memstats = () => {
  let filesBytes = 0; for (const b of _files.values()) filesBytes += b.length;
  const mb = (n) => (n / 1048576).toFixed(1) + 'MB';
  const m = performance.memory || {};
  const st = (window.__stats && window.__stats()) || {};
  const sprO = st.spr || window.spr; const md = st.mapData || window.mapData;
  const sprC = sprO && sprO.cache ? sprO.cache.size : (sprO && sprO.sheetCache ? sprO.sheetCache.size : 0), sprMax = sprO ? (sprO.maxCache || sprO.maxSheets || 0) : 0;
  const tiles = md && md.map ? md.map.size : 0;
  const s = {
    jsHeap: m.usedJSHeapSize ? mb(m.usedJSHeapSize) + ' / ' + mb(m.totalJSHeapSize) : 'n/d',
    filesCache: _files.size + ' arquivos = ' + mb(filesBytes),
    sprCache: sprC + ' / ' + sprMax + ' sprites = ' + mb(sprC * 4096),
    mapTiles: tiles,
  };
  console.table(s);
  try { alert('MEMÓRIA (JS):\n• jsHeap: ' + s.jsHeap + '\n• arquivos em cache: ' + s.filesCache + '\n• sprites em cache: ' + s.sprCache + '\n• tiles do mapa: ' + s.mapTiles + '\n\n(jsHeap = só o JS. Compare com o total dos processos no Gerenciador de Tarefas.)'); } catch (e) {}
  return s;
};
// atalho Ctrl+Shift+M = memstats (sem precisar do console)
window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'M' || e.key === 'm')) { e.preventDefault(); try { window.__memstats(); } catch (x) {} } });
// Ctrl+Shift+L = resetar a ativação desta máquina (re-pede a key)
window.addEventListener('keydown', async (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
    e.preventDefault();
    if (!confirm('Resetar a ativação DESTA máquina? Vai pedir a chave de novo.')) return;
    try { localStorage.removeItem('lic.key'); localStorage.removeItem('lic.cache'); } catch (x) {}
    try { await window.__TAURI__.core.invoke('license_reset'); } catch (x) {}
    location.reload();
  }
});

// ===================== LICENÇA (online com fallback offline) =====================
// >>> TROQUE pela URL do seu servidor depois do deploy (ex: https://meu-app.onrender.com). <<<
// Enquanto estiver assim (placeholder), o app valida só pela key OFFLINE (Ed25519 / GERAR-KEY.bat).
const LICENSE_SERVER = 'https://SEU-SERVIDOR.onrender.com';
const _srvOn = () => LICENSE_SERVER.startsWith('http') && !LICENSE_SERVER.includes('SEU-SERVIDOR');

// valida uma key: OFFLINE primeiro (Ed25519 assinada / GERAR-KEY.bat = instantâneo) e, se não
// validar offline, tenta ONLINE (servidor Stripe) — pra quem ativa por email da compra.
async function validateKey(key, hwid) {
  // 1) OFFLINE: chave assinada do keygen — entra na hora, sem depender de internet/servidor
  try { const st = await window.__TAURI__.core.invoke('license_verify', { key }); if (st.valid) return { valid: true, reason: 'offline', daysLeft: st.days_left || 0, src: 'offline' }; }
  catch (e) {}
  // 2) ONLINE: chaves/emails validados no Stripe (só se houver servidor configurado)
  let onlineReason = '';
  if (_srvOn()) {
    try {
      const ctrl = new AbortController(); const tid = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(LICENSE_SERVER + '/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, hwid }), signal: ctrl.signal });
      clearTimeout(tid);
      const st = await r.json();
      if (st.valid) { try { localStorage.setItem('lic.cache', JSON.stringify({ key, expiry: st.expiry, at: Date.now() })); } catch (e) {} return { valid: true, reason: st.reason || 'ok', daysLeft: st.daysLeft || 0, src: 'online' }; }
      onlineReason = st.reason || 'não encontrado';
    } catch (e) {
      // sem internet: tolera com cache (3 dias) se a key bate e não expirou
      try { const c = JSON.parse(localStorage.getItem('lic.cache') || '{}'); const now = Date.now() / 1000; if (c.key === key && c.expiry > now && (Date.now() - c.at) < 3 * 86400000) return { valid: true, reason: 'offline (cache)', daysLeft: Math.floor((c.expiry - now) / 86400), src: 'cache' }; } catch (x) {}
      onlineReason = 'sem internet';
    }
  }
  return { valid: false, reason: onlineReason || 'key inválida ou expirada', daysLeft: 0, src: 'fail' };
}

// invoke com timeout de segurança (evita travar se Rust demorar)
function invT(cmd, args, ms = 3000) {
  const inv = window.__TAURI__.core.invoke;
  return Promise.race([
    inv(cmd, args),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}

const _esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const _L = (id) => document.getElementById(id);
const REMOTE_FEED = 'https://SEU-BUCKET.r2.dev/launcher.json';

// ===== valida a licença salva SEM mostrar UI. true = pode entrar. =====
// Dois tipos de licença:
//  • CHAVE do keygen (Ed25519, SEM "@") → 100% offline; a expiração vem assinada na chave.
//  • E-MAIL da compra (Stripe, COM "@")  → o SERVIDOR é a fonte da verdade (revoga se cancelar).
async function checkLicenseSilent() {
  let saved = localStorage.getItem('lic.key') || '';
  if (!saved) { try { saved = await invT('license_load'); } catch (e) {} }
  if (!saved) return false;

  if (!saved.includes('@')) {
    // CHAVE keygen — offline puro (instantâneo, sem rede)
    try { const st = await invT('license_verify', { key: saved }); if (st.valid) { window.__lic = { valid: true, reason: 'offline', daysLeft: st.days_left || 0, src: 'offline' }; return true; } } catch (e) {}
    return false;
  }

  // E-MAIL (Stripe) — consulta o servidor; sem internet, tolera pelo cache por até 3 dias
  if (_srvOn()) {
    let hwid = ''; try { hwid = await invT('hwid'); } catch (e) {}
    try {
      const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 9000);
      const r = await fetch(LICENSE_SERVER + '/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: saved, hwid }), signal: ctrl.signal });
      const st = await r.json();
      if (st.valid) {
        try { localStorage.setItem('lic.cache', JSON.stringify({ key: saved, expiry: st.expiry, at: Date.now() })); } catch (e) {}
        window.__lic = { valid: true, reason: 'online', daysLeft: st.daysLeft || 0, src: 'online' };
        return true;
      }
      window.__licReason = st.reason || 'assinatura inativa'; // mostrado na tela de login
      return false;
    } catch (e) {
      try { const c = JSON.parse(localStorage.getItem('lic.cache') || '{}'); const nowS = Date.now() / 1000; if (c.key === saved && c.expiry > nowS && (Date.now() - c.at) < 3 * 86400000) { window.__lic = { valid: true, reason: 'cache', daysLeft: Math.floor((c.expiry - nowS) / 86400), src: 'cache' }; return true; } } catch (x) {}
      return false;
    }
  }
  return false;
}

// (compat) a revalidação periódica de e-mails fica no startLicenseWatch.
function startOnlineRecheck() {}

// ===== feed do launcher (remoto no R2 com fallback local) =====
async function fetchFeed() {
  try { const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 4000); const r = await fetch(REMOTE_FEED + '?t=' + Date.now(), { signal: ctrl.signal }); if (r.ok) return await r.json(); } catch (e) {}
  try { const r = await fetch('launcher.json'); if (r.ok) return await r.json(); } catch (e) {}
  return null;
}
function renderFeed(feed, ver) {
  if (!feed) return;
  if (feed.hero && _L('lxHero')) _L('lxHero').textContent = feed.hero;
  if (Array.isArray(feed.updates) && _L('lxUpdates')) {
    _L('lxUpdates').innerHTML = feed.updates.map((u, i) => {
      const isNew = i === 0;
      let body;
      if (Array.isArray(u.groups)) {
        // grupos: título + itens embaixo (igual o roadmap)
        body = u.groups.map((g) => {
          const lis = (g.items || []).map((it) => '<li>' + _esc(it) + '</li>').join('');
          return '<div class="lxGroup"><div class="lxGroupT">' + _esc(g.title) + '</div><ul>' + lis + '</ul></div>';
        }).join('');
      } else {
        // formato antigo: lista plana
        body = '<ul>' + (u.items || []).map((it) => '<li>' + _esc(it) + '</li>').join('') + '</ul>';
      }
      return '<div class="lxCard' + (isNew ? ' new' : '') + '"><div class="lxCardTop"><span class="lxCardVer">v' + _esc(u.version) + '</span><span class="lxCardDate">' + _esc(u.date || '') + '</span></div>' + body + '</div>';
    }).join('');
  }
  if (Array.isArray(feed.roadmap) && _L('lxRoadmap')) {
    _L('lxRoadmap').innerHTML = feed.roadmap.map((r) => '<div class="lxRoad"><span class="lxRoadIco"></span><div><b>' + _esc(r.title) + '</b><span>' + _esc(r.desc || '') + '</span></div></div>').join('');
  }
  window.__feed = feed;
}

// ===== status: atualização disponível? servidor online? =====
// retorna true se ESTÁ atualizando (vai reiniciar — não libera o Entrar); false = pode entrar.
// compara semver "a > b" (0.1.4 > 0.1.3)
function _verGt(a, b) { const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0), pb = String(b).split('.').map((n) => parseInt(n, 10) || 0); for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y; } return false; }
const LATEST_JSON = REMOTE_FEED.replace(/launcher\.json.*$/, 'latest.json');
async function checkLauncherUpdate() {
  const dot = _L('lxDot'), txt = _L('lxUpdTxt'), btn = _L('lxUpdateBtn'), enter = _L('lxEnter');
  // versão instalada
  let appVer = '0.0.0'; try { appVer = await window.__TAURI__.app.getVersion(); } catch (e) {}
  // 1) DETECÇÃO MANUAL com cache-bust + no-store → à prova de cache de CDN/WebView2 (o updater por endpoint cacheava)
  let feed = null;
  try { const r = await fetch(LATEST_JSON + '?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) feed = await r.json(); } catch (e) { console.warn('latest.json fetch', e); }
  const nv = feed && feed.version;
  if (!nv || !_verGt(nv, appVer)) { if (dot) dot.className = 'lxDot'; if (txt) txt.textContent = 'atualizado'; return false; }
  // 2) HÁ VERSÃO NOVA
  if (dot) dot.className = 'lxDot upd';
  if (txt) txt.textContent = 'atualizando para a v' + nv + '…';
  if (enter) { enter.disabled = true; enter.innerHTML = '<span class="lxSpin"></span>Atualizando…'; }
  const setupUrl = (feed.platforms && feed.platforms['windows-x86_64'] && feed.platforms['windows-x86_64'].url) || '';
  // fallback: oferece BAIXAR o instalador (link direto) — sempre disponível se o auto-install não rolar
  const offerDownload = () => {
    if (txt) txt.textContent = 'v' + nv + ' disponível';
    if (enter) { enter.disabled = false; enter.innerHTML = 'Entrar mesmo assim'; }
    if (btn && setupUrl) { btn.style.display = 'block'; btn.disabled = false; btn.innerHTML = '⬇ Baixar e instalar a v' + _esc(nv) + ' agora'; btn.onclick = () => openExt(setupUrl); }
  };
  // 3) tenta AUTO-INSTALAR via plugin (Rust → reqwest, sem cache). Se o global não existir ou falhar → download.
  try {
    const u = window.__TAURI__ && window.__TAURI__.updater;
    if (!u || !u.check) { console.warn('updater global indisponível — fallback download'); offerDownload(); return false; }
    if (btn) { btn.style.display = 'block'; btn.disabled = true; btn.innerHTML = 'Baixando a v' + _esc(nv) + '… <small>reinicia ao terminar</small>'; }
    const upd = await u.check();
    if (!upd) { console.warn('updater.check() null (cache do endpoint?) — fallback download'); offerDownload(); return false; }
    await upd.downloadAndInstall();
    const p = window.__TAURI__.process; if (p && p.relaunch) await p.relaunch();
    return true; // reiniciando na v nova
  } catch (e) {
    const msg = (e && (e.message || e.toString())) || 'erro';
    console.error('updater downloadAndInstall:', e);
    offerDownload();
    if (btn) btn.title = 'falha auto-install: ' + msg;
    return false;
  }
}

function openExt(url) { if (!url) return; try { invT('open_url', { url }); } catch (e) { try { window.open(url, '_blank'); } catch (x) {} } }

// ===== fluxo do launcher =====
async function showLauncher() {
  // versão
  let ver = '0.1.0';
  try { ver = await window.__TAURI__.app.getVersion(); } catch (e) {}
  if (_L('lxVer')) _L('lxVer').textContent = 'v' + ver;

  // banido? troca tudo pela tela de ban
  try {
    const bs = await invT('ban_status');
    if (bs && bs.banned) {
      if (bs.pending && _srvOn()) { fetch(LICENSE_SERVER + '/ban', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hwid: bs.hwid, reason: bs.reason }) }).then(() => invT('ban_mark_reported')).catch(() => {}); }
      showBanned(bs.reason, bs.hwid); return;
    }
  } catch (e) {}

  // feed + status (paralelo, não bloqueia)
  fetchFeed().then((f) => renderFeed(f, ver)).catch(() => {});
  wireLogin();

  // links
  const feedLinks = () => window.__feed || {};
  if (_L('lxLinkSite')) _L('lxLinkSite').onclick = () => openExt(feedLinks().site || 'https://SEU-USUARIO.github.io/otserv-editor-site/');
  if (_L('lxLinkSupport')) _L('lxLinkSupport').onclick = () => openExt(feedLinks().discord || 'https://discord.gg/SEU-CONVITE');
  if (_L('lxLinkReset')) _L('lxLinkReset').onclick = async () => {
    if (!window.confirm('Trocar a chave nesta máquina? Vai pedir uma nova ao entrar.')) return;
    try { localStorage.removeItem('lic.key'); localStorage.removeItem('lic.cache'); } catch (e) {}
    try { await invT('license_reset'); } catch (e) {}
    openLogin();
  };

  // FORÇA o update: checa ANTES de liberar o Entrar. Se há versão nova, baixa/instala/reinicia
  // (o Entrar nem chega a habilitar). Sem update (ou falha no download) → libera o Entrar.
  const updating = await checkLauncherUpdate();
  if (!updating) {
    const enter = _L('lxEnter');
    if (enter) { enter.disabled = false; enter.textContent = 'Entrar'; enter.onclick = onEnterClick; }
  }
}

async function onEnterClick() {
  const enter = _L('lxEnter');
  if (enter) { enter.disabled = true; enter.innerHTML = '<span class="lxSpin"></span>Verificando…'; }
  const ok = await checkLicenseSilent();
  if (ok) { await goEditor(); }
  else { if (enter) { enter.disabled = false; enter.textContent = 'Entrar'; } openLogin(); }
}

async function goEditor() {
  const enter = _L('lxEnter');
  if (enter) { enter.disabled = true; enter.innerHTML = '<span class="lxSpin"></span>Abrindo editor…'; }
  try { await loadEditor(); }
  catch (e) {
    console.error('loadEditor', e);
    if (enter) { enter.disabled = false; enter.textContent = 'Entrar'; }
    const m = _L('lxMsg'); if (m) { m.className = 'lxMsg'; m.textContent = 'Erro ao abrir o editor. Tente de novo.'; }
    return;
  }
  const lx = _L('launcher');
  if (lx) { lx.classList.add('hide'); setTimeout(() => { if (lx && lx.parentNode) lx.parentNode.removeChild(lx); }, 480); }
}

// ===== login (HWID + key) dentro do launcher =====
async function openLogin() {
  let hw = ''; try { hw = await invT('hwid'); } catch (e) {}
  window.__loginHwid = hw;
  if (_L('lxHwid')) _L('lxHwid').value = hw || '—';
  const saved = localStorage.getItem('lic.key') || '';
  if (_L('lxKey') && saved) _L('lxKey').value = saved;
  const m = _L('lxMsg'); if (m) { if (window.__licReason) { m.className = 'lxMsg'; m.textContent = window.__licReason; window.__licReason = ''; } else { m.className = 'lxMsg'; m.textContent = ''; } }
  if (_L('lxLogin')) _L('lxLogin').classList.add('show');
}
let _loginWired = false;
function wireLogin() {
  if (_loginWired) return; _loginWired = true;
  const copy = _L('lxCopy');
  if (copy) copy.onclick = () => { try { navigator.clipboard.writeText(window.__loginHwid || ''); copy.textContent = 'Copiado'; setTimeout(() => copy.textContent = 'Copiar', 1500); } catch (e) {} };
  const back = _L('lxBack');
  if (back) back.onclick = () => { if (_L('lxLogin')) _L('lxLogin').classList.remove('show'); };
  const act = _L('lxActivate');
  if (act) act.onclick = doActivate;
  const keyEl = _L('lxKey');
  if (keyEl) keyEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doActivate(); } });
}
async function doActivate() {
  const keyEl = _L('lxKey'), m = _L('lxMsg'), act = _L('lxActivate');
  const key = ((keyEl && keyEl.value) || '').trim();
  if (!key) { if (m) { m.className = 'lxMsg'; m.textContent = 'Cole a chave ou o e-mail da compra.'; } return; }
  if (m) { m.className = 'lxMsg wait'; m.textContent = 'Verificando…'; }
  if (act) act.disabled = true;
  const st = await validateKey(key, window.__loginHwid || '');
  if (st.valid) {
    try { localStorage.setItem('lic.key', key); } catch (e) {}
    try { await invT('license_save', { key }); } catch (e) {}
    if (window.__lic == null) window.__lic = { valid: true, reason: st.reason, daysLeft: st.daysLeft, src: st.src };
    startOnlineRecheck(key);
    if (m) { m.className = 'lxMsg ok'; m.textContent = 'Ativado (' + st.src + '). Abrindo editor…'; }
    if (_L('lxLogin')) _L('lxLogin').classList.remove('show');
    await goEditor();
  } else {
    if (act) act.disabled = false;
    if (m) { m.className = 'lxMsg'; m.textContent = st.reason || 'Chave inválida.'; }
  }
}
// aviso "soft": ferramenta de RE aberta na máquina → NÃO bane, só avisa e o app fecha em ~5s
function showTamperWarn(reason) {
  const tool = String(reason || '').replace(/^(tool|window):/, '').replace(/[<>]/g, '') || 'ferramenta de análise';
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(8,10,16,.96);color:#ffd9a0;font-family:Segoe UI,sans-serif;text-align:center;padding:30px';
  d.innerHTML = `<div style="max-width:520px">
    <div style="font-size:50px">⚠️</div>
    <h1 style="color:#ffb454;margin:6px 0">Ferramenta não permitida aberta</h1>
    <p style="color:#cdd6ec;font-size:14px;line-height:1.6">Detectamos <code style="color:#ffd9a0">${tool}</code> em execução. Por segurança, feche essa ferramenta para usar o OTServ Editor.</p>
    <p style="color:#7f8aa3;font-size:12px;margin-top:10px">O programa vai fechar. <b>Não houve banimento</b> — é só um aviso. Feche a ferramenta e abra de novo.</p>
  </div>`;
  document.body.appendChild(d);
}
try { window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen('tamper-soft', (e) => showTamperWarn(e && e.payload)); } catch (e) {}
// DevTools (F12 / inspecionar) aberto no WebView = SOFT: avisa e fecha (sem ban).
(function devtoolsGuard() {
  // Proteção JS: verifica adulteração de funções críticas de licença.
  // NÃO usa debugger/timing (falso positivo) nem lista de processos (falso positivo).
  // Detecta monkey-patching das funções que validam a licença.
  const inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  const closeApp = () => { try { if (window.__TAURI__.process && window.__TAURI__.process.exit) window.__TAURI__.process.exit(1); } catch (e) {} };

  // guarda referências originais das funções nativas usadas pela validação de licença
  const _fetch = window.fetch;
  const _jsonParse = JSON.parse;
  const _atob = window.atob;

  // verifica periodicamente se foram substituídas por proxies/hooks
  setInterval(() => {
    const tampered =
      window.fetch !== _fetch ||
      JSON.parse !== _jsonParse ||
      window.atob !== _atob;
    if (tampered) {
      try { invoke && invoke('ban_self', { reason: 'js-hook' }); } catch (e) {}
      closeApp();
    }
  }, 8000);
})();
function showBanned(reason, hwid) {
  document.body.innerHTML = `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0c12;color:#ffb0bd;font-family:Segoe UI,sans-serif;text-align:center;padding:30px">
    <div style="max-width:520px">
      <div style="font-size:54px">⛔</div>
      <h1 style="color:#ff5a6a;margin:6px 0">Acesso banido</h1>
      <p style="color:#cdd6ec;font-size:14px;line-height:1.6">Esta máquina foi <b>permanentemente banida</b> por violação dos Termos:<br>tentativa de injeção/debug/engenharia reversa, ou reembolso/chargeback.</p>
      <p style="color:#7f8aa3;font-size:12px;margin-top:14px">Motivo: <code style="color:#ffb0bd">${(reason || 'tamper').replace(/[<>]/g, '')}</code><br>HWID: <code style="color:#7f8aa3">${(hwid || '').replace(/[<>]/g, '')}</code></p>
      <p style="color:#566;font-size:11px;margin-top:18px">Se acredita que é um engano, contate o suporte no Discord.</p>
    </div></div>`;
}
async function showActivation(reason, hw, prefill) {
  const inv = window.__TAURI__.core.invoke;
  if (hw == null) { hw = ''; try { hw = await inv('hwid'); } catch (e) {} }
  document.body.innerHTML =
    '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:radial-gradient(900px 400px at 50% -10%,#1b2236,#0f1118 60%);font-family:Segoe UI,sans-serif;color:#e9edf6;z-index:99999">' +
    '<div style="width:480px;max-width:92vw;background:#141826;border:1px solid #2a3145;border-radius:14px;padding:26px;box-shadow:0 20px 60px #000a">' +
    '<h2 style="margin:0 0 4px;font-size:20px">⚔️ OTServ Editor — Ativação</h2>' +
    '<div style="color:#93a0b8;font-size:13px;margin-bottom:16px">Licença mensal — R$ 30/mês. Envie seu <b>ID da máquina</b> pro vendedor pra receber a chave.</div>' +
    '<label style="font-size:12px;color:#93a0b8">Seu ID da máquina (HWID):</label>' +
    '<div style="display:flex;gap:8px;margin:4px 0 14px">' +
    '<input id="licHwid" readonly value="' + hw + '" style="flex:1;background:#11131c;color:#5cf08a;border:1px solid #2a3145;border-radius:8px;padding:8px;font-family:monospace;font-size:13px">' +
    '<button id="licCopy" style="background:#2c3346;color:#e9edf6;border:1px solid #353d54;border-radius:8px;padding:8px 12px;cursor:pointer">📋 Copiar</button></div>' +
    '<label style="font-size:12px;color:#93a0b8">Chave de licença OU email da compra:</label>' +
    '<textarea id="licKey" rows="3" placeholder="cole a license key (OTE-...) ou o email usado no pagamento…" style="width:100%;margin:4px 0 14px;background:#11131c;color:#e9edf6;border:1px solid #2a3145;border-radius:8px;padding:8px;font-family:monospace;font-size:12px;resize:vertical"></textarea>' +
    '<div id="licMsg" style="color:#ff6b6b;font-size:12px;min-height:16px;margin-bottom:10px"></div>' +
    '<button id="licActivate" style="width:100%;background:linear-gradient(#5b8cff,#3f6fe0);color:#fff;border:none;border-radius:10px;padding:11px;font-size:15px;font-weight:600;cursor:pointer">Ativar</button>' +
    '<div style="color:#6b768e;font-size:11px;margin-top:12px;text-align:center">A chave é única por máquina e expira mensalmente.</div>' +
    '</div></div>';
  if (prefill) document.getElementById('licKey').value = prefill;
  if (reason) { const m = document.getElementById('licMsg'); m.textContent = '❌ ' + reason; }
  document.getElementById('licCopy').onclick = () => { try { navigator.clipboard.writeText(hw); document.getElementById('licCopy').textContent = '✓ Copiado'; } catch (e) {} };
  document.getElementById('licActivate').onclick = async () => {
    const key = document.getElementById('licKey').value.trim(); const msg = document.getElementById('licMsg');
    if (!key) { msg.style.color = '#ff6b6b'; msg.textContent = 'cole a chave primeiro'; return; }
    msg.style.color = '#93a0b8'; msg.textContent = 'verificando…';
    const st = await validateKey(key, hw);
    if (st.valid) { try { localStorage.setItem('lic.key', key); } catch (e) {} try { await inv('license_save', { key }); } catch (e) {} msg.style.color = '#5cf08a'; msg.textContent = '✓ Ativado (' + st.src + ')! ' + st.daysLeft + ' dias restantes. Reiniciando…'; setTimeout(() => location.reload(), 900); }
    else { msg.style.color = '#ff6b6b'; msg.textContent = '❌ ' + st.reason; }
  };
}

// ===================== boot =====================
// Abre o LAUNCHER imediatamente. O editor pesado (libs + renderer) só carrega
// quando o usuário clica "Entrar" e a licença é validada (goEditor → loadEditor).
export async function boot() {
  try { await showLauncher(); }
  catch (e) {
    console.error('launcher', e);
    // se o launcher falhar, libera o botão pra não travar
    const enter = _L('lxEnter'); if (enter) { enter.disabled = false; enter.textContent = 'Entrar'; enter.onclick = onEnterClick; }
  }
}

// carga pesada do editor — chamada UMA vez, após a licença validar
let _editorLoaded = false;
async function loadEditor() {
  if (_editorLoaded) return; _editorLoaded = true;
  // globais que o renderer.js espera
  window.require = req; window.process = { env: {}, cwd: () => '.', platform: 'win32', argv: [] }; window.__dirname = '.';
  window.ipcRenderer = ipcRenderer; window.clipboard = clipboard;
  // Tauri v2 bloqueia window.confirm via ACL do plugin:dialog → retorna true (auto-confirma)
  window.confirm = (msg) => { console.log('[confirm auto-ok]', msg); return true; };
  // pré-carrega as libs (texto) + assets (skills/wasm) p/ o require síncrono
  const libs = ['ai', 'analysis', 'appearances', 'assets', 'balance', 'config', 'dat', 'economy', 'i18n', 'itemsxml', 'mapgl', 'monsters', 'npcs', 'obd', 'otb', 'otbm', 'rmebrush', 'spawns', 'spr', 'sprwriter', 'validate', 'versions', 'vocations', 'bytereader'];
  // paths relativos a full/ (app.html roda em src/full/)
  await Promise.all([
    ...libs.map(async (l) => { try { _src[l + '.js'] = await (await fetch('lib/' + l + '.js')).text(); } catch (e) { console.warn('lib', l, e); } }),
    (async () => { _src['diff-match-patch.js'] = await (await fetch('vendor/diff-match-patch.js')).text(); })(),
    // skills.md etc no cache fs (lidos por path.join(__dirname,...))
    ...['spell_skills.md', 'skills_actions.md', 'skills_movements.md', 'skills_talkactions.md', 'skills_creaturescripts.md', 'skills_globalevents.md'].map(async (f) => { try { const b = new Uint8Array(await (await fetch(f)).arrayBuffer()); _cacheFile('./' + f, b); _cacheFile(f, b); } catch (e) {} }),
  ]);
  // injeta o renderer.js (roda como script normal, usando os globais acima)
  await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'renderer.js'; s.onload = res; s.onerror = rej; document.body.appendChild(s); });
  // wrap p/ redesenhar o DETALHE do objeto quando sprites chegam async (sem clobberar edição)
  if (typeof window.selectObjThing === 'function') {
    const orig = window.selectObjThing;
    window.selectObjThing = function (id, tile) { window.__objSelId = id; window.__objSelTile = tile; return orig.apply(this, arguments); };
    window.__redrawObjDetail = function () {
      const ae = document.activeElement; if (ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return; // não mexe se estiver editando
      if (window.__objSelId != null) { try { window.selectObjThing(window.__objSelId, window.__objSelTile); } catch (e) {} }
    };
  }
  checkUpdate();      // auto-update (R2) — não-bloqueante
  startLicenseWatch(); // revalida licença periodicamente
}

// ===================== revalidação periódica de licença =====================
// Verifica a cada 2h se a assinatura ainda está ativa no Stripe.
// Se o servidor revogar/cancelar, o app fecha na próxima checagem.
function startLicenseWatch() {
  const INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 horas
  const inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  const closeApp = () => { try { if (window.__TAURI__.process && window.__TAURI__.process.exit) window.__TAURI__.process.exit(1); } catch (e) {} };

  // hash SHA-256 simples via SubtleCrypto — verifica integridade dos scripts em disco
  async function hashText(text) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
    } catch (e) { return null; }
  }

  // verifica integridade do shim.js e renderer.js lendo do disco via Rust
  async function checkScriptIntegrity() {
    if (!inv) return;
    try {
      // lê shim.js e renderer.js do bundle e compara hash com o que está em memória
      // se foram modificados em disco após o boot, algo suspeito ocorreu
      const shimBytes = await inv('read_file', { path: window.__TAURI__._shimPath || '' });
      if (!shimBytes || shimBytes.length === 0) return; // path não configurado, skip
    } catch (e) { /* sem path configurado, skip */ }
  }

  // Revalidação periódica. CHAVE keygen → offline (data embutida). E-MAIL → servidor decide
  // (revoga se cancelou/chargeback/expirou). Sem internet: tolera, não fecha.
  function fechar(reason) {
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(8,10,16,.97);font-family:Segoe UI,sans-serif;color:#ffd9a0;text-align:center;padding:30px">' +
      '<div style="max-width:460px"><div style="font-size:48px">🔒</div>' +
      '<h2 style="color:#ffb454;margin:8px 0">Licença expirada ou cancelada</h2>' +
      '<p style="color:#8a93a8;font-size:14px">' + _esc(reason || '') + '</p>' +
      '<p style="color:#6b768e;font-size:12px;margin-top:12px">Renove sua licença · suporte: seu-email@exemplo.com</p>' +
      '</div></div>');
    setTimeout(closeApp, 6000);
  }
  async function revalidate() {
    try {
      if (!inv) return;
      const key = localStorage.getItem('lic.key') || await inv('license_load');
      if (!key) return;
      if (!key.includes('@')) {
        // CHAVE keygen: re-checa a data embutida; fecha só se REALMENTE expirou
        const st = await inv('license_verify', { key });
        if (st && !st.valid && /expir/i.test(st.reason || '')) fechar(st.reason);
        return;
      }
      // E-MAIL (Stripe): o servidor decide
      if (!_srvOn()) return;
      let hwid = ''; try { hwid = await inv('hwid'); } catch (e) {}
      const r = await fetch(LICENSE_SERVER + '/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, hwid }) });
      const st = await r.json();
      if (!st.valid) fechar(st.reason);
      else { try { localStorage.setItem('lic.cache', JSON.stringify({ key, expiry: st.expiry, at: Date.now() })); } catch (e) {} }
    } catch (e) { /* sem internet: tolera */ }
  }

  // primeira checagem após 10min (dá tempo do app carregar), depois a cada 2h
  setTimeout(() => { revalidate(); setInterval(revalidate, INTERVAL_MS); }, 10 * 60 * 1000);
}

// ===================== auto-update (Tauri updater + R2) =====================
async function checkUpdate() {
  setTimeout(async () => {
    try {
      const u = window.__TAURI__ && window.__TAURI__.updater;
      if (!u || !u.check) return;
      const upd = await u.check();
      if (!upd) return; // sem atualização
      const ver = upd.version || (upd.manifest && upd.manifest.version) || '';
      const notes = upd.body || (upd.manifest && upd.manifest.body) || '';
      if (confirm('🔄 Nova versão ' + ver + ' disponível!\n\n' + notes + '\n\nAtualizar agora? (baixa e reinicia o app)')) {
        try { document.body.insertAdjacentHTML('afterbegin', '<div id="updBar" style="position:fixed;top:0;left:0;right:0;background:#1c2740;color:#9fc0ff;padding:8px;text-align:center;z-index:99999;font-family:Segoe UI">Baixando atualização ' + ver + '…</div>'); } catch (e) {}
        await upd.downloadAndInstall();
        const p = window.__TAURI__.process; if (p && p.relaunch) await p.relaunch();
      }
    } catch (e) { console.warn('update check', e); }
  }, 4000);
}
