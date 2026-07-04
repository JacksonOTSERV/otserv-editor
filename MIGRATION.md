# Migração Electron → Tauri — Plano & Status

Objetivo: trocar o shell **Electron** (~600MB, RAM alta) pelo **Tauri** (~10MB, WebView2 do SO + backend Rust nativo), mantendo/melhorando o app. Render GPU e parsers pesados passam pro Rust.

## 📌 STATUS do build — ✅ COMPILA E LINKA (MSVC)
- **Visual Studio Build Tools (MSVC) instalado** + `rustup default stable-x86_64-pc-windows-msvc`.
- **`cargo build` PASSA** → gera `target/debug/otserv-editor.exe` (**~13 MB debug**; release ~5-8MB, vs ~600MB do Electron). Toolchain validado ponta-a-ponta.
- Rodar: `cd tools/otserv-editor-tauri && npm install && npm run dev` (abre a janela WebView2).
- Build de release/instalador: `npm run build`.
- (Histórico: o target GNU/mingw compila tudo mas o `ld 15.2` do WinLibs rejeita o resource do ícone — por isso usamos MSVC, que é o padrão recomendado do Tauri no Windows.)

## ✅ Pronto (fundação — esta sessão)
- **Toolchain**: rustc 1.96 + target `x86_64-pc-windows-gnu` (linker = mingw gcc, já instalado) + `tauri-cli 2.11` + WebView2 ✓.
- **Projeto Tauri** (`tools/otserv-editor-tauri/`): `src-tauri/` (Rust) + `src/` (frontend).
- **Backend Rust** (`src-tauri/src/lib.rs`) com comandos:
  - `read_file` / `write_file` / `path_exists` / `list_dir` (FS nativo)
  - `spr_open` / `spr_sprite` / `spr_compressed` — **decoder .spr nativo em Rust** (leitura lazy por offset + RLE decode), sem jogar os 686MB na RAM
  - `claude_cli` — spawn do Claude Code CLI
  - Diálogos via `tauri-plugin-dialog`
- **bridge.js**: camada de compat (`TFS`, `TSPR`, `TDLG`, `claudeCli`, shim de `ipcRenderer`).
- **index.html**: demo que prova o backend (abre .spr, decodifica e renderiza sprites em Rust).

## ⚠️ O desafio central: fs SÍNCRONO → ASSÍNCRONO
O `renderer.js` do Electron usa `fs.readFileSync`/`fd readSync` por todo lado (nodeIntegration). No Tauri **não existe IO síncrono** no WebView — tudo é `await invoke(...)`. Então a migração do frontend exige:
1. Trocar `fs.readFileSync(p)` → `await TFS.readFile(p)` (e tornar as funções de load `async`).
2. Trocar `fs.writeFileSync` → `await TFS.writeFile`.
3. Trocar `ipcRenderer.invoke('save-file'|'pick-file'|...)` → `TDLG.*` (o shim já cobre).
4. **`.spr` (hot path do render)**: hoje `spr.sprite(id)` é síncrono no loop de desenho. Estratégia: pré-carregar/`await TSPR.sprite(id)` os ids visíveis e **cachear** (sync depois). Ou mover a composição de sprite/tiles pro Rust e mandar a textura pronta. Recomendado: render do mapa em **WebGPU/WebGL** com atlas alimentado por um cache assíncrono.

