// bridge.js — camada de compatibilidade entre o frontend e o backend Rust (Tauri v2).
// Substitui o que no Electron era `require('fs')` + `ipcRenderer`.
// IMPORTANTE: no Tauri o acesso a arquivo é ASSÍNCRONO (não existe readFileSync).
// Por isso a migração do renderer.js precisa trocar fs.readFileSync(...) por `await TFS.readFile(...)`.

const _t = window.__TAURI__;
const invoke = _t.core.invoke;
const dialog = _t.dialog;

// ---- FS assíncrono (bytes = Uint8Array) ----
export const TFS = {
  // binário EFICIENTE: read_file_raw → ArrayBuffer (sem array-JSON de milhões de números)
  async readFile(path) { const ab = await invoke('read_file_raw', { path }); return new Uint8Array(ab); },
  async writeFile(path, data) { return invoke('write_file', { path, data: Array.from(data) }); }, // write é raro; Array.from é seguro
  async exists(path) { return invoke('path_exists', { path }); },
  async listDir(path, { recursive = false, ext = null } = {}) { return invoke('list_dir', { path, recursive, ext }); },
};

// ---- .spr nativo (decode em Rust) ----
export const TSPR = {
  async open(path, opts = {}) { return invoke('spr_open', { path, extended: opts.extended !== false, transparency: opts.transparency !== false }); },
  // retorna Uint8ClampedArray RGBA 32x32 (4096) ou null se vazio
  async sprite(id) { const arr = await invoke('spr_sprite', { id }); return arr && arr.length ? new Uint8ClampedArray(arr) : null; },
  async compressed(id) { const arr = await invoke('spr_compressed', { id }); return new Uint8Array(arr); },
};

// ---- Diálogos (abrir/salvar/pasta) ----
export const TDLG = {
  async openFile(filters) { return dialog.open({ multiple: false, filters }); },           // → path | null
  async openFiles(filters) { return dialog.open({ multiple: true, filters }); },             // → [paths] | null
  async openDir() { return dialog.open({ directory: true }); },                              // → path | null
  async saveFile(defaultPath) { return dialog.save({ defaultPath }); },                      // → path | null
};

// ---- Claude Code CLI ----
export async function claudeCli(prompt) { return invoke('claude_cli', { prompt }); }

// ---- Shim de `ipcRenderer` (pros call-sites antigos do renderer.js) ----
// mapeia os canais usados no Electron pros equivalentes Tauri.
export const ipcRenderer = {
  async invoke(channel, ...args) {
    switch (channel) {
      case 'pick-file': return TDLG.openFile(args[0] ? [{ name: args[0].join('/'), extensions: args[0] }] : undefined);
      case 'pick-files': return (await TDLG.openFiles(args[0] ? [{ name: args[0].join('/'), extensions: args[0] }] : undefined)) || [];
      case 'pick-dir': return TDLG.openDir();
      case 'save-file': return TDLG.saveFile(args[0]);
      default: return invoke(channel, args[0] || {});
    }
  },
};

// expõe global (transição mais fácil do código antigo)
window.TFS = TFS; window.TSPR = TSPR; window.TDLG = TDLG; window.claudeCli = claudeCli;
