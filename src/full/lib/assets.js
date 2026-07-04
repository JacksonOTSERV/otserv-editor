// AssetsSpr — fornece sprites do formato 12+/15.x (catalog-content.json + sprites-*.bmp.lzma).
// Mesma interface do TauriSpr (sprite/warm/ensureCapacity/loaded/count/close) p/ o editor usar sem mudar.
// O sprite id aqui é VIRTUAL = realSpriteId*16 + (subRow*4 + subCol)  (split de sprites grandes em tiles 32x32).
// O decode da folha (LZMA+BMP) é feito no Rust (comando sheet_rgba); aqui só recortamos os 32x32.

const SIZES = { 0: [32, 32], 1: [32, 64], 2: [64, 32], 3: [64, 64], 4: [64, 64], 5: [96, 96], 6: [128, 128] };

class AssetsSpr {
  constructor(dir, catalog) {
    this.dir = String(dir).replace(/\\/g, '/').replace(/\/+$/, '');
    this.transparency = true;
    this.sheets = catalog.filter((c) => c.type === 'sprite').map((c) => {
      const [w, h] = SIZES[c.spritetype] || [32, 32];
      return { first: c.firstspriteid, last: c.lastspriteid, file: c.file, w, h, cols: Math.max(1, Math.floor(384 / w)) };
    }).sort((a, b) => a.first - b.first);
    this.count = this.sheets.length ? this.sheets[this.sheets.length - 1].last * 16 + 15 : 0;
    this.sheetCache = new Map(); this.maxSheets = 80;   // ~47MB (cada folha 384x384x4 = 576KB)
    this.cropCache = new Map(); this.maxCrops = 8000;
    this._pend = new Set(); this._queue = new Set(); this._flushT = null; this._flushing = false;
  }
  _sheetOf(realId) {
    let lo = 0, hi = this.sheets.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; const s = this.sheets[m]; if (realId < s.first) hi = m - 1; else if (realId > s.last) lo = m + 1; else return s; }
    return null;
  }
  spriteSize(realId) { const s = this._sheetOf(realId); return s ? { w: s.w, h: s.h } : { w: 32, h: 32 }; }
  loaded(vid) { if (vid <= 0) return true; const s = this._sheetOf(Math.floor(vid / 16)); return !s || this.sheetCache.has(s.file); }
  sprite(vid) {
    if (vid <= 0) return null;
    if (this.cropCache.has(vid)) { const v = this.cropCache.get(vid); this.cropCache.delete(vid); this.cropCache.set(vid, v); return v; }
    const realId = Math.floor(vid / 16), sub = vid % 16;
    const s = this._sheetOf(realId); if (!s) return null;
    const sheet = this.sheetCache.get(s.file);
    if (!sheet) { if (!this._pend.has(s.file)) { this._queue.add(s.file); this._scheduleFlush(); } return null; }
    const px = this._crop(sheet, s, realId, sub % 4, Math.floor(sub / 4));
    if (this.cropCache.size >= this.maxCrops) { const k = this.cropCache.keys().next().value; this.cropCache.delete(k); }
    this.cropCache.set(vid, px); return px;
  }
  _crop(sheet, s, realId, subCol, subRow) {
    const off = realId - s.first, col = off % s.cols, row = Math.floor(off / s.cols);
    const x0 = col * s.w + subCol * 32, y0 = row * s.h + subRow * 32, W = sheet.w, src = sheet.px;
    const out = new Uint8ClampedArray(32 * 32 * 4); let empty = true;
    for (let yy = 0; yy < 32; yy++) { const srow = y0 + yy; for (let xx = 0; xx < 32; xx++) { const si4 = (srow * W + x0 + xx) * 4, di = (yy * 32 + xx) * 4; out[di] = src[si4]; out[di + 1] = src[si4 + 1]; out[di + 2] = src[si4 + 2]; const a = src[si4 + 3]; out[di + 3] = a; if (a) empty = false; } }
    return empty ? null : out;
  }
  _decodeInto(f, ab) { const u = new Uint8Array(ab); const w = u[0] | (u[1] << 8) | (u[2] << 16) | (u[3] << 24); const h = u[4] | (u[5] << 8) | (u[6] << 16) | (u[7] << 24); if (this.sheetCache.size >= this.maxSheets) { const k = this.sheetCache.keys().next().value; this.sheetCache.delete(k); } this.sheetCache.set(f, { w, h, px: new Uint8Array(ab.slice(8)) }); }
  _scheduleFlush() { if (this._flushT || this._flushing) return; this._flushT = setTimeout(() => { this._flushT = null; this._flush(); }, 0); }
  async _flush() {
    if (this._flushing) return; this._flushing = true;
    const invoke = window.__TAURI__.core.invoke;
    try {
      while (this._queue.size) {
        const files = [...this._queue]; this._queue.clear(); for (const f of files) this._pend.add(f);
        await Promise.all(files.map(async (f) => { try { const ab = await invoke('sheet_rgba', { path: this.dir + '/' + f }); this._decodeInto(f, ab); } catch (e) { this.sheetCache.set(f, null); } this._pend.delete(f); }));
      }
    } finally { this._flushing = false; }
    if (window.__rerender) window.__rerender();
  }
  async warm(vids) {
    const files = new Set();
    for (const vid of vids) { if (vid <= 0) continue; const s = this._sheetOf(Math.floor(vid / 16)); if (s && !this.sheetCache.has(s.file)) files.add(s.file); }
    const invoke = window.__TAURI__.core.invoke;
    for (const f of files) { try { const ab = await invoke('sheet_rgba', { path: this.dir + '/' + f }); this._decodeInto(f, ab); } catch (e) { this.sheetCache.set(f, null); } }
  }
  ensureCapacity(nSprites) { this.maxSheets = Math.max(60, Math.min(500, Math.ceil((nSprites || 0) / 80) + 30)); while (this.sheetCache.size > this.maxSheets) { const k = this.sheetCache.keys().next().value; this.sheetCache.delete(k); } }
  close() { this.sheetCache.clear(); this.cropCache.clear(); }
  getCompressed() { return null; }
  async warmAllCompressed() {}
}
module.exports = AssetsSpr;