## 🗺 Roadmap (fases)
1. **Fundação** ✅ (shell + backend + bridge + demo).
2. **Parsers em memória** ✅ **PROVADO**: criado `cjs.js` (mini-loader CommonJS + **shim de Buffer** estendendo Uint8Array) → reusa `dat.js`/`bytereader.js`/`versions.js` **sem bundler**. Testado vs o parser nativo do Electron: **20790 things, 0 divergências** (byte-a-byte). `sprites.js` = compose async sobre o decoder .spr nativo. `index.html` = **Object viewer funcional** (abre .dat+.spr, renderiza items/outfits/effects/missiles com sprites nativos). Opts do OTCv8 8.60: `extended+frameDurations+frameGroups = true`.
3. **Mapa** ✅ **FUNCIONAL**: `otbm.js`+`otb.js` reusados via o loader (testado vs nativo: **339.547 tiles + 20.392 itens otb, 0 divergências**). `map.html` = viewer com pan/zoom/andar, ground+itens, serverId→clientId via otb, sprites nativos (warm async + `composeSync` do cache). Nav Object↔Mapa.
4. **UI completa — PORT B (renderer.js inteiro) ✅ montado, a testar**: em vez de reescrever cada modo, o `renderer.js` do Electron roda inteiro no WebView via **shim mestre** (`src/full/shim.js`):
   - `window.Buffer` = Buf (estende Uint8Array, read/write LE + md5 p/ crypto).
   - `require()` = loader CommonJS (pré-carrega os 23 `lib/*.js` por fetch; `fs`/`path`/`crypto`/`child_process`/`electron`/`codemirror`/`diff-match-patch`/`lzma` mapeados).
   - **fs SÍNCRONO** funciona via **cache pré-carregado**: ao abrir arquivo/pasta (ipc `pick-*`) o shim pré-carrega o alvo + irmãos pequenos (`xml/lua/otb/otbm/dat/otfi/md…`, `.spr` excluído) no cache; `readFileSync/existsSync/readdirSync/statSync` leem do cache; `writeFileSync/mkdir/unlink/rename/copy/rm` gravam async via TFS + novos comandos Rust (`rm_path/rename_path/copy_path/make_dir/reveal_path`).
   - **`.spr` (hot path)**: `require('./lib/spr')` → `TauriSpr` (decode nativo Rust). `sprite(id)` devolve do cache sync; no miss busca via TSPR async, cacheia e dispara **`__sprDirty`** (re-render debounced; fallback dispara `resize`).
   - `electron`: `ipcRenderer` (pick/save→TDLG + preload), `clipboard` (navigator.clipboard), `shell.showItemInFolder`→`reveal_path`.
   - `child_process.spawn('claude')` → emula stdin/stdout/close sobre o comando Rust `claude_cli`.
   - **Boot**: `src/full/app.html` = index.html original com CSS/JS do CodeMirror apontando p/ `vendor/`, carrega CodeMirror como global, e um `<script type=module>` chama `boot()` (pré-carrega libs+skills, injeta `renderer.js`). Janela do Tauri aponta p/ `full/app.html` (`tauri.conf.json`).
   - **cargo check PASSA** com os comandos novos. **Falta**: rodar `EXECUTAR.bat` e iterar nos 1ºs erros de console (GUI não testável aqui).
   - Render do mapa pode evoluir pro WebGL (`lib/mapgl.js`); brushes/serialize podem ir pro Rust depois.
5. **Engine em Rust** (opcional, perf máxima): mover brushes/auto-border/serialize de `.otbm` pro Rust (comandos), deixando o JS só na UI.
6. **WebGPU** (opcional): trocar o render 2D/WebGL por WGSL pra mapas gigantes a 60fps.

## 🔨 Como rodar/buildar (Windows, com mingw)
```
cd tools/otserv-editor-tauri
npm install
npm run dev      # tauri dev --target x86_64-pc-windows-gnu  (abre a janela)
npm run build    # gera o .exe/instalador (alvo GNU)
```
> Se algum dia instalar o **Visual Studio Build Tools** (MSVC), pode usar o target padrão MSVC (tira o `--target ...` dos scripts) — costuma gerar binários menores.

## Notas
- `withGlobalTauri: true` na config → o JS usa `window.__TAURI__` sem bundler.
- Sem passo de build de frontend (HTML/JS/CSS estático em `src/`). Dá pra trocar por Vite/Svelte depois sem mexer no backend.
- Os parsers atuais (`lib/*.js` do Electron) são reaproveitáveis quase 1:1 — só muda quem entrega os bytes (TFS em vez de fs).
