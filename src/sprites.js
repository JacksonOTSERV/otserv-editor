// sprites.js — provedor de sprites do Tauri: decode .spr NATIVO (Rust) + cache async.
// O parser dat.js produz things com .sprites (ids). Aqui compomos o thing num canvas,
// buscando cada sprite via TSPR.sprite(id) (Rust) e cacheando o resultado decodificado.
import { TSPR } from './bridge.js';

const _sprCache = new Map(); // id -> ImageData | null   (decodificado, pronto)
const _pending = new Map();  // id -> Promise

// garante o sprite no cache (async). retorna ImageData|null.
async function ensureSprite(id) {
  if (_sprCache.has(id)) return _sprCache.get(id);
  if (_pending.has(id)) return _pending.get(id);
  const p = (async () => {
    const px = await TSPR.sprite(id); // Uint8ClampedArray(4096) | null
    const img = px ? new ImageData(px, 32, 32) : null;
    _sprCache.set(id, img); _pending.delete(id); return img;
  })();
  _pending.set(id, p); return p;
}

// pré-carrega vários ids (paralelo) — útil antes de desenhar uma página
export async function warmSprites(ids) {
  await Promise.all([...new Set(ids)].filter((i) => i > 0 && !_sprCache.has(i)).map(ensureSprite));
}

// índice do sprite no thing (igual dat.spriteIndex)
function sprIndex(t, w, h, l, x, y, z, a) {
  return ((((((a % t.frames) * t.pz + z) * t.py + y) * t.px + x) * t.layers + l) * t.height + h) * t.width + w;
}

// ids de sprite de um thing (frame 0, pattern x) — p/ warm em lote
export function thingSpriteIds(t, x = 0, a = 0) {
  const ids = []; if (!t || !t.sprites) return ids;
  for (let w = 0; w < t.width; w++) for (let h = 0; h < t.height; h++) { const idx = sprIndex(t, w, h, 0, x, 0, 0, a); if (idx >= 0 && idx < t.sprites.length) { const id = t.sprites[idx]; if (id) ids.push(id); } }
  return ids;
}
// cache cru por (thing,x,a) → canvas composto (sync, só do que já está no cache de sprite)
const _compCache = new WeakMap();
export function hasSprite(id) { return _sprCache.has(id); }
// compõe SÍNCRONO usando só sprites já cacheados (warmSprites antes). retorna canvas (pode faltar sprite não-cacheado).
export function composeSync(t, x = 0, a = 0) {
  if (!t || !t.sprites) return null;
  let e = _compCache.get(t); if (!e) { e = new Map(); _compCache.set(t, e); }
  const key = x + ':' + a; const hit = e.get(key); if (hit) return hit;
  const c = document.createElement('canvas'); c.width = t.width * 32; c.height = t.height * 32; const ctx = c.getContext('2d');
  let any = false, missing = false;
  for (let w = 0; w < t.width; w++) for (let h = 0; h < t.height; h++) {
    const idx = sprIndex(t, w, h, 0, x, 0, 0, a); if (idx < 0 || idx >= t.sprites.length) continue;
    const id = t.sprites[idx]; if (!id) continue;
    const img = _sprCache.get(id); if (!img) { missing = true; continue; } any = true;
    const tmp = document.createElement('canvas'); tmp.width = 32; tmp.height = 32; tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.drawImage(tmp, (t.width - 1 - w) * 32, (t.height - 1 - h) * 32);
  }
  if (!any) return null;
  if (!missing) e.set(key, c); // só cacheia quando completo
  return c;
}
// compõe um thing num canvas (async — espera os sprites). x = pattern, a = frame.
export async function composeThing(t, x = 0, a = 0) {
  if (!t || !t.sprites) return null;
  // coleta os ids necessários e pré-carrega
  const ids = [];
  for (let w = 0; w < t.width; w++) for (let h = 0; h < t.height; h++) { const idx = sprIndex(t, w, h, 0, x, 0, 0, a); if (idx >= 0 && idx < t.sprites.length) ids.push(t.sprites[idx]); }
  await warmSprites(ids);
  const c = document.createElement('canvas'); c.width = t.width * 32; c.height = t.height * 32; const ctx = c.getContext('2d');
  for (let w = 0; w < t.width; w++) for (let h = 0; h < t.height; h++) {
    const idx = sprIndex(t, w, h, 0, x, 0, 0, a); if (idx < 0 || idx >= t.sprites.length) continue;
    const img = _sprCache.get(t.sprites[idx]); if (!img) continue;
    // ImageData → desenha via canvas temp (putImageData não respeita destino com offset)
    const tmp = document.createElement('canvas'); tmp.width = 32; tmp.height = 32; tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.drawImage(tmp, (t.width - 1 - w) * 32, (t.height - 1 - h) * 32);
  }
  return c;
}
