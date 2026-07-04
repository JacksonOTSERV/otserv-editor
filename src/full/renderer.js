const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const I18N = require('./lib/i18n');
const Dat = require('./lib/dat');
const Spr = require('./lib/spr');
const Appearances = require('./lib/appearances'); // formato 12+/15.x (protobuf)
const AssetsSpr = require('./lib/assets');         // sprites 12+/15.x (catalog + .bmp.lzma)
let assetsMode = false, assetsDir = null;
const SprW = require('./lib/sprwriter');
const MapGL = require('./lib/mapgl');
let _mapGL = null, _glSink = null, _glAlpha = 1; // render WebGL opcional da camada base do mapa
const OBD = require('./lib/obd');
const economy = require('./lib/economy');
const M = require('./lib/monsters');
const N = require('./lib/npcs');
const { loadOtb } = require('./lib/otb');
const OTB = require('./lib/otb');
const IX = require('./lib/itemsxml');
const AI = require('./lib/ai');
const OTBM = require('./lib/otbm');
const RB = require('./lib/rmebrush');
const V = require('./lib/vocations');
const cfgLib = require('./lib/config');
const B = require('./lib/balance');
const A = require('./lib/analysis');
const VAL = require('./lib/validate');
const SP = require('./lib/spawns');
const VERS = require('./lib/versions');
const fsp = require('fs');
const CodeMirror = require('codemirror');
require('codemirror/mode/lua/lua');
require('codemirror/mode/xml/xml');
require('codemirror/mode/clike/clike'); // C/C++/Java
require('codemirror/mode/javascript/javascript');
require('codemirror/mode/css/css');

// mapeia a extensao -> modo do editor
function modeFor(file) {
  const ext = require('path').extname(file).toLowerCase();
  if (ext === '.lua') return 'lua';
  if (['.xml', '.otui', '.otmod', '.otbm'].includes(ext)) return 'xml';
  if (['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.hh', '.inl', '.ino', '.tpp'].includes(ext)) return 'text/x-c++src';
  if (ext === '.js' || ext === '.json') return 'application/javascript';
  if (ext === '.css') return 'css';
  return 'text/plain';
}
require('codemirror/addon/dialog/dialog');
require('codemirror/addon/search/searchcursor');
require('codemirror/addon/search/search');
// diff (merge addon precisa do diff_match_patch global)
window.diff_match_patch = require('diff-match-patch');
window.DIFF_DELETE = -1; window.DIFF_INSERT = 1; window.DIFF_EQUAL = 0;
require('codemirror/addon/merge/merge');
const { clipboard } = require('electron');
const CM_KEYS = { 'Ctrl-F': 'findPersistent', 'Ctrl-H': 'replace', 'Shift-Ctrl-F': 'replaceAll', 'Ctrl-G': 'findNext', 'Shift-Ctrl-G': 'findPrev' };

// persistencia simples (lembra pastas entre sessoes)
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignora */ } };

// resolve as sub-pastas a partir da raiz do servidor escolhida
function firstExisting(root, cands) {
  for (const c of cands) { const p = path.join(root, c); if (fsp.existsSync(p)) return p; }
  return null;
}
// busca recursiva limitada (tolerante a estruturas diferentes de server)
function deepFind(root, predicate, wantDir, maxDepth = 4) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, d] = stack.pop();
    let items; try { items = fsp.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (wantDir && it.isDirectory() && predicate(it.name, p)) return p;
      if (!wantDir && it.isFile() && predicate(it.name, p)) return p;
      if (it.isDirectory() && d < maxDepth && !/node_modules|\.git/i.test(it.name)) stack.push([p, d + 1]);
    }
  }
  return null;
}
function dirHasXml(p) { try { return fsp.readdirSync(p).some((f) => f.toLowerCase().endsWith('.xml')); } catch (e) { return false; } }

function resolveServer(root) {
  const r = {
    cfgFile: firstExisting(root, ['config.lua', '../config.lua', 'data/config.lua']),
    monDir: firstExisting(root, ['data/monster', 'monster', 'data/monsters']),
    npcDir: firstExisting(root, ['data/npc', 'npc']),
    vocFile: firstExisting(root, ['data/XML/vocations.xml', 'data/vocations.xml', 'XML/vocations.xml', 'vocations.xml']),
    spellsFile: firstExisting(root, ['data/spells/spells.xml', 'spells/spells.xml']),
    datFile: firstExisting(root, ['data/things/860/Tibia.dat', 'data/things/Tibia.dat']),
  };
  // fallback: procura recursivo o que nao achou direto
  if (!r.cfgFile) r.cfgFile = deepFind(root, (n) => n.toLowerCase() === 'config.lua', false);
  if (!r.monDir) r.monDir = deepFind(root, (n, p) => /^monsters?$/i.test(n) && dirHasXml(p), true);
  if (!r.npcDir) r.npcDir = deepFind(root, (n, p) => /^npcs?$/i.test(n) && dirHasXml(p), true);
  if (!r.vocFile) r.vocFile = deepFind(root, (n) => n.toLowerCase() === 'vocations.xml', false);
  if (!r.spellsFile) r.spellsFile = deepFind(root, (n) => n.toLowerCase() === 'spells.xml', false);
  if (!r.datFile) r.datFile = deepFind(root, (n) => n.toLowerCase().endsWith('.dat'), false);
  return r;
}
const pickPath = (k, fb) => { const s = lsGet(k); return (s && fsp.existsSync(s)) ? s : fb; };

// abre o modal de caminhos preenchido com o estado atual
function openPathsModal() {
  // Depois do 1º Salvar/Carregar, o modal mostra EXATAMENTE o salvo (branco fica branco).
  // Só na primeiríssima vez usa o auto-detectado (variável) como sugestão.
  const savedOnce = lsGet('pathsSavedOnce') === '1';
  const val = (key, fb) => savedOnce ? (lsGet(key) || '') : (lsGet(key) || fb || '');
  $('pRoot').value = lsGet('serverRoot') || '';
  $('pCfg').value = val('cfgFile', cfgFile);
  $('pMon').value = val('monDir', monDir);
  $('pNpc').value = val('npcDir', npcDir);
  $('pVoc').value = val('vocFile', vocStore && vocStore.file);
  $('pSpells').value = val('spellsFile', spellsFile);
  $('pDat').value = val('datPath', datPath);
  $('pSpr').value = val('sprPath', sprPath);
  $('pOtb').value = val('otbPath', otbPath);
  if ($('pMap')) $('pMap').value = val('mapPath', mapPath);
  if ($('pSpawn')) $('pSpawn').value = val('spawnFile', spawnFile);
  if ($('pRme')) $('pRme').value = lsGet('rmeData') || '';
  if ($('pAssets')) $('pAssets').value = val('assetsDir', assetsMode && assetsDir);
  if ($('pItemsXml')) $('pItemsXml').value = val('itemsXml15', itemsXmlPath);
  if ($('pAutoload')) $('pAutoload').checked = lsGet('autoload') !== '0';
  applySrvType();
  $('pathsModal').style.display = 'flex';
}

// mostra só os campos relevantes ao tipo de servidor escolhido (TFS · Canary · OpenTibia · Outro)
function applySrvType(t) {
  t = t || lsGet('srvType') || 'tfs';
  if (!['tfs', 'canary', 'ot', 'outro'].includes(t)) t = 'tfs';
  lsSet('srvType', t);
  document.querySelectorAll('#srvTypeBar .srvType').forEach((b) => b.classList.toggle('active', b.dataset.srv === t));
  document.querySelectorAll('#pathsModal [data-srv]:not(.srvType)').forEach((el) => { el.style.display = el.dataset.srv.split(' ').includes(t) ? '' : 'none'; });
}

// salva TODOS os caminhos do modal no localStorage (sem carregar nada). Reaproveitado pelo "Carregar".
function savePathsToLs() {
  const v = (id) => ($(id) ? $(id).value.trim() : '');
  lsSet('autoload', ($('pAutoload') && $('pAutoload').checked) ? '1' : '0');
  const map = { pCfg: 'cfgFile', pVoc: 'vocFile', pMon: 'monDir', pNpc: 'npcDir', pSpells: 'spellsFile', pDat: 'datPath', pSpr: 'sprPath', pOtb: 'otbPath', pMap: 'mapPath', pSpawn: 'spawnFile', pRme: 'rmeData', pAssets: 'assetsDir', pItemsXml: 'itemsXml15', pRoot: 'serverRoot' };
  for (const id in map) { lsSet(map[id], v(id)); } // salva o valor ATUAL do campo (vazio = limpa)
  lsSet('pathsSavedOnce', '1'); // a partir daqui o modal respeita EXATAMENTE o salvo (branco = branco)
}
// botão "Salvar": SÓ persiste os caminhos (recarregam sozinhos no próximo boot) — não carrega agora.
function savePaths() {
  savePathsToLs();
  $('pathsModal').style.display = 'none';
  $('status').textContent = '💾 Caminhos salvos — vão recarregar sozinhos ao abrir o programa.';
}

// carrega a partir dos caminhos informados + lembra cada um.
// IMPORTANTE: o fs do shim é cache-based → pré-carrega cada arquivo/pasta antes de ler (senão readFileSync falha).
// E SEMPRE salva o caminho (mesmo que o load falhe) p/ persistir no próximo boot.
async function applyPaths() {
  const v = (id) => $(id) ? $(id).value.trim() : '';
  const cfg = v('pCfg'), mon = v('pMon'), npc = v('pNpc'), voc = v('pVoc'), spells = v('pSpells');
  const datF = v('pDat'), sprF = v('pSpr'), otbF = v('pOtb'), mapF = v('pMap'), spawnF = v('pSpawn'), rmeF = v('pRme');
  const assetsV = v('pAssets'), itemsXmlV = v('pItemsXml'); // modo 15.x / Canary
  const inv = window.__TAURI__.core.invoke;
  const exists = async (p) => { try { return await inv('path_exists', { path: p }); } catch (e) { return false; } };
  const preF = async (p) => { try { if (window.__preloadFile) await window.__preloadFile(p); } catch (e) {} };
  const preD = async (p) => { try { if (window.__preloadTree) await window.__preloadTree(p); } catch (e) {} };
  const preDL = async (p) => { try { if (window.__preloadTreeLua) await window.__preloadTreeLua(p); else if (window.__preloadTree) await window.__preloadTree(p); } catch (e) {} }; // inclui .lua (Canary)
  $('status').textContent = 'carregando caminhos…';
  // 1) SALVA tudo que foi informado (persiste mesmo se o load falhar)
  savePathsToLs();
  // 2) CARREGA (com pré-carregamento real)
  try {
    if (cfg && await exists(cfg)) { await preF(cfg); serverCfg = cfgLib.loadConfig(cfg); cfgFile = cfg; }
    if (voc && await exists(voc)) { await preF(voc); vocStore = V.loadVocations(voc); fillVocSelect(); }
    if (mon && await exists(mon)) { await preDL(mon); monDir = mon; loadMonsters(mon); }
    if (npc && await exists(npc)) { await preDL(npc); npcDir = npc; loadNpcs(npc); }
    if (spells) { spellsFile = spells; loadSpellFolder(spells); } // spells.xml (TFS/OTX) OU pasta revscript (Canary) → sidebar
    if (datF && await exists(datF)) { await preF(datF); datPath = datF; detectDatFormat(datF); }
    if (sprF && await exists(sprF)) sprPath = sprF; // .spr lê nativo (Rust) — não precisa pré-carregar
    if (datF || sprF) reloadGraphics();
    if (otbF && await exists(otbF)) { await preF(otbF); otbMap = loadOtb(otbF); otbPath = otbF; rebuildOtbInv(); loadItemsXmlNear(datPath); refreshIcons(); }
    if (spawnF && await exists(spawnF)) { await preF(spawnF); spawnStore = SP.loadSpawn(spawnF); spawnFile = spawnF; }
    if (mapF && await exists(mapF)) { await preF(mapF); mapPath = mapF; loadMapFile(mapF); }
    if (rmeF && await exists(rmeF)) { await preD(rmeF); const bd = resolveBrushDir(rmeF); if (bd) { mapBrushData = null; loadBrushesFrom(bd); } else alert('materiais RME: não achei borders.xml/grounds.xml em "' + rmeF + '" (nem subpastas). Aponte a pasta data/ do RME (ou data/<versão>).'); }
    // 15.x / Canary: assets do CLIENTE (sprites) + items.xml do SERVIDOR (atributos)
    if (assetsV && await exists(assetsV)) await loadAssetsFrom(assetsV);
    if (itemsXmlV && await exists(itemsXmlV)) await loadItemsXmlFrom(itemsXmlV);
  } catch (e) { console.error('applyPaths', e); alert('erro ao carregar um dos caminhos: ' + (e.message || e)); }
  updateStatus(); updateSaveAll();
  $('pathsModal').style.display = 'none';
  $('status').textContent = '✅ Caminhos carregados e salvos.';
}

let dat = null, spr = null;
let otbMap = null;            // serverId -> clientId
let otbInv = null;            // clientId -> serverId
let otbFull = null, otbItemIdx = null; // árvore otb completa + serverId->node (p/ editar/escrever)
let itemsXml = null, itemsXmlPath = null, itemsXmlIdx = null; // items.xml (atributos de servidor)
let datPath = null, sprPath = null, otbPath = null;
let cfgFile = null, spellsFile = null, spawnFile = null;
let spawnStore = null;
let filesRoot = null, filesRoot2 = null, filesRootOtc = null, filesRootC = null;
let monsters = [];
let npcs = [];
let vocStore = null;          // { file, raw, list }
let monDir = null, npcDir = null;
let serverCfg = null;         // experienceStages + rates
let npcCtx = null;            // contexto de preço (economy.buildNpcContext)
let current = null;           // monstro selecionado
let currentNpc = null;        // npc selecionado
let currentVoc = null;        // vocation selecionada
let mode = 'mon';             // 'mon' | 'npc' | 'voc' | 'econ'

const vocList = () => (vocStore ? vocStore.list : []);

// marca entidade como alterada e atualiza o botao Salvar tudo
function markDirty(e) { if (e) e._dirty = true; updateSaveAll(); }
function dirtyCount() {
  let n = monsters.filter((m) => m._dirty).length + npcs.filter((m) => m._dirty).length;
  if (vocStore && vocList().some((v) => v._dirty || v._new)) n += vocList().filter((v) => v._dirty || v._new).length;
  if (spawnStore && spawnStore._dirty) n += 1;
  return n;
}
function updateSaveAll() { $('btnSaveAll').textContent = `💾 Salvar tudo (${dirtyCount()})`; }

const $ = (id) => document.getElementById(id);

// ---------- coletor de erros (aba de Logs) ----------
const errorLog = [];
function hhmmss() { const d = new Date(); return d.toTimeString().slice(0, 8); }
// avisos benignos do browser que NÃO são erro de verdade (não quebram nada) → ignora p/ não poluir os logs
const _IGNORED_ERRORS = [/ResizeObserver loop/i, /ResizeObserver loop completed with undelivered notifications/i];
function logError(msg, stack) {
  const _m = String(msg || '');
  if (_IGNORED_ERRORS.some((re) => re.test(_m))) return; // ruído benigno → descarta
  errorLog.push({ time: hhmmss(), msg: _m, stack: stack || '' });
  const b = document.getElementById('btnLogs');
  if (b) { b.textContent = `⚠ Logs (${errorLog.length})`; b.classList.toggle('hasErr', errorLog.length > 0); }
  const s = document.getElementById('status');
  if (s) s.textContent = '⚠ ' + String(msg || '');
  if (document.getElementById('errModal') && document.getElementById('errModal').style.display === 'flex') renderErrModal();
}
window.addEventListener('error', (e) => {
  console.error(e.error || e.message);
  logError(e.message || (e.error && e.error.message), (e.error && e.error.stack) || `${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  logError((e.reason && e.reason.message) || e.reason, (e.reason && e.reason.stack) || '');
});

let datVersion = 860; // detectado pela assinatura do .dat

// opcoes de formato (toggles, estilo Object Builder)
function datOpts() {
  return {
    extended: $('optExtended').checked,
    frameDurations: $('optFrameDurations').checked,
    frameGroups: $('optFrameGroups').checked,
    version: datVersion,
  };
}

// auto-detecta a versao do cliente pela assinatura do .dat e ajusta os toggles
function detectDatFormat(datFile) {
  try {
    const det = VERS.detect(datFile);
    let label = det.s;
    if (det.v) { datVersion = det.v; }
    else {
      // assinatura fora da tabela (que vai até 10.70) → cliente MAIS NOVO. Usa formato MODERNO (igual RME usa
      // format="10.57" p/ 10.71-10.98+): extended + frame-durations + frame-groups + transparência.
      datVersion = 1098; label = 'nova (assumindo 10.7x+ / formato moderno)';
    }
    const f = VERS.formatFor(datVersion);
    $('optExtended').checked = f.extended;
    $('optFrameGroups').checked = f.frameGroups;
    $('optFrameDurations').checked = f.frameDurations;
    $('optTransparency').checked = datVersion >= 1050; // 10.5x+ usa transparência (alpha) no .spr
    applyOtfiDefaults(datFile); // Tibia.otfi (se existir) sobrescreve com os flags reais do cliente
    const s = $('status'); if (s) s.textContent = `Cliente: ${label}  (sig ${det.sig}, v${datVersion}) — se não carregar, ajuste os toggles extended/transparência/frame-groups`;
  } catch (e) { console.error('detect', e); }
}
function sprOpts() {
  return { extended: $('optExtended').checked, transparency: $('optTransparency').checked };
}

// le Tibia.otfi (se existir ao lado do dat) p/ setar os defaults dos toggles
function applyOtfiDefaults(datFile) {
  try {
    const otfi = path.join(path.dirname(datFile), 'Tibia.otfi');
    if (!fs.existsSync(otfi)) return;
    const txt = fs.readFileSync(otfi, 'latin1');
    const has = (k) => new RegExp(k + '\\s*:\\s*true', 'i').test(txt);
    $('optExtended').checked = has('extended');
    $('optTransparency').checked = has('transparency');
    $('optFrameDurations').checked = has('frame-durations');
    $('optFrameGroups').checked = has('frame-groups');
  } catch (e) { /* ignora */ }
}

// carrega items.otb (mapa server->client) perto do dat
function loadOtbNear(datFile) {
  try {
    let otb = datFile ? path.join(path.dirname(datFile), 'items.otb') : null;
    if (!otb || !fs.existsSync(otb)) otb = findUp('data/things/860/items.otb');
    if (otb && fs.existsSync(otb)) { otbMap = loadOtb(otb); otbPath = otb; }
    else { otbMap = null; }
  } catch (e) { otbMap = null; console.error('otb', e); }
  rebuildOtbInv();
  loadItemsXmlNear(datFile);
}
function rebuildOtbInv() {
  otbInv = null;
  if (!otbMap) return;
  otbInv = new Map();
  for (const [s, c] of otbMap) if (!otbInv.has(c)) otbInv.set(c, s);
  otbFull = otbItemIdx = null; // invalida — re-parseia sob demanda (lazy)
}
// parseia a árvore otb completa só quando precisa editar binário (lazy: evita 21k nós no load)
function ensureOtbFull() {
  if (otbFull) return true;
  if (!otbPath || !fs.existsSync(otbPath)) return false;
  try {
    otbFull = OTB.parseFull(otbPath); otbItemIdx = new Map();
    for (const node of otbFull.root.children) {
      const ip = OTB.parseItemProps(node.props); const s = OTB.getAttr(ip, OTB.ATTR_SERVERID);
      if (s && s.length >= 2) otbItemIdx.set(s.readUInt16LE(0), node);
    }
    return true;
  } catch (e) { console.error('otb full', e); return false; }
}
// só ACHA o items.xml no load (barato); o parse pesado é lazy (ensureItemsXml)
function loadItemsXmlNear(datFile) {
  itemsXml = itemsXmlIdx = null; itemsXmlPath = null;
  const cands = [];
  if (datFile) cands.push(path.join(path.dirname(datFile), 'items.xml'));
  if (otbPath) cands.push(path.join(path.dirname(otbPath), 'items.xml'));
  cands.push(findUp('data/items/items.xml'), findUp('data/things/860/items.xml'));
  itemsXmlPath = cands.find((c) => c && fs.existsSync(c)) || null;
}
// parseia o items.xml só quando precisa (busca por nome / painel servidor)
function ensureItemsXml() {
  if (itemsXml) return true;
  if (!itemsXmlPath) return false;
  try { itemsXml = IX.load(itemsXmlPath); itemsXmlIdx = IX.indexById(itemsXml); return true; }
  catch (e) { console.error('items.xml', e); return false; }
}
// carrega o items.xml MANUALMENTE (15.x/Canary: fica em data/items, FORA da pasta de assets do
// cliente). Também lê proficiencies.json se estiver ao lado. Aqui serverId = clientId (sem items.otb).
let proficiencies = null; window.proficiencies = null;
async function loadItemsXmlPick() {
  const p = await ipcRenderer.invoke('pick-file', ['xml']);
  if (!p) return;
  return loadItemsXmlFrom(p);
}
// carrega o items.xml a partir de um caminho conhecido (caminhos salvos / modal)
async function loadItemsXmlFrom(p) {
  if (!p) return;
  $('status').textContent = 'lendo items.xml…';
  try { if (window.__preloadFile) await window.__preloadFile(p); } catch (e) {}
  itemsXml = itemsXmlIdx = null; itemsXmlPath = p;
  if (!ensureItemsXml()) { itemsXmlPath = null; return alert('Não consegui ler esse items.xml.'); }
  try { lsSet('itemsXml15', p); } catch (e) {} // persiste p/ o próximo boot
  // proficiencies.json ao lado (Canary) — carrega se existir
  proficiencies = null;
  try {
    const profPath = path.join(path.dirname(p), 'proficiencies.json');
    if (window.__preloadFile) await window.__preloadFile(profPath);
    if (fs.existsSync(profPath)) proficiencies = JSON.parse(fs.readFileSync(profPath, 'utf8'));
  } catch (e) { proficiencies = null; }
  window.proficiencies = proficiencies;
  // atualiza a UI (nomes dos itens + painel de atributos do thing selecionado)
  try { if (typeof refreshIcons === 'function') refreshIcons(); } catch (e) {}
  try { if (objSel && typeof selectObjThing === 'function') selectObjThing(objSel.id); } catch (e) {}
  try { if (typeof renderObjGrid === 'function') renderObjGrid(); } catch (e) {}
  const nItems = (itemsXml && itemsXml.items) ? itemsXml.items.length : 0;
  const nProf = proficiencies ? (Array.isArray(proficiencies) ? proficiencies.length : Object.keys(proficiencies).length) : 0;
  $('status').textContent = '📑 items.xml: ' + nItems + ' itens' + (nProf ? ' · proficiencies: ' + nProf : '') + ' (serverId = clientId)';
}
// serverId do clientId (via otb inverso; fallback = mesmo id)
function serverIdOf(clientId) { return (otbInv && otbInv.get(clientId)) || clientId; }
function itemEntryOf(clientId) { return ensureItemsXml() ? itemsXmlIdx.get(serverIdOf(clientId)) : null; }
function itemNameOf(clientId) { const e = itemEntryOf(clientId); return e ? (e.tagAttrs.name || '') : ''; }

// recarrega os icones da view atual
function refreshIcons() {
  if (mode === 'npc') { if (currentNpc) renderShop(); }
  else if (current) renderLoot();
}

// Carrega o .dat tentando o formato atual e, se desincronizar, varrendo combinações de
// extended/frame-durations/frame-groups até uma parsear inteira. Resolve dats 8.60 CUSTOM (OTCv8)
// que têm assinatura 8.60 mas são EXTENDED (32-bit) — a assinatura sozinha não distingue.
function loadDatAuto() {
  const cur = [$('optExtended').checked, $('optFrameDurations').checked, $('optFrameGroups').checked];
  const combos = [
    cur,                    // o que está marcado agora (detecção/usuário)
    [false, false, false],  // clássico ≤9.5
    [true, false, false],   // OTCv8 8.60 EXTENDED (custom) — caso mais comum aqui
    [true, true, false],    // extended + frame-durations
    [true, true, true],     // moderno 10.57+
    [true, false, true],
    [false, true, false],
  ];
  const seen = new Set(); let lastErr = null;
  for (const c of combos) {
    const key = c.join('/'); if (seen.has(key)) continue; seen.add(key);
    try {
      const d = new Dat(datPath, { extended: c[0], frameDurations: c[1], frameGroups: c[2], version: datVersion });
      // parseou inteiro sem desync → aplica os toggles que funcionaram
      $('optExtended').checked = c[0]; $('optFrameDurations').checked = c[1]; $('optFrameGroups').checked = c[2];
      // formato moderno (frame-durations/frame-groups = 10.50+/10.57+) usa transparência (alpha) no .spr
      if (c[1] || c[2]) $('optTransparency').checked = true;
      return d;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('formato não reconhecido');
}
// (re)carrega dat+spr com as opcoes atuais
function reloadGraphics() {
  if (assetsMode) return; // modo 15.x não usa .dat/.spr
  if (datPath) { try { dat = loadDatAuto(); } catch (e) { dat = null; console.error('dat', e); alert('❌ ERRO ao ler o .dat:\n' + e.message + '\n\nDica: ajuste extended / transparência / frame-groups no menu ⚙ Formato (ou escolha a Versão certa) e abra o .dat de novo.'); } }
  if (sprPath) { try { if (spr && spr.close) spr.close(); spr = new Spr(sprPath, sprOpts()); _objWarming = false; invalidateSprites(); } catch (e) { spr = null; console.error('spr', e); alert('❌ ERRO ao abrir o .spr:\n' + e.message); } }
  updateStatus();
  drawSprite();
  // re-renderiza JÁ no modo Object (não precisa trocar de modo p/ as spr aparecerem)
  if (mode === 'obj') { if (typeof renderObjGrid === 'function') renderObjGrid(); if (typeof renderSprPanel === 'function') renderSprPanel(); if (typeof renderObjInfo === 'function') renderObjInfo(); if (objSel && typeof selectObjThing === 'function') selectObjThing(objSel.id); }
  if (mode === 'assets' && typeof renderAssetsPanel === 'function') renderAssetsPanel();
  if (mode === 'npc') { if (currentNpc) renderShop(); }
  else if (current) renderLoot();
}
function _vis2(id) { const el = document.getElementById(id); return el && el.offsetParent !== null; }

// ---------- Carregar assets 12+/15.x (appearances + sprites, SEM .dat/.spr/.otb) ----------
async function loadAssets() {
  const dir = await ipcRenderer.invoke('pick-dir'); if (!dir) return;
  return loadAssetsFrom(dir);
}
// mesma coisa, mas a partir de uma PASTA já conhecida (caminhos salvos / modal) — sem abrir o picker
async function loadAssetsFrom(dir) {
  if (!dir) return;
  assetsDir = String(dir).replace(/\\/g, '/').replace(/\/+$/, '');
  const catPath = assetsDir + '/catalog-content.json';
  $('status').textContent = 'lendo catalog-content.json…';
  try {
    if (window.__fileCached && !window.__fileCached(catPath)) await window.__preloadFile(catPath);
    if (!fsp.existsSync(catPath)) return alert('catalog-content.json não encontrado nessa pasta.\nEscolha a pasta "assets" do client.');
    const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));
    const appEntry = cat.find((c) => c.type === 'appearances'); if (!appEntry) return alert('catalog sem entrada "appearances"');
    const appPath = assetsDir + '/' + appEntry.file;
    $('status').textContent = 'lendo appearances.dat…';
    if (window.__fileCached && !window.__fileCached(appPath)) await window.__preloadFile(appPath);
    const appBytes = fs.readFileSync(appPath);
    const aspr = new AssetsSpr(assetsDir, cat);
    const ap = new Appearances(appBytes, { spriteSizeOf: (id) => aspr.spriteSize(id) });
    if (spr && spr.close) spr.close();
    dat = ap; spr = aspr; assetsMode = true; datPath = null; sprPath = null; datVersion = 1500;
    window.spr = spr; window.dat = dat;
    try { lsSet('assetsDir', assetsDir); } catch (e) {} // persiste p/ o próximo boot
    objCat = 'items'; objPage = 0;
    updateStatus(); drawSprite();
    if (typeof renderObjGrid === 'function') renderObjGrid();
    if (typeof renderSprPanel === 'function') renderSprPanel();
    if (typeof renderObjInfo === 'function') renderObjInfo();
    if (mode === 'map') reqMap();
    $('status').textContent = `📦 Assets 15.x: ${ap.items.size} items · ${ap.outfits.size} outfits · ${ap.effects.size} fx · ${ap.missiles.size} mis · ${aspr.sheets.length} sheets`;
  } catch (e) { console.error('assets', e); alert('Erro ao carregar assets: ' + e.message); }
}

// ---------- composicao de sprite (creature ou item), frame opcional ----------
// ---- cache de gráficos (invalida via gfxVer a cada edição) ----
let gfxVer = 0, sprPixVer = 0;
function _resetGLAtlas() { if (_mapGL && _mapGL._resetAtlas) { try { _mapGL._resetAtlas(); } catch (e) {} } } // limpa cache GPU (senão sprite velha fica cacheada no atlas após reimport)
function invalidateGfx() { gfxVer++; _resetGLAtlas(); }            // edição estrutural: recompõe things, MAS preserva os canvas de sprite (pixels não mudaram)
function invalidateSprites() { sprPixVer++; gfxVer++; _resetGLAtlas(); } // edição de PIXEL/import .spr: invalida canvas de sprite + recompõe
// invalidação CIRÚRGICA (Tauri/.spr lazy): quando sprites chegam async, remove SÓ esses ids do cache
// de canvas (estavam cacheados como "branco" do miss) e recompõe — sem limpar os ~milhares já decodificados
// (evita churn de GC/explosão de RAM durante a animação). Chamado pelo shim a cada lote carregado.
// no streaming lazy NÃO bumpamos gfxVer (isso recriava todos os composites = churn/RAM). spriteCanvas/composeThing
// já não cacheiam o miss, então o próximo render (ou o próprio tick da animação) recompõe sozinho quando o sprite chega.
window.__invalidateSprIds = function () {};
const _sprCv = new Map(); let _sprCvVer = -1;
// cap do cache de canvas de sprite — DIMENSIONADO pelo viewport (setado no renderMap). Cobre o
// working-set da tela sem desperdiçar RAM: zoom in = poucos; zoom out = mais, na medida. Cada
// <canvas> 32×32 custa caro em RAM, então o cap fica entre 2500 e 9000.
let _sprCvCap = 4000;
// canvas 32x32 de um sprite (cacheado). null se vazio. só limpa quando pixels mudam (sprPixVer), não em edição estrutural.
function spriteCanvas(sid) {
  if (_sprCvVer !== sprPixVer) { _sprCv.clear(); _sprCvVer = sprPixVer; }
  if (_sprCv.has(sid)) return _sprCv.get(sid);
  const px = sprEdits.has(sid) ? sprEdits.get(sid) : (spr ? spr.sprite(sid) : null);
  if (!px) return null; // .spr lazy: NÃO cacheia o miss (sprite chega async; retenta na próxima sem invalidar nada)
  // cap DINÂMICO (dimensionado pelo viewport no renderMap): evita thrash sem explodir a RAM.
  if (_sprCv.size >= _sprCvCap) { const it = _sprCv.keys().next().value; _sprCv.delete(it); }
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const arr = px instanceof Uint8ClampedArray ? px : new Uint8ClampedArray(px); c.getContext('2d').putImageData(new ImageData(arr, 32, 32), 0, 0);
  _sprCv.set(sid, c); return c;
}
// cache de ground/flags por tile — chave = identidade do node.props (todos os mutators OTBM substituem o Buffer)
function tileGroundC(node) { if (node._pcg !== node.props) { node._pcg = node.props; node._cg = OTBM.getGround(node); } return node._cg; }
function tileFlagsC(node) { if (node._pcf !== node.props) { node._pcf = node.props; node._cf = OTBM.getTileFlags(node); } return node._cf; }
const _composeCv = new WeakMap(); // thing -> { ver, m:Map(x:a -> canvas) }
function composeThing(t, x, a = 0) {
  if (!t || !spr) return null;
  let e = _composeCv.get(t);
  if (!e || e.ver !== gfxVer) { e = { ver: gfxVer, m: new Map() }; _composeCv.set(t, e); }
  const key = x + ':' + a;
  const hit = e.m.get(key); if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = t.width * 32; c.height = t.height * 32;
  const ctx = c.getContext('2d');
  let missing = false;
  for (let w = 0; w < t.width; w++) {
    for (let h = 0; h < t.height; h++) {
      const idx = dat.spriteIndex(t, w, h, 0, x, 0, 0, a);
      if (idx < 0 || idx >= t.sprites.length) continue;
      const sid = t.sprites[idx]; const sc = spriteCanvas(sid);
      if (sc) ctx.drawImage(sc, (t.width - 1 - w) * 32, (t.height - 1 - h) * 32);
      else if (spr.loaded && !spr.loaded(sid)) missing = true; // não carregado ≠ vazio (lazy)
    }
  }
  c._incomplete = missing;
  if (!missing) e.m.set(key, c); // só cacheia composite COMPLETO; incompleto recompõe (sem invalidar nada)
  return c;
}
// compõe um FRAME GROUP específico (gi) — outfits têm grupo idle e grupo walk separados
const _composeGCv = new WeakMap(); // thing -> { ver, m:Map(gi:x:a -> canvas) }  (cacheado p/ não recriar canvas por tick da animação)
function composeThingG(t, gi, x, a) {
  if (!t || !spr) return null; const g = t._groups && t._groups[gi]; if (!g || !g.sprites) return composeThing(t, x, a);
  let e = _composeGCv.get(t); if (!e || e.ver !== gfxVer) { e = { ver: gfxVer, m: new Map() }; _composeGCv.set(t, e); }
  const px = Math.min(x, (g.px || 1) - 1), frames = Math.max(1, g.frames || 1);
  const key = gi + ':' + px + ':' + a; const hit = e.m.get(key); if (hit) return hit;
  const c = document.createElement('canvas'); c.width = (g.width || 1) * 32; c.height = (g.height || 1) * 32; const ctx = c.getContext('2d');
  let missing = false;
  for (let w = 0; w < g.width; w++) for (let h = 0; h < g.height; h++) {
    const idx = ((((((a % frames) * g.pz + 0) * g.py + 0) * g.px + px) * g.layers + 0) * g.height + h) * g.width + w;
    if (idx < 0 || idx >= g.sprites.length) continue; const sid = g.sprites[idx]; const sc = spriteCanvas(sid);
    if (sc) ctx.drawImage(sc, (g.width - 1 - w) * 32, (g.height - 1 - h) * 32);
    else if (spr.loaded && !spr.loaded(sid)) missing = true;
  }
  c._incomplete = missing;
  if (!missing) e.m.set(key, c);
  return c;
}
// compõe um missile/distance-effect apontando pra direção (dx,dy) — usa os padrões px/py direcionais do .dat
function composeMissileDir(th, dx, dy) {
  if (!th || !spr) return null;
  const sx = dx < 0 ? 0 : dx > 0 ? 2 : 1, sy = dy < 0 ? 0 : dy > 0 ? 2 : 1;
  const px = Math.min(sx, (th.px || 1) - 1), py = Math.min(sy, (th.py || 1) - 1);
  const c = document.createElement('canvas'); c.width = (th.width || 1) * 32; c.height = (th.height || 1) * 32; const ctx = c.getContext('2d');
  for (let w = 0; w < th.width; w++) for (let h = 0; h < th.height; h++) {
    const idx = dat.spriteIndex(th, w, h, 0, px, py, 0, 0);
    if (idx < 0 || idx >= th.sprites.length) continue; const sc = spriteCanvas(th.sprites[idx]); if (!sc) continue;
    ctx.drawImage(sc, (th.width - 1 - w) * 32, (th.height - 1 - h) * 32);
  }
  return c;
}
// grupos do outfit (igual Object Builder): grupo 0 = idle (parado), grupo 1 = walk (andando)
function outfitGroups(t) { const gs = t._groups || []; if (gs.length > 1) return { idle: 0, walk: 1 }; const p = t._primary || 0; return { idle: p, walk: p }; }

// ---------- colorização de outfit (HSI 0..132, igual OTClient Color::getOutfitColor) ----------
function getOutfitColor(color) {
  const HSI_SI_VALUES = 7, HSI_H_STEPS = 19;
  if (color >= HSI_H_STEPS * HSI_SI_VALUES) color = 0;
  let loc1 = 0, loc2 = 0, loc3 = 0;
  if (color % HSI_H_STEPS !== 0) {
    loc1 = (color % HSI_H_STEPS) * 1.0 / 18.0; loc2 = 1; loc3 = 1;
    switch (Math.floor(color / HSI_H_STEPS)) {
      case 0: loc2 = 0.25; loc3 = 1.00; break; case 1: loc2 = 0.25; loc3 = 0.75; break;
      case 2: loc2 = 0.50; loc3 = 0.75; break; case 3: loc2 = 0.667; loc3 = 0.75; break;
      case 4: loc2 = 1.00; loc3 = 1.00; break; case 5: loc2 = 1.00; loc3 = 0.75; break;
      case 6: loc2 = 1.00; loc3 = 0.50; break;
    }
  } else { loc1 = 0; loc2 = 0; loc3 = 1 - color / HSI_H_STEPS / HSI_SI_VALUES; }
  if (loc3 === 0) return [0, 0, 0];
  if (loc2 === 0) { const v = Math.floor(loc3 * 255); return [v, v, v]; }
  let red = 0, green = 0, blue = 0;
  if (loc1 < 1 / 6) { red = loc3; blue = loc3 * (1 - loc2); green = blue + (loc3 - blue) * 6 * loc1; }
  else if (loc1 < 2 / 6) { green = loc3; blue = loc3 * (1 - loc2); red = green - (loc3 - blue) * (6 * loc1 - 1); }
  else if (loc1 < 3 / 6) { green = loc3; red = loc3 * (1 - loc2); blue = red + (loc3 - red) * (6 * loc1 - 2); }
  else if (loc1 < 4 / 6) { blue = loc3; red = loc3 * (1 - loc2); green = blue - (loc3 - red) * (6 * loc1 - 3); }
  else if (loc1 < 5 / 6) { blue = loc3; green = loc3 * (1 - loc2); red = green + (loc3 - green) * (6 * loc1 - 4); }
  else { red = loc3; green = loc3 * (1 - loc2); blue = red - (loc3 - green) * (6 * loc1 - 5); }
  return [Math.floor(red * 255), Math.floor(green * 255), Math.floor(blue * 255)];
}
const outfitColors = { head: 0, body: 0, legs: 0, feet: 0, addon: 0, dir: 2 };
// compõe outfit colorizado (layer0 base × cor da parte via mask layer1). Retorna canvas w*32 × h*32.
function composeColorized(t, g, dir, addon) {
  const c = document.createElement('canvas'); c.width = g.width * 32; c.height = g.height * 32;
  const ctx = c.getContext('2d');
  const parts = [getOutfitColor(outfitColors.head), getOutfitColor(outfitColors.body), getOutfitColor(outfitColors.legs), getOutfitColor(outfitColors.feet)];
  const x = Math.min(dir, g.px - 1), y = Math.min(addon, g.py - 1);
  for (let w = 0; w < g.width; w++) for (let h = 0; h < g.height; h++) {
    const i0 = dat.spriteIndex(g, w, h, 0, x, y, 0, 0);
    const base = spr.sprite(g.sprites[i0]); if (!base) continue;
    const out = new Uint8ClampedArray(base);
    if (g.layers >= 2) {
      const i1 = dat.spriteIndex(g, w, h, 1, x, y, 0, 0);
      const mask = spr.sprite(g.sprites[i1]);
      if (mask) {
        // lógica EXATA do shader glslOutfitFragmentShader: yellow=head, red=body, green=legs, blue=feet
        const T = 229; // 0.9*255
        for (let p = 0; p < 1024; p++) {
          const o = p * 4; if (out[o + 3] === 0) continue;
          const mr = mask[o], mg = mask[o + 1], mb = mask[o + 2];
          let col = null;
          if (mr > T) col = mg > T ? parts[0] : parts[1];   // head : body
          else if (mg > T) col = parts[2];                  // legs
          else if (mb > T) col = parts[3];                  // feet
          if (!col) continue;
          out[o] = (out[o] * col[0] / 255) | 0; out[o + 1] = (out[o + 1] * col[1] / 255) | 0; out[o + 2] = (out[o + 2] * col[2] / 255) | 0;
        }
      }
    }
    const off = document.createElement('canvas'); off.width = 32; off.height = 32;
    off.getContext('2d').putImageData(new ImageData(out, 32, 32), 0, 0);
    ctx.drawImage(off, (g.width - 1 - w) * 32, (g.height - 1 - h) * 32);
  }
  return c;
}
// ---------- animação de sprite (cicla os frames) ----------
const _anims = new Map(); // canvas -> { t, x, a, last, interval }
let _animRAF = null;
function _frameDur(t, a) { // duração (ms) do frame a, das durations reais se houver
  if (t._durations && t._durations[a]) { const d = t._durations[a]; return Math.max(20, d.min || 100); }
  return 200;
}
// compõe um grupo específico (usa o cache do primário quando gi==primário; senão compõe o grupo)
function composeG(t, gi, x, a) { return (gi == null || gi === (t._primary || 0)) ? composeThing(t, x, a) : composeThingG(t, gi, x, a); }
function _animTick(ts) {
  for (const [cv, st] of _anims) {
    if (ts - st.last >= st.interval) {
      const c = composeG(st.t, st.g, st.x, st.a);
      if (c && c._incomplete) continue; // frame ainda carregando (lazy): mantém o último bom, NÃO desenha preto nem avança
      st.last = ts; if (c) drawScaled(cv, c); st.a = (st.a + 1) % st.frames; st.interval = _frameDur(st.t, st.a);
    }
  }
  _animRAF = _anims.size ? requestAnimationFrame(_animTick) : null;
}
function setAnim(canvas, t, x, gi) {
  gi = (gi == null) ? (t && t._primary || 0) : gi;
  const g = (t && t._groups && t._groups[gi]) || t; const frames = Math.max(1, (g && g.frames) || 1);
  drawScaled(canvas, composeG(t, gi, x, 0));
  if (frames > 1) {
    _anims.set(canvas, { t, x, g: gi, frames, a: 1 % frames, last: 0, interval: _frameDur(t, 0) });
    if (!_animRAF) _animRAF = requestAnimationFrame(_animTick);
  } else { _anims.delete(canvas); }
}
function clearAllAnims() { _anims.clear(); if (_animRAF) { cancelAnimationFrame(_animRAF); _animRAF = null; } }

function drawScaled(disp, off) {
  const ctx = disp.getContext('2d');
  ctx.clearRect(0, 0, disp.width, disp.height);
  if (!off) return false;
  const s = Math.max(1, Math.min(Math.floor(disp.width / off.width), Math.floor(disp.height / off.height)));
  const dw = off.width * s, dh = off.height * s;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, (disp.width - dw) / 2, (disp.height - dh) / 2, dw, dh);
  return true;
}

// desenha o icone de um item (loot usa SERVER id -> mapeia p/ client via otb)
function drawItemIcon(canvas, serverId) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!dat || !spr || !serverId) return;
  const cid = (otbMap && otbMap.get(serverId)) || serverId;
  const t = dat.item(cid);
  if (!t) return;
  drawScaled(canvas, composeThing(t, 0));
}

// desenha um outfit (creature) virado p/ sul no canvas dado
function drawCreatureSprite(disp, looktype) {
  const ctx = disp.getContext('2d');
  ctx.clearRect(0, 0, disp.width, disp.height);
  if (!dat || !spr) { drawText(ctx, 'carregue .dat/.spr'); return; }
  if (!looktype) { drawText(ctx, 'sem looktype'); return; }
  const t = dat.creature(looktype);
  if (!t) { drawText(ctx, 'outfit ' + looktype + ' n/d'); return; }
  const x = t.px >= 4 ? 2 : (t.px > 1 ? 2 % t.px : 0); // sul
  setAnim(disp, t, x); // anima se tiver frames
}

// ---------- auto-load ----------
function findUp(rel) {
  let base = process.cwd();
  for (let i = 0; i < 8; i++) {
    const c = path.join(base, rel);
    if (fs.existsSync(c)) return c;
    const parent = path.dirname(base);
    if (parent === base) break;
    base = parent;
  }
  // tambem tenta a partir do diretorio do app
  base = __dirname;
  for (let i = 0; i < 8; i++) {
    const c = path.join(base, rel);
    if (fs.existsSync(c)) return c;
    const parent = path.dirname(base);
    if (parent === base) break;
    base = parent;
  }
  return null;
}

async function autoLoad() {
  const inv = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  // checa no fs REAL (Rust), não no cache do shim — senão o boot descarta caminho válido ainda não carregado
  const exists = async (p) => { if (!p) return false; try { return inv ? await inv('path_exists', { path: p }) : fsp.existsSync(p); } catch (e) { return false; } };
  const preF = async (p) => { try { if (window.__preloadFile) await window.__preloadFile(p); } catch (e) {} };
  const preD = async (p) => { try { if (window.__preloadTree) await window.__preloadTree(p); } catch (e) {} };
  const preDL = async (p) => { try { if (window.__preloadTreeLua) await window.__preloadTreeLua(p); else if (window.__preloadTree) await window.__preloadTree(p); } catch (e) {} }; // inclui .lua (Canary)
  // o caminho que o USUÁRIO salvou SEMPRE tem prioridade; findUp() é só o chute da 1ª vez (sem nada salvo)
  const saved = (k, rel) => lsGet(k) || (rel ? (findUp(rel) || '') : '');

  // client things (.dat/.spr/.otb) — pré-carrega (leitura confiável no boot) + detecta versão; o formato real (extended) é resolvido no loadDatAuto
  const datF = saved('datPath', 'data/things/860/Tibia.dat');
  const sprF = saved('sprPath', 'data/things/860/Tibia.spr');
  if (datF && await exists(datF)) { await preF(datF); datPath = datF; detectDatFormat(datF); }
  if (sprF && await exists(sprF)) sprPath = sprF; // .spr lê nativo (Rust)
  const otbF = saved('otbPath', '');
  if (otbF && await exists(otbF)) { try { await preF(otbF); otbMap = loadOtb(otbF); otbPath = otbF; rebuildOtbInv(); loadItemsXmlNear(datPath); } catch (e) { console.error('otb', e); } }
  else if (datPath) loadOtbNear(datPath);
  reloadGraphics();

  // 15.x / Canary (se salvos): assets do CLIENTE (sprites) + items.xml do SERVIDOR (atributos).
  // Carrega DEPOIS do .dat/.spr → se o usuário usa 15.x, os assets assumem o lugar dos gráficos.
  try {
    const assetsD = lsGet('assetsDir') || '';
    if (assetsD && await exists(assetsD)) await loadAssetsFrom(assetsD);
    const itemsX = lsGet('itemsXml15') || '';
    if (itemsX && await exists(itemsX)) await loadItemsXmlFrom(itemsX);
  } catch (e) { console.error('assets15/itemsxml15', e); }

  // dados do servidor — SEMPRE prioriza o caminho salvo do usuário (qualquer pasta dele)
  const cfgF = saved('cfgFile', 'otserv/config.lua');
  const vocF = saved('vocFile', 'otserv/data/XML/vocations.xml');
  const monF = saved('monDir', 'otserv/data/monster');
  const npcF = saved('npcDir', 'otserv/data/npc');
  spellsFile = saved('spellsFile', 'otserv/data/spells/spells.xml');
  try { if (cfgF && await exists(cfgF)) { await preF(cfgF); serverCfg = cfgLib.loadConfig(cfgF); cfgFile = cfgF; } } catch (e) { console.error('cfg', e); }
  try { if (vocF && await exists(vocF)) { await preF(vocF); vocStore = V.loadVocations(vocF); fillVocSelect(); } } catch (e) { console.error('voc', e); }
  if (monF && await exists(monF)) { await preDL(monF); monDir = monF; loadMonsters(monF); }
  if (npcF && await exists(npcF)) { await preDL(npcF); npcDir = npcF; loadNpcs(npcF); }
  spawnFile = lsGet('spawnFile') || '';
  if (spawnFile && await exists(spawnFile)) { try { await preF(spawnFile); spawnStore = SP.loadSpawn(spawnFile); spawnStore._auto = true; } catch (e) { spawnStore = null; } }
  // mapa (.otbm): lembra o caminho; parse preguiçoso ao abrir o modo Mapa (não atrasa o boot)
  mapPath = lsGet('mapPath') || ''; if (mapPath && !(await exists(mapPath))) mapPath = '';
  // raiz do explorador de arquivos
  filesRoot   = lsGet('filesRoot')    || lsGet('serverRoot') || (monDir ? path.resolve(monDir, '..', '..') : (findUp('otserv') || ''));
  filesRoot2  = lsGet('filesRoot2')   || null;
  filesRootOtc = lsGet('filesRootOtc') || null;
  filesRootC   = lsGet('filesRootC')   || null;
  updateStatus();
  updateSaveAll();
  setMode('mon');
  try { wireNativeFileDrop(); } catch (e) {}
}

// ---------- editor de arquivo (.lua/.xml com syntax highlight) ----------
let _editFile = null, _editReload = null, _cm = null;
function ensureCM() {
  if (_cm) return _cm;
  _cm = CodeMirror.fromTextArea($('editArea'), {
    lineNumbers: true, theme: 'material-darker', mode: 'text/plain',
    indentUnit: 4, tabSize: 4, lineWrapping: false, extraKeys: CM_KEYS,
  });
  return _cm;
}
function openEditor(file, reloadFn) {
  if (!file || !fsp.existsSync(file)) { alert('arquivo nao existe: ' + file); return; }
  if (window.__fileCached && !window.__fileCached(file)) { window.__preloadFile(file).then(() => openEditor(file, reloadFn)); return; } // .lua/.md lidos sob demanda (não ficam em RAM no boot)
  let text;
  try { text = fsp.readFileSync(file, 'latin1'); } catch (e) { alert(e.message); return; }
  _editFile = file; _editReload = reloadFn || null;
  const mode = modeFor(file);
  $('editTitle').textContent = 'Editar: ' + path.basename(file);
  $('editPath').textContent = file;
  $('editModal').style.display = 'flex';
  const cm = ensureCM();
  cm.setOption('mode', mode);
  cm.setValue(text);
  cm.clearHistory();
  setTimeout(() => { cm.refresh(); cm.focus(); }, 20);
}
function reloadMobFile(file) {
  const i = monsters.findIndex((m) => m.file === file);
  if (i < 0) return;
  const nm = M.parse(file); if (!nm) return;
  monsters[i] = nm; rebuildNpcCtx();
  if (current && current.file === file) select(nm); else renderList();
}
function reloadNpcFile(file) {
  const i = npcs.findIndex((n) => n.file === file);
  if (i < 0) return;
  const nn = N.parse(file); if (!nn) return;
  npcs[i] = nn; rebuildNpcCtx();
  if (currentNpc && currentNpc.file === file) selectNpc(nn); else renderList();
}
function reloadAfterEdit(file) {
  const b = path.basename(file).toLowerCase();
  if (b === 'config.lua') { try { serverCfg = cfgLib.loadConfig(file); } catch (e) {} }
  else if (b === 'vocations.xml') { try { vocStore = V.loadVocations(file); fillVocSelect(); renderList(); } catch (e) {} }
  else if (monDir && file.startsWith(monDir)) reloadMobFile(file);
  else if (npcDir && file.startsWith(npcDir)) reloadNpcFile(file);
  updateStatus();
}

// popula o select de vocação (default = maior gainhp, ou id 1)
function fillVocSelect() {
  const sel = $('balVoc');
  sel.innerHTML = '';
  let best = 0, bestHp = -1;
  vocList().forEach((v, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${vname(v)} (hp+${vnum(v, 'gainhp')})`;
    sel.appendChild(o);
    if (v.id > 0 && vnum(v, 'gainhp') > bestHp) { bestHp = vnum(v, 'gainhp'); best = i; }
  });
  sel.value = best;
}

function updateStatus() {
  const d = dat ? `${dat.creatureCountLoaded()} outfits` : '—';
  const s = spr ? `${spr.count} sprites` : '—';
  const o = otbMap ? `${otbMap.size} itens` : '—';
  const v = vocList().length ? `${vocList().length} vocs` : '—';
  const st = serverCfg ? `${serverCfg.stages.length} stages` : '—';
  $('status').textContent = `.dat: ${d} | .spr: ${s} | otb: ${o} | mobs: ${monsters.length} | NPCs: ${npcs.length} | voc: ${v} | exp: ${st}`;
}

function rebuildNpcCtx() { npcCtx = economy.buildNpcContext(npcs, monsters); }

// ---------- carregamento ----------
function loadMonsters(dir) {
  try {
    monsters = M.loadFolder(dir);
    rebuildNpcCtx();
    renderList();
    updateStatus();
  } catch (e) {
    alert('Erro ao carregar monstros: ' + e.message);
  }
}

function loadNpcs(dir) {
  try {
    npcs = N.loadFolder(dir);
    rebuildNpcCtx();
    renderList();
    updateStatus();
  } catch (e) {
    alert('Erro ao carregar NPCs: ' + e.message);
  }
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const list = $('list');
  list.innerHTML = '';
  if (mode === 'econ') return;
  if (mode === 'spell') {
    if (!spellStore.dir) { list.innerHTML = '<div class="alabel" style="padding:8px;font-size:11px">Clique <b>📂 Abrir do servidor</b> e escolha a pasta de spells (ex: data/scripts/spells)</div>'; return; }
    const arr = spellStore.list.filter((s) => !q || (s.name + ' ' + (s.words || '') + ' ' + s.rel).toLowerCase().includes(q));
    if (!arr.length) { list.innerHTML = '<div class="alabel" style="padding:8px">nenhuma spell</div>'; return; }
    arr.slice(0, 2000).forEach((s) => {
      const div = document.createElement('div');
      div.className = 'item' + (s === _spellSel ? ' sel' : '');
      div.innerHTML = `${escapeHtml(s.name)}${s.rune ? ' 🪧' : ''}<br><span class="exp">${s.words ? escapeHtml(s.words) : (s.group || s.rel)}</span>`;
      div.onclick = () => openSpellFromStore(s);
      list.appendChild(div);
    });
    return;
  }
  if (mode === 'voc') {
    vocList().forEach((v) => {
      if (q && !v.name.toLowerCase().includes(q)) return;
      const div = document.createElement('div');
      div.className = 'item' + (v === currentVoc ? ' sel' : '');
      div.innerHTML = `${escapeHtml(vname(v))}${v._new ? ' 🆕' : (v._dirty ? ' *' : '')}<br><span class="exp">id ${v.id} · hp+${vnum(v, 'gainhp')}</span>`;
      div.onclick = () => selectVoc(v);
      list.appendChild(div);
    });
    return;
  }
  if (mode === 'npc') {
    for (const n of npcs) {
      if (q && !n.name.toLowerCase().includes(q)) continue;
      const b = n.items.filter((i) => i.role === 'buy').length;
      const s = n.items.filter((i) => i.role === 'sell').length;
      const div = document.createElement('div');
      div.className = 'item' + (n === currentNpc ? ' sel' : '');
      div.innerHTML = `${escapeHtml(n.name)}<br><span class="exp">vende ${b} · compra ${s}</span>`;
      div.onclick = () => selectNpc(n);
      list.appendChild(div);
    }
  } else {
    for (const m of monsters) {
      if (q && !m.name.toLowerCase().includes(q)) continue;
      const div = document.createElement('div');
      div.className = 'item' + (m === current ? ' sel' : '');
      div.innerHTML = `${escapeHtml(m.name)}<br><span class="exp">${m.exp} exp · ${m.tier}</span>`;
      div.onclick = () => select(m);
      list.appendChild(div);
    }
  }
}

function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

// alterna entre modos: mon | npc | voc | econ
function setMode(m) {
  mode = m;
  clearAllAnims();
  _objInspectCv = null;
  for (const [id, md] of [['modeMon', 'mon'], ['modeNpc', 'npc'], ['modeVoc', 'voc'], ['modeSpawn', 'spawn'], ['modeFiles', 'files'], ['modeObj', 'obj'], ['modeAssets', 'assets'], ['modeEcon', 'econ'], ['modeMap', 'map'], ['modeAi', 'ai'], ['modeSpell', 'spell'], ['modeScript', 'script']])
    { const el = $(id); if (el) el.classList.toggle('active', m === md); }
  const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };
  const full = m === 'econ' || m === 'spawn' || m === 'obj' || m === 'assets' || m === 'ai' || m === 'map' || m === 'spell' || m === 'script'; // largura toda
  const files = m === 'files';                     // arvore na sidebar + editor
  const editable = !full && !files;                // modos de entidade (mon/npc/voc)
  show('list', editable);
  show('searchRow', editable);
  show('fileTreeWrap', files);
  show('head', m === 'mon' || m === 'npc');
  show('balance', m === 'mon');
  show('attrPanel', m === 'mon' || m === 'npc');
  show('vocForm', m === 'voc');
  show('tableWrap', m === 'mon' || m === 'npc');
  show('actions', editable);
  show('econPanel', m === 'econ');
  show('spawnPanel', m === 'spawn');
  show('objPanel', m === 'obj');
  show('assetsPanel', m === 'assets');
  show('aiPanel', m === 'ai');
  show('spellPanel', m === 'spell');
  show('scriptPanel', m === 'script');
  show('mapPanel', m === 'map');
  if ($('detail')) $('detail').style.padding = (m === 'map') ? '0' : '';
  show('filesPanel', files);
  show('btnGold', m === 'mon');
  show('btnAdd', m === 'mon' || m === 'npc');
  show('btnApplySug', m === 'npc');
  show('btnDelete', editable);
  show('btnEditRaw', editable);
  show('btnSave', editable);
  $('btnSave').textContent = m === 'npc' ? '💾 Salvar NPC' : (m === 'voc' ? '💾 Salvar Voc' : '💾 Salvar XML');
  $('btnNew').textContent = m === 'voc' ? '＋ Nova voc' : (m === 'npc' ? '＋ Novo NPC' : (m === 'spell' ? '＋ Nova spell' : '＋ Novo mob'));
  if (m === 'spell') { show('list', true); show('searchRow', true); } // spell tem sidebar fixa (lista da pasta)
  $('lootBody').innerHTML = '';
  if (m === 'econ') initEcon();
  if (m === 'spawn') renderSpawns();
  if (m === 'obj') { renderObjGrid(); renderSprPanel(); renderObjInfo(); }
  if (m === 'ai') initAi();
  if (m === 'map') { if (!mapData && mapPath && lsGet('autoload') !== '0') { $('status').textContent = 'auto-carregando mapa salvo…'; (async () => { try { if (window.__preloadFile) await window.__preloadFile(mapPath); loadMapFile(mapPath); } catch (e) { console.error('auto-map', e); } })(); } initMap(); }
  if (m === 'spell') initSpell();
  if (m === 'script') initScript();
  if (files) { renderTree(); renderTreeB(); renderTreeOtc(); renderTreeC(); updateAiFolderStatus(); if (filesCM) setTimeout(() => filesCM.refresh(), 20); }
  renderList();
  if (typeof liveCursorMode === 'function') liveCursorMode();
}

// ---------- selecao monstro ----------
function select(m) {
  current = m;
  renderList();
  setHead('mon');
  $('mName').textContent = m.name;
  $('mMeta').textContent =
    `vida: ${m.health} · speed: ${m.speed} · looktype: ${m.looktype}` +
    (m.typeex ? ` · typeex: ${m.typeex}` : '');
  $('mExp').value = m.exp;
  const [mn, mx] = economy.goldRange(m.exp);
  $('mTier').textContent = `Tier: ${m.tier}   (gold sugerido ${mn}–${mx})`;
  $('mSuggest').textContent = `Sugestao: <item ${economy.suggestedGoldAttrs(m.exp)}/>`;
  renderBalance();
  renderAttrs();
  renderMonExtras();
  renderLoot();
  drawSprite();
}

// painel de atributos completos do mob (edita qualquer campo)
// edita um bloco nomeado no raw do monstro (summons/voices) — preservado no save (patch)
function rawBlockRe(tag) { return new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '>|<' + tag + '\\b[^>]*\\/>', 'i'); }
function rawSetBlock(m, tag, block) {
  const re = rawBlockRe(tag); const cur = m.raw.match(re);
  if (!block) { if (cur) m.raw = m.raw.replace(re, '').replace(/[ \t]*\n[ \t]*\n[ \t]*\n/g, '\n\n'); return; }
  if (cur) m.raw = m.raw.replace(re, block); else { const i = m.raw.lastIndexOf('</monster>'); if (i >= 0) m.raw = m.raw.slice(0, i) + '\t' + block + '\n' + m.raw.slice(i); }
}
function attrOf(s, k) { const mm = s.match(new RegExp(k + '\\s*=\\s*"([^"]*)"', 'i')); return mm ? mm[1] : ''; }
function renderMonExtras() {
  const box = $('attrFields'); const m = current; if (!box || !m) return;
  // ---- SUMMONS ----
  const sec = (t) => { const d = document.createElement('div'); d.className = 'vsection'; d.textContent = t; box.appendChild(d); };
  sec('🐾 Summons');
  const sblk = (m.raw.match(rawBlockRe('summons')) || [''])[0];
  let maxS = attrOf(sblk, 'maxSummons') || '';
  const summons = []; if (sblk) { const re = /<summon\b([^>]*?)\/?>/gi; let s; while ((s = re.exec(sblk))) summons.push({ name: attrOf(s[1], 'name'), interval: attrOf(s[1], 'interval'), chance: attrOf(s[1], 'chance'), max: attrOf(s[1], 'max') }); }
  const rebuildS = () => { let b = ''; if (summons.length) { b = `<summons maxSummons="${maxS || summons.length}">\n`; for (const s of summons) b += `\t\t<summon name="${s.name}" interval="${s.interval || 2000}" chance="${s.chance || 10}"${s.max ? ` max="${s.max}"` : ''}/>\n`; b += '\t</summons>'; } rawSetBlock(m, 'summons', b); markDirty(m); };
  const mr = document.createElement('div'); mr.className = 'vrow'; const ml = document.createElement('label'); ml.textContent = 'maxSummons'; const mi = document.createElement('input'); mi.type = 'number'; mi.value = maxS; mi.oninput = () => { maxS = mi.value; rebuildS(); }; mr.append(ml, mi); box.appendChild(mr);
  const slist = document.createElement('div'); box.appendChild(slist);
  const drawS = () => { slist.innerHTML = ''; summons.forEach((s, i) => { const r = document.createElement('div'); r.className = 'vrow'; r.style.gridTemplateColumns = '1fr 70px 60px 50px 24px';
    const mk = (ph, key, w) => { const inp = document.createElement('input'); inp.placeholder = ph; inp.value = s[key]; inp.style.width = w || ''; inp.oninput = () => { s[key] = inp.value; rebuildS(); }; return inp; };
    const del = document.createElement('button'); del.className = 'expBtn'; del.textContent = '✕'; del.onclick = () => { summons.splice(i, 1); rebuildS(); drawS(); };
    r.append(mk('nome', 'name'), mk('interval', 'interval'), mk('chance', 'chance'), mk('max', 'max'), del); slist.appendChild(r); }); };
  drawS();
  const addS = document.createElement('button'); addS.className = 'miniBtn'; addS.textContent = '➕ summon'; addS.onclick = () => { summons.push({ name: 'Demon', interval: '2000', chance: '10', max: '1' }); rebuildS(); drawS(); }; box.appendChild(addS);
  // ---- VOICES ----
  sec('🗣 Voices');
  const vblk = (m.raw.match(rawBlockRe('voices')) || [''])[0];
  let vInt = attrOf(vblk, 'interval') || '5000', vBeat = attrOf(vblk, 'beatInterval') || '';
  const voices = []; if (vblk) { const re = /<voice\b([^>]*?)\/?>/gi; let s; while ((s = re.exec(vblk))) voices.push({ sentence: attrOf(s[1], 'sentence'), yell: /yell\s*=\s*"1"/i.test(s[1]) }); }
  const rebuildV = () => { let b = ''; if (voices.length) { b = `<voices interval="${vInt}"${vBeat ? ` beatInterval="${vBeat}"` : ''}>\n`; for (const v of voices) b += `\t\t<voice sentence="${v.sentence}"${v.yell ? ' yell="1"' : ''}/>\n`; b += '\t</voices>'; } rawSetBlock(m, 'voices', b); markDirty(m); };
  const vlist = document.createElement('div'); box.appendChild(vlist);
  const drawV = () => { vlist.innerHTML = ''; voices.forEach((v, i) => { const r = document.createElement('div'); r.className = 'vrow'; r.style.gridTemplateColumns = '1fr 40px 24px';
    const inp = document.createElement('input'); inp.placeholder = 'frase'; inp.value = v.sentence; inp.oninput = () => { v.sentence = inp.value; rebuildV(); };
    const yl = document.createElement('label'); yl.style.cssText = 'font-size:10px'; const yc = document.createElement('input'); yc.type = 'checkbox'; yc.checked = v.yell; yc.onchange = () => { v.yell = yc.checked; rebuildV(); }; yl.append(yc, document.createTextNode('yell'));
    const del = document.createElement('button'); del.className = 'expBtn'; del.textContent = '✕'; del.onclick = () => { voices.splice(i, 1); rebuildV(); drawV(); };
    r.append(inp, yl, del); vlist.appendChild(r); }); };
  drawV();
  const addV = document.createElement('button'); addV.className = 'miniBtn'; addV.textContent = '➕ voice'; addV.onclick = () => { voices.push({ sentence: 'Grrr!', yell: false }); rebuildV(); drawV(); }; box.appendChild(addV);
  // ---- SCRIPTS / EVENTOS (registra creaturescripts no monstro) ----
  sec('📜 Scripts (eventos)');
  const scblk = (m.raw.match(rawBlockRe('script')) || [''])[0];
  const events = []; if (scblk) { const re = /<event\b([^>]*?)\/?>/gi; let s; while ((s = re.exec(scblk))) events.push({ name: attrOf(s[1], 'name') }); }
  const rebuildSc = () => { let b = ''; if (events.length) { b = '<script>\n'; for (const e of events) b += `\t\t<event name="${e.name}"/>\n`; b += '\t</script>'; } rawSetBlock(m, 'script', b); markDirty(m); };
  const sclist = document.createElement('div'); box.appendChild(sclist);
  const drawSc = () => { sclist.innerHTML = ''; events.forEach((e, i) => { const r = document.createElement('div'); r.className = 'vrow'; r.style.gridTemplateColumns = '1fr 24px'; const inp = document.createElement('input'); inp.placeholder = 'nome do creaturescript'; inp.value = e.name; inp.oninput = () => { e.name = inp.value; rebuildSc(); }; const del = document.createElement('button'); del.className = 'expBtn'; del.textContent = '✕'; del.onclick = () => { events.splice(i, 1); rebuildSc(); drawSc(); }; r.append(inp, del); sclist.appendChild(r); }); };
  drawSc();
  const addSc = document.createElement('button'); addSc.className = 'miniBtn'; addSc.textContent = '➕ evento'; addSc.onclick = () => { events.push({ name: 'MonsterDeath' }); rebuildSc(); drawSc(); }; box.appendChild(addSc);
}
function renderAttrs() {
  const box = $('attrFields');
  box.innerHTML = '';
  if (!current || mode !== 'mon') return;
  const m = current;
  const section = (t) => { const d = document.createElement('div'); d.className = 'vsection'; d.textContent = t; box.appendChild(d); };
  const field = (label, tag, key, after) => {
    if (!tag) return;
    const row = document.createElement('div'); row.className = 'vrow';
    const l = document.createElement('label'); l.textContent = label;
    const i = document.createElement('input'); i.value = M.tagGet(tag, key) || '';
    i.oninput = () => { M.tagSet(tag, key, i.value); markDirty(m); if (after) after(i.value); };
    row.append(l, i); box.appendChild(row);
  };
  section('Geral');
  field('name', m.rootTag, 'name', (v) => { m.name = v; $('mName').textContent = v; renderList(); });
  field('nameDescription', m.rootTag, 'nameDescription');
  field('race', m.rootTag, 'race');
  field('speed', m.rootTag, 'speed', (v) => { m.speed = parseInt(v, 10) || 0; });
  field('manacost', m.rootTag, 'manacost');
  section('Vida');
  field('now', m.healthTag, 'now');
  field('max', m.healthTag, 'max', (v) => { m.health = parseInt(v, 10) || 0; });
  section('Look');
  ['type', 'head', 'body', 'legs', 'feet', 'addons', 'corpse'].forEach((k) =>
    field(k, m.lookTag, k, k === 'type' ? (v) => { m.looktype = parseInt(v, 10) || 0; drawSprite(); } : null));
  section('Strategy');
  field('attack', m.strategyTag, 'attack');
  field('defense', m.strategyTag, 'defense');
  section('Defenses');
  field('armor', m.defensesTag, 'armor');
  field('defense', m.defensesTag, 'defense');
  const listSection = (title, tags) => {
    if (!tags || !tags.length) return;
    section(title);
    tags.forEach((t) => { (t.attrs || []).forEach((a) => field(a.k, t, a.k)); }); // mostra TODOS os attrs (multi-elemento: fire/energy/earth…)
  };
  listSection('Flags', m.flagTags);
  listSection('Immunities', m.immunityTags);
  listSection('Elements', m.elementTags);
}

// dano max atual do monstro (maior |max| dos ataques)
function curMaxHit(m) {
  let mx = 0;
  for (const a of (m.attacks || [])) {
    const v = Math.abs(parseInt(M.lget(a.attrs, 'max') || '0', 10));
    if (v > mx) mx = v;
  }
  return mx;
}

// painel de balanceamento (exp vs stages + dano vs HP do player)
function renderBalance() {
  if (!current || mode !== 'mon') return;
  const voc = vocList()[parseInt($('balVoc').value, 10)] || vocList()[0];
  const level = Math.max(1, parseInt($('balLevel').value, 10) || 1);
  const gainhp = voc ? vnum(voc, 'gainhp') : 0;

  const hp = B.playerHP(level, gainhp);
  const mp = voc ? B.playerMana(level, vnum(voc, 'gainmana')) : 0;
  $('balHp').textContent = `Player lv${level}: ${hp} HP · ${mp} mana`;

  // exp (usa stages do config)
  const mult = serverCfg ? cfgLib.stageMult(serverCfg, level) : 1;
  const sExp = B.suggestExp(level, mult);
  $('balExp').innerHTML = `Exp: ${current.exp} → <b>${sExp}</b> <span class="alabel">(stage x${mult}, ${B.KILLS_PER_LEVEL} kills/lv)</span>`;
  $('balExpApply').dataset.v = sExp;

  // dano (vs HP do player)
  const cur = curMaxHit(current);
  const sDmg = B.suggestMaxHit(level, gainhp);
  $('balDmg').innerHTML = `Dano máx: ${cur} → <b>${sDmg}</b> <span class="alabel">(${Math.round(B.DANGER_PCT * 100)}% do HP)</span>`;
  $('balDmgApply').dataset.v = sDmg;

  // life (HP do mob equivalente ao level do player)
  const sLife = B.suggestHealth(level, gainhp);
  $('balLife').innerHTML = `Life: ${current.health || 0} → <b>${sLife}</b> <span class="alabel">(${Math.round(B.HP_MULT * 100)}% do HP do player)</span>`;
  $('balLifeApply').dataset.v = sLife;

  // lista de ataques: nome + min/max editaveis + remover + adicionar
  const box = $('attacksBox');
  box.innerHTML = '';
  (current.attacks || []).forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'atkRow';
    const nm = document.createElement('input');
    nm.className = 'aname';
    nm.value = M.lget(a.attrs, 'name') || '';
    nm.placeholder = 'nome da spell';
    nm.onchange = () => { current.attacks[i].attrs = M.lset(current.attacks[i].attrs, 'name', nm.value.trim()); markDirty(current); };
    row.appendChild(nm);
    const mkAtk = (key) => {
      const wrap = document.createElement('span');
      wrap.innerHTML = `<span class="alabel">${key}</span> `;
      const inp = document.createElement('input');
      inp.value = M.lget(a.attrs, key) || '';
      inp.onchange = () => {
        const val = inp.value.trim();
        current.attacks[i].attrs = val ? M.lset(current.attacks[i].attrs, key, val) : M.lremove(current.attacks[i].attrs, key);
        markDirty(current); renderBalance();
      };
      wrap.appendChild(inp);
      return wrap;
    };
    row.appendChild(mkAtk('min'));
    row.appendChild(mkAtk('max'));
    const del = document.createElement('button');
    del.className = 'delBtn'; del.textContent = '✕';
    del.onclick = () => { current.attacks.splice(i, 1); markDirty(current); renderBalance(); };
    row.appendChild(del);
    box.appendChild(row);
  });
  const add = document.createElement('button');
  add.className = 'sugBtn'; add.textContent = '＋ ataque / spell';
  add.onclick = () => {
    current.attacks.push({ attrs: 'name="nova_spell" interval="2000" chance="15" min="-100" max="-200"', selfClose: true, orig: '' });
    markDirty(current); renderBalance();
  };
  box.appendChild(add);
}

// ---------- selecao npc ----------
function selectNpc(n) {
  currentNpc = n;
  renderList();
  setHead('npc');
  $('mName').textContent = n.name;
  const b = n.items.filter((i) => i.role === 'buy').length;
  const s = n.items.filter((i) => i.role === 'sell').length;
  $('mMeta').textContent = `vendedor · looktype: ${n.looktype} · vende ${b} item(s), compra ${s}`;
  renderNpcParams();
  renderShop();
  drawSprite();
}
// editor de parâmetros/diálogo do NPC (message_greet, farewell, módulos…) — edita o raw, preservado no save
const NPC_PARAM_HINTS = ['message_greet', 'message_farewell', 'message_walkaway', 'message_decline', 'message_needmorespace', 'message_alreadytrading', 'message_sendtrade', 'module_shop', 'module_travel', 'module_keywords', 'idletime', 'talkradius'];
function renderNpcParams() {
  const box = $('attrFields'); const n = currentNpc; if (!box || !n) return; box.innerHTML = '';
  const sec = document.createElement('div'); sec.className = 'vsection'; sec.textContent = '💬 Parâmetros / Diálogo'; box.appendChild(sec);
  // parse params (exceto shop_buyable/sellable que têm UI própria)
  const params = []; const re = /<parameter\b[^>]*\bkey\s*=\s*"([^"]*)"[^>]*\bvalue\s*=\s*"([\s\S]*?)"[^>]*\/?>/gi; let pm;
  while ((pm = re.exec(n.raw))) { if (/^shop_(buyable|sellable)$/i.test(pm[1])) continue; params.push({ key: pm[1], value: pm[2] }); }
  const setParam = (key, value) => {
    const re2 = new RegExp('<parameter\\b[^>]*\\bkey\\s*=\\s*"' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*\\/?>', 'i');
    const tag = `<parameter key="${key}" value="${value}" />`;
    if (re2.test(n.raw)) n.raw = n.raw.replace(re2, tag);
    else { const i = n.raw.search(/<\/parameters>/i); if (i >= 0) n.raw = n.raw.slice(0, i) + '\t\t' + tag + '\n\t' + n.raw.slice(i); else { const j = n.raw.lastIndexOf('</npc>'); if (j >= 0) n.raw = n.raw.slice(0, j) + `\t<parameters>\n\t\t${tag}\n\t</parameters>\n` + n.raw.slice(j); } }
    markDirty(n);
  };
  const delParam = (key) => { const re2 = new RegExp('[ \\t]*<parameter\\b[^>]*\\bkey\\s*=\\s*"' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*\\/?>\\n?', 'i'); n.raw = n.raw.replace(re2, ''); markDirty(n); };
  const list = document.createElement('div'); box.appendChild(list);
  const draw = () => { list.innerHTML = ''; params.forEach((p, i) => { const r = document.createElement('div'); r.className = 'vrow'; r.style.gridTemplateColumns = '130px 1fr 24px';
    const kl = document.createElement('input'); kl.value = p.key; kl.style.fontSize = '11px';
    const vl = document.createElement('input'); vl.value = p.value;
    let oldKey = p.key;
    const commit = () => { if (kl.value !== oldKey) { delParam(oldKey); oldKey = kl.value; } p.key = kl.value; p.value = vl.value; setParam(p.key, p.value); };
    kl.onchange = commit; vl.oninput = commit;
    const del = document.createElement('button'); del.className = 'expBtn'; del.textContent = '✕'; del.onclick = () => { delParam(p.key); params.splice(i, 1); draw(); };
    r.append(kl, vl, del); list.appendChild(r); }); };
  draw();
  const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;margin-top:6px';
  const add = document.createElement('button'); add.className = 'miniBtn'; add.textContent = '➕ parâmetro'; add.onclick = () => { params.push({ key: 'message_greet', value: 'Hello |PLAYERNAME|!' }); setParam('message_greet', 'Hello |PLAYERNAME|!'); draw(); };
  bar.appendChild(add);
  const dl = document.createElement('select'); dl.style.fontSize = '11px'; const o0 = document.createElement('option'); o0.textContent = '+ param comum…'; o0.value = ''; dl.appendChild(o0); for (const h of NPC_PARAM_HINTS) { const o = document.createElement('option'); o.value = h; o.textContent = h; dl.appendChild(o); } dl.onchange = () => { if (!dl.value) return; if (!params.find((p) => p.key === dl.value)) { params.push({ key: dl.value, value: '' }); setParam(dl.value, ''); draw(); } dl.value = ''; };
  bar.appendChild(dl); box.appendChild(bar);
}

// cabecalho da tabela conforme o modo
function setHead(m) {
  const head = $('tableHead');
  head.innerHTML = m === 'npc'
    ? '<tr><th></th><th>Item</th><th>id</th><th>tipo</th><th>preço atual</th><th>sugerido</th><th></th></tr>'
    : '<tr><th></th><th>Item (id ou name)</th><th>chance (/100000)</th><th>countmax</th><th></th></tr>';
}

// ---------- sprite ----------
function drawSprite() {
  const ent = mode === 'npc' ? currentNpc : current;
  const disp = $('sprite');
  if (!ent) { disp.getContext('2d').clearRect(0, 0, disp.width, disp.height); return; }
  drawCreatureSprite(disp, ent.looktype);
}

function drawText(ctx, txt) {
  ctx.fillStyle = '#888';
  ctx.font = '12px Segoe UI';
  ctx.textAlign = 'center';
  ctx.fillText(txt, 75, 78);
  ctx.textAlign = 'left';
}

// ---------- loot ----------
function renderLoot() {
  const body = $('lootBody');
  body.innerHTML = '';
  if (!current) return;
  current.loot.forEach((attrs, i) => {
    const tr = document.createElement('tr');

    // icone do item (server id -> client via otb)
    const tdIcon = document.createElement('td');
    tdIcon.className = 'icon';
    const cv = document.createElement('canvas');
    cv.width = 34; cv.height = 34;
    tdIcon.appendChild(cv);
    const idNow = M.lget(attrs, 'id');
    if (idNow) drawItemIcon(cv, parseInt(idNow, 10));

    const tdItem = document.createElement('td');
    const inItem = mkInput(M.ldisplay(attrs), (v) => {
      let a = current.loot[i];
      if (/^\d+$/.test(v)) { a = M.lremove(a, 'name'); a = M.lset(a, 'id', v); }
      else if (v.startsWith('id ')) { a = M.lremove(a, 'name'); a = M.lset(a, 'id', v.slice(3).trim()); }
      else { a = M.lremove(a, 'id'); a = M.lset(a, 'name', v); }
      current.loot[i] = a;
      markDirty(current);
      renderLoot(); // atualiza o icone
    });
    tdItem.appendChild(inItem);

    const tdChance = document.createElement('td');
    const chInp = mkInput(M.lget(attrs, 'chance') || '', (v) => { current.loot[i] = M.lset(current.loot[i], 'chance', v); markDirty(current); const ch = parseInt(v, 10) || 0; pct.textContent = ch ? (ch >= 100000 ? '100%' : (ch / 1000).toFixed(ch < 1000 ? 2 : 1) + '%') : ''; });
    tdChance.appendChild(chInp);
    const pct = document.createElement('span'); pct.className = 'alabel'; pct.style.marginLeft = '5px'; const chv = parseInt(M.lget(attrs, 'chance') || '0', 10); pct.textContent = chv ? (chv >= 100000 ? '100%' : (chv / 1000).toFixed(chv < 1000 ? 2 : 1) + '%') : ''; tdChance.appendChild(pct);
    // validação do id (existe no items?)
    if (idNow && otbMap && !otbMap.has(parseInt(idNow, 10)) && !(dat && dat.item(parseInt(idNow, 10)))) { tdItem.title = '⚠ item id ' + idNow + ' não existe no items.otb/.dat'; inItem.style.borderColor = '#f0556a'; }

    const tdCount = document.createElement('td');
    tdCount.appendChild(mkInput(M.lget(attrs, 'countmax') || '', (v) => {
      current.loot[i] = M.lset(current.loot[i], 'countmax', v); markDirty(current);
    }));

    const tdDel = document.createElement('td');
    tdDel.className = 'del';
    const del = document.createElement('button');
    del.className = 'delBtn';
    del.textContent = '✕';
    del.onclick = () => { current.loot.splice(i, 1); markDirty(current); renderLoot(); };
    tdDel.appendChild(del);

    tr.append(tdIcon, tdItem, tdChance, tdCount, tdDel);
    body.appendChild(tr);
  });
}

function mkInput(val, onchange) {
  const inp = document.createElement('input');
  inp.value = val;
  inp.onchange = () => onchange(inp.value.trim());
  return inp;
}

// ---------- loja do NPC ----------
function renderShop() {
  const body = $('lootBody');
  body.innerHTML = '';
  if (!currentNpc) return;
  currentNpc.items.forEach((it, i) => {
    const tr = document.createElement('tr');

    const tdIcon = document.createElement('td');
    tdIcon.className = 'icon';
    const cv = document.createElement('canvas');
    cv.width = 34; cv.height = 34;
    tdIcon.appendChild(cv);
    drawItemIcon(cv, it.id);

    const tdName = document.createElement('td');
    tdName.appendChild(mkInput(it.name, (v) => { it.name = v; markDirty(currentNpc); }));

    const tdId = document.createElement('td');
    tdId.appendChild(mkInput(String(it.id), (v) => { it.id = parseInt(v, 10) || 0; markDirty(currentNpc); renderShop(); }));

    const tdRole = document.createElement('td');
    tdRole.textContent = it.role === 'buy' ? 'Vende (ralo)' : 'Compra (fonte)';
    tdRole.style.color = it.role === 'buy' ? '#e0a85a' : '#7fd28a';
    tdRole.style.cursor = 'pointer';
    tdRole.title = 'clique p/ alternar vende/compra';
    tdRole.onclick = () => { it.role = it.role === 'buy' ? 'sell' : 'buy'; markDirty(currentNpc); renderShop(); };

    const tdPrice = document.createElement('td');
    tdPrice.appendChild(mkInput(String(it.price), (v) => { it.price = parseInt(v, 10) || 0; markDirty(currentNpc); renderShop(); }));

    const tdSug = document.createElement('td');
    const sug = npcCtx ? economy.npcSuggest(it, npcCtx) : null;
    if (sug) {
      const span = document.createElement('span');
      const diff = sug.price !== it.price;
      span.innerHTML = `<b style="color:${diff ? '#29c2e8' : '#888'}">${sug.price}</b> ` +
        `<button class="sugBtn" title="${sug.reason}">→</button>` +
        `<div class="sugReason">${sug.reason}</div>`;
      span.querySelector('.sugBtn').onclick = () => { it.price = sug.price; markDirty(currentNpc); renderShop(); };
      tdSug.appendChild(span);
    }

    const tdDel = document.createElement('td');
    tdDel.className = 'del';
    const del = document.createElement('button');
    del.className = 'delBtn';
    del.textContent = '✕';
    del.onclick = () => { currentNpc.items.splice(i, 1); markDirty(currentNpc); renderShop(); };
    tdDel.appendChild(del);

    tr.append(tdIcon, tdName, tdId, tdRole, tdPrice, tdSug, tdDel);
    body.appendChild(tr);
  });
}

// ---------- selecao vocation ----------
const vnum = (v, k) => parseInt(V.attrGet(v, k) || '0', 10) || 0;
const vname = (v) => V.attrGet(v, 'name') || ('voc' + v.id);

function selectVoc(v) { currentVoc = v; renderList(); renderVoc(); }

// Simulador de loot — roda N kills e mostra drops simulados vs esperado
function lootSim() {
  if (!current || !current.loot.length) return alert('monstro sem loot');
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '520px';
  box.innerHTML = `<h3>🎲 Simular loot — ${current.name}</h3>`;
  const kr = document.createElement('label'); kr.className = 'opRow'; kr.innerHTML = '<span>nº de kills</span>'; const ki = document.createElement('input'); ki.type = 'number'; ki.value = '1000'; ki.style.width = '100px'; kr.appendChild(ki); box.appendChild(kr);
  const out = document.createElement('div'); box.appendChild(out);
  const run = () => {
    const N = Math.max(1, Math.min(1e7, parseInt(ki.value, 10) || 1000));
    const items = current.loot.map((a) => { const idm = a.match(/(?:id|name)\s*=\s*"([^"]*)"/i); const ch = parseInt((a.match(/chance\s*=\s*"(\d+)"/i) || [])[1] || '0', 10); const cmax = parseInt((a.match(/countmax\s*=\s*"(\d+)"/i) || [])[1] || '1', 10); return { name: idm ? idm[1] : '?', chance: ch, cmax, drops: 0, qty: 0 }; });
    for (let k = 0; k < N; k++) for (const it of items) { if (Math.random() * 100000 < it.chance) { it.drops++; it.qty += 1 + Math.floor(Math.random() * Math.max(1, it.cmax)); } }
    let html = `<table class="cmpTable" style="width:100%"><thead><tr><th>item</th><th>chance</th><th>dropou</th><th>% real</th><th>qtd total</th></tr></thead><tbody>`;
    for (const it of items) html += `<tr><td>${it.name}</td><td>${(it.chance / 1000).toFixed(2)}%</td><td>${it.drops}</td><td>${(it.drops / N * 100).toFixed(2)}%</td><td>${it.qty}</td></tr>`;
    html += '</tbody></table>'; out.innerHTML = html;
  };
  ki.onchange = run; run();
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const rb = document.createElement('button'); rb.className = 'miniBtn'; rb.textContent = '🎲 rodar de novo'; rb.onclick = run; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.append(rb, c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// Comparar 2 monstros lado a lado
function monCompare() {
  if (!monsters.length) return alert('carregue a pasta de monstros');
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '520px';
  box.innerHTML = '<h3>📊 Comparar monstros</h3>';
  const sorted = [...monsters].sort((a, b) => a.name.localeCompare(b.name));
  const mkSel = () => { const s = document.createElement('select'); s.style.width = '48%'; sorted.forEach((m, i) => { const o = document.createElement('option'); o.value = i; o.textContent = m.name; s.appendChild(o); }); return s; };
  const selA = mkSel(), selB = mkSel(); selB.selectedIndex = Math.min(1, sorted.length - 1);
  const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:8px;margin-bottom:8px'; bar.append(selA, selB); box.appendChild(bar);
  const out = document.createElement('div'); box.appendChild(out);
  const stat = (m) => ({ exp: +m.exp || 0, health: +m.health || 0, speed: +m.speed || 0, looktype: m.looktype, attacks: (m.attacks || []).length, loot: (m.loot || []).length, tier: m.tier });
  const draw = () => { const a = sorted[selA.value], b = sorted[selB.value]; const sa = stat(a), sb = stat(b);
    const rows = [['exp', 'exp'], ['health', 'health'], ['speed', 'speed'], ['looktype', 'looktype'], ['# ataques', 'attacks'], ['# loot', 'loot'], ['tier', 'tier']];
    let html = `<table class="cmpTable"><thead><tr><th>attr</th><th>${a.name}</th><th>${b.name}</th></tr></thead><tbody>`;
    for (const [lbl, k] of rows) { const va = sa[k], vb = sb[k]; const hi = (x, o) => (typeof x === 'number' && typeof o === 'number' && x > o) ? ' style="color:#5cf08a;font-weight:700"' : ''; html += `<tr><td><b>${lbl}</b></td><td${hi(va, vb)}>${va}</td><td${hi(vb, va)}>${vb}</td></tr>`; }
    html += '</tbody></table>'; out.innerHTML = html; };
  selA.onchange = draw; selB.onchange = draw; draw();
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// Economia: cenário what-if (preview não-destrutivo + aplicar)
function econScenario() {
  if (!monsters || !monsters.length) return alert('carregue a pasta de monstros (Servidor)');
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '460px';
  box.innerHTML = '<h3>🔮 Cenário — what-if de EXP</h3>';
  const tiers = ['(todos)', 'Trash', 'Comum', 'Forte', 'Elite', 'Boss'];
  const tr = document.createElement('label'); tr.className = 'opRow'; tr.innerHTML = '<span>tier afetado</span>'; const tsel = document.createElement('select'); tiers.forEach((t) => { const o = document.createElement('option'); o.value = t; o.textContent = t; tsel.appendChild(o); }); tr.appendChild(tsel); box.appendChild(tr);
  const mr = document.createElement('label'); mr.className = 'opRow'; mr.innerHTML = '<span>multiplicador de exp (ex: 1.5 = +50%)</span>'; const mi = document.createElement('input'); mi.type = 'number'; mi.step = '0.1'; mi.value = '1.5'; mi.style.width = '90px'; mr.appendChild(mi); box.appendChild(mr);
  const out = document.createElement('div'); out.className = 'animBox'; out.style.padding = '8px'; box.appendChild(out);
  const calc = () => {
    const tier = tsel.value, mult = parseFloat(mi.value) || 1;
    const aff = monsters.filter((m) => tier === '(todos)' || m.tier === tier);
    const totBefore = aff.reduce((s, m) => s + (+m.exp || 0), 0); const totAfter = Math.round(totBefore * mult);
    const avgB = aff.length ? Math.round(totBefore / aff.length) : 0;
    out.innerHTML = `<div class="opRow"><span>monstros afetados</span><b>${aff.length}</b></div>
      <div class="opRow"><span>exp total (antes → depois)</span><b>${totBefore.toLocaleString()} → ${totAfter.toLocaleString()}</b></div>
      <div class="opRow"><span>exp média (antes → depois)</span><b>${avgB.toLocaleString()} → ${Math.round(avgB * mult).toLocaleString()}</b></div>
      <div class="alabel" style="font-size:11px">${mult > 1 ? '⚠ mais exp = level mais rápido (menos longevidade)' : mult < 1 ? 'menos exp = progressão mais lenta' : 'sem mudança'}</div>`;
    return { aff, mult };
  };
  tsel.onchange = calc; mi.oninput = calc; calc();
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const apply = document.createElement('button'); apply.className = 'miniBtn accent'; apply.textContent = '✓ Aplicar aos XMLs';
  apply.onclick = () => { const { aff, mult } = calc(); if (mult === 1) return; if (!confirm(`Aplicar ×${mult} na exp de ${aff.length} monstro(s)?`)) return; for (const m of aff) { m.exp = Math.round((+m.exp || 0) * mult); markDirty(m); } updateSaveAll(); if (current) select(current); $('status').textContent = `exp ×${mult} aplicada em ${aff.length} mobs (não salvo)`; ov.remove(); };
  const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Fechar'; c.onclick = () => ov.remove();
  foot.append(c, apply); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
function vocCompare() {
  if (!vocStore || !vocList().length) return alert('carregue vocations.xml');
  const ATTRS = ['gaincap', 'gainhp', 'gainmana', 'gainhpamount', 'gainmanaamount', 'gainhpticks', 'gainmanaticks', 'manamultiplier', 'attackspeed', 'soulmax', 'gainsoulticks', 'fromvoc'];
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '90vw';
  let html = '<h3>📊 Comparar vocações</h3><div style="overflow:auto;max-height:70vh"><table class="cmpTable"><thead><tr><th>attr</th>';
  for (const v of vocList()) html += `<th>${v.name}</th>`;
  html += '</tr></thead><tbody>';
  for (const k of ATTRS) { html += `<tr><td><b>${k}</b></td>`; let vals = vocList().map((v) => (v.attrs.find((a) => a.k === k) || {}).v || '—'); const nums = vals.filter((x) => x !== '—').map(Number); const mx = Math.max(...nums); for (const val of vals) html += `<td${(val !== '—' && +val === mx && nums.length > 1) ? ' style="color:#5cf08a;font-weight:700"' : ''}>${val}</td>`; html += '</tr>'; }
  // skills
  for (const sk of ['fist', 'club', 'sword', 'axe', 'distance', 'shielding', 'fishing']) { html += `<tr><td>skill ${sk}</td>`; for (const v of vocList()) { let s = '—'; if (v.skills) { if (Array.isArray(v.skills)) { const f = v.skills.find((x) => x.k === sk || x.k === 'skill_' + sk); s = f ? f.v : '—'; } else if (v.skills[sk] != null) s = v.skills[sk]; } html += `<td>${s}</td>`; } html += '</tr>'; }
  html += '</tbody></table></div>';
  box.innerHTML = html;
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
function renderVoc() {
  if (!currentVoc) return;
  const v = currentVoc;
  const box = $('vocFields');
  box.innerHTML = '';
  { const cmp = document.createElement('button'); cmp.className = 'miniBtn'; cmp.textContent = '📊 Comparar todas as vocações'; cmp.style.marginBottom = '8px'; cmp.onclick = vocCompare; box.appendChild(cmp); }
  const section = (t) => { const d = document.createElement('div'); d.className = 'vsection'; d.textContent = t; box.appendChild(d); };
  const field = (label, val, onch) => {
    const row = document.createElement('div'); row.className = 'vrow';
    const l = document.createElement('label'); l.textContent = label;
    const i = document.createElement('input'); i.value = val;
    i.oninput = () => { onch(i.value); currentVoc._dirty = true; updateSaveAll(); };
    row.append(l, i); box.appendChild(row);
  };

  section('Vocation');
  v.attrs.forEach((a) => field(a.k, a.v, (val) => {
    a.v = val;
    if (a.k === 'id') v.id = parseInt(val, 10) || v.id;
    if (a.k === 'name') v.name = val;
    if (a.k === 'name' || a.k === 'id' || a.k === 'gainhp') renderList();
    if (a.k === 'gainhp') renderVocInfoBox();
  }));

  if (v.formula && v.formula.length) {
    section('Formula (dano / defesa)');
    v.formula.forEach((a) => field(a.k, a.v, (val) => { a.v = val; }));
  }
  if (v.skills && v.skills.length) {
    section('Skills (multiplier)');
    v.skills.forEach((s) => field('skill ' + s.id, s.multiplier, (val) => { s.multiplier = val; }));
  }

  const info = document.createElement('div'); info.className = 'vinfo'; info.id = 'vInfoBox';
  box.appendChild(info);
  renderVocInfoBox();
}
function renderVocInfoBox() {
  const el = document.getElementById('vInfoBox');
  if (!el || !currentVoc) return;
  const gh = vnum(currentVoc, 'gainhp');
  el.innerHTML = `Player HP: lv50 <b>${B.playerHP(50, gh)}</b> · lv100 <b>${B.playerHP(100, gh)}</b> · lv300 <b>${B.playerHP(300, gh)}</b>`;
}

// ---------- economia (massa / simulador / auditoria) ----------
function tierLevel(tier) {
  const map = { Trash: 'lvTrash', Comum: 'lvComum', Forte: 'lvForte', Elite: 'lvElite', Boss: 'lvBoss' };
  return parseInt($(map[tier] || 'lvComum').value, 10) || 50;
}
function refVoc() { return vocList()[parseInt($('balVoc').value, 10)] || vocList()[0]; }

// validação de spawn: monstros referenciados que não existem em data/monster
function spawnValidate() {
  if (!spawnStore || !spawnStore.entries.length) return alert('abra um spawn.xml com monstros');
  if (!monsters.length) return alert('carregue os monstros (data/monster) primeiro');
  const valid = new Set(monsters.map((m) => (m.name || '').toLowerCase()));
  const bad = new Map(); for (const e of spawnStore.entries) { const n = e.name || ''; if (!valid.has(n.toLowerCase())) bad.set(n, (bad.get(n) || 0) + 1); }
  if (!bad.size) return alert(`✓ OK — todos os ${spawnStore.entries.length} monstros do spawn existem em data/monster`);
  const ov = document.createElement('div'); ov.className = 'modal'; const b = document.createElement('div'); b.className = 'modalBox'; b.style.maxWidth = '440px'; b.innerHTML = `<h3>⚠ ${bad.size} monstro(s) inexistente(s) no spawn</h3>`;
  const list = document.createElement('div'); list.style.cssText = 'max-height:360px;overflow:auto;font-size:12px'; for (const [n, c] of [...bad].sort((a, b) => b[1] - a[1])) { const r = document.createElement('div'); r.style.cssText = 'padding:3px 6px;border-bottom:1px solid var(--border)'; r.innerHTML = `❌ <b>${n || '(sem nome)'}</b> <span style="color:var(--muted)">× ${c}</span>`; list.appendChild(r); } b.appendChild(list);
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const x = document.createElement('button'); x.className = 'miniBtn accent'; x.textContent = 'Fechar'; x.onclick = () => ov.remove(); foot.appendChild(x); b.appendChild(foot); ov.appendChild(b); document.body.appendChild(ov);
}
function initEcon() { fillSimMob(); renderAudit(); renderSim(); }
// gráfico de curva de progressão: exp e gold de todos os mobs (ordenados por exp, escala log)
function econCurve() {
  if (!monsters.length) return alert('carregue os monstros');
  const data = monsters.map((m) => ({ name: m.name, exp: m.exp || 0, gold: A.goldPerKill ? A.goldPerKill(m) : 0, hp: m.health || 0 })).filter((d) => d.exp > 0).sort((a, b) => a.exp - b.exp);
  if (!data.length) return alert('sem dados de exp');
  document.querySelectorAll('.econCurveM').forEach((m) => m.remove());
  const ov = document.createElement('div'); ov.className = 'modal econCurveM'; const b = document.createElement('div'); b.className = 'modalBox'; b.style.maxWidth = '720px'; b.innerHTML = '<h3>📈 Curva de progressão (exp/gold, escala log, ordenado por exp)</h3>';
  const cv = document.createElement('canvas'); cv.width = 680; cv.height = 360; cv.style.cssText = 'background:#0b0d12;border:1px solid var(--border);border-radius:6px'; b.appendChild(cv);
  const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height, pad = 40;
  const xs = (i) => pad + (i / Math.max(1, data.length - 1)) * (W - pad - 10);
  const lg = (v) => Math.log10(Math.max(1, v));
  const maxL = Math.max(lg(Math.max(...data.map((d) => d.exp))), lg(Math.max(...data.map((d) => d.gold)) || 1));
  const ys = (v) => H - pad - (lg(v) / (maxL || 1)) * (H - pad - 10);
  // grid + eixos
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.fillStyle = '#8a93a6'; ctx.font = '10px sans-serif';
  for (let p = 0; p <= maxL; p++) { const y = ys(Math.pow(10, p)); ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - 10, y); ctx.stroke(); ctx.fillText('10^' + p, 4, y + 3); }
  const line = (key, col) => { ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath(); data.forEach((d, i) => { const x = xs(i), y = ys(d[key] || 1); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke(); };
  line('exp', '#5b8cff'); line('gold', '#f0c84a');
  // legenda + detecção de saltos bruscos (desbalanço)
  ctx.fillStyle = '#5b8cff'; ctx.fillText('● exp', W - 110, 16); ctx.fillStyle = '#f0c84a'; ctx.fillText('● gold', W - 60, 16);
  let jumps = 0; for (let i = 1; i < data.length; i++) { if (data[i - 1].exp > 0 && data[i].exp / data[i - 1].exp > 5) jumps++; }
  const info = document.createElement('div'); info.className = 'alabel'; info.style.cssText = 'margin-top:6px;font-size:12px'; info.textContent = `${data.length} mobs · exp ${data[0].exp}–${data[data.length - 1].exp} · ${jumps} salto(s) >5× (possível buraco de progressão)`; b.appendChild(info);
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); b.appendChild(foot); ov.appendChild(b); document.body.appendChild(ov);
}

function fillSimMob() {
  const sel = $('simMob');
  sel.innerHTML = '';
  monsters.forEach((m, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = m.name;
    sel.appendChild(o);
  });
}

function renderSim() {
  const m = monsters[parseInt($('simMob').value, 10)];
  if (!m) { $('simOut').textContent = ''; return; }
  const level = Math.max(1, parseInt($('simLevel').value, 10) || 1);
  const killTime = Math.max(1, parseInt($('simKill').value, 10) || 1);
  const heal = Math.max(1, parseInt($('simHeal').value, 10) || 1);
  const cost = parseInt($('simCost').value, 10) || 0;
  const voc = refVoc();
  const hp = B.playerHP(level, voc ? vnum(voc, 'gainhp') : 500);
  const dps = A.mobDPS(m);
  const dmgPerKill = dps * killTime;
  const potions = dmgPerKill / heal;
  const potCost = potions * cost;
  const gold = A.goldPerKill(m);
  const kph = 3600 / killTime;
  const ralo = gold > 0 ? (potCost / gold * 100) : 0;
  const net = gold - potCost;
  const alvo = level < 100 ? '75-90%' : (level < 300 ? '50-65%' : '30-45%');
  const verdict = gold <= 0 ? '⚠️ mob sem gold' : (ralo > 95 ? '❌ caro demais (prejuízo)' : (ralo < 20 ? '⚠️ gold fácil (ralo fraco)' : '✅ equilibrado'));
  $('simOut').innerHTML =
    `Player lv${level}: <b>${hp}</b> HP · DPS do mob <b>${dps}</b><br>` +
    `Por kill: gold <b>${gold}</b> · dano levado ${Math.round(dmgPerKill)} → ${potions.toFixed(1)} poções = <b>${Math.round(potCost)}</b> gold<br>` +
    `Ralo: <b>${ralo.toFixed(0)}%</b> do gold vai em poção (alvo ${alvo}) → ${verdict}<br>` +
    `Por hora (~${Math.round(kph)} kills): +${Math.round(gold * kph)} gold · -${Math.round(potCost * kph)} poção · líquido <b>${Math.round(net * kph)}</b>/h`;
}

let auditSort = { col: 'name', dir: 1 };
function renderAudit() {
  const body = $('auditBody');
  body.innerHTML = '';
  const stats = A.expHealthStats(monsters);
  let rows = monsters.map((m) => ({
    m, name: m.name, tier: m.tier, exp: m.exp, health: m.health,
    gold: A.goldPerKill(m), dmg: A.maxHit(m),
    ratio: m.health > 0 ? m.exp / m.health : 0, fl: A.flags(m, stats),
  }));
  const q = $('auditFilter').value.trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.tier.toLowerCase().includes(q) || r.fl.join(' ').toLowerCase().includes(q));
  const c = auditSort.col, d = auditSort.dir;
  rows.sort((a, b) => {
    if (c === 'name' || c === 'tier') return String(a[c]).localeCompare(String(b[c])) * d;
    const av = c === 'flags' ? a.fl.length : a[c], bv = c === 'flags' ? b.fl.length : b[c];
    return (av - bv) * d;
  });
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(r.name)}${r.m._dirty ? ' *' : ''}</td><td>${r.tier}</td>` +
      `<td>${r.exp}</td><td>${r.health}</td><td>${r.gold}</td><td>${r.dmg}</td>` +
      `<td>${r.ratio ? r.ratio.toFixed(2) : '-'}</td><td class="flag">${r.fl.join(', ')}</td>`;
    tr.onclick = () => { $('simMob').value = monsters.indexOf(r.m); renderSim(); };
    body.appendChild(tr);
  }
}

// aplica gold por tier num mob (remove gold antigo, adiciona o sugerido)
function applyGoldToMob(m) {
  m.loot = m.loot.filter((a) => !A.GOLD_UNIT[parseInt(M.lget(a, 'id') || '0', 10)]);
  m.loot.unshift(economy.suggestedGoldAttrs(m.exp));
  m._dirty = true;
}

function backup(file) { try { if (fsp.existsSync(file)) fsp.copyFileSync(file, file + '.bak'); } catch (e) { /* ignora */ } }

function saveAll() {
  const bk = $('batBackup') && $('batBackup').checked;
  let n = 0; const errs = [];
  for (const m of monsters) if (m._dirty) {
    try { if (bk && !m._new) backup(m.file); M.save(m); m._dirty = false; n++; } catch (e) { errs.push(m.name + ': ' + e.message); }
  }
  for (const np of npcs) if (np._dirty) {
    try { if (bk && !np._new) backup(np.file); N.save(np); np._dirty = false; n++; } catch (e) { errs.push(np.name + ': ' + e.message); }
  }
  if (vocStore && vocList().some((v) => v._dirty || v._new)) {
    try { if (bk) backup(vocStore.file); V.saveVocations(vocStore); vocList().forEach((v) => { v._dirty = false; }); n++; }
    catch (e) { errs.push('vocations: ' + e.message); }
  }
  if (spawnStore && spawnStore._dirty) {
    try { if (bk) backup(spawnStore.file); SP.save(spawnStore); spawnStore._dirty = false; n++; }
    catch (e) { errs.push('spawn: ' + e.message); }
  }
  updateSaveAll();
  $('status').textContent = `Salvos ${n} arquivo(s).` + (errs.length ? ('  ERROS: ' + errs.join(' | ')) : '');
  if (mode === 'econ') renderAudit();
  renderList();
}

// ---------- object edit (navegador de things) ----------
let objCat = 'items', objSel = null, objPage = 0, _objInspectCv = null, objHideEmpty = false, _filmRoll = false, objDir = 2;
let objEditPixels = false, objEditColor = '#ff00ff', objEditErase = false, objEditGrid = true, objEditWrap = false, objEditFrame = 0, objMainZoom = 1;
const DIR_LBL = ['Norte', 'Leste', 'Sul', 'Oeste', 'NE', 'NO', 'SE', 'SO'];
// navega o painel de Sprites (direita) até um sprite id e seleciona/realça (duplo-clique no slot)
function gotoSprite(sid) {
  if (!spr || !sid) return;
  _selBrowseSpr = sid; sprBrowsePage = Math.floor((sid - 1) / SPR_PER_PAGE); renderSprPanel();
  setTimeout(() => { const cont = $('objSprites'); const cv = cont && cont.querySelector(`canvas[data-sid="${sid}"]`); if (cv) cv.scrollIntoView({ block: 'center' }); }, 30);
  $('status').textContent = 'sprite #' + sid + ' (no painel direito)';
}
// dado o ponto na composição (coords em px do sprite, 0..W-1/0..H-1), retorna o sprite id daquele tile
function previewTileSid(t, dir, frame, compX, compY) {
  const col = Math.floor(compX / 32), row = Math.floor(compY / 32);
  if (col < 0 || row < 0 || col >= t.width || row >= t.height) return 0;
  const w = t.width - 1 - col, h = t.height - 1 - row; // composeThing coloca (w,h) em (W-1-w, H-1-h)
  let idx; try { idx = dat.spriteIndex(t, w, h, 0, dir, 0, 0, frame); } catch (e) { return 0; }
  return (idx >= 0 && idx < t.sprites.length) ? t.sprites[idx] : 0;
}
// tira de frames/direções (Film Roll do ObjectBuilder)
function buildFilmRoll(box, t, g, x) {
  box.innerHTML = '';
  const frames = Math.max(1, g.frames);
  const dirs = ((objCat === 'outfits' || objCat === 'missiles') && t.px > 1) ? t.px : 1;
  const DLBL = ['N', 'E', 'S', 'W', 'NE', 'NW', 'SE', 'SW'];
  for (let d = 0; d < dirs; d++) {
    const row = document.createElement('div'); row.className = 'filmRow';
    for (let f = 0; f < frames; f++) {
      const cell = document.createElement('div'); cell.className = 'filmCell';
      const dir = dirs > 1 ? d : x;
      const c = document.createElement('canvas'); c.width = 38; c.height = 38;
      drawScaled(c, composeG(t, objGroup, dir, f));
      // clique = editar o pixel desse frame INTEIRO (todos os tiles juntos, igual OB)
      c.style.cursor = 'pointer'; c.title = 'editar pixels deste frame'; c.onclick = () => openPixelEditorThing(t, objGroup, dir, f);
      const lb = document.createElement('span'); lb.textContent = (dirs > 1 ? (DLBL[d] || ('d' + d)) + '·' : 'f') + (f + 1);
      cell.append(c, lb); row.appendChild(cell);
    }
    box.appendChild(row);
  }
}
let objGroup = 0, _lastSelId = null; // frame group atual no inspector (outfit idle/walk)
let obdExportVer = 3;     // versão de export .obd (1/2/3)
let clipThing = null;     // copy/paste de thing {attrs, groups, cat}
const objMulti = new Set(); // ids multi-selecionados (ctrl/shift+clique) na categoria atual
function curGroup(t) { return (t && t._groups && t._groups[objGroup]) || t; }
let OBJ_PER_PAGE = parseInt(localStorage.getItem('objPerPage'), 10) || 300;
let prefPreviewAnim = localStorage.getItem('previewAnim') !== '0';
let prefAnimateGrid = localStorage.getItem('animateGrid') === '1'; // default OFF: grid estático, só o selecionado anima
const sprEdits = new Map(); // spriteId -> Uint8ClampedArray (32x32 RGBA) pendente
let datDirty = false;
let sprAddedCount = 0;      // sprites NOVOS adicionados (alem do count original)

function updateObjSaveBtn() { invalidateSprites(); const b = $('objSaveSpr'); if (b) b.textContent = `💾 Salvar .spr (${sprEdits.size})`; }
function updateDatSaveBtn() { invalidateGfx(); const b = $('objSaveDat'); if (b) b.style.display = datDirty ? '' : 'none'; }

// desenha 1 sprite (com edicao pendente se houver) num canvas
function drawSpriteTo(canvas, sid) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const off = spriteCanvas(sid);
  if (!off) return;
  const s = Math.max(1, Math.floor(Math.min(canvas.width / 32, canvas.height / 32)));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, (canvas.width - 32 * s) / 2, (canvas.height - 32 * s) / 2, 32 * s, 32 * s);
}

// carrega qualquer PNG como HTMLImageElement (path string ou File object)
async function loadPngImage(file) {
  let url, owned = false;
  if (file instanceof File) {
    url = URL.createObjectURL(file); owned = true;
  } else {
    // path string → pré-carrega no VFS, lê sincrono, cria Blob URL
    try {
      if (window.__preloadFile) await window.__preloadFile(file);
      const bytes = fsp.readFileSync(file);
      url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' })); owned = true;
    } catch (e) { alert('Erro ao ler PNG: ' + e); return null; }
  }
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => { if (owned) URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { if (owned) URL.revokeObjectURL(url); alert('PNG inválido: ' + (file instanceof File ? file.name : file)); res(null); };
    img.src = url;
  });
}
// carrega um PNG e devolve RGBA 32x32 (redimensiona se preciso)
async function loadPng32(file, cb) {
  const img = await loadPngImage(file); if (!img) return;
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, 32, 32);
  ctx.drawImage(img, 0, 0, 32, 32);
  cb(ctx.getImageData(0, 0, 32, 32).data);
}
// ---- Painel de Sprites (estilo Object Builder): navega TODOS os sprites do .spr ----
let sprBrowsePage = 0, _selBrowseSpr = 0;
const SPR_PER_PAGE = 240;
// painel Info (coluna esquerda, estilo ObjectBuilder) — metadados do .dat/.spr/assets
function renderObjInfo() {
  const box = $('objInfoStats'); if (!box) return;
  if (!dat) { box.innerHTML = '<div class="alabel" style="padding:6px;font-size:10px">carregue .dat/.spr ou Assets</div>'; return; }
  const cat = (c) => { try { const m = dat.category(c); return m ? m.size : 0; } catch (e) { return 0; } };
  const ext = $('optExtended') && $('optExtended').checked, tr = $('optTransparency') && $('optTransparency').checked, fg = $('optFrameGroups') && $('optFrameGroups').checked;
  const rows = [
    ['Versão', assetsMode ? '15.x (assets)' : datVersion],
    ['OTB', otbMap ? (otbMap.size + ' itens') : '—'],
    ['Sprite Dim', '32×32'],
    ['Items', cat('items')], ['Outfits', cat('outfits')], ['Effects', cat('effects')], ['Missiles', cat('missiles')],
    ['Sprites', spr ? spr.count : 0],
    ['Extended', assetsMode ? '—' : (ext ? 'Sim' : 'Não')],
    ['Transparency', assetsMode ? 'Sim' : (tr ? 'Sim' : 'Não')],
    ['Frame Groups', assetsMode ? 'Sim' : (fg ? 'Sim' : 'Não')],
    ['Modo', assetsMode ? 'Assets 12+/15.x' : '.dat/.spr'],
  ];
  box.innerHTML = rows.map(([k, v]) => `<div class="ir"><span>${k}</span><b>${v}</b></div>`).join('');
}
// zoom da Visualização (igual o Object Builder)
let _objPrevZoom = 1;
function applyObjPrevZoom() { const c = $('objInfoPrev'); if (!c) return; const s = Math.round(96 * _objPrevZoom); c.style.width = s + 'px'; c.style.height = s + 'px'; const l = $('objPrevZoomLbl'); if (l) l.textContent = Math.round(_objPrevZoom * 100) + '%'; const sl = $('objPrevZoomSlider'); if (sl) sl.value = Math.round(_objPrevZoom * 100); }
function renderSprPanel() {
  const cont = $('objSprites'); if (!cont) return;
  cont.innerHTML = ''; cont.scrollTop = 0; // sempre começa do topo ao trocar de página
  if (!spr || !spr.count) { cont.innerHTML = '<div class="alabel" style="padding:8px;grid-column:1/-1">carregue o .spr / assets</div>'; if ($('sprBrowsePage')) $('sprBrowsePage').textContent = '—'; return; }
  const count = spr.count;
  const totalPages = Math.max(1, Math.ceil(count / SPR_PER_PAGE));
  sprBrowsePage = Math.max(0, Math.min(totalPages - 1, sprBrowsePage));
  const start = sprBrowsePage * SPR_PER_PAGE + 1, end = Math.min(count, start + SPR_PER_PAGE - 1);
  if ($('sprBrowsePage')) $('sprBrowsePage').textContent = `pág ${sprBrowsePage + 1}/${totalPages} · ${start}–${end} / ${count}`;
  if ($('sprBrowsePageInp')) { $('sprBrowsePageInp').value = sprBrowsePage + 1; $('sprBrowsePageInp').max = totalPages; }
  const ids = [];
  for (let id = start; id <= end; id++) ids.push(id);
  if (spr.warm) spr.warm(ids).then(() => { for (const cv of cont.querySelectorAll('canvas')) drawSpriteTo(cv, +cv.dataset.sid); });
  for (const id of ids) {
    const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32; cv.dataset.sid = id; cv.title = '#' + id + ' · clique = selecionar · duplo-clique = editar pixel';
    if (id === _selBrowseSpr) cv.classList.add('sel');
    drawSpriteTo(cv, id);
    cv.onclick = () => { _selBrowseSpr = id; for (const c of cont.querySelectorAll('canvas.sel')) c.classList.remove('sel'); cv.classList.add('sel'); if ($('status')) $('status').textContent = 'sprite #' + id + ' selecionado'; };
    cv.ondblclick = () => openPixelEditor(id); // editar o pixel da peça direto no painel direito
    cont.appendChild(cv);
  }
}
let _objWarming = false;
function renderObjGrid() {
  const grid = $('objGrid');
  // remove animações dos tiles antigos (evita vazamento no rAF)
  for (const c of [..._anims.keys()]) if (c.dataset && c.dataset.grid) _anims.delete(c);
  grid.innerHTML = '';
  if (!dat || !spr) { const falta = !dat && !spr ? '.dat e .spr' : (!dat ? '.dat' : '.spr'); grid.innerHTML = `<div class="alabel" style="padding:12px">carregue ${falta} (botões no topo)</div>`; $('objInfo').textContent = ''; $('objPage').textContent = ''; return; }
  const map = dat.category(objCat);
  const q = $('objFilter').value.trim();
  let ids = Array.from(map.keys());
  if (q) {
    if (/^\d+$/.test(q)) ids = ids.filter((id) => String(id).includes(q)); // numérico = id
    else { const ql = q.toLowerCase(); ids = ids.filter((id) => itemNameOf(id).toLowerCase().includes(ql)); } // texto = nome (items.xml)
  }
  const ff = $('objFlagFilter') ? $('objFlagFilter').value : '';
  if (ff) { const cn = parseInt(ff, 10); ids = ids.filter((id) => map.get(id)._attrs.some((a) => a.canon === cn)); }
  if (objHideEmpty) ids = ids.filter((id) => { const t = map.get(id); return t && t.sprites && t.sprites.some((s) => s > 0); }); // Hide empty objects (OB)
  ids.sort((a, b) => a - b);
  const totalPages = Math.max(1, Math.ceil(ids.length / OBJ_PER_PAGE));
  if (objPage >= totalPages) objPage = totalPages - 1;
  if (objPage < 0) objPage = 0;
  const start = objPage * OBJ_PER_PAGE;
  const shown = ids.slice(start, start + OBJ_PER_PAGE);
  $('objInfo').textContent = `${map.size} ${objCat}`;
  $('objPage').textContent = `/${totalPages}  (ids ${shown[0] ?? '-'}–${shown[shown.length - 1] ?? '-'})`;
  const pi = $('objPageInp'); if (pi) { pi.value = objPage + 1; pi.max = totalPages; }
  // pré-aquece (async) os sprites da página e re-renderiza UMA vez quando prontos (.spr lazy → sem cells vazias)
  if (spr.warm && !_objWarming) {
    const need = new Set();
    for (const id of shown) { const t = map.get(id); if (!t || !t.sprites) continue; const x = (objCat === 'outfits' && t.px >= 4) ? 2 : 0; for (let w = 0; w < t.width; w++) for (let h = 0; h < t.height; h++) { const idx = dat.spriteIndex(t, w, h, 0, x, 0, 0, 0); if (idx >= 0 && idx < t.sprites.length) { const s = t.sprites[idx]; if (s && spr.loaded && !spr.loaded(s)) need.add(s); } } }
    if (need.size) { _objWarming = true; spr.warm([...need]).then(() => { _objWarming = false; if (mode === 'obj') renderObjGrid(); }); }
  }
  const frag = document.createDocumentFragment(); // 1 reflow só
  const isItem = objCat === 'items';
  for (const id of shown) {
    const t = map.get(id);
    const tile = document.createElement('div');
    tile.className = 'objTile' + (objSel && objSel.cat === objCat && objSel.id === id ? ' sel' : '') + (objMulti.has(id) ? ' multi' : '');
    const cv = document.createElement('canvas'); cv.width = 40; cv.height = 40; cv.dataset.grid = '1';
    const x = (objCat === 'outfits' && t.px >= 4) ? 2 : 0;
    const _ig = (objCat === 'outfits' && t._groups && t._groups.length > 1) ? 0 : (t._primary || 0); // outfit no grid = idle (grupo 0) parado
    if (prefAnimateGrid && objCat !== 'outfits' && t.frames > 1) setAnim(cv, t, x); else drawScaled(cv, composeG(t, _ig, x, 0));
    const sp = document.createElement('span'); sp.textContent = id;
    if (isItem) { const nm = itemNameOf(id); tile.title = nm ? `#${id} — ${nm}` : `#${id}`; }
    tile.append(cv, sp);
    tile.onclick = (ev) => tileClick(id, tile, ev);
    frag.appendChild(tile);
  }
  grid.appendChild(frag);
  updateMultiInfo();
}
// clique no tile: ctrl/cmd = toggle multi · shift = range · normal = seleção única
function tileClick(id, tile, ev) {
  if (ev && (ev.ctrlKey || ev.metaKey)) {
    if (objMulti.has(id)) objMulti.delete(id); else objMulti.add(id);
    tile.classList.toggle('multi', objMulti.has(id));
    updateMultiInfo(); return;
  }
  if (ev && ev.shiftKey && objSel && objSel.cat === objCat) {
    const a = Math.min(objSel.id, id), b = Math.max(objSel.id, id);
    for (const k of dat.category(objCat).keys()) if (k >= a && k <= b) objMulti.add(k);
    renderObjGrid(); return;
  }
  objMulti.clear();
  selectObjThing(id, tile);
  updateMultiInfo();
}
function selectedIds() { return objMulti.size ? Array.from(objMulti).sort((a, b) => a - b) : (objSel ? [objSel.id] : []); }
function updateMultiInfo() {
  const el = $('objMultiInfo'); if (!el) return;
  const n = objMulti.size;
  el.style.display = n ? '' : 'none';
  el.textContent = n ? `${n} selecionado(s)` : '';
}
// aplica PNG como sheet no thing atual — distribui pixels pelos slots da geometria do grupo g
// Detecta geometria automaticamente pelo tamanho do PNG (mesma lógica do ObjectBuilder)
// Regra: idle = sempre 1 frame (primeira linha de cells); walk = linhas restantes
// Retorna duração default (ms) do .dat carregado: usa o primeiro thing animado da mesma categoria.
// Fallback: 200ms (padrão tibia clássico).
function datDefaultDuration(cat) {
  if (!dat) return 200;
  for (const [, t] of dat.category(cat)) {
    if (!t._durations || !t._durations.length) continue;
    const d = t._durations[0];
    if (d && d.min > 0) return d.min;
  }
  return 200;
}
// Configs conhecidas em ordem de prioridade (maior → menor)
function detectSheetGeom(imgW, imgH, cat) {
  // [width, height, px, py, pz, layers]
  const KNOWN = [
    [4, 4, 4, 1, 1, 1],
    [3, 3, 4, 1, 1, 1],
    [2, 2, 4, 1, 1, 1],
    [2, 1, 4, 1, 1, 1],
    [1, 2, 4, 1, 1, 1],
    [1, 1, 4, 1, 1, 1],
    // com layers=2 (outfits coloridos)
    [4, 4, 4, 1, 1, 2],
    [3, 3, 4, 1, 1, 2],
    [2, 2, 4, 1, 1, 2],
    [1, 1, 4, 1, 1, 2],
    // com py=4 (4 direções em linhas)
    [2, 2, 4, 4, 1, 2],
    [2, 2, 4, 4, 1, 1],
    [1, 1, 4, 4, 1, 2],
    [1, 1, 4, 4, 1, 1],
  ];

  for (const [width, height, px, py, pz, layers] of KNOWN) {
    const totalX = pz * px * layers;
    const cellW  = width  * 32;
    const cellH  = height * 32;
    if (imgW !== totalX * cellW) continue;
    if (imgH % cellH !== 0) continue;
    const totalRows  = imgH / cellH;
    const idleRows   = 1 * py;           // idle = sempre 1 frame
    const walkRows   = totalRows - idleRows;
    if (walkRows < 0) continue;
    if (walkRows % py !== 0) continue;
    return { width, height, layers, px, py, pz, idleFrames: 1, walkFrames: walkRows / py };
  }
  return null;
}

async function applySheetFile(file, t, _g) {
  if (!spr || !t) return;
  const img = await loadPngImage(file); if (!img) return;

  const idle0 = t._groups[0];
  const isDefault = t._groups.length === 1 &&
    (idle0.width||1) === 1 && (idle0.height||1) === 1 &&
    (idle0.layers||1) === 1 && (idle0.px||1) === 1 &&
    (idle0.py||1) === 1 && (idle0.pz||1) === 1 && (idle0.frames||1) === 1;

  let cellW, cellH, statusExtra = '';
  if (isDefault) {
    // geometria padrão → auto-detecta pelo PNG
    const geom = detectSheetGeom(img.width, img.height, objCat);
    if (!geom) return alert(`PNG ${img.width}×${img.height} não corresponde a nenhuma geometria reconhecida.\nConfigure a geometria manualmente antes de importar.`);
    const defDur = datDefaultDuration(objCat);
    dat.setGeometry(t, objCat, { width: geom.width, height: geom.height, layers: geom.layers, px: geom.px, py: geom.py, pz: geom.pz, frames: geom.idleFrames }, 0);
    if (geom.idleFrames > 1) dat.setAnimation(t, objCat, { durations: Array(geom.idleFrames).fill({ min: defDur, max: defDur }) }, 0);
    if (geom.walkFrames > 0) {
      if (t._groups.length < 2) dat.addFrameGroup(t, objCat);
      dat.setGeometry(t, objCat, { width: geom.width, height: geom.height, layers: geom.layers, px: geom.px, py: geom.py, pz: geom.pz, frames: geom.walkFrames }, 1);
      if (geom.walkFrames > 1) dat.setAnimation(t, objCat, { durations: Array(geom.walkFrames).fill({ min: defDur, max: defDur }) }, 1);
    }
    invalidateGfx(); datDirty = true; updateDatSaveBtn();
    cellW = geom.width * 32; cellH = geom.height * 32;
    statusExtra = ` [auto: ${geom.width}×${geom.height} px=${geom.px} py=${geom.py} l=${geom.layers} idle=${geom.idleFrames}f walk=${geom.walkFrames}f]`;
  } else {
    // geometria já configurada manualmente → usa como está
    const maxW = Math.max(...t._groups.map((gr) => gr.width||1));
    const maxH = Math.max(...t._groups.map((gr) => gr.height||1));
    cellW = maxW * 32; cellH = maxH * 32;
    // log da geometria manual para referência
    const grpLog = t._groups.map((gr, gi) =>
      `grupo${gi}(${gi===0?'idle':'walk'} ${gr.frames||1}f px=${gr.px||1} py=${gr.py||1} pz=${gr.pz||1} layers=${gr.layers||1} w=${gr.width||1} h=${gr.height||1})`
    ).join(' | ');
    console.log(`[applySheet MANUAL] PNG ${img.width}×${img.height} → ${grpLog} | cellW=${cellW} cellH=${cellH} globalTotalX=${Math.max(...t._groups.map((gr)=>(gr.pz||1)*(gr.px||1)*(gr.layers||1)))}`);
    statusExtra = ` [manual: PNG ${img.width}×${img.height} w=${maxW} h=${maxH} ${t._groups.map((gr,gi)=>(gi===0?'idle':'walk')+' py='+( gr.py||1)+' frames='+(gr.frames||1)).join(' ')} layers=${t._groups[0].layers||1} px=${t._groups[0].px||1}]`;
  }

  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0);
  const globalTotalX = Math.max(...t._groups.map((gr) => (gr.pz||1)*(gr.px||1)*(gr.layers||1)));
  let groupYCell = 0, changed = 0;
  for (let gi = 0; gi < t._groups.length; gi++) {
    const grp = t._groups[gi];
    const yOff = groupYCell * cellH;
    for (let f = 0; f < (grp.frames||1); f++)
      for (let z = 0; z < (grp.pz||1); z++)
        for (let y = 0; y < (grp.py||1); y++)
          for (let x = 0; x < (grp.px||1); x++)
            for (let l = 0; l < (grp.layers||1); l++) {
              const texIdx = (((f*(grp.pz||1)+z)*(grp.py||1)+y)*(grp.px||1)+x)*(grp.layers||1)+l;
              const fx = (texIdx % globalTotalX) * cellW;
              const fy = yOff + Math.floor(texIdx / globalTotalX) * cellH;
              for (let w = 0; w < (grp.width||1); w++)
                for (let h = 0; h < (grp.height||1); h++) {
                  const idx = dat.spriteIndex(grp, w, h, l, x, y, z, f);
                  let sid = grp.sprites[idx];
                  if (!sid) { sid = spr.count + (++sprAddedCount); dat.setSpriteId(t, idx, sid, grp); }
                  const srcX = fx + (grp.width - w - 1) * 32, srcY = fy + (grp.height - h - 1) * 32;
                  if (srcX + 32 > cv.width || srcY + 32 > cv.height) continue;
                  const raw = ctx.getImageData(srcX, srcY, 32, 32).data;
                  // converte magenta (255,0,255) → transparente, igual OB removeMagenta
                  const data = new Uint8ClampedArray(raw);
                  for (let pi = 0; pi < data.length; pi += 4)
                    if (data[pi] === 255 && data[pi+1] === 0 && data[pi+2] === 255) data[pi+3] = 0;
                  sprEdits.set(sid, data);
                  if (spr.cache) spr.cache.set(sid, new Uint8ClampedArray(data));
                  changed++;
                }
            }
    groupYCell += (grp.frames||1) * (grp.py||1);
  }
  invalidateSprites(); invalidateGfx(); updateObjSaveBtn();
  if (objSel) selectObjThing(objSel.id);
  renderObjGrid();
  $('status').textContent = `sheet importado → ${changed} sprite(s)${statusExtra} — 💾 Salvar .dat + .spr`;
}
function selectObjThing(id, tile) {
  const t = dat.category(objCat).get(id);
  if (!t) return;
  objSel = { cat: objCat, id, t };
  if (id !== _lastSelId) { objGroup = (objCat === 'outfits' && t._groups.length > 1) ? 0 : (t._primary || 0); _lastSelId = id; } // outfit começa no idle (grupo 0)
  if (objGroup >= t._groups.length) objGroup = t._primary || 0;
  document.querySelectorAll('#objGrid .objTile.sel').forEach((e) => e.classList.remove('sel'));
  if (tile) tile.classList.add('sel');
  const g = curGroup(t);
  const ins = $('objInspect');
  ins.innerHTML = '';
  const nm = objCat === 'items' ? itemNameOf(id) : '';
  const h = document.createElement('h3'); h.textContent = `${objCat.replace(/s$/, '')} #${id}` + (nm ? ` — ${nm}` : '') + (g.frames > 1 ? `  🎞 ${g.frames}f` : ''); ins.appendChild(h);
  const acts = document.createElement('div'); acts.className = 'insActs';
  const bExp = document.createElement('button'); bExp.className = 'miniBtn'; bExp.textContent = '📤 .obd'; bExp.title = 'exportar thing como .obd'; bExp.onclick = exportObd;
  const bShExp = document.createElement('button'); bShExp.className = 'miniBtn'; bShExp.textContent = '🗇 sheet'; bShExp.title = 'exportar sprite sheet (PNG do grupo)'; bShExp.onclick = exportSheet;
  const bShImp = document.createElement('button'); bShImp.className = 'miniBtn'; bShImp.textContent = '📥 sheet'; bShImp.title = 'importar sprite sheet (PNG → fatia nos sprites)'; bShImp.onclick = importSheet;
  const bRem = document.createElement('button'); bRem.className = 'miniBtn danger'; bRem.textContent = '🗑'; bRem.title = 'remover thing'; bRem.onclick = removeThing;
  acts.append(bExp, bShExp, bShImp, bRem); ins.appendChild(acts);
  // ---- Zoom da textura (topo, igual o Object Builder) ----
  { const zb = document.createElement('div'); zb.className = 'objZoomBar'; const lb = document.createElement('span'); lb.className = 'alabel'; lb.textContent = 'Zoom:'; const sl = document.createElement('input'); sl.type = 'range'; sl.min = 1; sl.max = 8; sl.step = 1; sl.value = objMainZoom; sl.style.cssText = 'flex:1;max-width:200px'; const vl = document.createElement('span'); vl.className = 'alabel'; vl.textContent = objMainZoom + 'x'; sl.oninput = () => { objMainZoom = +sl.value; selectObjThing(id, tile); }; zb.append(lb, sl, vl); ins.appendChild(zb); }
  // ---- seletor de frame group (outfits) ----
  if (objCat === 'outfits') {
    const gb = document.createElement('div'); gb.className = 'groupBar';
    t._groups.forEach((grp, gi) => {
      const b = document.createElement('button'); b.className = 'miniBtn' + (gi === objGroup ? ' accent' : '');
      b.textContent = (grp.type === 1 ? 'walk' : grp.type === 0 ? 'idle' : 'grupo ' + gi) + ` (${grp.frames}f)`;
      b.onclick = () => { objGroup = gi; selectObjThing(id, tile); };
      gb.appendChild(b);
    });
    if (t._groups.length < 2) { const a = document.createElement('button'); a.className = 'miniBtn'; a.textContent = '➕ grupo walk'; a.title = 'adicionar frame group (idle+walk)'; a.onclick = () => { dat.addFrameGroup(t, objCat); invalidateGfx(); datDirty = true; updateDatSaveBtn(); objGroup = t._groups.length - 1; selectObjThing(id, tile); }; gb.appendChild(a); }
    else { const rmv = document.createElement('button'); rmv.className = 'miniBtn danger'; rmv.textContent = '🗑 grupo'; rmv.title = 'remover este frame group'; rmv.onclick = () => { dat.removeFrameGroup(t, objCat, objGroup); invalidateGfx(); datDirty = true; updateDatSaveBtn(); objGroup = 0; selectObjThing(id, tile); }; gb.appendChild(rmv); }
    // slider idle ↔ walk (igual o "Group" do Object Builder) — troca sem clicar no botão
    if (t._groups.length > 1) { const sl = document.createElement('input'); sl.type = 'range'; sl.min = 0; sl.max = t._groups.length - 1; sl.step = 1; sl.value = objGroup; sl.title = 'idle ↔ walk'; sl.style.cssText = 'width:90px;vertical-align:middle'; sl.oninput = () => { objGroup = +sl.value; selectObjThing(id, tile); }; const gl = document.createElement('span'); gl.className = 'alabel'; gl.textContent = ' ' + (t._groups[objGroup] && t._groups[objGroup].type === 1 ? 'walk' : 'idle'); gb.append(sl, gl); }
    ins.appendChild(gb);
  }
  if (_objInspectCv) _anims.delete(_objInspectCv);
  const x = ((objCat === 'outfits' || objCat === 'missiles') && t.px > 1) ? Math.min(objDir, t.px - 1) : 0;
  // ---- direção (virar o personagem, igual a bússola do OB) ----
  if ((objCat === 'outfits' || objCat === 'missiles') && t.px > 1) {
    const dc = document.createElement('div'); dc.className = 'objDirBar';
    const nm = document.createElement('span'); nm.className = 'alabel'; nm.textContent = '🧭 ' + (DIR_LBL[x] || x);
    const mk = (lbl, d) => { const b = document.createElement('button'); b.className = 'miniBtn' + (x === d ? ' accent' : ''); b.textContent = lbl; b.title = 'virar p/ ' + (DIR_LBL[d] || d); b.disabled = d >= t.px; b.onclick = () => { objDir = d; selectObjThing(id, tile); }; return b; };
    dc.append(nm, mk('▲', 0), mk('►', 1), mk('▼', 2), mk('◄', 3));
    ins.appendChild(dc);
  }
  // preview no painel Info (sempre)
  const ip = $('objInfoPrev'); if (ip) { _anims.delete(ip); if (!objEditPixels && prefPreviewAnim) setAnim(ip, t, x, objGroup); else drawScaled(ip, composeG(t, objGroup, x, 0)); applyObjPrevZoom(); }
  // toggle Edit Pixels (inline, igual o Object Builder)
  if (spr) { const ep = document.createElement('button'); ep.className = 'miniBtn' + (objEditPixels ? ' accent' : ''); ep.style.cssText = 'display:block;margin:0 auto 6px'; ep.textContent = objEditPixels ? '✏️ Edit Pixels: ON' : '✏️ Edit Pixels'; ep.title = 'editar os pixels direto aqui (inline)'; ep.onclick = () => { objEditPixels = !objEditPixels; selectObjThing(id, tile); }; ins.appendChild(ep); }
  if (objEditPixels && spr && t.sprites && t.sprites.length) {
    buildInlineEditor(ins, t, x); // edição inline na tela principal
  } else {
    const D = Math.round(128 * objMainZoom); // tamanho do preview conforme o Zoom do topo
    const cv = document.createElement('canvas'); cv.width = D; cv.height = D; cv.style.cssText = 'display:block;margin:0 auto;image-rendering:pixelated'; ins.appendChild(cv);
    if (prefPreviewAnim) setAnim(cv, t, x, objGroup); else drawScaled(cv, composeG(t, objGroup, x, 0));
    _objInspectCv = cv;
    // drag PNG direto na canvas → aplica como sheet (igual Object Builder)
    cv.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; cv.style.outline = '2px solid #3fcf7a'; });
    cv.addEventListener('dragleave', () => { cv.style.outline = ''; });
    cv.addEventListener('drop', async (e) => { e.preventDefault(); cv.style.outline = ''; const f = e.dataTransfer.files[0]; if (!f || !/\.png$/i.test(f.name)) return; await applySheetFile(f, t, g); });
    // duplo-clique numa parte do sprite → mostra/edita essa peça no painel direito (igual OB)
    cv.title = 'arraste .png aqui → importa sheet · duplo-clique → mostra peça no painel Sprites';
    cv.ondblclick = (e) => { const r = cv.getBoundingClientRect(); const W = t.width * 32, HH = t.height * 32; const s = Math.max(1, Math.min(Math.floor(D / W), Math.floor(D / HH))); const offX = (D - W * s) / 2, offY = (D - HH * s) / 2; const sx = D / r.width; const compX = ((e.clientX - r.left) * sx - offX) / s, compY = ((e.clientY - r.top) * sx - offY) / s; const sid = previewTileSid(t, x, 0, compX, compY); if (sid) gotoSprite(sid); };
    if (g.frames > 1) { const animTgl = document.createElement('button'); animTgl.className = 'miniBtn'; animTgl.style.display = 'block'; animTgl.style.margin = '0 auto 6px'; animTgl.textContent = _anims.has(cv) ? '⏸ pausar animação' : '▶ animar'; animTgl.onclick = () => { if (_anims.has(cv)) { _anims.delete(cv); drawScaled(cv, composeThing(t, x, 0)); animTgl.textContent = '▶ animar'; } else { setAnim(cv, t, x); animTgl.textContent = '⏸ pausar animação'; } }; ins.appendChild(animTgl); }
    const multiFrame = g.frames > 1, multiDir = (objCat === 'outfits' || objCat === 'missiles') && t.px > 1;
    if (multiFrame || multiDir) {
      const fr = document.createElement('button'); fr.className = 'miniBtn' + (_filmRoll ? ' accent' : ''); fr.style.cssText = 'display:block;margin:0 auto 6px'; fr.textContent = _filmRoll ? '🎞 Film Roll: ON' : '🎞 Film Roll'; fr.title = 'mostra todos os frames/direções numa tira'; fr.onclick = () => { _filmRoll = !_filmRoll; selectObjThing(id, tile); }; ins.appendChild(fr);
      if (_filmRoll) { const strip = document.createElement('div'); strip.className = 'filmRoll'; buildFilmRoll(strip, t, g, x); ins.appendChild(strip); }
    }
  }
  // ===== ABAS (estilo Object Builder): Sprite & Animação | Propriedades =====
  const tabBar = document.createElement('div'); tabBar.className = 'objTabs';
  const paneSprite = document.createElement('div'); const paneProps = document.createElement('div'); paneProps.style.display = 'none'; const paneFlags = document.createElement('div'); paneFlags.style.display = 'none';
  const PANES = { sprite: paneSprite, props: paneProps, flags: paneFlags };
  const mkTab = (label, which, active) => { const b = document.createElement('button'); b.className = 'objTabBtn' + (active ? ' active' : ''); b.textContent = label; b.onclick = () => { tabBar.querySelectorAll('.objTabBtn').forEach((x) => x.classList.remove('active')); b.classList.add('active'); for (const k in PANES) PANES[k].style.display = (k === which) ? '' : 'none'; }; return b; };
  tabBar.append(mkTab('🖼 Sprite & Animação', 'sprite', true), mkTab('📋 Propriedades', 'props', false), mkTab('⚑ Flags', 'flags', false));
  ins.append(tabBar, paneSprite, paneProps, paneFlags);
  const row = (k, v, parent) => { const d = document.createElement('div'); d.className = 'opRow'; d.innerHTML = `<span>${k}</span><b>${v}</b>`; (parent || paneProps).appendChild(d); };
  // ---- aba SPRITE: geometria + animação + cor + slots ----
  const gdiv = document.createElement('div'); gdiv.id = 'objGeom'; paneSprite.appendChild(gdiv); renderGeomEditor(t, g);
  const adiv = document.createElement('div'); adiv.id = 'objAnim'; paneSprite.appendChild(adiv); renderAnimEditor(t, g);
  const coldiv = document.createElement('div'); coldiv.id = 'objColor'; paneSprite.appendChild(coldiv); renderColorize(t, g);
  row('total sprites', g.sprites.length, paneSprite);
  // ---- aba PROPRIEDADES: só as Propriedades (com valor), igual o Object Builder original ----
  const propDiv = document.createElement('div'); propDiv.id = 'objProps'; paneProps.appendChild(propDiv); renderFlagEditor(t, propDiv, 'props');
  // items.xml + Market + info do thing (extras do server, abaixo das propriedades)
  const srvdiv = document.createElement('div'); srvdiv.id = 'objServer'; paneProps.appendChild(srvdiv); renderServerAttrs(id);
  renderMarketEditor(t, paneProps);
  row('tamanho', `${t.width}×${t.height}`); row('layers', t.layers); row('pattern', `${t.px}×${t.py}×${t.pz}`); row('frames', g.frames);
  // ---- aba FLAGS: só as flags booleanas (separada das propriedades, igual o OB) ----
  const fdiv = document.createElement('div'); fdiv.id = 'objFlags'; paneFlags.appendChild(fdiv); renderFlagEditor(t, fdiv, 'flags');
  const lbl = document.createElement('div'); lbl.className = 'opRow'; lbl.innerHTML = '<span>slots de sprite (clica = editar pixel · edita id = reapontar)</span>'; paneSprite.appendChild(lbl);
  const sgrid = document.createElement('div'); sgrid.className = 'objSprites'; paneSprite.appendChild(sgrid);
  const W = t.width, H = t.height, BLK = W * H;
  // reaponta o slot real (índice em g.sprites) p/ outro id
  const reSlot = (realIdx, nid) => { if (isNaN(nid)) return; objSnapshot(); dat.setSpriteId(t, realIdx, nid, g); invalidateGfx(); datDirty = true; updateDatSaveBtn(); if (typeof liveOp === 'function') liveOp('obj', 'setspr', { cat: objCat, id: objSel.id, slot: realIdx, gi: objGroup, sid: nid }); selectObjThing(objSel.id); renderObjGrid(); };
  const clickSlot = (realIdx, sid) => { if (_selBrowseSpr > 0 && dat && !assetsMode) { reSlot(realIdx, _selBrowseSpr); $('status').textContent = `slot ${realIdx} → sprite #${_selBrowseSpr} (aplicado do painel)`; } else openPixelEditor(sid); };
  if (W === 1 && H === 1) {
    // 1×1: lista simples (cada slot é o sprite inteiro)
    for (let i = 0; i < g.sprites.length; i++) {
      const sid = g.sprites[i];
      const st = document.createElement('div'); st.className = 'objSpr' + (sprEdits.has(sid) ? ' edited' : ''); st.dataset.sid = sid; st.dataset.slot = i;
      const cv2 = document.createElement('canvas'); cv2.width = 34; cv2.height = 34; drawSpriteTo(cv2, sid); cv2.title = 'clique = editar pixel · duplo-clique = mostrar no painel Sprites'; cv2.onclick = () => clickSlot(i, sid); cv2.ondblclick = () => gotoSprite(sid);
      const inp = document.createElement('input'); inp.className = 'slotId'; inp.value = sid; inp.title = 'reaponta este slot p/ outro id'; inp.onchange = () => reSlot(i, parseInt(inp.value, 10));
      const edt = document.createElement('button'); edt.className = 'expBtn'; edt.textContent = '✏️'; edt.title = 'editar pixel'; edt.onclick = (e) => { e.stopPropagation(); openPixelEditor(sid); };
      const rep = document.createElement('button'); rep.className = 'expBtn'; rep.textContent = '🖼'; rep.title = 'trocar por PNG'; rep.onclick = (e) => { e.stopPropagation(); replaceSprite(sid); };
      const exp = document.createElement('button'); exp.className = 'expBtn'; exp.textContent = '⤓'; exp.title = 'exportar PNG'; exp.onclick = (e) => { e.stopPropagation(); exportSprite(sid); };
      st.append(cv2, inp, edt, rep, exp); sgrid.appendChild(st);
    }
  } else {
    // multi-tile (2×2+): monta cada bloco de W×H tiles na posição certa formando o sprite (igual Object Builder)
    sgrid.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start;overflow:auto;padding:4px';
    const nBlocks = Math.floor(g.sprites.length / BLK);
    for (let b = 0; b < nBlocks; b++) {
      const base = b * BLK;
      const blk = document.createElement('div'); blk.className = 'objSprBlock'; blk.style.gridTemplateColumns = `repeat(${W}, 32px)`;
      // ordem visual = bloco invertido (composeThing coloca tile w,h em (W-1-w, H-1-h))
      for (let k = 0; k < BLK; k++) {
        const realIdx = base + (BLK - 1 - k); const sid = g.sprites[realIdx];
        const cell = document.createElement('div'); cell.className = 'objSprTile' + (sprEdits.has(sid) ? ' edited' : ''); cell.dataset.sid = sid;
        const c = document.createElement('canvas'); c.width = 32; c.height = 32; drawSpriteTo(c, sid); c.title = `sprite #${sid} · clique = editar pixel · duplo-clique = mostrar no painel Sprites`; c.onclick = () => clickSlot(realIdx, sid); c.ondblclick = () => gotoSprite(sid);
        const idl = document.createElement('span'); idl.className = 'objSprTileId'; idl.textContent = sid; idl.title = 'clique = reapontar id'; idl.onclick = (e) => { e.stopPropagation(); const v = prompt('reapontar sprite id deste tile:', sid); if (v != null) reSlot(realIdx, parseInt(v, 10)); };
        cell.append(c, idl); blk.appendChild(cell);
      }
      // botão: editar o sprite INTEIRO do bloco (composto)
      const eb = document.createElement('button'); eb.className = 'objSprBlkEdit'; eb.textContent = '✏️ ' + (b + 1); eb.title = 'editar o sprite INTEIRO deste bloco'; eb.onclick = () => openPixelEditorThingBlock(t, g, base);
      const wrap = document.createElement('div'); wrap.className = 'objSprBlockWrap'; wrap.append(blk, eb); sgrid.appendChild(wrap);
    }
  }
  // ---- footer: Salvar / Fechar (igual o Object Builder) ----
  const ft = document.createElement('div'); ft.className = 'objEditFoot';
  const sv = document.createElement('button'); sv.className = 'miniBtn accent'; sv.textContent = '💾 Salvar'; sv.title = 'salvar .dat e/ou .spr alterados';
  sv.onclick = () => { let did = false; if (datDirty) { saveDat(); did = true; } if (sprEdits.size) { saveSpr(); did = true; } if (!did) $('status').textContent = 'nada alterado p/ salvar'; };
  const cl = document.createElement('button'); cl.className = 'miniBtn'; cl.textContent = 'Fechar'; cl.title = 'fechar o objeto (volta pra lista)';
  cl.onclick = () => { objSel = null; _objInspectCv = null; objEditPixels = false; document.querySelectorAll('#objGrid .objTile.sel').forEach((e) => e.classList.remove('sel')); ins.innerHTML = '<div class="alabel" style="padding:12px">clique num thing →</div>'; };
  ft.append(sv, cl); ins.appendChild(ft);
}
// edita o sprite composto de um bloco (W×H tiles a partir de baseIdx em g.sprites) e re-fatia ao salvar
function openPixelEditorThingBlock(t, g, base) {
  if (!spr) return; const W = t.width, H = t.height, BLK = W * H, PW = W * 32, PH = H * 32;
  const px = new Uint8ClampedArray(PW * PH * 4); const tiles = [];
  for (let h = 0; h < H; h++) for (let w = 0; w < W; w++) {
    const realIdx = base + h * W + w; const sid = g.sprites[realIdx]; if (!sid) continue;
    const sp = sprEdits.get(sid) || spr.sprite(sid);
    const ox = (W - 1 - w) * 32, oy = (H - 1 - h) * 32; tiles.push({ sid, ox, oy });
    if (sp) for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const so = (y * 32 + x) * 4, no = ((oy + y) * PW + (ox + x)) * 4; px[no] = sp[so]; px[no + 1] = sp[so + 1]; px[no + 2] = sp[so + 2]; px[no + 3] = sp[so + 3]; }
  }
  if (!tiles.length) return;
  pixelEditorUI(PW, PH, px, `Editor de pixel — sprite ${W}×${H} (${PW}×${PH}px)`, (out) => {
    for (const ts of tiles) { const sp = new Uint8ClampedArray(4096); for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const no = ((ts.oy + y) * PW + (ts.ox + x)) * 4, so = (y * 32 + x) * 4; sp[so] = out[no]; sp[so + 1] = out[no + 1]; sp[so + 2] = out[no + 2]; sp[so + 3] = out[no + 3]; } sprEdits.set(ts.sid, sp); if (spr.cache) spr.cache.set(ts.sid, new Uint8ClampedArray(sp)); if (typeof liveOp === 'function') liveOp('obj', 'pixel', { sid: ts.sid, rgba: Array.from(sp) }); }
    invalidateSprites(); updateObjSaveBtn(); if (objSel) selectObjThing(objSel.id); renderObjGrid(); $('status').textContent = `bloco editado (${tiles.length} tiles) — 💾 Salvar .spr`;
  });
}
// flags editaveis (canonico -> nome + bytes de dados + labels dos campos u16)
const OBJ_FLAGS = [
  { c: 0, n: 'Ground', d: 2, f: ['velocidade'] }, { c: 1, n: 'GroundBorder' }, { c: 2, n: 'OnBottom' },
  { c: 3, n: 'OnTop' }, { c: 4, n: 'Container' }, { c: 5, n: 'Stackable' }, { c: 6, n: 'ForceUse' },
  { c: 7, n: 'MultiUse' }, { c: 8, n: 'Writable', d: 2, f: ['maxlen'] }, { c: 9, n: 'WritableOnce', d: 2, f: ['maxlen'] },
  { c: 10, n: 'FluidContainer' }, { c: 11, n: 'Splash' }, { c: 12, n: 'NotWalkable' }, { c: 13, n: 'NotMoveable' },
  { c: 14, n: 'BlockProjectile' }, { c: 15, n: 'NotPathable' }, { c: 16, n: 'Pickupable' }, { c: 17, n: 'Hangable' },
  { c: 18, n: 'HookSouth' }, { c: 19, n: 'HookEast' }, { c: 20, n: 'Rotateable' },
  { c: 21, n: 'Light', d: 4, f: ['intensidade', 'cor'] }, { c: 22, n: 'DontHide' }, { c: 23, n: 'Translucent' },
  { c: 25, n: 'Elevation', d: 2, f: ['altura'] }, { c: 26, n: 'LyingCorpse' }, { c: 27, n: 'AnimateAlways' },
  { c: 28, n: 'MinimapColor', d: 2, f: ['cor'] }, { c: 30, n: 'FullGround' }, { c: 31, n: 'Look' },
  { c: 35, n: 'Wrapable' }, { c: 36, n: 'Unwrapable' }, { c: 37, n: 'TopEffect' },
  { c: 24, n: 'Displacement', d: 4, f: ['offsetX', 'offsetY'], minV: 755 }, // deslocamento (só >=7.55)
  { c: 32, n: 'LensHelp', d: 2, f: ['id'] }, { c: 34, n: 'Cloth', d: 2, f: ['slot'] },
  { c: 29, n: 'NoMoveAnim', d: 2, f: ['?'] }, { c: 38, n: 'Wings', preserve: true }, // Market (33) tem editor dedicado na aba Propriedades
];
// editor de geometria: w/h/layers/patternX/Y/Z/frames + exact. Aplicar reconstrói o thing.
const GEOM_FIELDS = [
  { k: 'width', n: 'largura' }, { k: 'height', n: 'altura' }, { k: 'exact', n: 'exact px' },
  { k: 'layers', n: 'layers' }, { k: 'px', n: 'pattern X' }, { k: 'py', n: 'pattern Y' },
  { k: 'pz', n: 'pattern Z' }, { k: 'frames', n: 'frames (anim)' },
];
function renderGeomEditor(t, g) {
  g = g || curGroup(t);
  const box = $('objGeom');
  if (!box) return;
  box.innerHTML = '<div class="opRow"><span>geometria (sprites = w·h·layers·pX·pY·pZ·frames)</span></div>';
  const grid = document.createElement('div'); grid.className = 'geomBox';
  const inputs = {};
  for (const f of GEOM_FIELDS) {
    const cell = document.createElement('label'); cell.className = 'geomCell';
    cell.appendChild(document.createTextNode(f.n));
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = 1; inp.max = 255; inp.value = g[f.k];
    if (f.k === 'pz' && datVersion < 755) { inp.disabled = true; }
    inputs[f.k] = inp; cell.appendChild(inp);
    grid.appendChild(cell);
  }
  box.appendChild(grid);
  const preview = document.createElement('div'); preview.className = 'alabel'; preview.style.cssText = 'font-size:11px;margin:4px 0';
  const calc = () => {
    const v = (k) => Math.max(1, parseInt(inputs[k].value, 10) || 1);
    const tot = v('width') * v('height') * v('layers') * v('px') * v('py') * v('pz') * v('frames');
    preview.textContent = `novo total de sprites: ${tot}` + (tot > g.sprites.length ? ` (+${tot - g.sprites.length} novos em branco)` : tot < g.sprites.length ? ` (−${g.sprites.length - tot} cortados)` : ' (igual)');
  };
  Object.values(inputs).forEach((i) => i.addEventListener('input', calc));
  calc();
  box.appendChild(preview);
  const btn = document.createElement('button'); btn.className = 'miniBtn accent'; btn.textContent = '✓ Aplicar geometria';
  btn.onclick = () => {
    const geom = {}; for (const f of GEOM_FIELDS) geom[f.k] = inputs[f.k].value;
    objSnapshot();
    dat.setGeometry(t, objCat, geom, objGroup);
    invalidateGfx(); datDirty = true; updateDatSaveBtn();
    selectObjThing(objSel.id); renderObjGrid();
    const ng = curGroup(t);
    $('status').textContent = `geometria alterada (${ng.width}×${ng.height}, ${ng.frames}f, ${ng.sprites.length} sprites) — não salvo`;
  };
  box.appendChild(btn);
}
// editor de animação: durações min/max por frame + modo/loop/start. Só p/ frames>1 com durations.
function renderAnimEditor(t, g) {
  g = g || curGroup(t);
  const box = $('objAnim');
  if (!box) return;
  box.innerHTML = '';
  if (!(g.frames > 1 && g.durations)) return; // sem animação editável (.dat antigo ou 1 frame)
  box.innerHTML = '<div class="opRow"><span>animação — duração por frame (ms)</span></div>';
  const durInputs = [];
  const quick = document.createElement('div'); quick.className = 'animQuick';
  const allInp = document.createElement('input'); allInp.type = 'number'; allInp.min = 0; allInp.placeholder = 'ms'; allInp.style.width = '70px';
  const allBtn = document.createElement('button'); allBtn.className = 'miniBtn'; allBtn.textContent = 'todos os frames';
  allBtn.onclick = () => { const v = parseInt(allInp.value, 10); if (isNaN(v)) return; durInputs.forEach((p) => { p.min.value = v; p.max.value = v; }); };
  quick.append(allInp, allBtn); box.appendChild(quick);
  const grid = document.createElement('div'); grid.className = 'animBox';
  for (let i = 0; i < g.frames; i++) {
    const d = g.durations[i] || { min: 100, max: 100 };
    const r = document.createElement('div'); r.className = 'animRow';
    const lab = document.createElement('span'); lab.textContent = 'f' + i;
    const mn = document.createElement('input'); mn.type = 'number'; mn.min = 0; mn.value = d.min; mn.title = 'mín ms';
    const mx = document.createElement('input'); mx.type = 'number'; mx.min = 0; mx.value = d.max; mx.title = 'máx ms';
    r.append(lab, mn, mx); grid.appendChild(r); durInputs.push({ min: mn, max: mx });
  }
  box.appendChild(grid);
  const opts = document.createElement('div'); opts.className = 'geomBox';
  const mkNum = (lbl, val, title) => { const w = document.createElement('label'); w.className = 'geomCell'; w.appendChild(document.createTextNode(lbl)); const i = document.createElement('input'); i.type = 'number'; i.value = val; i.title = title; w.appendChild(i); opts.appendChild(w); return i; };
  const modeInp = mkNum('modo', g.animMode || 0, '0=async  1=sync');
  const loopInp = mkNum('loop', g.loopCount || 0, '0=infinito · >0 = nº de loops');
  const startInp = mkNum('start', g.startFrame || 0, 'frame inicial (-1=aleatório)');
  box.appendChild(opts);
  const btn = document.createElement('button'); btn.className = 'miniBtn accent'; btn.textContent = '✓ Aplicar animação';
  btn.onclick = () => {
    const durations = durInputs.map((p) => ({ min: parseInt(p.min.value, 10) || 0, max: parseInt(p.max.value, 10) || 0 }));
    objSnapshot();
    dat.setAnimation(t, objCat, { durations, animMode: parseInt(modeInp.value, 10) || 0, loopCount: parseInt(loopInp.value, 10) || 0, startFrame: parseInt(startInp.value, 10) || 0 }, objGroup);
    invalidateGfx(); datDirty = true; updateDatSaveBtn(); selectObjThing(objSel.id);
    $('status').textContent = 'animação aplicada — não salvo';
  };
  box.appendChild(btn);
}
// ===== Undo/Redo do Object (snapshot via _cloneThing) =====
let objUndo = [], objRedo = [];
function objSnapshot() { if (!objSel || !dat) return; try { objUndo.push({ cat: objCat, id: objSel.id, snap: dat._cloneThing(objSel.t, objCat) }); if (objUndo.length > 60) objUndo.shift(); objRedo.length = 0; } catch (e) {} }
function objRestore(stackFrom, stackTo) { if (!stackFrom.length || !dat) return; const u = stackFrom.pop(); const m = dat.category(u.cat); const cur = m.get(u.id); if (cur) stackTo.push({ cat: u.cat, id: u.id, snap: dat._cloneThing(cur, u.cat) }); m.set(u.id, u.snap); datDirty = true; updateDatSaveBtn(); if (objCat === u.cat) { objSel = null; selectObjThing(u.id); renderObjGrid(); } $('status').textContent = `#${u.id} restaurado`; }
function objUndoDo() { objRestore(objUndo, objRedo); }
function objRedoDo() { objRestore(objRedo, objUndo); }
// find-usages: onde um sprite id é usado
function objFindSpriteUsages() {
  if (!dat) return; const sid = parseInt(prompt('Sprite id — achar quais things o usam:', ''), 10); if (!sid) return;
  const hits = [];
  for (const cat of ['items', 'outfits', 'effects', 'missiles']) { const m = dat.category(cat); if (!m) continue; for (const [id, t] of m) { let used = false; for (const g of t._groups) if (g.sprites && g.sprites.includes(sid)) { used = true; break; } if (used) hits.push({ cat, id }); if (hits.length >= 2000) break; } }
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '420px';
  box.innerHTML = `<h3>🔍 sprite #${sid} — usado em ${hits.length} thing(s)</h3>`;
  const list = document.createElement('div'); list.className = 'animBox'; list.style.maxHeight = '400px'; box.appendChild(list);
  for (const h of hits) { const r = document.createElement('div'); r.className = 'animRow'; r.style.gridTemplateColumns = '1fr'; const b = document.createElement('button'); b.className = 'miniBtn'; b.style.textAlign = 'left'; b.textContent = `${h.cat} #${h.id}`; b.onclick = () => { objCat = h.cat; document.querySelectorAll('.objCat').forEach((x) => x.classList.toggle('active', x.dataset.cat === h.cat)); renderObjGrid(); setTimeout(() => selectObjThing(h.id), 30); ov.remove(); }; r.appendChild(b); list.appendChild(r); }
  if (!hits.length) list.innerHTML = '<div class="alabel" style="padding:8px">nenhum thing usa esse sprite</div>';
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// batch: troca sprite id em TODOS os things
function objBatchReplaceSprite() {
  if (!dat) return; const s = prompt('Trocar sprite id em TODOS os things — "de, para":', ''); const m = s && s.match(/(\d+)\D+(\d+)/); if (!m) return; const from = +m[1], to = +m[2];
  if (!confirm(`Trocar todos os usos do sprite #${from} → #${to}?`)) return;
  let n = 0;
  for (const cat of ['items', 'outfits', 'effects', 'missiles']) { const mp = dat.category(cat); if (!mp) continue; for (const [id, t] of mp) { for (const g of t._groups) { if (!g.sprites) continue; for (let i = 0; i < g.sprites.length; i++) if (g.sprites[i] === from) { dat.setSpriteId(t, i, to, g); n++; } } } }
  datDirty = true; updateDatSaveBtn(); renderObjGrid(); if (objSel) selectObjThing(objSel.id); $('status').textContent = `${n} slot(s) ${from}→${to} (não salvo)`;
}
// buscar itens do items.xml por atributo (key opcional value)
function itemsSearchByAttr() {
  if (!ensureItemsXml() || !itemsXml) return alert('carregue o items.xml (junto do items.otb)');
  const s = prompt('Buscar no items.xml — "atributo" ou "atributo=valor" (ex: weaponType=sword, armor):', 'weaponType=sword'); if (!s) return;
  const eq = s.indexOf('='); const key = (eq >= 0 ? s.slice(0, eq) : s).trim().toLowerCase(); const val = eq >= 0 ? s.slice(eq + 1).trim().toLowerCase() : null;
  const hits = [];
  for (const e of itemsXml.items) { const a = (e.attributes || []).find((x) => (x.key || '').toLowerCase() === key && (val == null || String(x.value).toLowerCase() === val)); if (a) hits.push({ id: e.tagAttrs.id || e.id, name: e.tagAttrs.name || '', val: a.value }); if (hits.length >= 3000) break; }
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '480px';
  box.innerHTML = `<h3>🔎 ${key}${val ? '=' + val : ''} — ${hits.length} item(ns)</h3>`;
  const list = document.createElement('div'); list.className = 'animBox'; list.style.maxHeight = '440px'; box.appendChild(list);
  for (const h of hits) { const r = document.createElement('div'); r.className = 'animRow'; r.style.gridTemplateColumns = '1fr'; const b = document.createElement('button'); b.className = 'miniBtn'; b.style.cssText = 'text-align:left;font-size:11px'; b.textContent = `#${h.id} ${h.name} — ${key}=${h.val}`; b.onclick = () => { navigator.clipboard.writeText(String(h.id)); $('status').textContent = 'server id ' + h.id + ' copiado'; }; r.appendChild(b); list.appendChild(r); }
  if (!hits.length) list.innerHTML = '<div class="alabel" style="padding:8px">nada encontrado</div>';
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// editar atributos do items.otb (rotateTo + speed) p/ um server id
function otbEditAttr() {
  if (!otbPath) return alert('carregue o items.otb (botão items.otb)');
  const s = prompt('items.otb — "serverId, rotateTo" (rotateTo=0 limpa):', ''); const m = s && s.match(/(\d+)\D+(\d+)/); if (!m) return; const sid = +m[1], rt = +m[2];
  try {
    const model = OTB.parseFull(otbPath); let found = null;
    for (const node of model.root.children) { const p = OTB.parseItemProps(node.props); const sv = OTB.getAttr(p, OTB.ATTR_SERVERID); if (sv && sv.length >= 2 && sv.readUInt16LE(0) === sid) { found = { node, p }; break; } }
    if (!found) return alert('server id ' + sid + ' não achado no items.otb');
    OTB.setU16Attr(found.p, 0x1E, rt); // 0x1E = ITEM_ATTR_ROTATETO
    found.node.props = OTB.buildItemProps(found.p.flags, found.p.attrs);
    backup(otbPath); OTB.saveOtb(model, otbPath); otbMap = loadOtb(otbPath); rebuildOtbInv();
    $('status').textContent = `rotateTo de #${sid} = ${rt} salvo no items.otb (.bak feito)`;
  } catch (e) { alert('erro: ' + e.message); }
}
// ===== Market editor (canon 33) — igual Object Builder (9.86+) =====
const MARKET_CATS = ['(0)', 'Armors', 'Amulets', 'Boots', 'Containers', 'Decoration', 'Food', 'Helmets/Hats', 'Legs', 'Others', 'Potions', 'Rings', 'Runes', 'Shields', 'Tools', 'Valuables', 'Ammunition', 'Axes', 'Clubs', 'Distance', 'Swords', 'Wands/Rods', 'Premium Scrolls', 'Tibia Coins', 'Creature Products', 'Quiver'];
function marketParse(data) {
  if (!data || data.length < 8) return { category: 0, tradeAs: 0, showAs: 0, name: '', restrictVoc: 0, restrictLvl: 0 };
  const category = data.readUInt16LE(0), tradeAs = data.readUInt16LE(2), showAs = data.readUInt16LE(4);
  const nameLen = data.readUInt16LE(6); const name = data.toString('latin1', 8, 8 + nameLen);
  let o = 8 + nameLen; const restrictVoc = (o + 1 < data.length) ? data.readUInt16LE(o) : 0; const restrictLvl = (o + 3 < data.length) ? data.readUInt16LE(o + 2) : 0;
  return { category, tradeAs, showAs, name, restrictVoc, restrictLvl };
}
function marketBuild(m) {
  const nb = Buffer.from(m.name || '', 'latin1'); const buf = Buffer.alloc(8 + nb.length + 4);
  buf.writeUInt16LE((m.category || 0) & 0xFFFF, 0); buf.writeUInt16LE((m.tradeAs || 0) & 0xFFFF, 2); buf.writeUInt16LE((m.showAs || 0) & 0xFFFF, 4);
  buf.writeUInt16LE(nb.length, 6); nb.copy(buf, 8);
  buf.writeUInt16LE((m.restrictVoc || 0) & 0xFFFF, 8 + nb.length); buf.writeUInt16LE((m.restrictLvl || 0) & 0xFFFF, 10 + nb.length); return buf;
}
function renderMarketEditor(t, parent) {
  const wrap = document.createElement('div'); wrap.className = 'tpGroup'; wrap.style.marginTop = '8px';
  const head = document.createElement('div'); head.className = 'tpLbl'; head.style.display = 'flex'; head.style.justifyContent = 'space-between';
  let attr = t._attrs.find((a) => a.canon === 33);
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!attr;
  const ttl = document.createElement('span'); ttl.textContent = '🛒 Market (9.86+)'; const lblc = document.createElement('label'); lblc.style.cssText = 'display:flex;gap:5px;align-items:center;font-weight:400'; lblc.append(cb, document.createTextNode(' ativo'));
  head.append(ttl, lblc); wrap.appendChild(head);
  const fields = document.createElement('div');
  const m = marketParse(attr && attr.data);
  const commit = () => { if (!attr) return; attr.data = marketBuild(m); datDirty = true; updateDatSaveBtn(); $('status').textContent = 'market editado (não salvo)'; };
  const catSel = document.createElement('select'); MARKET_CATS.forEach((c, i) => { const o = document.createElement('option'); o.value = i; o.textContent = i + ' — ' + c; catSel.appendChild(o); }); catSel.value = m.category; catSel.onchange = () => { m.category = +catSel.value; commit(); };
  const mkF = (lbl, key, isText) => { const w = document.createElement('label'); w.className = 'tpField'; w.innerHTML = `<span>${lbl}</span>`; const i = document.createElement('input'); if (!isText) i.type = 'number'; i.value = m[key]; i.onchange = () => { m[key] = isText ? i.value : (parseInt(i.value, 10) || 0); commit(); }; w.appendChild(i); fields.appendChild(w); };
  const catRow = document.createElement('label'); catRow.className = 'tpField'; catRow.innerHTML = '<span>categoria</span>'; catRow.appendChild(catSel); fields.appendChild(catRow);
  mkF('nome no market', 'name', true); mkF('tradeAs (item id)', 'tradeAs'); mkF('showAs (item id)', 'showAs'); mkF('restrict vocação', 'restrictVoc'); mkF('restrict level', 'restrictLvl');
  wrap.appendChild(fields); fields.style.display = attr ? '' : 'none';
  cb.onchange = () => { if (cb.checked) { if (!attr) { attr = { op: VERS.inverseRemap(33, datVersion), canon: 33, data: marketBuild(m) }; t._attrs.push(attr); } fields.style.display = ''; } else { t._attrs = t._attrs.filter((a) => a.canon !== 33); attr = null; fields.style.display = 'none'; } datDirty = true; updateDatSaveBtn(); };
  parent.appendChild(wrap);
}
// editor de colorização de outfit (preview + look XML). Só outfit com layers>=2.
function renderColorize(t, g) {
  const box = $('objColor'); if (!box) return; box.innerHTML = '';
  if (objCat !== 'outfits' || g.layers < 2) return;
  box.innerHTML = '<div class="opRow"><span>colorização (preview — não altera sprites)</span></div>';
  const prev = document.createElement('canvas'); prev.width = 96; prev.height = 96; prev.style.cssText = 'image-rendering:pixelated;background:#1c2740;border-radius:6px';
  const redraw = () => drawScaled(prev, composeColorized(t, g, outfitColors.dir, outfitColors.addon));
  box.appendChild(prev);
  const grid = document.createElement('div'); grid.className = 'geomBox';
  for (const part of ['head', 'body', 'legs', 'feet']) {
    const cell = document.createElement('label'); cell.className = 'geomCell';
    const sw = document.createElement('span'); sw.className = 'swatch'; const setSw = () => { const c = getOutfitColor(outfitColors[part]); sw.style.background = `rgb(${c[0]},${c[1]},${c[2]})`; };
    cell.appendChild(document.createTextNode(part)); cell.appendChild(sw);
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = 0; inp.max = 132; inp.value = outfitColors[part]; inp.style.width = '52px';
    inp.onchange = () => { outfitColors[part] = Math.max(0, Math.min(132, parseInt(inp.value, 10) || 0)); setSw(); redraw(); };
    setSw(); cell.appendChild(inp); grid.appendChild(cell);
  }
  box.appendChild(grid);
  const ctrl = document.createElement('div'); ctrl.className = 'animQuick';
  const mk = (txt, fn) => { const b = document.createElement('button'); b.className = 'miniBtn'; b.textContent = txt; b.onclick = fn; return b; };
  ctrl.append(
    document.createTextNode('dir:'),
    mk('↑', () => { outfitColors.dir = 0; redraw(); }), mk('→', () => { outfitColors.dir = 1; redraw(); }),
    mk('↓', () => { outfitColors.dir = 2; redraw(); }), mk('←', () => { outfitColors.dir = 3; redraw(); }),
  );
  box.appendChild(ctrl);
  const ad = document.createElement('div'); ad.className = 'animQuick';
  ad.appendChild(document.createTextNode('addon:'));
  for (let a = 0; a < g.py; a++) ad.appendChild(mk('' + a, () => { outfitColors.addon = a; redraw(); }));
  ad.appendChild(mk('🎲 random', () => { outfitColors.head = rnd133(); outfitColors.body = rnd133(); outfitColors.legs = rnd133(); outfitColors.feet = rnd133(); renderColorize(t, g); }));
  ad.appendChild(mk('📋 copiar look', () => copyLook(t)));
  box.appendChild(ad);
  redraw();
}
function rnd133() { return Math.floor(_rng() * 133); }
let _rngSeed = 123456789;
function _rng() { _rngSeed = (_rngSeed * 1103515245 + 12345) & 0x7fffffff; return _rngSeed / 0x7fffffff; }
function copyLook(t) {
  const xml = `<look type="${objSel.id}" head="${outfitColors.head}" body="${outfitColors.body}" legs="${outfitColors.legs}" feet="${outfitColors.feet}" addons="${outfitColors.addon}"/>`;
  try { navigator.clipboard.writeText(xml); } catch (e) {}
  $('status').textContent = 'look copiado: ' + xml;
}
// atributos de servidor (items.xml): nome + article + atributos key/value editáveis
const COMMON_ATTRS = ['weight', 'attack', 'defense', 'armor', 'description', 'slotType', 'weaponType', 'ammoType', 'shootType', 'range', 'decayTo', 'duration', 'charges', 'showcount', 'maxItems', 'containerSize', 'speed', 'healthGain', 'manaGain'];
function renderServerAttrs(clientId) {
  const box = $('objServer'); if (!box) return; box.innerHTML = '';
  if (objCat !== 'items') return;
  if (!ensureItemsXml()) { box.innerHTML = '<div class="alabel" style="font-size:11px;padding:4px">items.xml não carregado (aponte items.otb + items.xml)</div>'; return; }
  const sid = serverIdOf(clientId);
  let e = itemEntryOf(clientId);
  box.innerHTML = `<div class="opRow"><span>servidor (items.xml) · serverId ${sid}${otbInv ? '' : ' (=clientId)'}</span></div>`;
  // editor de clientId no .otb (mapeia serverId -> qual sprite/thing do client)
  if (ensureOtbFull() && otbItemIdx) {
    const node = otbItemIdx.get(sid);
    const w = document.createElement('label'); w.className = 'opRow'; w.innerHTML = '<span>clientId (items.otb)</span>';
    const i = document.createElement('input'); i.type = 'number'; i.style.cssText = 'width:90px';
    const ip = node ? OTB.parseItemProps(node.props) : null;
    const cidA = ip ? OTB.getAttr(ip, OTB.ATTR_CLIENTID) : null;
    i.value = cidA ? cidA.readUInt16LE(0) : clientId;
    i.title = node ? 'altera p/ qual id do client este item aponta' : 'serverId sem entrada no otb';
    i.disabled = !node;
    i.onchange = () => { const ipx = OTB.parseItemProps(node.props); OTB.setU16Attr(ipx, OTB.ATTR_CLIENTID, parseInt(i.value, 10) || 0); node.props = OTB.buildItemProps(ipx.flags, ipx.attrs); $('status').textContent = `otb: serverId ${sid} → clientId ${i.value} (não salvo)`; };
    const sv = document.createElement('button'); sv.className = 'expBtn'; sv.textContent = '💾'; sv.title = 'salvar items.otb'; sv.onclick = saveOtbFile;
    w.append(i, sv); box.appendChild(w);
  }
  if (!e) {
    const b = document.createElement('button'); b.className = 'miniBtn'; b.textContent = '➕ criar entrada no items.xml';
    b.onclick = () => { e = { id: sid, fromid: null, toid: null, tagAttrs: { id: sid, name: 'new item' }, attributes: [] }; itemsXml.items.push(e); itemsXmlIdx.set(sid, e); renderServerAttrs(clientId); };
    box.appendChild(b); return;
  }
  const mkText = (lbl, val, on) => { const w = document.createElement('label'); w.className = 'opRow'; w.innerHTML = `<span>${lbl}</span>`; const i = document.createElement('input'); i.value = val || ''; i.style.cssText = 'flex:1;max-width:160px'; i.onchange = () => on(i.value); w.appendChild(i); box.appendChild(w); };
  mkText('name', e.tagAttrs.name, (v) => { e.tagAttrs.name = v; });
  mkText('article', e.tagAttrs.article, (v) => { e.tagAttrs.article = v; });
  mkText('plural', e.tagAttrs.plural, (v) => { e.tagAttrs.plural = v; });
  const al = document.createElement('div'); al.className = 'opRow'; al.innerHTML = '<span>attributes</span>'; box.appendChild(al);
  const list = document.createElement('div'); list.className = 'animBox';
  const drawAttrs = () => {
    list.innerHTML = '';
    e.attributes.forEach((a, i) => {
      const r = document.createElement('div'); r.className = 'animRow'; r.style.gridTemplateColumns = '1fr 1fr 22px';
      const k = document.createElement('input'); k.value = a.key; k.title = 'key'; k.setAttribute('list', 'attrKeys'); k.onchange = () => { a.key = k.value; };
      const v = document.createElement('input'); v.value = a.value; v.title = 'value'; v.onchange = () => { a.value = v.value; };
      const rm = document.createElement('button'); rm.className = 'expBtn'; rm.textContent = '✕'; rm.onclick = () => { e.attributes.splice(i, 1); drawAttrs(); };
      r.append(k, v, rm); list.appendChild(r);
    });
  };
  drawAttrs(); box.appendChild(list);
  const ITEM_ATTRS = ['weight', 'armor', 'attack', 'defense', 'extradef', 'slotType', 'weaponType', 'ammoType', 'shootType', 'range', 'decayTo', 'duration', 'charges', 'showcount', 'containerSize', 'fluidSource', 'writeable', 'readable', 'maxTextLen', 'rotateTo', 'levelDoor', 'corpseType', 'type', 'description', 'runeSpellName', 'magicpoints', 'hitChance', 'breakChance', 'manaShield', 'invisible', 'speed', 'healthGain', 'healthTicks', 'manaGain', 'manaTicks', 'skillSword', 'skillAxe', 'skillClub', 'skillDist', 'skillShield', 'skillFish', 'criticalHitChance', 'absorbPercentAll', 'absorbPercentFire', 'absorbPercentEnergy', 'absorbPercentPhysical', 'suppressDrunk', 'preventDrop', 'preventLoss', 'transformEquipTo', 'transformDeEquipTo', 'field'];
  const addSel = document.createElement('select'); addSel.style.fontSize = '11px'; const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '➕ atributo…'; addSel.appendChild(o0); for (const a of ITEM_ATTRS) { const o = document.createElement('option'); o.value = a; o.textContent = a; addSel.appendChild(o); } addSel.onchange = () => { if (!addSel.value) return; e.attributes.push({ key: addSel.value, value: '' }); addSel.value = ''; drawAttrs(); };
  box.appendChild(addSel);
  const add = document.createElement('button'); add.className = 'miniBtn'; add.textContent = '➕ custom';
  add.onclick = () => { e.attributes.push({ key: 'weight', value: '100' }); drawAttrs(); };
  const sv = document.createElement('button'); sv.className = 'miniBtn accent'; sv.textContent = '💾 Salvar items.xml';
  sv.onclick = () => {
    if (!confirm('Salvar items.xml?\n' + itemsXmlPath + '\n(backup .bak)')) return;
    try { backup(itemsXmlPath); IX.save(itemsXml, itemsXmlPath); $('status').textContent = 'items.xml salvo: ' + itemsXmlPath; }
    catch (err) { alert('Erro salvar items.xml: ' + err.message); }
  };
  const row = document.createElement('div'); row.className = 'insActs'; row.append(add, sv); box.appendChild(row);
  if (!document.getElementById('attrKeys')) { const dl = document.createElement('datalist'); dl.id = 'attrKeys'; COMMON_ATTRS.forEach((k) => { const o = document.createElement('option'); o.value = k; dl.appendChild(o); }); document.body.appendChild(dl); }
}
// IDs canônicos das PROPRIEDADES (têm valor) — separadas das FLAGS booleanas, igual o Object Builder.
// OB "Properties": Ground, Light, Minimap, Displacement, Elevation, Cloth, Market, Writable, WritableOnce, LensHelp.
const OBJ_PROP_CANONS = new Set([0, 21, 28, 24, 25, 34, 33, 8, 9, 32, 29, 38]);
// which: 'props' (só propriedades com valor) | 'flags' (só flags booleanas) | 'both'. box = elemento alvo.
function renderFlagEditor(t, box, which) {
  box = box || $('objFlags'); which = which || 'both';
  if (!box) return;
  box.innerHTML = '';
  const has = (c) => t._attrs.find((a) => a.canon === c);
  const renderRow = (fl, grid) => {
    if (fl.minV && datVersion < fl.minV) return;
    const a = has(fl.c);
    const row = document.createElement('div'); row.className = 'flagRow';
    const lab = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!a;
    if (fl.preserve) { cb.disabled = true; cb.title = 'dados complexos — preservado, não editável'; lab.append(cb, document.createTextNode(' ' + fl.n + (a ? ' ✓' : ''))); row.appendChild(lab); grid.appendChild(row); return; }
    cb.onchange = () => {
      objSnapshot();
      if (cb.checked) { if (!has(fl.c)) t._attrs.push({ op: VERS.inverseRemap(fl.c, datVersion), canon: fl.c, data: Buffer.alloc(fl.d || 0) }); }
      else t._attrs = t._attrs.filter((x) => x.canon !== fl.c);
      dat.applyAttrs(t); datDirty = true; updateDatSaveBtn();
      if (typeof liveOp === 'function' && objSel) liveOp('obj', 'flag', { cat: objCat, id: objSel.id, canon: fl.c, on: cb.checked, data: [] });
      renderFlagEditor(t, box, which);
      $('status').textContent = `${fl.n} ${cb.checked ? 'ON' : 'OFF'} (não salvo)`;
    };
    lab.append(cb, document.createTextNode(' ' + fl.n));
    row.appendChild(lab);
    if (fl.d > 0 && fl.f && a) {
      for (let fi = 0; fi < fl.f.length; fi++) {
        const inp = document.createElement('input'); inp.type = 'number'; inp.className = 'flagData'; inp.title = fl.f[fi]; inp.placeholder = fl.f[fi];
        inp.value = a.data.length >= (fi + 1) * 2 ? a.data.readUInt16LE(fi * 2) : 0;
        inp.onchange = () => { const aa = has(fl.c); if (!aa) return; aa.data.writeUInt16LE((parseInt(inp.value, 10) || 0) & 0xFFFF, fi * 2); dat.applyAttrs(t); datDirty = true; updateDatSaveBtn(); };
        row.appendChild(inp);
      }
    }
    grid.appendChild(row);
  };
  const section = (title, list) => {
    if (!list.length) return;
    const h = document.createElement('div'); h.className = 'opRow'; h.innerHTML = '<span><b>' + title + '</b></span>'; box.appendChild(h);
    const grid = document.createElement('div'); grid.className = 'flagBox'; box.appendChild(grid);
    for (const fl of list) renderRow(fl, grid);
  };
  // igual o OB: Properties (com valor) e Flags (booleanas) — mostradas separadas conforme `which`
  if (which === 'props' || which === 'both') section('Properties', OBJ_FLAGS.filter((fl) => OBJ_PROP_CANONS.has(fl.c)));
  if (which === 'flags' || which === 'both') section('Flags', OBJ_FLAGS.filter((fl) => !OBJ_PROP_CANONS.has(fl.c)));
  if (which === 'flags' || which === 'both') { const others = t._attrs.filter((a) => !OBJ_FLAGS.some((f) => f.c === a.canon)).map((a) => a.canon); if (others.length) { const o = document.createElement('div'); o.className = 'alabel'; o.style.cssText = 'font-size:10px;margin-top:4px'; o.textContent = '(preservadas: ' + others.join(', ') + ')'; box.appendChild(o); } }
}
function saveDat() {
  if (!dat || !datPath) return alert('.dat não carregado');
  if (!datDirty) return alert('nenhuma alteração no .dat');
  if (!confirm(`Salvar alterações no .dat?\n${datPath}\n(backup .bak criado)`)) return;
  try {
    backup(datPath);
    dat.compile(datPath);
    dat = new Dat(datPath, datOpts());
    datDirty = false; updateDatSaveBtn();
    renderObjGrid(); if (objSel) selectObjThing(objSel.id);
    $('status').textContent = '.dat salvo: ' + datPath;
  } catch (e) { alert('Erro ao salvar .dat: ' + e.message); }
}
async function replaceSprite(sid) {
  const f = await ipcRenderer.invoke('pick-file', ['png']);
  if (!f) return;
  await loadPng32(f, (rgba) => { sprEdits.set(sid, rgba); if (spr && spr.cache) spr.cache.set(sid, rgba); });
  invalidateSprites(); updateObjSaveBtn(); if (objSel) selectObjThing(objSel.id); renderObjGrid();
  $('status').textContent = `sprite ${sid} trocado (não salvo) — clique 💾 Salvar .spr`;
}
// Converte canvas para Uint8Array PNG usando atob (Buf.from ignora 'base64' no shim)
function canvasToPngBytes(cv) {
  const b64 = cv.toDataURL('image/png').split(',')[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
// Igual OB: preenche fundo com magenta (0xFF00FF) nos pixels transparentes antes de exportar PNG
function canvasWithMagentaBg(src) {
  const cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#FF00FF'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(src, 0, 0);
  return cv;
}

async function exportSprite(sid) {
  if (!spr) return;
  const px = spr.sprite(sid);
  if (!px) return alert('sprite vazio');
  const f = await ipcRenderer.invoke('save-file', `sprite_${sid}.png`);
  if (!f) return;
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  c.getContext('2d').putImageData(new ImageData(px, 32, 32), 0, 0);
  try { fsp.writeFileSync(f, canvasToPngBytes(c)); $('status').textContent = 'exportado: ' + f; }
  catch (e) { alert(e.message); }
}
async function saveSpr() {
  if (!spr || !sprPath) return alert('.spr não carregado');
  if (sprEdits.size === 0 && !pendingSprKept) return alert('nenhum sprite alterado');
  const newCount = pendingSprKept ? pendingSprKept.length : (spr.count + sprAddedCount);
  const statusEl = $('status');
  statusEl.textContent = '⏳ Salvando .spr…';
  try {
    const tmp = sprPath + '.tmp';
    // serializa edits para o Rust (arrays simples, transferíveis via IPC)
    const editsIds = [], editsRgba = [];
    for (const [id, rgba] of sprEdits) { editsIds.push(id); editsRgba.push(Array.from(rgba)); }
    const inv = window.__TAURI__.core.invoke;
    // garante que o handle Rust está aberto ANTES de mexer em arquivos. Se falhar aqui,
    // aborta limpo (sem criar .bak nem apagar nada) e mostra a CAUSA real.
    try {
      await inv('spr_open', { path: sprPath, ...sprOpts() });
    } catch (e) {
      throw new Error('não consegui abrir o .spr p/ salvar: ' + (e && e.message || e) +
        '\n\nDica: confira os toggles "Extended" e "Transparency" no menu ⚙ Formato — se não baterem com o arquivo, recarregue o .spr antes de salvar.');
    }
    // 1) backup awaited (garante que o arquivo não está sendo copiado durante o rename)
    try { await inv('copy_path', { from: sprPath, to: sprPath + '.bak' }); } catch (e) {}
    // 2) escreve tmp + fecha handle do original no Rust
    await inv('spr_save', { outPath: tmp, editsIds, editsRgba, newCount });
    // 3) deleta o original e 4) renomeia tmp → final. Se o rename falhar, RESTAURA do .bak
    //    pra NUNCA ficar sem o .spr (era o que deixava "arquivo não encontrado" nos próximos saves).
    await inv('rm_path', { path: sprPath });
    try {
      await inv('rename_path', { from: tmp, to: sprPath });
    } catch (e) {
      try { await inv('copy_path', { from: sprPath + '.bak', to: sprPath }); } catch (x) {}
      throw new Error('falha ao gravar o .spr (' + (e && e.message || e) + '). O backup .bak foi restaurado — recarregue o .spr e tente de novo.');
    }
    // 4) reabre o novo arquivo no Rust + atualiza wrapper JS
    const savedCount = await inv('spr_open', { path: sprPath, ...sprOpts() });
    pendingSprKept = null;
    spr.cache.clear(); spr.comp.clear(); spr._queue.clear();
    spr.count = savedCount;
    sprEdits.clear(); sprAddedCount = 0; updateObjSaveBtn();
    renderObjGrid(); if (objSel) selectObjThing(objSel.id);
    statusEl.textContent = '.spr salvo: ' + sprPath;
  } catch (e) { alert('Erro ao salvar .spr: ' + e); statusEl.textContent = 'Erro ao salvar .spr'; }
}

// importa um .obd (cria thing + adiciona sprites) ou .png (adiciona sprite)
async function importObd(file) {
  if (!dat || !spr) return alert('carregue .dat/.spr primeiro');
  let data;
  try { data = await OBD.decodeFile(file); } catch (e) { return alert('OBD inválido: ' + e.message); }
  // importa TODOS os grupos (idle + walk) com seus sprites reais
  let totalSprites = 0;
  const groups = data.groups.map((g) => {
    const newIds = [];
    for (const rgba of g.sprites) {
      const id = spr.count + (++sprAddedCount);
      sprEdits.set(id, rgba);
      if (spr.cache) spr.cache.set(id, rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba));
      newIds.push(id);
    }
    totalSprites += newIds.length;
    return { ...g, sprites: newIds };
  });
  const r = dat.addFull(data.category, data.attrs, groups);
  datDirty = true; updateDatSaveBtn(); updateObjSaveBtn();
  objCat = data.category;
  document.querySelectorAll('.objCat').forEach((x) => x.classList.toggle('active', x.dataset.cat === objCat));
  gotoObjThing(r.id);
  $('status').textContent = `OBD importado → ${data.category} #${r.id} (${groups.length} grupo(s)) + ${totalSprites} sprite(s). 💾 Salvar .dat E .spr`;
}
// ---- Bulk edit de flags em vários things (multi-seleção) ----
function bulkEditFlags() {
  const ids = selectedIds();
  if (ids.length < 1) return alert('selecione thing(s) — Ctrl/Shift+clique ou ☑ Tudo');
  const ov = document.createElement('div'); ov.className = 'modal';
  const box = document.createElement('div'); box.className = 'modalBox';
  box.innerHTML = `<h3>Editar flags em ${ids.length} thing(s)</h3><div class="alabel" style="font-size:11px">— deixa como está · ✓ liga · ✗ desliga. Só flags sem dados.</div>`;
  const grid = document.createElement('div'); grid.className = 'flagBox'; box.appendChild(grid);
  const states = {};
  for (const fl of OBJ_FLAGS) {
    if (fl.preserve || (fl.minV && datVersion < fl.minV)) continue;
    const row = document.createElement('div'); row.className = 'flagRow';
    const sel = document.createElement('select'); sel.innerHTML = '<option value="">—</option><option value="on">✓ ligar</option><option value="off">✗ desligar</option>';
    states[fl.c] = sel;
    row.append(sel, document.createTextNode(' ' + fl.n)); grid.appendChild(row);
  }
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const ap = document.createElement('button'); ap.className = 'miniBtn accent'; ap.textContent = 'Aplicar';
  ap.onclick = () => {
    let n = 0;
    for (const id of ids) {
      const t = dat.category(objCat).get(id); if (!t) continue;
      let ch = false;
      for (const fl of OBJ_FLAGS) {
        const s = states[fl.c]; if (!s || !s.value) continue;
        const hasIt = t._attrs.some((a) => a.canon === fl.c);
        if (s.value === 'on' && !hasIt) { t._attrs.push({ op: VERS.inverseRemap(fl.c, datVersion), canon: fl.c, data: Buffer.alloc(fl.d || 0) }); ch = true; }
        else if (s.value === 'off' && hasIt) { t._attrs = t._attrs.filter((a) => a.canon !== fl.c); ch = true; }
      }
      if (ch) { dat.applyAttrs(t); n++; }
    }
    datDirty = true; updateDatSaveBtn(); renderObjGrid(); if (objSel) selectObjThing(objSel.id);
    ov.remove(); $('status').textContent = `flags aplicadas em ${n} thing(s) — 💾 Salvar .dat`;
  };
  const cl = document.createElement('button'); cl.className = 'miniBtn'; cl.textContent = 'cancelar'; cl.onclick = () => ov.remove();
  foot.append(ap, cl); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// ---- Compile-As: salva .dat/.spr em novo caminho (opção: converter versão) ----
async function compileAs() {
  if (!dat || !spr) return alert('carregue .dat/.spr');
  const conv = prompt(`Salvar como — versão de destino (cliente).\nAtual: ${datVersion}. Deixe igual p/ não converter, ou ex: 1057, 1098, 770…`, String(datVersion));
  if (conv === null) return;
  const target = parseInt(conv, 10) || datVersion;
  const f = await ipcRenderer.invoke('save-file', 'Tibia.dat');
  if (!f) return;
  const base = f.replace(/\.dat$/i, '');
  try {
    if (target !== datVersion) {
      const warn = dat.convertTo(target);
      if (warn.length && !confirm('Conversão ' + datVersion + '→' + target + ':\n- ' + warn.join('\n- ') + '\n\nContinuar?')) return;
    }
    dat.compile(base + '.dat');
    SprW.compileSpr(spr, base + '.spr', sprEdits, spr.count + sprAddedCount);
    $('status').textContent = `salvo como ${base}.dat + .spr` + (target !== datVersion ? ` (convertido p/ ${target})` : '');
    if (target !== datVersion) { datVersion = target; }
  } catch (e) { alert('Erro compile-as: ' + e.message); }
}
// ---- Merge: anexa things+sprites de outro .dat/.spr ----
async function mergeDat() {
  if (!dat || !spr) return alert('carregue .dat/.spr base primeiro');
  const df = await ipcRenderer.invoke('pick-file', ['dat']); if (!df) return;
  const sf = await ipcRenderer.invoke('pick-file', ['spr']); if (!sf) return;
  try {
    const od = new Dat(df, datOpts()); const os = new Spr(sf, datOpts());
    let things = 0, sprites = 0;
    for (const cat of ['items', 'outfits', 'effects', 'missiles']) {
      for (const t of od.category(cat).values()) {
        const groups = t._groups.map((g, gi) => {
          const ng = dat._normGroup(g, gi);
          ng.sprites = g.sprites.map((sid) => { const rgba = os.sprite(sid); if (!rgba) return 0; const nid = spr.count + (++sprAddedCount); sprEdits.set(nid, rgba); sprites++; return nid; });
          return ng;
        });
        dat.addFull(cat, t._attrs, groups); things++;
      }
    }
    if (os.close) os.close();
    datDirty = true; updateDatSaveBtn(); updateObjSaveBtn(); renderObjGrid();
    $('status').textContent = `merge: +${things} things, +${sprites} sprites — 💾 Salvar .dat E .spr`;
  } catch (e) { alert('Erro merge: ' + e.message); }
}
// ---- New: cria .dat/.spr novos (mínimo válido) a partir do dat aberto ----
async function newDatSpr() {
  if (!dat || !spr) return alert('abra um .dat/.spr base primeiro (define versão/assinatura)');
  if (!confirm('Criar projeto NOVO em branco?\nGera .dat com 1 item/outfit/effect/missile em branco + .spr com 1 sprite vazio, na versão atual.')) return;
  const f = await ipcRenderer.invoke('save-file', 'Tibia.dat'); if (!f) return;
  const base = f.replace(/\.dat$/i, '');
  try {
    const nd = new Dat(datPath, datOpts()); // clona estrutura
    // esvazia: mantém só id mínimo de cada categoria, em branco
    nd.itemCount = 100; nd.creatureCount = 1; nd.effectCount = 1; nd.missileCount = 1;
    nd.items = new Map(); nd.outfits = new Map(); nd.effects = new Map(); nd.missiles = new Map();
    nd.items.set(100, nd._blankThing(false, 'items'));
    nd.outfits.set(1, nd._blankThing(true, 'outfits'));
    nd.effects.set(1, nd._blankThing(false, 'effects'));
    nd.missiles.set(1, nd._blankThing(false, 'missiles'));
    nd.compile(base + '.dat');
    // .spr com 1 sprite vazio
    const blankSpr = { ext: spr.ext, signature: spr.signature, transparency: spr.transparency, count: 1, getCompressed: () => null };
    SprW.compileSpr(blankSpr, base + '.spr', new Map(), 1);
    $('status').textContent = `projeto novo criado: ${base}.dat + .spr — abra-o p/ editar`;
  } catch (e) { alert('Erro novo projeto: ' + e.message); }
}
// ---- Compare: dois things lado a lado (props/geometria) ----
function compareThings() {
  const ids = selectedIds();
  if (ids.length !== 2) return alert('selecione EXATAMENTE 2 things (Ctrl+clique) p/ comparar');
  const [a, b] = ids.map((id) => dat.category(objCat).get(id));
  const ov = document.createElement('div'); ov.className = 'modal';
  const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '520px';
  const fld = (t) => ({ w: t.width, h: t.height, layers: t.layers, px: t.px, py: t.py, pz: t.pz, frames: t.frames, grupos: t._groups.length, flags: t._attrs.map((x) => x.canon).sort((m, n) => m - n).join(',') });
  const fa = fld(a), fb = fld(b);
  let rows = '';
  for (const k of Object.keys(fa)) { const eq = String(fa[k]) === String(fb[k]); rows += `<div class="opRow" style="${eq ? '' : 'background:#3a2230'}"><span>${k}</span><b>${fa[k]}</b><b style="margin-left:8px">${fb[k]}</b></div>`; }
  box.innerHTML = `<h3>Comparar #${ids[0]} ⟷ #${ids[1]}</h3>${rows}<div class="modalFoot"><button class="miniBtn" id="cmpClose">fechar</button></div>`;
  ov.appendChild(box); document.body.appendChild(ov);
  box.querySelector('#cmpClose').onclick = () => ov.remove();
}
// ---- Slicer interativo: carrega PNG, célula configurável, seleção com mouse ----
async function slicePng() {
  if (!spr) return alert('carregue .spr');
  const file = await ipcRenderer.invoke('pick-file', ['png']); if (!file) return;
  const img = await loadPngImage(file); if (!img) return;
  {
    const ov = document.createElement('div'); ov.className = 'modal';
    const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '90vw';
    box.innerHTML = `<h3>Slicer — ${file.split(/[\\/]/).pop()} (${img.width}×${img.height})</h3>`;
    const ctrls = document.createElement('div'); ctrls.className = 'animQuick';
    const mkN = (lbl, v) => { ctrls.appendChild(document.createTextNode(lbl)); const i = document.createElement('input'); i.type = 'number'; i.value = v; i.min = 1; i.style.width = '54px'; ctrls.appendChild(i); return i; };
    const cw = mkN('célula W:', 32), chh = mkN(' H:', 32), mx = mkN(' margem X:', 0), my = mkN(' Y:', 0);
    box.appendChild(ctrls);
    const hint = document.createElement('div'); hint.className = 'alabel'; hint.style.cssText = 'font-size:11px;margin:4px 0'; hint.textContent = 'arraste p/ selecionar área (vazio = imagem toda). células viram sprites 32×32.';
    box.appendChild(hint);
    const wrap = document.createElement('div'); wrap.style.cssText = 'max-height:60vh;overflow:auto;border:1px solid #333';
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; cv.style.cssText = 'image-rendering:pixelated;cursor:crosshair;display:block';
    const ctx = cv.getContext('2d');
    let sel = null, down = false, sx = 0, sy = 0;
    const redraw = () => {
      ctx.clearRect(0, 0, cv.width, cv.height); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0);
      const W = +cw.value || 32, H = +chh.value || 32, ox = +mx.value || 0, oy = +my.value || 0;
      ctx.strokeStyle = 'rgba(91,140,255,.5)'; ctx.lineWidth = 1;
      for (let xx = ox; xx <= img.width; xx += W) { ctx.beginPath(); ctx.moveTo(xx + .5, 0); ctx.lineTo(xx + .5, img.height); ctx.stroke(); }
      for (let yy = oy; yy <= img.height; yy += H) { ctx.beginPath(); ctx.moveTo(0, yy + .5); ctx.lineTo(img.width, yy + .5); ctx.stroke(); }
      if (sel) { ctx.strokeStyle = '#3fcf7a'; ctx.lineWidth = 2; ctx.strokeRect(sel.x, sel.y, sel.w, sel.h); }
    };
    cv.onmousedown = (e) => { const r = cv.getBoundingClientRect(); down = true; sx = e.clientX - r.left; sy = e.clientY - r.top; sel = null; };
    cv.onmousemove = (e) => { if (!down) return; const r = cv.getBoundingClientRect(); const ex = e.clientX - r.left, ey = e.clientY - r.top; sel = { x: Math.min(sx, ex), y: Math.min(sy, ey), w: Math.abs(ex - sx), h: Math.abs(ey - sy) }; redraw(); };
    window.addEventListener('mouseup', () => { down = false; });
    [cw, chh, mx, my].forEach((i) => i.oninput = redraw);
    wrap.appendChild(cv); box.appendChild(wrap); redraw();
    const foot = document.createElement('div'); foot.className = 'modalFoot';
    const go = document.createElement('button'); go.className = 'miniBtn accent'; go.textContent = '✂ Fatiar → sprites';
    go.onclick = () => {
      const W = +cw.value || 32, H = +chh.value || 32, ox = +mx.value || 0, oy = +my.value || 0;
      const rx = sel ? sel.x : ox, ry = sel ? sel.y : oy, rw = sel ? sel.w : img.width - ox, rh = sel ? sel.h : img.height - oy;
      let n = 0; const ids = [];
      for (let yy = ry; yy + H <= ry + rh + 1 && yy + H <= img.height; yy += H) for (let xx = rx; xx + W <= rx + rw + 1 && xx + W <= img.width; xx += W) {
        const cell = document.createElement('canvas'); cell.width = 32; cell.height = 32; const cc = cell.getContext('2d'); cc.imageSmoothingEnabled = false;
        cc.drawImage(cv, xx, yy, W, H, 0, 0, 32, 32);
        const nid = spr.count + (++sprAddedCount); sprEdits.set(nid, new Uint8ClampedArray(cc.getImageData(0, 0, 32, 32).data)); ids.push(nid); n++;
      }
      updateObjSaveBtn(); ov.remove();
      $('status').textContent = n ? `slicer: ${n} sprites criados (ids ${ids[0]}–${ids[n - 1]}) — 💾 Salvar .spr` : 'nada fatiado';
    };
    const cl = document.createElement('button'); cl.className = 'miniBtn'; cl.textContent = 'fechar'; cl.onclick = () => ov.remove();
    foot.append(go, cl); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
  }
}
let pendingSprKept = null; // remap pendente p/ saveSpr (compactação)
// ---- Preferências ----
function openPreferences() {
  const ov = document.createElement('div'); ov.className = 'modal';
  const box = document.createElement('div'); box.className = 'modalBox';
  box.innerHTML = '<h3>⚙ Preferências</h3>';
  const r1 = document.createElement('label'); r1.className = 'opRow'; r1.innerHTML = '<span>sprites por página</span>';
  const pp = document.createElement('input'); pp.type = 'number'; pp.min = 50; pp.max = 2000; pp.value = OBJ_PER_PAGE; pp.style.width = '80px'; r1.appendChild(pp); box.appendChild(r1);
  const r2 = document.createElement('label'); r2.className = 'opRow'; r2.innerHTML = '<span>animar preview (inspector)</span>';
  const an = document.createElement('input'); an.type = 'checkbox'; an.checked = prefPreviewAnim; r2.appendChild(an); box.appendChild(r2);
  const r3 = document.createElement('label'); r3.className = 'opRow'; r3.innerHTML = '<span>animar tiles na grade</span>';
  const ag = document.createElement('input'); ag.type = 'checkbox'; ag.checked = prefAnimateGrid; r3.appendChild(ag); box.appendChild(r3);
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const sv = document.createElement('button'); sv.className = 'miniBtn accent'; sv.textContent = 'salvar';
  sv.onclick = () => {
    OBJ_PER_PAGE = Math.max(50, Math.min(2000, parseInt(pp.value, 10) || 300)); localStorage.setItem('objPerPage', OBJ_PER_PAGE);
    prefPreviewAnim = an.checked; localStorage.setItem('previewAnim', prefPreviewAnim ? '1' : '0');
    prefAnimateGrid = ag.checked; localStorage.setItem('animateGrid', prefAnimateGrid ? '1' : '0');
    objPage = 0; renderObjGrid(); if (objSel) selectObjThing(objSel.id);
    ov.remove(); $('status').textContent = 'preferências salvas';
  };
  const cl = document.createElement('button'); cl.className = 'miniBtn'; cl.textContent = 'fechar'; cl.onclick = () => ov.remove();
  foot.append(sv, cl); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// ---- sprite hash (igual SpriteStorage.getSpriteHash do Object Builder) ----
const _crypto = require('crypto');
// RGB 32x32 (linha-a-linha, transparente=0x11) igual Sprite.getRGBData do OB.
// usa os runs RLE (getCompressed) p/ honrar pixels coloridos c/ alpha 0; fallback RGBA p/ editados.
function spriteRGBForHash(sid) {
  const rgb = new Uint8Array(3072).fill(0x11);
  if (!sid) return rgb;
  if (sprEdits.has(sid)) { // sprite editado: usa RGBA (alpha 0 = transparente)
    const px = sprEdits.get(sid);
    for (let p = 0; p < 1024; p++) { if (px[p * 4 + 3] !== 0) { const o = p * 3; rgb[o] = px[p * 4]; rgb[o + 1] = px[p * 4 + 1]; rgb[o + 2] = px[p * 4 + 2]; } }
    return rgb;
  }
  const comp = spr ? spr.getCompressed(sid) : null;
  if (!comp || comp.length === 0) return rgb;
  const bpp = spr.transparency ? 4 : 3;
  let read = 0, write = 0; const len = comp.length;
  while (read + 4 <= len && write < 1024) {
    const tr = comp.readUInt16LE(read); read += 2;
    const co = comp.readUInt16LE(read); read += 2;
    write += tr; // run transparente: deixa 0x11
    for (let j = 0; j < co && write < 1024; j++) { const o = write * 3; rgb[o] = comp[read]; rgb[o + 1] = comp[read + 1]; rgb[o + 2] = comp[read + 2]; read += bpp; write++; }
  }
  return rgb;
}
function computeSpriteHash(group) {
  const n = group.width * group.height * group.layers; // só DEFAULT: w*h*layers (frame 0, pattern 0)
  const stream = Buffer.alloc(n * 32 * 32 * 4);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const rgb = spriteRGBForHash(group.sprites[i]);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const sp = (31 - y) * 96 + x * 3; // flip vertical
      stream[o++] = rgb[sp + 2]; stream[o++] = rgb[sp + 1]; stream[o++] = rgb[sp]; stream[o++] = 0; // BGR0
    }
  }
  return _crypto.createHash('md5').update(stream).digest(); // Buffer 16 bytes
}
// recalcula o spriteHash (0x20) de todos os itens do otb a partir dos sprites do client
function recomputeHashes() {
  if (!ensureOtbFull() || !dat || !spr) return alert('carregue .dat/.spr/.otb');
  if (!confirm('Recalcular sprite hashes de todos os itens do otb?\n(usa os sprites atuais do client; depois 💾 Salvar items.otb)')) return;
  let n = 0;
  for (const [sid, node] of otbItemIdx) {
    const ip = OTB.parseItemProps(node.props);
    const cidA = OTB.getAttr(ip, OTB.ATTR_CLIENTID); const cid = cidA ? cidA.readUInt16LE(0) : sid;
    const t = dat.items.get(cid); if (!t) continue;
    const g = t._groups[0];
    OTB.setBytesAttr(ip, OTB.ATTR_SPRITEHASH, computeSpriteHash(g));
    node.props = OTB.buildItemProps(ip.flags, ip.attrs); n++;
  }
  $('status').textContent = `${n} sprite hashes recalculados (não salvo) — 💾 Salvar items.otb`;
}
// ---- salvar items.otb (binário) ----
function saveOtbFile() {
  if (!ensureOtbFull() || !otbPath) return alert('items.otb não carregado');
  if (!confirm('Salvar items.otb?\n' + otbPath + '\n(backup .bak)')) return;
  try { backup(otbPath); OTB.saveOtb(otbFull, otbPath); otbMap = loadOtb(otbPath); rebuildOtbInv(); $('status').textContent = 'items.otb salvo: ' + otbPath; }
  catch (e) { alert('Erro salvar otb: ' + e.message); }
}
// ---- criar entradas otb faltantes (serverIds do items.xml sem nó no otb) ----
function createMissingOtb() {
  if (!ensureOtbFull() || !otbItemIdx) return alert('items.otb não carregado');
  if (!itemsXml || !itemsXmlIdx) return alert('items.xml não carregado');
  const missing = [];
  for (const sid of itemsXmlIdx.keys()) if (!otbItemIdx.has(sid)) missing.push(sid);
  if (!missing.length) return alert('nenhum item do items.xml está faltando no otb 👍');
  if (!confirm(`Criar ${missing.length} item(ns) no items.otb (serverId=clientId)?\nDepois 💾 Salvar items.otb.`)) return;
  // tipo do nó: reusa o type de um item existente
  const sampleType = otbFull.root.children[0] ? otbFull.root.children[0].type : 0;
  for (const sid of missing) {
    const attrs = [];
    OTB.setU16Attr({ attrs }, OTB.ATTR_SERVERID, sid);
    OTB.setU16Attr({ attrs }, OTB.ATTR_CLIENTID, sid);
    const node = { type: sampleType, props: OTB.buildItemProps(0, attrs), children: [] };
    otbFull.root.children.push(node); otbItemIdx.set(sid, node);
  }
  $('status').textContent = `criados ${missing.length} itens no otb (não salvo) — 💾 Salvar items.otb`;
}
// ---- Frame Durations Optimizer: seta ms em massa em todos os things animados ----
function frameDurOptimizer() {
  if (!dat) return alert('carregue .dat');
  const ov = document.createElement('div'); ov.className = 'modal';
  const box = document.createElement('div'); box.className = 'modalBox';
  box.innerHTML = '<h3>Frame Durations Optimizer</h3><div class="alabel" style="font-size:11px">aplica a MESMA duração (ms) em todos os frames de todos os things animados.</div>';
  const inp = document.createElement('input'); inp.type = 'number'; inp.value = 100; inp.min = 1; inp.style.width = '90px';
  const scope = document.createElement('select'); scope.innerHTML = `<option value="${objCat}">só ${objCat}</option><option value="all">todas categorias</option>`;
  const row = document.createElement('div'); row.className = 'animQuick'; row.append(document.createTextNode('ms:'), inp, scope); box.appendChild(row);
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const ap = document.createElement('button'); ap.className = 'miniBtn accent'; ap.textContent = 'Aplicar';
  ap.onclick = () => {
    const ms = Math.max(1, parseInt(inp.value, 10) || 100);
    const cats = scope.value === 'all' ? ['items', 'outfits', 'effects', 'missiles'] : [scope.value];
    let n = 0;
    for (const cat of cats) for (const t of dat.category(cat).values()) {
      let touched = false;
      for (let gi = 0; gi < t._groups.length; gi++) {
        const g = t._groups[gi]; if (g.frames > 1) { dat.setAnimation(t, cat, { durations: Array(g.frames).fill(0).map(() => ({ min: ms, max: ms })) }, gi); touched = true; }
      }
      if (touched) n++;
    }
    datDirty = true; updateDatSaveBtn(); renderObjGrid(); if (objSel) selectObjThing(objSel.id);
    ov.remove(); $('status').textContent = `durações setadas (${ms}ms) em ${n} things — 💾 Salvar .dat`;
  };
  const cl = document.createElement('button'); cl.className = 'miniBtn'; cl.textContent = 'cancelar'; cl.onclick = () => ov.remove();
  foot.append(ap, cl); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// ---- Bulk Replace: substitui faixa de ids da categoria atual por things de outro .dat/.spr ----
async function bulkReplace() {
  if (!dat || !spr) return alert('carregue .dat/.spr base');
  const df = await ipcRenderer.invoke('pick-file', ['dat']); if (!df) return;
  const sf = await ipcRenderer.invoke('pick-file', ['spr']); if (!sf) return;
  const range = prompt('Faixa de ids no arquivo ORIGEM (ex: 100-150). Serão colados a partir do MESMO id na categoria atual:', '');
  if (!range) return;
  const mm = range.match(/(\d+)\s*-\s*(\d+)/); if (!mm) return alert('faixa inválida');
  const from = parseInt(mm[1], 10), to = parseInt(mm[2], 10);
  try {
    const od = new Dat(df, datOpts()); const os = new Spr(sf, datOpts());
    let n = 0, sprites = 0;
    for (let id = from; id <= to; id++) {
      const ot = od.category(objCat).get(id); if (!ot) continue;
      const groups = ot._groups.map((g, gi) => { const ng = dat._normGroup(g, gi); ng.sprites = g.sprites.map((sid) => { const rgba = os.sprite(sid); if (!rgba) return 0; const nid = spr.count + (++sprAddedCount); sprEdits.set(nid, rgba); sprites++; return nid; }); return ng; });
      const dst = dat.category(objCat).get(id);
      if (dst) { dat.setGroups(dst, objCat, groups); dst._attrs = ot._attrs.map((a) => ({ op: VERS.inverseRemap(a.canon, datVersion), canon: a.canon, data: Buffer.from(a.data) })); dat.applyAttrs(dst); }
      else dat.addFull(objCat, ot._attrs, groups);
      n++;
    }
    if (os.close) os.close();
    datDirty = true; updateDatSaveBtn(); updateObjSaveBtn(); renderObjGrid();
    $('status').textContent = `bulk replace: ${n} things (#${from}-#${to}), +${sprites} sprites — 💾 Salvar .dat E .spr`;
  } catch (e) { alert('Erro bulk replace: ' + e.message); }
}
// ---- Export ALL sprites (faixa) em PNG ----
async function exportAllSprites() {
  if (!spr) return alert('carregue .spr');
  const range = prompt(`Faixa de sprite ids p/ exportar (1-${spr.count}). Pode ser grande!`, `1-${Math.min(spr.count, 500)}`);
  if (!range) return;
  const mm = range.match(/(\d+)\s*-\s*(\d+)/); if (!mm) return alert('faixa inválida');
  const from = Math.max(1, parseInt(mm[1], 10)), to = Math.min(spr.count + sprAddedCount, parseInt(mm[2], 10));
  const dir = await ipcRenderer.invoke('pick-dir'); if (!dir) return;
  let n = 0;
  for (let id = from; id <= to; id++) {
    const px = sprEdits.get(id) || spr.sprite(id); if (!px) continue;
    const c = document.createElement('canvas'); c.width = 32; c.height = 32; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), 32, 32), 0, 0);
    fs.writeFileSync(path.join(dir, `sprite_${id}.png`), canvasToPngBytes(c)); n++;
    if (n % 200 === 0) $('status').textContent = `exportando sprites… ${n}`;
  }
  $('status').textContent = `${n} sprites exportados → ${dir}`;
}
// ---- Compactar sprites: remove não-referenciados + renumera (remoção real) ----
function compactSprites() {
  if (!dat || !spr) return alert('carregue .dat/.spr');
  if (!confirm('Compactar sprites?\nRemove sprites NÃO referenciados por nenhum thing e renumera todos os índices.\nDepois é obrigatório Salvar .dat E .spr juntos.')) return;
  const used = new Set();
  for (const cat of ['items', 'outfits', 'effects', 'missiles']) for (const t of dat.category(cat).values()) for (const g of t._groups) for (const s of g.sprites) if (s > 0) used.add(s);
  const kept = Array.from(used).sort((a, b) => a - b);
  const map = new Map(); kept.forEach((old, k) => map.set(old, k + 1));
  let n = 0;
  for (const cat of ['items', 'outfits', 'effects', 'missiles']) for (const t of dat.category(cat).values()) for (const g of t._groups) for (let i = 0; i < g.sprites.length; i++) { const o = g.sprites[i]; if (o > 0) { dat.setSpriteId(t, i, map.get(o) || 0, g); n++; } }
  pendingSprKept = kept;
  datDirty = true; updateDatSaveBtn(); updateObjSaveBtn(); renderObjGrid(); if (objSel) selectObjThing(objSel.id);
  $('status').textContent = `compactado: ${spr.count}→${kept.length} sprites, ${n} slots remapeados — 💾 Salvar .dat E .spr (juntos)`;
}
// ---- Object Viewer: preview de um .obd antes de importar ----
async function objectViewer() {
  const file = await ipcRenderer.invoke('pick-file', ['obd']); if (!file) return;
  let data; try { data = await OBD.decodeFile(file); } catch (e) { return alert('OBD inválido: ' + e.message); }
  let g = data.groups[0]; for (const x of data.groups) if (x.frames > g.frames) g = x;
  const ov = document.createElement('div'); ov.className = 'modal';
  const box = document.createElement('div'); box.className = 'modalBox';
  box.innerHTML = `<h3>Object Viewer — ${file.split(/[\\/]/).pop()}</h3>
    <div class="opRow"><span>categoria</span><b>${data.category}</b></div>
    <div class="opRow"><span>geometria</span><b>${g.width}×${g.height} · ${g.frames}f · ${g.layers}L</b></div>
    <div class="opRow"><span>flags</span><b>${(data.attrs || []).map((a) => a.canon).join(',') || '—'}</b></div>`;
  const cv = document.createElement('canvas'); cv.width = 96; cv.height = 96; cv.style.cssText = 'image-rendering:pixelated;background:#1c2740;border-radius:6px';
  const ctx = cv.getContext('2d');
  const s = Math.max(1, Math.floor(96 / (Math.max(g.width, g.height) * 32)));
  // índice do grupo OBD (sprites planos): a=frame, layout w*h*layers*px*py*pz*frames
  const idxAt = (w, h, a) => ((((a * g.pz + 0) * g.py + 0) * g.px + 0) * g.layers + 0) * g.height * g.width + (h * g.width + w);
  let frame = 0;
  const drawFrame = () => {
    ctx.clearRect(0, 0, 96, 96);
    for (let w = 0; w < g.width; w++) for (let h = 0; h < g.height; h++) {
      const rgba = g.sprites[idxAt(w, h, frame)]; if (!rgba) continue;
      const off = document.createElement('canvas'); off.width = 32; off.height = 32; off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), 32, 32), 0, 0);
      ctx.imageSmoothingEnabled = false; ctx.drawImage(off, (g.width - 1 - w) * 32 * s, (g.height - 1 - h) * 32 * s, 32 * s, 32 * s);
    }
  };
  drawFrame();
  let timer = null;
  if (g.frames > 1) timer = setInterval(() => { frame = (frame + 1) % g.frames; drawFrame(); }, (g.durations && g.durations[frame] && g.durations[frame].min) || 200);
  box.appendChild(cv);
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const imp = document.createElement('button'); imp.className = 'miniBtn accent'; imp.textContent = '📥 Importar este'; imp.onclick = () => { if (timer) clearInterval(timer); ov.remove(); importObd(file); };
  const cl = document.createElement('button'); cl.className = 'miniBtn'; cl.textContent = 'fechar'; cl.onclick = () => { if (timer) clearInterval(timer); ov.remove(); };
  foot.append(imp, cl); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// ---- Sprites Optimizer: acha vazios + duplicados, remapeia duplicados (seguro, sem renumerar) ----
function optimizeSprites() {
  if (!spr || !dat) return alert('carregue .dat/.spr');
  const empties = [];
  const byHash = new Map();   // hashKey -> { id, buf }
  const dupOf = new Map();    // dupId -> canonicalId
  for (let id = 1; id <= spr.count; id++) {
    const buf = spr.getCompressed(id);
    if (!buf || buf.length === 0) { empties.push(id); continue; }
    let h = 2166136261; for (let i = 0; i < buf.length; i++) { h ^= buf[i]; h = (h * 16777619) >>> 0; }
    const key = h + ':' + buf.length;
    const prev = byHash.get(key);
    if (prev && Buffer.compare(prev.buf, buf) === 0) dupOf.set(id, prev.id);
    else if (!prev) byHash.set(key, { id, buf });
  }
  const ov = document.createElement('div'); ov.className = 'modal'; ov.id = 'optOverlay';
  const box = document.createElement('div'); box.className = 'modalBox';
  box.innerHTML = `<h3>Sprites Optimizer</h3>
    <div class="opRow"><span>total de sprites</span><b>${spr.count}</b></div>
    <div class="opRow"><span>vazios (sem pixel)</span><b>${empties.length}</b></div>
    <div class="opRow"><span>duplicados (conteúdo igual)</span><b>${dupOf.size}</b></div>
    <div class="alabel" style="font-size:11px;margin:6px 0">"Remapear duplicados" reaponta os slots dos things p/ o 1º sprite igual (seguro, não renumera nem apaga). Depois é só não referenciar os duplicados.</div>`;
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const apply = document.createElement('button'); apply.className = 'miniBtn accent'; apply.textContent = `🔧 Remapear ${dupOf.size} duplicados`;
  apply.disabled = dupOf.size === 0;
  apply.onclick = () => {
    let n = 0;
    for (const cat of ['items', 'outfits', 'effects', 'missiles']) {
      for (const t of dat.category(cat).values()) {
        for (const g of t._groups) {
          for (let i = 0; i < g.sprites.length; i++) {
            const canon = dupOf.get(g.sprites[i]);
            if (canon != null) { dat.setSpriteId(t, i, canon, g); n++; }
          }
        }
      }
    }
    datDirty = true; updateDatSaveBtn(); renderObjGrid(); if (objSel) selectObjThing(objSel.id);
    ov.remove(); $('status').textContent = `remapeados ${n} slots de sprite p/ canônicos — 💾 Salvar .dat`;
  };
  const close = document.createElement('button'); close.className = 'miniBtn'; close.textContent = 'fechar'; close.onclick = () => ov.remove();
  foot.append(apply, close); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// ---- editor de pixel (32x32) ----
// editor de pixel genérico — W×H (suporta sprite composto multi-tile, igual o Object Builder).
function pixelEditorUI(W, H, px0, title, onApply, navBuilder) {
  const px = new Uint8ClampedArray(px0);
  const Z = Math.max(4, Math.min(14, Math.floor(440 / Math.max(W, H)))); // zoom adapta ao tamanho (não corta sprite grande)
  let ov = document.getElementById('pxOverlay'); if (ov) ov.remove();
  ov = document.createElement('div'); ov.id = 'pxOverlay'; ov.className = 'modal';
  const box = document.createElement('div'); box.className = 'modalBox'; box.style.cssText = 'width:auto;max-width:94vw;max-height:94vh;overflow:auto';
  box.innerHTML = `<h3>${title}</h3>`;
  const cv = document.createElement('canvas'); cv.width = W * Z; cv.height = H * Z; cv.style.cssText = 'image-rendering:pixelated;border:1px solid #444;background:conic-gradient(#2a2a30 25%,#222 0 50%,#2a2a30 0 75%,#222 0) 0/16px 16px;cursor:crosshair';
  const ctx = cv.getContext('2d');
  const draw = () => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4, al = px[o + 3]; if (!al) continue; ctx.fillStyle = `rgba(${px[o]},${px[o + 1]},${px[o + 2]},${al / 255})`; ctx.fillRect(x * Z, y * Z, Z, Z); }
    if (gridChk.checked) {
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.20)';
      for (let i = 0; i <= W; i++) { ctx.beginPath(); ctx.moveTo(i * Z, 0); ctx.lineTo(i * Z, H * Z); ctx.stroke(); }
      for (let j = 0; j <= H; j++) { ctx.beginPath(); ctx.moveTo(0, j * Z); ctx.lineTo(W * Z, j * Z); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(120,200,255,.5)'; // guia de 8 em 8 px
      for (let i = 0; i <= W; i += 8) { ctx.beginPath(); ctx.moveTo(i * Z, 0); ctx.lineTo(i * Z, H * Z); ctx.stroke(); }
      for (let j = 0; j <= H; j += 8) { ctx.beginPath(); ctx.moveTo(0, j * Z); ctx.lineTo(W * Z, j * Z); ctx.stroke(); }
      if (W > 32 || H > 32) { ctx.strokeStyle = 'rgba(255,210,90,.65)'; ctx.lineWidth = 2; for (let i = 0; i <= W; i += 32) { ctx.beginPath(); ctx.moveTo(i * Z, 0); ctx.lineTo(i * Z, H * Z); ctx.stroke(); } for (let j = 0; j <= H; j += 32) { ctx.beginPath(); ctx.moveTo(0, j * Z); ctx.lineTo(W * Z, j * Z); ctx.stroke(); } } // divisória dos tiles 32×32
    }
  };
  const setPx = (mx, my) => { const x = Math.floor(mx / Z), y = Math.floor(my / Z); if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 4; if (eChk.checked) { px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0; } else { const c = hexToRgb(color.value); px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255; } draw(); };
  let down = false;
  cv.onmousedown = (e) => { down = true; const r = cv.getBoundingClientRect(); setPx(e.clientX - r.left, e.clientY - r.top); };
  cv.onmousemove = (e) => { if (!down) return; const r = cv.getBoundingClientRect(); setPx(e.clientX - r.left, e.clientY - r.top); };
  window.addEventListener('mouseup', () => { down = false; });
  const shift = (dx, dy, wrap) => { const nw = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let sx = x - dx, sy = y - dy; if (wrap) { sx = (sx + W) % W; sy = (sy + H) % H; } if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue; const so = (sy * W + sx) * 4, no = (y * W + x) * 4; nw[no] = px[so]; nw[no + 1] = px[so + 1]; nw[no + 2] = px[so + 2]; nw[no + 3] = px[so + 3]; } px.set(nw); draw(); };
  const tools = document.createElement('div'); tools.className = 'pxTools';
  const color = document.createElement('input'); color.type = 'color'; color.value = '#ff00ff'; color.title = 'cor';
  const eraser = document.createElement('label'); const eChk = document.createElement('input'); eChk.type = 'checkbox'; eraser.append(eChk, document.createTextNode(' borracha'));
  const gridL = document.createElement('label'); const gridChk = document.createElement('input'); gridChk.type = 'checkbox'; gridChk.checked = true; gridChk.onchange = draw; gridL.append(gridChk, document.createTextNode(' grade'));
  const wrapL = document.createElement('label'); const wrapChk = document.createElement('input'); wrapChk.type = 'checkbox'; wrapL.append(wrapChk, document.createTextNode(' wrap'));
  const mkBtn = (txt, fn, cls) => { const b = document.createElement('button'); b.className = 'miniBtn' + (cls ? ' ' + cls : ''); b.textContent = txt; b.onclick = fn; return b; };
  const arrows = document.createElement('div'); arrows.className = 'pxArrows';
  arrows.append(mkBtn('↑', () => shift(0, -1, wrapChk.checked)), mkBtn('↓', () => shift(0, 1, wrapChk.checked)), mkBtn('←', () => shift(-1, 0, wrapChk.checked)), mkBtn('→', () => shift(1, 0, wrapChk.checked)), mkBtn('limpar', () => { px.fill(0); draw(); }, 'danger'));
  tools.append(color, eraser, gridL, wrapL);
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  foot.append(mkBtn('💾 Aplicar', () => { onApply(px); ov.remove(); }, 'accent'), mkBtn('cancelar', () => ov.remove()));
  box.append(cv, tools, arrows);
  if (navBuilder) { const nav = navBuilder(() => onApply(px)); if (nav) box.appendChild(nav); } // troca direção/idle-walk/frame sem fechar
  box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
  draw();
}
// edita UM sprite (32×32)
function openPixelEditor(sid) {
  if (!spr) return;
  const base = sprEdits.get(sid) || spr.sprite(sid) || new Uint8ClampedArray(4096);
  pixelEditorUI(32, 32, base, `Editor de pixel — sprite #${sid}`, (px) => {
    sprEdits.set(sid, new Uint8ClampedArray(px)); if (spr.cache) spr.cache.set(sid, new Uint8ClampedArray(px)); invalidateSprites(); updateObjSaveBtn();
    if (typeof liveOp === 'function') liveOp('obj', 'pixel', { sid, rgba: Array.from(px) });
    if (objSel) selectObjThing(objSel.id); renderObjGrid(); $('status').textContent = `sprite ${sid} editado — 💾 Salvar .spr`;
  });
}
// edita o SPRITE COMPLETO de um frame (todos os tiles w×h juntos, igual o Object Builder) e re-fatia ao salvar
function openPixelEditorThing(t, gi, dir, frame) {
  if (!spr || !dat || !t) return;
  const W = t.width * 32, H = t.height * 32;
  const px = new Uint8ClampedArray(W * H * 4);
  const tiles = []; // {sid, ox, oy}
  for (let w = 0; w < t.width; w++) for (let h = 0; h < t.height; h++) {
    let idx; try { idx = dat.spriteIndex(t, w, h, 0, dir, 0, 0, frame); } catch (e) { idx = -1; }
    if (idx < 0 || idx >= t.sprites.length) continue;
    const sid = t.sprites[idx]; if (!sid) continue;
    const sp = sprEdits.get(sid) || spr.sprite(sid);
    const ox = (t.width - 1 - w) * 32, oy = (t.height - 1 - h) * 32; // mesma colocação do composeThing
    tiles.push({ sid, ox, oy });
    if (sp) for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const so = (y * 32 + x) * 4, no = ((oy + y) * W + (ox + x)) * 4; px[no] = sp[so]; px[no + 1] = sp[so + 1]; px[no + 2] = sp[so + 2]; px[no + 3] = sp[so + 3]; }
  }
  if (!tiles.length) return alert('frame sem sprites');
  const grp = (t._groups && t._groups[gi]) || t; const frames = Math.max(1, grp.frames || 1);
  const dlbl = ((objCat === 'outfits' || objCat === 'missiles') && t.px > 1) ? ' · ' + (DIR_LBL[dir] || dir) : '';
  const glbl = (t._groups && t._groups.length > 1) ? ' · ' + (grp.type === 1 ? 'walk' : 'idle') : '';
  pixelEditorUI(W, H, px, `Editor de pixel — ${objCat.replace(/s$/, '')} #${objSel ? objSel.id : ''} (${t.width}×${t.height})${dlbl}${glbl}${frames > 1 ? ' · frame ' + (frame + 1) + '/' + frames : ''}`, (out) => {
    for (const ts of tiles) {
      const sp = new Uint8ClampedArray(4096);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const no = ((ts.oy + y) * W + (ts.ox + x)) * 4, so = (y * 32 + x) * 4; sp[so] = out[no]; sp[so + 1] = out[no + 1]; sp[so + 2] = out[no + 2]; sp[so + 3] = out[no + 3]; }
      sprEdits.set(ts.sid, sp); if (spr.cache) spr.cache.set(ts.sid, new Uint8ClampedArray(sp));
      if (typeof liveOp === 'function') liveOp('obj', 'pixel', { sid: ts.sid, rgba: Array.from(sp) });
    }
    invalidateSprites(); updateObjSaveBtn(); if (objSel) selectObjThing(objSel.id); renderObjGrid(); $('status').textContent = `${tiles.length} sprite(s) do frame editado(s) — 💾 Salvar .spr`;
  }, (commit) => {
    // navegação DENTRO do editor: troca idle/walk, direção e frame sem fechar (salva o atual antes)
    const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:6px;align-items:center;justify-content:center;flex-wrap:wrap;margin-top:8px';
    const go = (ngi, ndir, nfr) => { commit(); objGroup = ngi; objDir = ndir; openPixelEditorThing(t, ngi, ndir, nfr); };
    const mk = (txt, fn, title) => { const b = document.createElement('button'); b.className = 'miniBtn'; b.textContent = txt; if (title) b.title = title; b.onclick = fn; return b; };
    if (t._groups && t._groups.length > 1) bar.appendChild(mk(grp.type === 1 ? '🏃 walk' : '🧍 idle', () => go((gi + 1) % t._groups.length, dir, 0), 'trocar idle/walk'));
    if ((objCat === 'outfits' || objCat === 'missiles') && t.px > 1) { const s = document.createElement('span'); s.className = 'alabel'; s.textContent = '🧭 ' + (DIR_LBL[dir] || dir); bar.append(mk('◀', () => go(gi, (dir + t.px - 1) % t.px, frame), 'direção anterior'), s, mk('▶', () => go(gi, (dir + 1) % t.px, frame), 'próxima direção')); }
    if (frames > 1) { const s = document.createElement('span'); s.className = 'alabel'; s.textContent = 'frame ' + (frame + 1) + '/' + frames; bar.append(mk('◀f', () => go(gi, dir, (frame + frames - 1) % frames)), s, mk('f▶', () => go(gi, dir, (frame + 1) % frames))); }
    return bar.children.length ? bar : null;
  });
}
// EDITOR DE PIXEL INLINE — pinta direto no preview central (igual o "Edit Pixels" do Object Builder)
function buildInlineEditor(ins, t, dir) {
  const gi = objGroup, grp = (t._groups && t._groups[gi]) || t, frames = Math.max(1, grp.frames || 1);
  let frame = Math.min(objEditFrame, frames - 1); if (frame < 0) frame = 0;
  const W = t.width * 32, H = t.height * 32;
  const px = new Uint8ClampedArray(W * H * 4), tiles = [];
  for (let w = 0; w < t.width; w++) for (let h = 0; h < t.height; h++) {
    let idx; try { idx = dat.spriteIndex(t, w, h, 0, dir, 0, 0, frame); } catch (e) { idx = -1; }
    if (idx < 0 || idx >= t.sprites.length) continue;
    const sid = t.sprites[idx]; if (!sid) continue;
    const sp = sprEdits.get(sid) || (spr && spr.sprite(sid));
    const ox = (t.width - 1 - w) * 32, oy = (t.height - 1 - h) * 32; tiles.push({ sid, ox, oy });
    if (sp) for (let y = 0; y < 32; y++) for (let xx = 0; xx < 32; xx++) { const so = (y * 32 + xx) * 4, no = ((oy + y) * W + (ox + xx)) * 4; px[no] = sp[so]; px[no + 1] = sp[so + 1]; px[no + 2] = sp[so + 2]; px[no + 3] = sp[so + 3]; }
  }
  const Z = Math.max(3, Math.min(12, Math.floor(360 / Math.max(W, H, 32)))) * objMainZoom; // respeita o Zoom do topo
  const cv = document.createElement('canvas'); cv.width = W * Z; cv.height = H * Z; cv.className = 'inlinePxCv'; const ctx = cv.getContext('2d');
  const draw = () => {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) { const o = (y * W + xx) * 4, al = px[o + 3]; if (!al) continue; ctx.fillStyle = `rgba(${px[o]},${px[o + 1]},${px[o + 2]},${al / 255})`; ctx.fillRect(xx * Z, y * Z, Z, Z); }
    if (objEditGrid) {
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.18)';
      for (let i = 0; i <= W; i++) { ctx.beginPath(); ctx.moveTo(i * Z, 0); ctx.lineTo(i * Z, H * Z); ctx.stroke(); }
      for (let j = 0; j <= H; j++) { ctx.beginPath(); ctx.moveTo(0, j * Z); ctx.lineTo(W * Z, j * Z); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(120,200,255,.45)'; for (let i = 0; i <= W; i += 8) { ctx.beginPath(); ctx.moveTo(i * Z, 0); ctx.lineTo(i * Z, H * Z); ctx.stroke(); } for (let j = 0; j <= H; j += 8) { ctx.beginPath(); ctx.moveTo(0, j * Z); ctx.lineTo(W * Z, j * Z); ctx.stroke(); }
      if (W > 32 || H > 32) { ctx.strokeStyle = 'rgba(255,210,90,.6)'; ctx.lineWidth = 2; for (let i = 0; i <= W; i += 32) { ctx.beginPath(); ctx.moveTo(i * Z, 0); ctx.lineTo(i * Z, H * Z); ctx.stroke(); } for (let j = 0; j <= H; j += 32) { ctx.beginPath(); ctx.moveTo(0, j * Z); ctx.lineTo(W * Z, j * Z); ctx.stroke(); } }
    }
  };
  const commit = () => {
    for (const ts of tiles) { const sp = new Uint8ClampedArray(4096); for (let y = 0; y < 32; y++) for (let xx = 0; xx < 32; xx++) { const no = ((ts.oy + y) * W + (ts.ox + xx)) * 4, so = (y * 32 + xx) * 4; sp[so] = px[no]; sp[so + 1] = px[no + 1]; sp[so + 2] = px[no + 2]; sp[so + 3] = px[no + 3]; } sprEdits.set(ts.sid, sp); if (spr && spr.cache) spr.cache.set(ts.sid, new Uint8ClampedArray(sp)); if (typeof liveOp === 'function') liveOp('obj', 'pixel', { sid: ts.sid, rgba: Array.from(sp) }); }
    invalidateSprites(); updateObjSaveBtn();
    const ipv = $('objInfoPrev'); if (ipv) { _anims.delete(ipv); drawScaled(ipv, composeG(t, gi, dir, 0)); applyObjPrevZoom(); }
    $('status').textContent = `✏️ editando inline — 💾 Salvar .spr (${sprEdits.size})`;
  };
  // paintLog guarda o valor ORIGINAL dos pixels pintados na "rajada" atual → permite desfazer no duplo-clique
  const paintLog = new Map();
  const setPx = (mx, my) => { const xx = Math.floor(mx / Z), y = Math.floor(my / Z); if (xx < 0 || y < 0 || xx >= W || y >= H) return; const o = (y * W + xx) * 4; if (!paintLog.has(o)) paintLog.set(o, [px[o], px[o + 1], px[o + 2], px[o + 3]]); if (objEditErase) { px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0; } else { const c = hexToRgb(objEditColor); px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255; } draw(); };
  let down = false, lastDownT = 0;
  cv.onmousedown = (e) => { const now = performance.now(); if (now - lastDownT > 400) paintLog.clear(); lastDownT = now; down = true; const r = cv.getBoundingClientRect(); setPx(e.clientX - r.left, e.clientY - r.top); };
  cv.onmousemove = (e) => { if (!down) return; const r = cv.getBoundingClientRect(); setPx(e.clientX - r.left, e.clientY - r.top); };
  const up = () => { if (down) { down = false; commit(); } }; cv.onmouseup = up; cv.onmouseleave = up;
  // duplo-clique: DESFAZ o que os cliques pintaram e navega pra peça no painel direito (não deixa pintado)
  cv.ondblclick = (e) => { if (paintLog.size) { for (const [o, v] of paintLog) { px[o] = v[0]; px[o + 1] = v[1]; px[o + 2] = v[2]; px[o + 3] = v[3]; } paintLog.clear(); draw(); commit(); } const r = cv.getBoundingClientRect(); const sid = previewTileSid(t, dir, frame, (e.clientX - r.left) / Z, (e.clientY - r.top) / Z); if (sid) gotoSprite(sid); };
  const shift = (dx, dy) => { const nw = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) { let sx = xx - dx, sy = y - dy; if (objEditWrap) { sx = (sx + W) % W; sy = (sy + H) % H; } if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue; const so = (sy * W + sx) * 4, no = (y * W + xx) * 4; nw[no] = px[so]; nw[no + 1] = px[so + 1]; nw[no + 2] = px[so + 2]; nw[no + 3] = px[so + 3]; } px.set(nw); draw(); commit(); };
  // toolbar
  const tb = document.createElement('div'); tb.className = 'inlinePxTools';
  const color = document.createElement('input'); color.type = 'color'; color.value = objEditColor; color.title = 'cor'; color.oninput = () => objEditColor = color.value;
  const mkChk = (lbl, val, set) => { const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'; c.checked = val; c.onchange = () => { set(c.checked); draw(); }; l.append(c, document.createTextNode(' ' + lbl)); return l; };
  const mkB = (txt, fn, title) => { const b = document.createElement('button'); b.className = 'miniBtn'; b.textContent = txt; if (title) b.title = title; b.onclick = fn; return b; };
  tb.append(color, mkChk('borracha', objEditErase, (v) => objEditErase = v), mkChk('grade', objEditGrid, (v) => objEditGrid = v), mkChk('wrap', objEditWrap, (v) => objEditWrap = v), mkB('↑', () => shift(0, -1)), mkB('↓', () => shift(0, 1)), mkB('←', () => shift(-1, 0)), mkB('→', () => shift(1, 0)));
  if (frames > 1) { const fl = document.createElement('span'); fl.className = 'alabel'; fl.textContent = 'f ' + (frame + 1) + '/' + frames; tb.append(mkB('◀f', () => { objEditFrame = (frame + frames - 1) % frames; selectObjThing(objSel.id); }), fl, mkB('f▶', () => { objEditFrame = (frame + 1) % frames; selectObjThing(objSel.id); })); }
  const hint = document.createElement('div'); hint.className = 'alabel'; hint.style.cssText = 'font-size:10px;text-align:center;margin:2px 0'; hint.textContent = 'pinte direto · use 🧭 direção e o slider idle/walk acima · salva ao soltar o mouse';
  ins.append(tb, cv, hint);
  draw();
}
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
// monta um group p/ OBD a partir de um frame group do thing (durações reais)
function obdGroupFrom(g) {
  return {
    width: g.width||1, height: g.height||1, exact: g.exact || 32, layers: g.layers||1,
    px: g.px||1, py: g.py||1, pz: g.pz||1, frames: g.frames||1,
    animMode: g.animMode || 0, loopCount: g.loopCount || 0, startFrame: g.startFrame || 0,
    durations: g.frames > 1 ? (g.durations || Array(g.frames).fill(0).map(() => ({ min: 100, max: 100 }))) : null,
  };
}
// coleta todos os sprite ids de um thing (todos os grupos)
function allSpriteIds(t) {
  const ids = [];
  for (const g of t._groups) for (const sid of g.sprites) if (sid > 0) ids.push(sid);
  return ids;
}
// pré-aquece todos os sprites de um thing no cache do TauriSpr
async function warmThing(t) { if (spr && spr.warm) await spr.warm(allSpriteIds(t)); }
// monta lista de grupos formatados para encodeFile (todos os grupos do thing)
function obdGroupsFrom(t) {
  return t._groups.map((g) => {
    const grp = obdGroupFrom(g);
    grp.spriteIds = g.sprites;
    grp.spriteRgbaList = g.sprites.map((sid) => sprEdits.get(sid) || spr.sprite(sid) || new Uint8ClampedArray(4096));
    return grp;
  });
}
// exporta o thing selecionado como .obd (V3 + todos os grupos + LZMA)
async function exportObd() {
  if (!objSel || !dat || !spr) return alert('selecione um thing');
  const t = objSel.t;
  const f = await ipcRenderer.invoke('save-file', `${objCat.replace(/s$/, '')}_${objSel.id}.obd`);
  if (!f) return;
  try {
    await warmThing(t);
    const buf = await OBD.encodeFile({ clientVersion: datVersion, category: objCat, attrs: t._attrs, groups: obdGroupsFrom(t), obdVersion: obdExportVer });
    fs.writeFileSync(f, buf);
    $('status').textContent = `OBD exportado (${t._groups.length} grupo(s)): ${f}`;
  } catch (e) { alert('Erro export OBD: ' + e.message); }
}
// monta o buffer .obd de um thing — todos os grupos
async function buildObdBuf(id) {
  const t = dat.category(objCat).get(id);
  await warmThing(t);
  return OBD.encodeFile({ clientVersion: datVersion, category: objCat, attrs: t._attrs, groups: obdGroupsFrom(t), obdVersion: obdExportVer });
}
// ---- sprite sheet export/import — igual getTotalSpriteSheet do OB: todos os grupos empilhados ----
async function exportSheet() {
  if (!objSel || !spr) return alert('selecione um thing');
  const t = objSel.t;
  await warmThing(t);
  const groups = t._groups;
  // globalTotalX = max(pz*px*layers) entre todos os grupos; maxW/maxH = max de width/height
  const globalTotalX = Math.max(...groups.map((gr) => (gr.pz||1)*(gr.px||1)*(gr.layers||1)));
  const maxW = Math.max(...groups.map((gr) => gr.width||1));
  const maxH = Math.max(...groups.map((gr) => gr.height||1));
  const cellW = maxW * 32, cellH = maxH * 32;
  // altura total = soma de (frames*py) de todos os grupos
  const totalRows = groups.reduce((s, gr) => s + (gr.frames||1)*(gr.py||1), 0);
  const cv = document.createElement('canvas');
  cv.width = globalTotalX * cellW; cv.height = totalRows * cellH;
  const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
  let groupYCell = 0;
  for (const gr of groups) {
    for (let f = 0; f < (gr.frames||1); f++)
      for (let z = 0; z < (gr.pz||1); z++)
        for (let y = 0; y < (gr.py||1); y++)
          for (let x = 0; x < (gr.px||1); x++)
            for (let l = 0; l < (gr.layers||1); l++) {
              const texIdx = (((f*(gr.pz||1)+z)*(gr.py||1)+y)*(gr.px||1)+x)*(gr.layers||1)+l;
              const fx = (texIdx % globalTotalX) * cellW;
              const fy = (groupYCell + Math.floor(texIdx / globalTotalX)) * cellH;
              for (let w = 0; w < (gr.width||1); w++)
                for (let h = 0; h < (gr.height||1); h++) {
                  const idx = dat.spriteIndex(gr, w, h, l, x, y, z, f);
                  const sid = gr.sprites[idx];
                  const pxData = sprEdits.get(sid) || (spr ? spr.sprite(sid) : null);
                  if (!pxData) continue;
                  const off = document.createElement('canvas'); off.width = 32; off.height = 32;
                  off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pxData), 32, 32), 0, 0);
                  ctx.drawImage(off, fx + (gr.width - w - 1) * 32, fy + (gr.height - h - 1) * 32);
                }
            }
    groupYCell += (gr.frames||1) * (gr.py||1);
  }
  const f = await ipcRenderer.invoke('save-file', `${objCat.replace(/s$/, '')}_${objSel.id}_sheet.png`);
  if (!f) return;
  fs.writeFileSync(f, canvasToPngBytes(cv));
  $('status').textContent = `sheet exportado ${cv.width}×${cv.height}px (${groups.length} grupo(s)): ${f}`;
}
async function importSheet() {
  if (!objSel || !spr) return alert('selecione um thing');
  const file = await ipcRenderer.invoke('pick-file', ['png']); if (!file) return;
  await applySheetFile(file, objSel.t, curGroup(objSel.t));
}
// PNG total sheet (todos os grupos empilhados) de um thing
async function thingPngBuf(id) {
  const t = dat.category(objCat).get(id);
  await warmThing(t);
  const groups = t._groups;
  const globalTotalX = Math.max(...groups.map((gr) => (gr.pz||1)*(gr.px||1)*(gr.layers||1)));
  const maxW = Math.max(...groups.map((gr) => gr.width||1));
  const maxH = Math.max(...groups.map((gr) => gr.height||1));
  const cellW = maxW * 32, cellH = maxH * 32;
  const totalRows = groups.reduce((s, gr) => s + (gr.frames||1)*(gr.py||1), 0);
  const cv = document.createElement('canvas');
  cv.width = globalTotalX * cellW; cv.height = totalRows * cellH;
  const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
  let groupYCell = 0;
  for (const gr of groups) {
    for (let f = 0; f < (gr.frames||1); f++)
      for (let z = 0; z < (gr.pz||1); z++)
        for (let y = 0; y < (gr.py||1); y++)
          for (let x = 0; x < (gr.px||1); x++)
            for (let l = 0; l < (gr.layers||1); l++) {
              const texIdx = (((f*(gr.pz||1)+z)*(gr.py||1)+y)*(gr.px||1)+x)*(gr.layers||1)+l;
              const fx = (texIdx % globalTotalX) * cellW;
              const fy = (groupYCell + Math.floor(texIdx / globalTotalX)) * cellH;
              for (let w = 0; w < (gr.width||1); w++)
                for (let h = 0; h < (gr.height||1); h++) {
                  const idx = dat.spriteIndex(gr, w, h, l, x, y, z, f);
                  const sid = gr.sprites[idx];
                  const pxData = sprEdits.get(sid) || (spr ? spr.sprite(sid) : null);
                  if (!pxData) continue;
                  const off = document.createElement('canvas'); off.width = 32; off.height = 32;
                  off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pxData), 32, 32), 0, 0);
                  ctx.drawImage(off, fx + (gr.width - w - 1) * 32, fy + (gr.height - h - 1) * 32);
                }
            }
    groupYCell += (gr.frames||1) * (gr.py||1);
  }
  return canvasToPngBytes(cv);
}
// exporta seleção (single ou multi) → pasta. fmt = 'obd' | 'png'
async function exportSelection(fmt) {
  if (!dat || !spr) return alert('carregue .dat/.spr');
  const ids = selectedIds();
  if (!ids.length) return alert('selecione thing(s) — clique, ou Ctrl/Shift+clique p/ vários');
  const dir = await ipcRenderer.invoke('pick-dir');
  if (!dir) return;
  let n = 0;
  for (const id of ids) {
    try {
      const name = `${objCat.replace(/s$/, '')}_${id}.${fmt}`;
      const buf = fmt === 'obd' ? await buildObdBuf(id) : await thingPngBuf(id);
      if (!buf) continue;
      fs.writeFileSync(path.join(dir, name), buf);
      n++;
      $('status').textContent = `exportando ${fmt}… ${n}/${ids.length}`;
    } catch (e) { console.error('export', id, e); $('status').textContent = `erro export ${fmt} #${id}: ${e.message}`; }
  }
  $('status').textContent = `${n} .${fmt} exportado(s) → ${dir}`;
}
// remove thing — qualquer id. Último = seguro; meio = renumera (avisa).
function removeThing() {
  if (!dat || !objSel) return alert('selecione um thing');
  const map = dat.category(objCat);
  const maxId = Math.max(...map.keys());
  const id = objSel.id;
  if (id === maxId) {
    if (!confirm(`Remover ${objCat.replace(/s$/, '')} #${id} (último id, seguro)?\n(backup .bak ao salvar)`)) return;
    dat.removeLast(objCat);
  } else {
    if (!confirm(`⚠️ Remover ${objCat.replace(/s$/, '')} #${id} do MEIO?\nTodos os ids acima de ${id} descem 1 (#${id + 1}→#${id}, …).\nIsso pode quebrar referências em spawns/items.xml/scripts.\n\nContinuar?`)) return;
    dat.removeAt(objCat, id);
  }
  objSel = null; _lastSelId = null; datDirty = true; updateDatSaveBtn();
  if (objPage > 0 && objPage * OBJ_PER_PAGE >= map.size) objPage--;
  renderObjGrid();
  $('objInspect').innerHTML = '<div class="alabel" style="padding:12px">removido #' + id + ' — 💾 Salvar .dat</div>';
  $('status').textContent = `removido #${id} (não salvo)`;
}
// ---- copy / paste de thing ----
function copyThing() {
  if (!objSel) return alert('selecione um thing');
  const t = objSel.t;
  clipThing = {
    cat: objCat,
    attrs: t._attrs.map((a) => ({ canon: a.canon, data: Buffer.from(a.data) })),
    groups: t._groups.map((g, i) => dat._normGroup(g, i)),
  };
  $('status').textContent = `copiado ${objCat.replace(/s$/, '')} #${objSel.id} (flags + ${clipThing.groups.length} grupo[s])`;
}
function pasteNewThing() {
  if (!clipThing) return alert('nada copiado');
  if (clipThing.cat !== objCat) return alert(`copiado é da categoria "${clipThing.cat}", troque p/ ela`);
  const r = dat.addFull(objCat, clipThing.attrs, clipThing.groups);
  datDirty = true; updateDatSaveBtn();
  gotoObjThing(r.id);
  $('status').textContent = `colado → novo #${r.id} (não salvo)`;
}
function pasteProps() {
  if (!clipThing || !objSel) return alert('copie um thing e selecione o destino');
  objSel.t._attrs = clipThing.attrs.map((a) => ({ op: VERS.inverseRemap(a.canon, datVersion), canon: a.canon, data: Buffer.from(a.data) }));
  dat.applyAttrs(objSel.t); datDirty = true; updateDatSaveBtn(); selectObjThing(objSel.id);
  $('status').textContent = `flags coladas em #${objSel.id} (não salvo)`;
}
function pastePatterns() {
  if (!clipThing || !objSel) return alert('copie um thing e selecione o destino');
  dat.setGroups(objSel.t, objCat, clipThing.groups.map((g, i) => dat._normGroup(g, i)));
  datDirty = true; updateDatSaveBtn(); _lastSelId = null; selectObjThing(objSel.id); renderObjGrid();
  $('status').textContent = `patterns/grupos colados em #${objSel.id} (não salvo)`;
}
async function doImport() {
  const files = await ipcRenderer.invoke('pick-files', ['obd', 'png']);
  if (!files || !files.length) return;
  for (const f of files) {
    if (f.toLowerCase().endsWith('.obd')) await importObd(f);
    else { // png -> novo sprite
      const id = spr.count + (sprAddedCount + 1);
      sprAddedCount++;
      await loadPng32(f, (rgba) => { sprEdits.set(id, rgba); });
      updateObjSaveBtn();
      $('status').textContent = `sprite ${id} importado (PNG) — 💾 Salvar .spr`;
    }
  }
}
// importa 1 PNG (por caminho) como sprite NOVO; retorna o id
async function importPngAsNew(f) {
  const id = spr.count + (sprAddedCount + 1); sprAddedCount++;
  await loadPng32(f, (rgba) => { sprEdits.set(id, rgba); });
  return id;
}
// drag-drop NATIVO de arquivos (WebView2/Tauri): arrastar .png/.obd do explorer p/ dentro do app.
// Tauri intercepta o drop do SO e manda os CAMINHOS via evento próprio (não dá File no JS).
function wireNativeFileDrop() {
  if (wireNativeFileDrop._done) return; const ev = window.__TAURI__ && window.__TAURI__.event; if (!ev) return; wireNativeFileDrop._done = true;
  // bloqueia navegação nativa do WebView2 ao soltar arquivo (mantém dragover p/ permitir o drop nos elementos)
  window.addEventListener('dragover', (e) => e.preventDefault(), true);
  window.addEventListener('drop', (e) => { if (!e.defaultPrevented) e.preventDefault(); }, true);
  let lastPos = null;
  const slotAt = (pos) => { // descobre se o drop caiu em cima de um slot de sprite (hit-test)
    if (!pos) return null; const dpr = window.devicePixelRatio || 1; const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr); if (!el) return null; const sl = el.closest && el.closest('.objSpr'); return (sl && sl.dataset.sid != null) ? sl : null;
  };
  const handle = async (paths, pos) => {
    paths = (paths || []).filter((p) => /\.(png|obd)$/i.test(p));
    if (!paths.length) return;
    if (mode !== 'obj') { setMode('obj'); }
    if (!dat || !spr) return alert('carregue .dat/.spr (ou Assets 15.x) primeiro, depois arraste o PNG');
    // 1 PNG solto EM CIMA de um slot → troca aquele sprite (igual Object Builder)
    const slot = slotAt(pos);
    if (slot && paths.length === 1 && /\.png$/i.test(paths[0])) {
      const sid = parseInt(slot.dataset.sid, 10);
      await loadPng32(paths[0], (rgba) => { sprEdits.set(sid, rgba); if (spr.cache) spr.cache.set(sid, rgba); });
      invalidateSprites(); updateObjSaveBtn(); if (objSel) selectObjThing(objSel.id); renderObjGrid();
      return void ($('status').textContent = `sprite #${sid} trocado pelo PNG arrastado — 💾 Salvar .spr`);
    }
    // senão → importa como sprite(s) novo(s) / .obd vira thing
    let n = 0, first = 0;
    for (const f of paths) {
      if (window.__preloadFile) await window.__preloadFile(f); // garante cache antes de readFileSync
      if (/\.obd$/i.test(f)) { await importObd(f); } else { const id = await importPngAsNew(f); if (!first) first = id; n++; }
    }
    updateObjSaveBtn(); renderSprPanel(); if (objSel) selectObjThing(objSel.id);
    if (n) $('status').textContent = `${n} PNG importado(s) (ids ${first}+) — arraste em cima de um slot p/ trocar, ou edite o id do slot · 💾 Salvar .spr`;
  };
  const norm = (p) => Array.isArray(p) ? { paths: p } : (p || {});
  for (const name of ['tauri://drag-drop', 'tauri://file-drop']) ev.listen(name, (e) => { const d = norm(e.payload); handle(d.paths || [], d.position || lastPos); document.body.classList.remove('dropping'); });
  for (const name of ['tauri://drag-over', 'tauri://file-drop-hover']) ev.listen(name, (e) => { const d = norm(e.payload); lastPos = d.position || lastPos; if (mode === 'obj') document.body.classList.add('dropping'); });
  for (const name of ['tauri://drag-leave', 'tauri://file-drop-cancelled']) ev.listen(name, () => document.body.classList.remove('dropping'));
}

// ---------- spawns / respawn ----------
// acha o spawn file mais "cheio" nas pastas world* do data
function autoFindSpawn() {
  const base = monDir ? path.resolve(monDir, '..') : (filesRoot ? path.join(filesRoot, 'data') : null);
  if (!base || !fsp.existsSync(base)) return null;
  let best = null, bestCount = 0;
  let dirs;
  try { dirs = fsp.readdirSync(base, { withFileTypes: true }); } catch (e) { return null; }
  for (const d of dirs) {
    if (!d.isDirectory() || !/world/i.test(d.name)) continue;
    const wdir = path.join(base, d.name);
    let files; try { files = fsp.readdirSync(wdir); } catch (e) { continue; }
    for (const f of files) {
      if (!/spawn.*\.xml$/i.test(f)) continue;
      const fp = path.join(wdir, f);
      try { const c = (fsp.readFileSync(fp, 'latin1').match(/<monster /gi) || []).length; if (c > bestCount) { bestCount = c; best = fp; } } catch (e) {}
    }
  }
  return best;
}
function loadSpawnFile(file) {
  try { spawnStore = SP.loadSpawn(file); spawnFile = file; lsSet('spawnFile', file); }
  catch (e) { alert('spawn invalido: ' + e.message); return; }
  updateSaveAll();
  $('status').textContent = `Spawn carregado: ${spawnStore.entries.length} entradas`;
  if (mode !== 'spawn') setMode('spawn'); else renderSpawns();
}
function renderSpawns() {
  const body = $('spawnBody');
  body.innerHTML = '';
  // auto-carrega so se nada foi escolhido a mao (auto + vazio pode ser trocado)
  if (!spawnStore || (spawnStore._auto && spawnStore.entries.length === 0)) {
    let f = null;
    const saved = lsGet('spawnFile');
    if (saved && fsp.existsSync(saved)) {
      try { if ((fsp.readFileSync(saved, 'latin1').match(/<monster /gi) || []).length > 0) f = saved; } catch (e) {}
    }
    if (!f) f = autoFindSpawn();
    if (f) { try { spawnStore = SP.loadSpawn(f); spawnStore._auto = true; spawnFile = f; lsSet('spawnFile', f); updateSaveAll(); } catch (e) { /* ignora */ } }
  }
  if (!spawnStore) { $('spawnInfo').textContent = 'Nenhum spawn encontrado — clique "📂 Abrir spawn.xml"'; return; }
  const groups = new Map();
  for (const e of spawnStore.entries) { if (!groups.has(e.name)) groups.set(e.name, []); groups.get(e.name).push(e); }
  const pts = (spawnStore.raw.match(/<spawn\b/gi) || []).length;
  if (spawnStore.entries.length === 0) {
    $('spawnInfo').textContent = `${path.basename(spawnStore.file)} — ${pts} pontos de spawn, mas 0 monstros colocados (vazio)`;
    return;
  }
  $('spawnInfo').textContent = `${spawnStore.entries.length} monstros · ${groups.size} tipos · ${pts} pontos · ${path.basename(spawnStore.file)}`;
  const q = $('spawnFilter').value.trim().toLowerCase();
  for (const name of Array.from(groups.keys()).sort()) {
    if (q && !name.toLowerCase().includes(q)) continue;
    const list = groups.get(name);
    const times = list.map((e) => e.spawntime);
    const mn = Math.min(...times), mx = Math.max(...times);
    const tr = document.createElement('tr');
    const tdN = document.createElement('td'); tdN.textContent = name;
    const tdQ = document.createElement('td'); tdQ.textContent = list.length;
    const tdT = document.createElement('td');
    const inp = document.createElement('input'); inp.type = 'number';
    inp.value = (mn === mx) ? mn : '';
    if (mn !== mx) inp.placeholder = `${mn}–${mx} (misto)`;
    const commit = () => {
      const v = parseInt(inp.value, 10);
      if (isNaN(v)) return;
      for (const e of list) e.spawntime = v;
      spawnStore._dirty = true; updateSaveAll();
      $('status').textContent = `respawn de ${name} = ${v}s (não salvo)`;
    };
    inp.onchange = commit;
    inp.onkeydown = (ev) => { if (ev.key === 'Enter') { commit(); inp.blur(); } };
    tdT.appendChild(inp);
    // ações: +1 (adiciona outro perto) e 🗑 (remove todos do tipo)
    const tdA = document.createElement('td');
    const addOne = document.createElement('button'); addOne.className = 'miniBtn'; addOne.textContent = '➕1'; addOne.title = 'adicionar mais 1 desse monstro (mesmo ponto)';
    addOne.onclick = () => {
      SP.addMonster(spawnStore, name, (mn === mx ? mn : 60), list[0]);
      updateSaveAll(); renderSpawns();
      $('status').textContent = `+1 ${name} adicionado (não salvo)`;
    };
    const del = document.createElement('button'); del.className = 'miniBtn danger'; del.textContent = '🗑'; del.title = 'remover TODOS desse monstro';
    del.onclick = () => {
      if (!confirm(`Remover todos os ${list.length} "${name}" do spawn?`)) return;
      const n = SP.removeAllOfName(spawnStore, name);
      updateSaveAll(); renderSpawns();
      $('status').textContent = `${n} "${name}" removidos (não salvo)`;
    };
    const addN = document.createElement('button'); addN.className = 'miniBtn'; addN.textContent = '➕N'; addN.title = 'adicionar N desse monstro de uma vez';
    addN.onclick = () => { const n = parseInt(prompt(`Quantos "${name}" adicionar?`, '5'), 10); if (!n || n < 1) return; for (let k = 0; k < n; k++) SP.addMonster(spawnStore, name, (mn === mx ? mn : 60), list[0]); updateSaveAll(); renderSpawns(); $('status').textContent = `+${n} ${name} (não salvo)`; };
    const posBtn = document.createElement('button'); posBtn.className = 'miniBtn'; posBtn.textContent = '📍 posições'; posBtn.title = 'ver onde esse monstro spawna no mapa';
    posBtn.onclick = () => showSpawnPositions(name);
    tdA.append(posBtn, addOne, addN, del);
    tr.append(tdN, tdQ, tdT, tdA);
    tdN.style.cursor = 'pointer'; tdN.title = 'clique p/ ver posições'; tdN.onclick = () => showSpawnPositions(name); // clicar no nome = posições
    body.appendChild(tr);
  }
}
// posição ABSOLUTA de cada spawn de um monstro = centro do <spawn> + offset do <monster>
function spawnPositionsOf(raw, name) {
  const out = []; const ln = name.toLowerCase();
  const sre = /<spawn\b([^>]*)>([\s\S]*?)<\/spawn>/gi; let sm;
  const num = (s, re) => { const m = s.match(re); return m ? parseInt(m[1], 10) : null; };
  while ((sm = sre.exec(raw))) {
    const at = sm[1], body = sm[2];
    const cx = num(at, /centerx\s*=\s*"(-?\d+)"/i) || 0, cy = num(at, /centery\s*=\s*"(-?\d+)"/i) || 0, cz = num(at, /centerz\s*=\s*"(-?\d+)"/i) || 0, rad = num(at, /radius\s*=\s*"(\d+)"/i) || 0;
    const mre = /<monster\b([^>]*?)\/?>/gi; let mm;
    while ((mm = mre.exec(body))) { const a = mm[1]; const nm = (a.match(/name\s*=\s*"([^"]*)"/i) || [])[1] || '';
      if (nm.toLowerCase() !== ln) continue;
      const rx = num(a, /\bx\s*=\s*"(-?\d+)"/i) || 0, ry = num(a, /\by\s*=\s*"(-?\d+)"/i) || 0; const rz = num(a, /\bz\s*=\s*"(-?\d+)"/i);
      out.push({ x: cx + rx, y: cy + ry, z: rz != null ? rz : cz, rad, spawntime: num(a, /spawntime\s*=\s*"(\d+)"/i) || 0 });
    }
  }
  return out;
}
function showSpawnPositions(name) {
  if (!spawnStore) return; const pos = spawnPositionsOf(spawnStore.raw, name);
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '440px';
  box.innerHTML = `<h3>📍 ${name} — ${pos.length} spawn(s)</h3><div class="alabel" style="font-size:11px;margin-bottom:6px">clique numa posição p/ copiar · "🗺 ir" abre no mapa (se o .otbm estiver aberto)</div>`;
  const list = document.createElement('div'); list.className = 'animBox'; list.style.maxHeight = '420px'; box.appendChild(list);
  if (!pos.length) list.innerHTML = '<div class="alabel" style="padding:8px">nenhuma posição (esse spawn.xml não tem coordenadas pra esse mob)</div>';
  for (const p of pos) {
    const r = document.createElement('div'); r.className = 'animRow'; r.style.gridTemplateColumns = '1fr 64px';
    const lbl = document.createElement('span'); lbl.textContent = `x=${p.x} y=${p.y} z=${p.z}` + (p.rad ? ` · raio ${p.rad}` : '') + (p.spawntime ? ` · ${p.spawntime}s` : '');
    lbl.style.cursor = 'pointer'; lbl.title = 'copiar posição'; lbl.onclick = () => { navigator.clipboard.writeText(`{x = ${p.x}, y = ${p.y}, z = ${p.z}}`); $('status').textContent = `posição copiada: ${p.x},${p.y},${p.z}`; };
    const go = document.createElement('button'); go.className = 'miniBtn'; go.textContent = '🗺 ir'; go.title = 'abrir no mapa';
    go.onclick = () => { if (!mapData) return alert('abra o mapa (.otbm) no modo 🗺 Mapa primeiro'); setMode('map'); mapZ = p.z; setTimeout(() => mapCenterOn(p.x, p.y), 60); $('status').textContent = `mapa em ${p.x},${p.y},${p.z}`; ov.remove(); };
    r.append(lbl, go); list.appendChild(r);
  }
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}

// ---------- Mapa (.otbm) — visualizador otimizado (culling de viewport) ----------
let mapData = null, mapPath = null, mapZ = 7, mapZoom = 1, mapOX = 0, mapOY = 0; // pan em tiles (canto sup-esq)
let _mapInit = false, _mapDrag = null, _mapRAF = null, mapTool = 'pan', _mapPaint = false, _borderWarned = false, _mapRO = null;
let mapAutoBorder = localStorage.getItem('mapAutoBorder') !== '0'; // Automagic (tecla A)
let mapUndo = [], mapRedo = [], _stroke = null;           // histórico
let mapSel = null, _selDrag = null, mapClip = null, _fillDrag = null, _delMatchDrag = null;       // seleção {x0,y0,x1,y1} + clipboard
// Shift+arrastar com o pincel: preenche o retângulo todo com o brush atual (igual RME)
function fillRectWithBrush() {
  if (!hasSel() || !mapData) return;
  const tiles = selTiles2D(); if (!tiles.length) return;
  // set dos tiles selecionados para borderize externo
  const tileSet = new Set(tiles.map(([x,y]) => x+','+y));
  strokeBegin();
  try {
    for (const [x, y] of tiles) mapPaintTile(x, y, mapZ);
    // borderiza tiles da borda exterior (vizinhos fora da seleção) p/ bordas ficarem corretas
    if (mapAutoBorder && mapBrushData) {
      for (const [x, y] of tiles) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx===0&&dy===0) continue;
        const nx=x+dx, ny=y+dy; const nk=nx+','+ny;
        if (!tileSet.has(nk)) { strokeTouch(nk+','+mapZ); RB.recomputeTile(mapBrushData, mapData, nx, ny, mapZ); }
      }
    }
  } finally { strokeEnd(); }
  mapSel = null; mapSelPoly = null; mapData._dirty = true; _miniDirty = true; $('mapSave').style.display = ''; reqMap();
  $('status').textContent = `preenchido ${tiles.length} tile(s) com o brush`;
}
function setMapTool(t) { mapTool = t; for (const [id, v] of [['mapToolPan', 'pan'], ['mapToolSelect', 'select'], ['mapToolPaint', 'paint'], ['mapToolErase', 'erase'], ['mapToolSpawn', 'spawn'], ['mapToolWaypoint', 'waypoint'], ['mapToolBucket', 'bucket'], ['mapToolZone', 'zone'], ['mapAutoCmp', 'autocomplete']]) { const el = $(id); if (el) el.classList.toggle('active', t === v); }
  { const dr = $('mapAutoDensityRow'); if (dr) dr.style.display = (t === 'autocomplete') ? '' : 'none'; } // densidade só no modo AUTO
  $('mapCanvas').style.cursor = t === 'pan' ? 'grab' : 'crosshair'; if (typeof _toSync === 'function') _toSync(); }
// balde: preenche região conexa de mesmo ground com o brush de terrain selecionado
function bucketFill(x, y, z) {
  if (!palBrush || palBrush.kind !== 'ground' || !mapBrushData) return alert('escolha um brush de Terrain na palette');
  const target = OTBM.getGround(mapData.map.get(x + ',' + y + ',' + z));
  const brush = mapBrushData.byName.get(palBrush.name); if (!brush) return; const gid = (brush.items && brush.items[0]) || brush.lookid; if (gid === target) return;
  strokeBegin();
  const seen = new Set(), stack = [[x, y]]; let n = 0; const LIM = 8000;
  const touched = [];
  while (stack.length && n < LIM) {
    const [cx, cy] = stack.pop(); const k = cx + ',' + cy; if (seen.has(k)) continue; seen.add(k);
    const node = mapData.map.get(cx + ',' + cy + ',' + z);
    if (OTBM.getGround(node) !== target) continue;
    strokeTouch(cx + ',' + cy + ',' + z); OTBM.setGround(mapData, cx, cy, z, gid); touched.push([cx, cy]); n++;
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  // borderiza a região preenchida + contorno
  for (const [cx, cy] of touched) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { strokeTouch((cx + dx) + ',' + (cy + dy) + ',' + z); RB.recomputeTile(mapBrushData, mapData, cx + dx, cy + dy, z); }
  strokeEnd(); reqMap(); $('status').textContent = `balde: ${n} tiles preenchidos` + (n >= LIM ? ' (limite atingido)' : '');
}
// --- undo/redo (transação por traço) ---
function strokeBegin() { _stroke = new Map(); }
function strokeTouch(key) { if (_stroke && !_stroke.has(key)) _stroke.set(key, OTBM.snapTile(mapData, key)); }
function strokeEnd() {
  if (!_stroke || !_stroke.size) { _stroke = null; return; }
  const changes = []; for (const [key, before] of _stroke) changes.push({ key, before, after: OTBM.snapTile(mapData, key) });
  mapUndo.push(changes); if (mapUndo.length > 400) mapUndo.shift(); mapRedo = []; _stroke = null;
  $('mapSave').style.display = ''; updateMapBtns(); _miniDirty = true;
}
function mapUndoDo() { const c = mapUndo.pop(); if (!c) return; for (const ch of c) OTBM.setTile(mapData, ch.key, ch.before); mapRedo.push(c); $('mapSave').style.display = ''; updateMapBtns(); _miniDirty = true; reqMap(); }
function mapRedoDo() { const c = mapRedo.pop(); if (!c) return; for (const ch of c) OTBM.setTile(mapData, ch.key, ch.after); mapUndo.push(c); $('mapSave').style.display = ''; updateMapBtns(); _miniDirty = true; reqMap(); }
function updateMapBtns() { $('mapUndo').disabled = !mapUndo.length; $('mapRedo').disabled = !mapRedo.length; $('mapCopy').disabled = !mapSel; $('mapPaste').disabled = !mapClip; $('mapDel').disabled = !(mapSel || (mapSelPoly && mapSelPoly.length >= 3)); }
let mapSelShape = 'rect', mapSelFloor = 'current', mapSelPoly = null; // shape: rect/circle/polygon · floor: current/lower/visible
function pointInPoly(px, py, poly) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y; if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside; } return inside; }
// tiles 2D da seleção (respeita a forma: retângulo/círculo/polígono/diamante/triângulo/linha/estrela/hexágono)
function selTiles2D() {
  // polígono livre (clique-a-clique)
  if (mapSelShape === 'polygon' && mapSelPoly && mapSelPoly.length >= 3) {
    const xs = mapSelPoly.map((p) => p.x), ys = mapSelPoly.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const out = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++)
      if (pointInPoly(x+0.5, y+0.5, mapSelPoly)) out.push([x,y]);
    return out;
  }
  if (!mapSel) return [];
  const x0=Math.min(mapSel.x0,mapSel.x1), x1=Math.max(mapSel.x0,mapSel.x1);
  const y0=Math.min(mapSel.y0,mapSel.y1), y1=Math.max(mapSel.y0,mapSel.y1);
  const W=x1-x0+1, H=y1-y0+1;
  const cx=(x0+x1+1)/2, cy=(y0+y1+1)/2;
  const rx=Math.max(0.5,W/2), ry=Math.max(0.5,H/2);
  const out = [];

  if (mapSelShape === 'circle') {
    for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) {
      const ddx=(x+0.5-cx)/rx, ddy=(y+0.5-cy)/ry;
      if (ddx*ddx+ddy*ddy<=1.0) out.push([x,y]);
    }
  } else if (mapSelShape === 'diamond') {
    // losango: |dx/rx|+|dy/ry|<=1
    for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) {
      if (Math.abs((x+0.5-cx)/rx)+Math.abs((y+0.5-cy)/ry)<=1.0) out.push([x,y]);
    }
  } else if (mapSelShape === 'triangle') {
    // triângulo isósceles: base em baixo, ponto no topo-centro
    const tip=[cx,y0+0.5], bl=[x0+0.5,y1+0.5], br=[x1+0.5,y1+0.5];
    for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++)
      if (pointInPoly(x+0.5,y+0.5,[{x:tip[0],y:tip[1]},{x:br[0],y:br[1]},{x:bl[0],y:bl[1]}])) out.push([x,y]);
  } else if (mapSelShape === 'rtriangle') {
    // triângulo retângulo: vértice no canto sup-esq
    for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) {
      // abaixo da hipotenusa de (x0,y0)→(x1,y1)
      const t=(y-y0)/Math.max(1,H-1);
      if (x<=x0+t*(W-1)+0.5) out.push([x,y]);
    }
  } else if (mapSelShape === 'line') {
    // linha de Bresenham de (x0,y0) a (x1,y1) com espessura 1
    let lx=x0,ly=y0,dx=Math.abs(x1-x0),dy=Math.abs(y1-y0);
    const sx=x0<x1?1:-1, sy=y0<y1?1:-1;
    let err=dx-dy;
    for (let step=0;step<=dx+dy+1;step++) {
      out.push([lx,ly]);
      if (lx===x1&&ly===y1) break;
      const e2=2*err;
      if (e2>-dy){err-=dy;lx+=sx;}
      if (e2<dx){err+=dx;ly+=sy;}
    }
  } else if (mapSelShape === 'star') {
    // estrela de 5 pontas via polígono interno
    const pts=[], n=5;
    for (let i=0;i<n*2;i++) {
      const angle=Math.PI*i/n - Math.PI/2;
      const r=i%2===0?1:0.38; // ponta externa / interna
      pts.push({x:cx+rx*r*Math.cos(angle), y:cy+ry*r*Math.sin(angle)});
    }
    for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++)
      if (pointInPoly(x+0.5,y+0.5,pts)) out.push([x,y]);
  } else if (mapSelShape === 'hexagon') {
    // hexágono regular
    const pts=[];
    for (let i=0;i<6;i++) { const a=Math.PI/3*i-Math.PI/6; pts.push({x:cx+rx*Math.cos(a),y:cy+ry*Math.sin(a)}); }
    for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++)
      if (pointInPoly(x+0.5,y+0.5,pts)) out.push([x,y]);
  } else {
    // retângulo (padrão)
    for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) out.push([x,y]);
  }
  return out;
}
function selFloors() { if (!mapData) return [mapZ]; if (mapSelFloor === 'lower') { const a = []; for (let z = mapZ; z <= mapData.zmax; z++) a.push(z); return a; } if (mapSelFloor === 'visible') { const a = []; for (let z = mapData.zmin; z <= mapZ; z++) a.push(z); return a; } return [mapZ]; }
function selKeys() { return selTiles2D().map(([x, y]) => x + ',' + y + ',' + mapZ); } // só andar atual (copy/move/transform)
function selKeysFloors() { const t = selTiles2D(), zs = selFloors(), ks = []; for (const [x, y] of t) for (const z of zs) ks.push(x + ',' + y + ',' + z); return ks; } // multi-andar (del/replace)
function hasSel() { return !!(mapSel || (mapSelPoly && mapSelPoly.length >= 3)); }
function mapCopySel() {
  if (!mapSel) return; const x0 = Math.min(mapSel.x0, mapSel.x1), y0 = Math.min(mapSel.y0, mapSel.y1);
  const tiles = [];
  for (const key of selKeys()) { const it = OTBM.itemsOf(mapData.map.get(key)).map(OTBM.itemId); if (it.length) { const p = key.split(',').map(Number); tiles.push({ dx: p[0] - x0, dy: p[1] - y0, items: it }); } }
  mapClip = { tiles }; updateMapBtns(); $('status').textContent = `copiado ${tiles.length} tile(s)`;
}
function mapPasteAt(bx, by) {
  if (!mapClip) return; strokeBegin();
  for (const t of mapClip.tiles) { const key = (bx + t.dx) + ',' + (by + t.dy) + ',' + mapZ; strokeTouch(key); OTBM.clearTile(mapData, key); OTBM.setTileItems(mapData, bx + t.dx, by + t.dy, mapZ, t.items); }
  strokeEnd(); reqMap(); $('status').textContent = `colado ${mapClip.tiles.length} tile(s)`;
}
function mapDelSel() {
  if (!hasSel()) return; strokeBegin(); let n = 0;
  for (const key of selKeysFloors()) { if (mapData.map.get(key)) { strokeTouch(key); OTBM.clearTile(mapData, key); n++; } }
  strokeEnd(); mapData._dirty = true; _miniDirty = true; $('mapSave').style.display = ''; reqMap(); $('status').textContent = `seleção apagada (${n} tiles, ${mapSelFloor})`;
}
let _mapRect = null;
function refreshMapRect() { const cv = $('mapCanvas'); _mapRect = cv.getBoundingClientRect(); }
function tileAt(e) {
  const cv = $('mapCanvas'); const r = _mapRect || cv.getBoundingClientRect();
  const ts = 32 * mapZoom;
  const scaleX = cv.width / (r.width || cv.width), scaleY = cv.height / (r.height || cv.height);
  const cx = (e.clientX - r.left) * scaleX, cy = (e.clientY - r.top) * scaleY;
  return { x: Math.floor(mapOX + cx / ts), y: Math.floor(mapOY + cy / ts), z: mapZ, inside: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom };
}
function mapZoneAt(e) {
  if (!mapData) return; const t = tileAt(e); if (!t.inside) return;
  const node = mapData.map.get(t.x + ',' + t.y + ',' + t.z); if (!node) return; // só tiles existentes
  const flag = parseInt($('mapZoneFlag').value, 10);
  strokeTouch(t.x + ',' + t.y + ',' + t.z);
  const cur = OTBM.getTileFlags(node);
  OTBM.setTileFlags(mapData, node, flag === 0 ? 0 : (cur | flag));
  $('mapSave').style.display = ''; reqMap();
}
// footprint do brush (size 0 = 1 tile; shape square/circle) — porta do RME brush size/shape
let brushSize = 0, brushShape = 'square';
function brushTiles(cx, cy) {
  if (brushSize <= 0) return [[cx, cy]];
  const out = []; const s = brushSize, r2 = (s + 0.4) * (s + 0.4);
  for (let dy = -s; dy <= s; dy++) for (let dx = -s; dx <= s; dx++) { if (brushShape === 'circle' && dx * dx + dy * dy > r2) continue; out.push([cx + dx, cy + dy]); }
  return out;
}
// pinta UM tile com o brush/serverId atual (sem reqMap; chamado em loop pelo footprint)
function mapPaintTile(x, y, z) {
  if (palBrush && mapBrushData && palBrush.kind !== 'creature') {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) strokeTouch((x + dx) + ',' + (y + dy) + ',' + z);
    if (palBrush.kind === 'ground') {
      if (mapAutoBorder) RB.paintGround(mapBrushData, mapData, x, y, z, palBrush.name);
      else { const b = mapBrushData.byName.get(palBrush.name); if (b) { RB.cleanGroundItems(mapBrushData, mapData, x, y, z); OTBM.setGround(mapData, x, y, z, (b.items && b.items[0]) || b.lookid); } }
    } else if (palBrush.kind === 'wall') { if (mapAutoBorder) RB.paintWall(mapBrushData, mapData, x, y, z, palBrush.name); else { const w = mapBrushData.wallByName.get(palBrush.name); if (w) { const id = (w.walls.pole || w.walls.horizontal || [])[0]; const tl = OTBM.ensureTile(mapData, x, y, z); if (id) tl.children.push({ type: 6, props: itemBuf2(id), children: [] }); } } }
    else if (palBrush.kind === 'doodad') RB.paintDoodad(mapBrushData, mapData, x, y, z, palBrush.name, palBrush._rot);
    else if (palBrush.kind === 'carpet') RB.paintCarpet(mapBrushData, mapData, x, y, z, palBrush.name);
    else if (palBrush.kind === 'table') RB.paintTable(mapBrushData, mapData, x, y, z, palBrush.name);
    else if (palBrush.kind === 'door') RB.paintDoor(mapBrushData, mapData, x, y, z, palBrush.name, $('mapDoorType') ? $('mapDoorType').value : 'normal');
    else if (palBrush.kind === 'house') { strokeTouch(x + ',' + y + ',' + z); OTBM.setHouseTile(mapData, x, y, z, mapHouseId || 0); }
    else if (palBrush.kind === 'raw') { if ($('mapGroundMode').checked) OTBM.setGround(mapData, x, y, z, palBrush.id); else OTBM.placeItem(mapData, x, y, z, palBrush.id); } // item RAW (architecture, escada, qualquer item)
  } else {
    const id = parseInt($('mapBrush').value, 10); if (!id) { $('status').textContent = 'escolha um brush na palette ou digite um serverId'; return; }
    const border = parseInt($('mapBorder').value, 10) || 0;
    if ($('mapGroundMode').checked) {
      strokeTouch(x + ',' + y + ',' + z); OTBM.setGround(mapData, x, y, z, id);
      if (border) { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { strokeTouch((x + dx) + ',' + (y + dy) + ',' + z); OTBM.autoBorder(mapData, x + dx, y + dy, z, id, border); } }
    } else { strokeTouch(x + ',' + y + ',' + z); OTBM.placeItem(mapData, x, y, z, id); }
  }
}
function itemBuf2(id) { const p = Buffer.alloc(2); p.writeUInt16LE(id & 0xFFFF, 0); return p; }
// Auto-completar: olha a área 10x10 ao redor do cursor, acha o ground DOMINANTE ali.
// autoCompletePlan = só CALCULA (p/ preview); mapAutoComplete = aplica. "completa com o que vê na área".
const AUTOCMP_R = 5; // 10x10
// pseudo-random DETERMINÍSTICO por (x,y,i) → preview estável e idêntico ao que será aplicado (sem flicker)
function _acRand(x, y, i) { let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(i + 1, 2246822519)) >>> 0; h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
// Auto-completar: clona o CENÁRIO dos tiles vizinhos (chão + itens/decorações, menos bordas) nos tiles
// VAZIOS, propagando da borda pra dentro. Cada vazio copia um vizinho não-vazio (aleatório) → a área se
// completa com o que existe em volta (grama+moitas vira grama+moitas, água vira água, etc).
function autoCompletePlan(cx, cy, z) {
  if (!mapData || !mapBrushData) return null;
  const R = AUTOCMP_R, x0 = cx - R, y0 = cy - R, x1 = cx + R - 1, y1 = cy + R - 1;
  const bSet = mapBrushData.borderItemSet || new Set();
  const groundAt = (x, y) => { const tn = mapData.map.get(x + ',' + y + ',' + z); return tn ? OTBM.getGround(tn) : 0; };
  // fontes de CENÁRIO (listas de itens não-borda) por chão — pra copiar decoração coerente com o chão
  const srcByGround = new Map();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const tn = mapData.map.get(x + ',' + y + ',' + z); if (!tn) continue; const g = OTBM.getGround(tn); if (!g) continue;
    const items = []; for (const c of tn.children) if (c.type === 6) { const id = c.props.readUInt16LE(0); if (!bSet.has(id)) items.push(id); }
    if (items.length) { if (!srcByGround.has(g)) srcByGround.set(g, []); srcByGround.get(g).push(items); }
  }
  const empties = []; let any = false;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { if (groundAt(x, y)) any = true; else empties.push([x, y]); }
  if (!any) return { x0, y0, x1, y1, best: null, cells: [] };
  // CHÃO por MAIORIA dos vizinhos (coerente → sem checkerboard → bordas limpas)
  const assigned = new Map(); let changed = true, guard = 0;
  while (changed && guard++ < 80) {
    changed = false;
    for (const [x, y] of empties) {
      const k = x + ',' + y; if (assigned.has(k)) continue;
      const vote = new Map();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const ng = groundAt(x + dx, y + dy) || assigned.get((x + dx) + ',' + (y + dy)) || 0; if (ng) vote.set(ng, (vote.get(ng) || 0) + 1); }
      if (vote.size) { let bg = 0, bn = -1; for (const [g, n] of vote) if (n > bn) { bn = n; bg = g; } assigned.set(k, bg); changed = true; }
    }
  }
  // cada vazio: chão coerente + itens de um cenário REAL do MESMO chão (pick determinístico p/ preview estável)
  const groundOf = (x, y) => groundAt(x, y) || assigned.get(x + ',' + y) || 0;
  const cells = [];
  for (const [x, y] of empties) {
    const gid = assigned.get(x + ',' + y); if (!gid) continue;
    const edge = groundOf(x, y - 1) !== gid || groundOf(x, y + 1) !== gid || groundOf(x - 1, y) !== gid || groundOf(x + 1, y) !== gid; // beira → sem decoração
    const src = srcByGround.get(gid); const items = (src && src.length) ? src[Math.floor(_acRand(x, y, 7) * src.length)].slice() : [];
    cells.push({ x, y, gid, items, edge });
  }
  return { x0, y0, x1, y1, best: cells.length ? cells[0].gid : 0, cells };
}
function mapAutoComplete(cx, cy, z) {
  if (!mapData || !mapBrushData) { $('status').textContent = 'abra um mapa + materiais RME (Servidor) primeiro'; return; }
  const p = autoCompletePlan(cx, cy, z); if (!p) return;
  if (!p.best) { $('status').textContent = '🪄 auto-completar: nenhum cenário reconhecido na área 10x10'; return; }
  if (!p.cells.length) { $('status').textContent = '🪄 auto-completar: área já está cheia (nada vazio p/ completar)'; return; }
  const dens = $('mapAutoDensity') ? (parseInt($('mapAutoDensity').value, 10) || 0) : 100; // 0% = só chão+borda; 100% = todo o cenário
  strokeBegin();
  // 1) CHÃO só (sem itens ainda) — pras bordas calcularem certo
  for (const c of p.cells) { strokeTouch(c.x + ',' + c.y + ',' + z); RB.cleanGroundItems(mapBrushData, mapData, c.x, c.y, z); OTBM.setGround(mapData, c.x, c.y, z, c.gid); }
  // 2) BORDAS (cria vizinhos vazios p/ outer border + recalcula área + anel; depois limpa vazios criados)
  for (let y = p.y0 - 1; y <= p.y1 + 1; y++) for (let x = p.x0 - 1; x <= p.x1 + 1; x++) OTBM.ensureTile(mapData, x, y, z);
  for (let y = p.y0 - 1; y <= p.y1 + 1; y++) for (let x = p.x0 - 1; x <= p.x1 + 1; x++) { strokeTouch(x + ',' + y + ',' + z); RB.recomputeTile(mapBrushData, mapData, x, y, z); }
  for (let y = p.y0 - 1; y <= p.y1 + 1; y++) for (let x = p.x0 - 1; x <= p.x1 + 1; x++) { const k = x + ',' + y + ',' + z; const t = mapData.map.get(k); if (t && !OTBM.getGround(t) && !t.children.some((c) => c.type === 6) && t.type !== 14) OTBM.setTile(mapData, k, null); }
  // 3) DECORAÇÕES POR CIMA (densidade) — SÓ no INTERIOR (pula beira/borda); pick determinístico = igual ao preview
  const bSet = mapBrushData.borderItemSet || new Set();
  if (dens > 0) for (const c of p.cells) {
    if (c.edge || !(c.items && c.items.length)) continue;
    const tn = mapData.map.get(c.x + ',' + c.y + ',' + z); if (!tn) continue;
    if (tn.children.some((ch) => ch.type === 6 && bSet.has(ch.props.readUInt16LE(0)))) continue; // tile de borda → deixa limpo
    for (let i = 0; i < c.items.length; i++) if (dens >= 100 || _acRand(c.x, c.y, i) * 100 < dens) tn.children.push({ type: 6, props: itemBuf2(c.items[i]), children: [] });
  }
  strokeEnd(); mapData._dirty = true; _miniDirty = true; $('mapSave').style.display = ''; reqMap();
  $('status').textContent = `🪄 auto-completar: +${p.cells.length} tiles preenchidos pela vizinhança na área 10x10`;
}
// apaga só o brush atual de UM tile (Ctrl+arrastar) — igual undraw do RME
function mapEraseBrushTile(x, y, z) {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) strokeTouch((x + dx) + ',' + (y + dy) + ',' + z);
  if (palBrush && mapBrushData) {
    if (palBrush.kind === 'wall') RB.eraseWall(mapBrushData, mapData, x, y, z, palBrush.name);
    else if (palBrush.kind === 'ground') RB.eraseTile(mapBrushData, mapData, x, y, z);
    else if (palBrush.kind === 'carpet') RB.eraseCarpet(mapBrushData, mapData, x, y, z, palBrush.name);
    else if (palBrush.kind === 'table') RB.eraseTable(mapBrushData, mapData, x, y, z, palBrush.name);
    else if (palBrush.kind === 'doodad') RB.eraseDoodad(mapBrushData, mapData, x, y, z, palBrush.name);
    else if (palBrush.kind === 'house') OTBM.setHouseTile(mapData, x, y, z, 0);
    else OTBM.deleteTop(mapData, x, y, z);
  } else OTBM.deleteTop(mapData, x, y, z);
}
function mapEditAt(e) {
  if (!mapData) return;
  const t = tileAt(e); if (!t.inside) return;
  // ação serializável (p/ Live: mesmo brush/estado aplicado no PC dos outros)
  const act = { tool: mapTool, ctrl: !!e.ctrlKey, x: t.x, y: t.y, z: t.z,
    brush: palBrush ? { kind: palBrush.kind, name: palBrush.name, id: palBrush.id, _rot: palBrush._rot } : null,
    mb: $('mapBrush') ? $('mapBrush').value : '', bd: $('mapBorder') ? $('mapBorder').value : '0',
    gm: $('mapGroundMode') ? $('mapGroundMode').checked : false, ab: mapAutoBorder, bs: brushSize, bsh: brushShape,
    house: mapHouseId, door: $('mapDoorType') ? $('mapDoorType').value : 'normal' };
  mapApplyAction(act);
  if (typeof liveOp === 'function') liveOp('map', 'edit', act);
}
// aplica uma ação de edição (local ou vinda do Live). Restaura estado de brush p/ ficar idêntico ao remetente.
function mapApplyAction(a) {
  if (!mapData) return;
  const sB = palBrush, sT = mapTool, sAB = mapAutoBorder, sBS = brushSize, sBSH = brushShape, sH = mapHouseId;
  const sMb = $('mapBrush') ? $('mapBrush').value : null, sBd = $('mapBorder') ? $('mapBorder').value : null;
  const sGm = $('mapGroundMode') ? $('mapGroundMode').checked : null, sDoor = $('mapDoorType') ? $('mapDoorType').value : null;
  palBrush = a.brush; mapTool = a.tool; mapAutoBorder = a.ab; brushSize = a.bs; brushShape = a.bsh; mapHouseId = a.house;
  if ($('mapBrush')) $('mapBrush').value = a.mb; if ($('mapBorder')) $('mapBorder').value = a.bd;
  if ($('mapGroundMode')) $('mapGroundMode').checked = a.gm; if ($('mapDoorType')) $('mapDoorType').value = a.door;
  try {
    const tiles = brushTiles(a.x, a.y);
    if (a.tool === 'paint' && a.ctrl) { for (const [x, y] of tiles) mapEraseBrushTile(x, y, a.z); }
    else if (a.tool === 'paint') { for (const [x, y] of tiles) mapPaintTile(x, y, a.z); }
    else if (a.tool === 'erase') { for (const [x, y] of tiles) { strokeTouch(x + ',' + y + ',' + a.z); if (a.bs > 0 && mapBrushData) RB.eraseTile(mapBrushData, mapData, x, y, a.z); else OTBM.deleteTop(mapData, x, y, a.z); } }
    else if (a.tool === 'optborder') {
      if (!mapBrushData) { if (!_borderWarned) { _borderWarned = true; alert('Carregue os materiais RME primeiro (botão 📦) para o BORDER.'); } }
      else { let known = 0; for (const [x, y] of tiles) { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) strokeTouch((x + dx) + ',' + (y + dy) + ',' + a.z); const ctn = mapData.map.get(x + ',' + y + ',' + a.z); if (ctn) { const g = OTBM.getGround(ctn); if (g && mapBrushData.groundToBrush.get(g)) known++; } RB.borderize(mapBrushData, mapData, x, y, a.z); } $('status').textContent = known ? `▦ bordas recalculadas (${tiles.length})` : '⚠ tile sem ground brush RME'; }
    }
  } finally {
    palBrush = sB; mapTool = sT; mapAutoBorder = sAB; brushSize = sBS; brushShape = sBSH; mapHouseId = sH;
    if (sMb != null) $('mapBrush').value = sMb; if (sBd != null) $('mapBorder').value = sBd;
    if (sGm != null) $('mapGroundMode').checked = sGm; if (sDoor != null) $('mapDoorType').value = sDoor;
  }
  $('mapSave').style.display = ''; reqMap();
}
// Shift+Ctrl + arrastar área = apaga TODAS as instâncias daquele item na área (magic eraser do RME).
// "aquele item" = o item do topo do tile onde você começou o clique (ou o brush/serverId atual se vazio).
function mapMatchTargetAt(x, y, z) {
  const node = mapData.map.get(x + ',' + y + ',' + z);
  if (node) { const its = OTBM.itemsOf(node); if (its.length) return OTBM.itemId(its[its.length - 1]); const g = OTBM.getGround(node); if (g) return g; }
  if (palBrush && palBrush.kind === 'raw' && palBrush.id) return palBrush.id;
  return parseInt($('mapBrush').value, 10) || 0;
}
function applyDelMatchRect(id) {
  if (!id || !mapSel || !mapData) { mapSel = null; reqMap(); return; }
  const x0 = Math.min(mapSel.x0, mapSel.x1), x1 = Math.max(mapSel.x0, mapSel.x1);
  const y0 = Math.min(mapSel.y0, mapSel.y1), y1 = Math.max(mapSel.y0, mapSel.y1);
  let tiles = 0, removed = 0;
  strokeBegin();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const node = mapData.map.get(x + ',' + y + ',' + mapZ); if (!node) continue;
    let did = false;
    // remove todas as instâncias do item empilhado (re-escaneia pq removeItemId muta o tile)
    let guard = 0; while (OTBM.itemsOf(node).some((it) => OTBM.itemId(it) === id) && guard++ < 64) { OTBM.removeItemId(mapData, node, id); did = true; removed++; }
    if (OTBM.getGround(node) === id) { OTBM.setGround(mapData, x, y, mapZ, 0); did = true; removed++; }
    if (did) { strokeTouch(x + ',' + y + ',' + mapZ); tiles++; }
  }
  strokeEnd();
  mapSel = null; $('mapSave').style.display = '';
  $('status').textContent = removed ? `🧽 apagado item ${id}: ${removed} em ${tiles} tile(s)` : `nenhum item ${id} na área`;
  reqMap();
}
function initMap() {
  const cv = $('mapCanvas');
  if (!_mapInit) {
    _mapInit = true;
    $('btnOpenMap').onclick = openMapFile;
    if ($('mapLoadAssets')) $('mapLoadAssets').onclick = loadAssets; // sprites 15.x p/ o mapa
    $('mapFloorUp').onclick = () => { if (mapZ > (mapData ? mapData.zmin : 0)) { mapZ--; reqMap(); } };
    $('mapFloorDown').onclick = () => { if (mapZ < (mapData ? mapData.zmax : 15)) { mapZ++; reqMap(); } };
    $('mapZoomIn').onclick = () => { mapZoom = Math.min(8, mapZoom * 1.5); reqMap(); };
    $('mapZoomOut').onclick = () => { mapZoom = Math.max(0.08, mapZoom / 1.5); reqMap(); };
    $('mapStack').onchange = reqMap;
    $('mapOverlays').onchange = reqMap;
    $('mapShadow').onchange = reqMap;
    $('mapAnim').onchange = () => { mapAnimOn = $('mapAnim').checked; if (mapAnimOn) { if (!_mapAnimTimer) _mapAnimTimer = setInterval(() => { if (mode === 'map' && mapAnimOn && mapZoom >= 0.5 && !_panRAF && !_mapDrag) { mapAnimFrame++; reqMap(); } }, 240); } else if (_mapAnimTimer) { clearInterval(_mapAnimTimer); _mapAnimTimer = null; } reqMap(); }; // anima só em zoom normal e parado (zoom-out/arrasto = carga demais)
    $('mapGoto').onchange = () => { const mm = $('mapGoto').value.match(/(\d+)\D+(\d+)/); if (mm) { mapPushHist(); mapCenterOn(+mm[1], +mm[2]); } };
    $('mapToolPan').onclick = () => setMapTool('pan');
    $('mapToolSelect').onclick = () => setMapTool('select');
    $('mapToolPaint').onclick = () => setMapTool('paint');
    $('mapToolErase').onclick = () => setMapTool('erase');
    $('mapPick').onclick = () => { if (_mapLastHover && mapData) { const node = mapData.map.get(_mapLastHover); const it = OTBM.itemsOf(node); if (it.length) { $('mapBrush').value = OTBM.itemId(it[it.length - 1]); palBrush = null; setMapTool('paint'); } if (mapBrushData && node) { const bn = mapBrushData.groundToBrush.get(OTBM.getGround(node)); if (bn) { palType = 'terrain'; $('palType').value = 'terrain'; fillTilesets(); palBrush = { kind: 'ground', name: bn }; renderPalette(); $('status').textContent = 'brush detectado: ' + bn; } } } };
    $('mapMerge').onclick = mapMerge; $('mapSaveAs').onclick = mapSaveAs; $('mapBack').onclick = mapBack;
    $('mapUndo').onclick = mapUndoDo; $('mapRedo').onclick = mapRedoDo;
    $('mapCopy').onclick = mapCopySel; $('mapPaste').onclick = () => { if (_mapLastHover) { const p = _mapLastHover.split(',').map(Number); mapPasteAt(p[0], p[1]); } };
    $('mapDel').onclick = mapDelSel;
    $('mapFlipH').onclick = () => mapTransformSel('flipH');
    $('mapFlipV').onclick = () => mapTransformSel('flipV');
    $('mapRot').onclick = () => mapTransformSel('rot');
    if ($('mapRotCCW')) $('mapRotCCW').onclick = () => mapTransformSel('rot270');
    if ($('mapRot180')) $('mapRot180').onclick = () => mapTransformSel('rot180');
    $('mapFind').onclick = mapFind;
    $('mapReplace').onclick = mapReplaceItem;
    if ($('mapRemoveItem')) $('mapRemoveItem').onclick = mapRemoveItemSel;
    if ($('mapFillSelBtn')) $('mapFillSelBtn').onclick = mapFillSel;
    if ($('mapSearchAid')) $('mapSearchAid').onclick = () => mapSearchProp('aid');
    if ($('mapSearchUid')) $('mapSearchUid').onclick = () => mapSearchProp('uid');
    if ($('mapSearchAttr')) $('mapSearchAttr').onclick = () => mapSearchProp('attr');
    if ($('mapSelectAll')) $('mapSelectAll').onclick = () => { if (!mapData) return; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, has = false; for (const n of mapData.map.values()) { if (n._z !== mapZ) continue; has = true; if (n._x < x0) x0 = n._x; if (n._x > x1) x1 = n._x; if (n._y < y0) y0 = n._y; if (n._y > y1) y1 = n._y; } if (!has) return alert('andar vazio'); mapSelShape = 'rect'; mapSelPoly = null; mapSel = { x0, y0, x1, y1 }; if ($('mapSelShape')) $('mapSelShape').value = 'rect'; updateMapBtns(); reqMap(); $('status').textContent = `selecionado tudo do andar z=${mapZ} (${x1 - x0 + 1}×${y1 - y0 + 1})`; };
    if ($('mapGoto2')) $('mapGoto2').onclick = mapGoToXYZ;
    if ($('mapJumpBrush')) $('mapJumpBrush').onclick = mapJumpToBrush;
    if ($('mapNew')) $('mapNew').onclick = mapNewEmpty;
    if ($('mapResize')) $('mapResize').onclick = mapResizeDo;
    if ($('mapClearHouses')) $('mapClearHouses').onclick = mapClearInvalidHouses;
    if ($('mapRemoveCorpses')) $('mapRemoveCorpses').onclick = mapRemoveCorpsesDo;
    if ($('mapSelShape')) $('mapSelShape').onchange = () => { mapSelShape = $('mapSelShape').value; mapSelPoly = null; mapSel = null; reqMap(); };
    if ($('mapSelFloor')) $('mapSelFloor').onchange = () => { mapSelFloor = $('mapSelFloor').value; };
    $('mapStats').onclick = mapStatsShow;
    $('mapCleanup').onclick = mapCleanup;
    $('mapBorderize').onclick = mapBorderize;
    $('mapBorderizeAll').onclick = borderizeMap;
    if ($('mapScanBrush')) $('mapScanBrush').onclick = scanSelectionToBrush;
    $('mapExportPng').onclick = exportMapPng;
    $('mapExportFullPng').onclick = exportMapFullPng;
    if ($('mapExportAllFloors')) $('mapExportAllFloors').onclick = exportAllFloors;
    $('mapRandomize').onclick = () => mapRandomize(false);
    $('mapRandomizeAll').onclick = () => mapRandomize(true);
    $('mapProps').onclick = mapProperties;
    $('mapToolBucket').onclick = () => setMapTool('bucket');
    $('mapToolZone').onclick = () => setMapTool('zone');
    $('mapAutoB').classList.toggle('active', mapAutoBorder);
    $('mapAutoB').onclick = () => { mapAutoBorder = !mapAutoBorder; localStorage.setItem('mapAutoBorder', mapAutoBorder ? '1' : '0'); $('mapAutoB').classList.toggle('active', mapAutoBorder); $('status').textContent = 'Automagic (A): ' + (mapAutoBorder ? 'LIGADO' : 'DESLIGADO'); };
    if ($('mapAutoCmp')) $('mapAutoCmp').onclick = () => { setMapTool('autocomplete'); $('status').textContent = '🪄 Auto 10x10: passe o mouse (vê o preview) e CLIQUE p/ preencher. Esc/outra ferramenta sai.'; reqMap(); };
    $('mapMini').onchange = reqMap;
    $('mapGrid').onchange = reqMap;
    if ($('mapDisp')) $('mapDisp').onchange = () => { mapDisp = $('mapDisp').checked; $('status').textContent = mapDisp ? 'efeito 3D ligado' : 'efeito 3D desligado'; reqMap(); };
    if ($('mapAllBelow')) $('mapAllBelow').onchange = () => { $('status').textContent = $('mapAllBelow').checked ? 'vendo todos os andares abaixo' : 'só o andar de baixo'; reqMap(); };
    if ($('mapGPU')) $('mapGPU').onchange = () => { $('status').textContent = $('mapGPU').checked ? '⚡ render GPU (WebGL) ligado — mais fluido no zoom out' : 'render GPU desligado (2D)'; if (_mapGL) { try { _mapGL._resetAtlas && _mapGL._resetAtlas(); } catch (e) {} } reqMap(); };
    $('mapShowHouses').onchange = reqMap;
    $('mapShowCreatures').onchange = reqMap;
    if ($('mapGhostUp')) $('mapGhostUp').onchange = reqMap;
    if ($('mapAllFloors')) $('mapAllFloors').onchange = reqMap;
    if ($('mapIngame')) $('mapIngame').onchange = reqMap;
    if ($('mapShowPathing')) $('mapShowPathing').onchange = reqMap;
    if ($('mapHighlightItems')) $('mapHighlightItems').onchange = reqMap;
    if ($('mapShowSpecial')) $('mapShowSpecial').onchange = reqMap;
    if ($('mapTooltips')) $('mapTooltips').onchange = () => { const tp = $('mapTooltip'); if (tp && !$('mapTooltips').checked) tp.style.display = 'none'; };
    $('mapBrushSize').oninput = () => { brushSize = parseInt($('mapBrushSize').value, 10) || 0; $('mapBrushSizeLbl').textContent = brushSize; };
    if ($('mapAutoDensity')) $('mapAutoDensity').oninput = () => { $('mapAutoDensityLbl').textContent = $('mapAutoDensity').value + '%'; };
    $('mapBrushShape').onclick = () => { brushShape = brushShape === 'square' ? 'circle' : 'square'; $('mapBrushShape').textContent = brushShape === 'square' ? '▢' : '◯'; $('mapBrushShape').classList.toggle('active', brushShape === 'circle'); };
    $('mapLight').onclick = () => { mapLightOn = !mapLightOn; $('mapLight').classList.toggle('active', mapLightOn); reqMap(); };
    if ($('mapWalk')) { $('mapWalk').onclick = () => { walkMode = !walkMode; $('mapWalk').classList.toggle('active', walkMode); $('status').textContent = walkMode ? '🚶 walk: clique p/ por o player · setas andam · botão-direito no 🚶 = nome/looktype' : 'modo caminhada off'; if (!walkMode) player = null; reqMap(); }; $('mapWalk').oncontextmenu = (e) => { e.preventDefault(); configPlayer(); }; }
    if ($('mapSimilar')) $('mapSimilar').onclick = mapFindSimilar;
    if ($('mapTeleports')) $('mapTeleports').onclick = teleportsManager;
    if ($('mapHousesBtn')) $('mapHousesBtn').onclick = housesManager;
    $('mapLightInt').oninput = () => { if (mapLightOn) reqMap(); };
    $('mapLightAmb').oninput = () => { if (mapLightOn) reqMap(); };
    wireToolOptions();
    $('mapLoadBrush').onclick = loadBrushesPick;
    $('palType').onchange = () => { palType = $('palType').value; palRawPage = 0; if ($('mapDoorType')) $('mapDoorType').style.display = palType === 'door' ? '' : 'none'; if ($('palHouseId')) $('palHouseId').style.display = palType === 'house' ? '' : 'none'; if (palType === 'house') { palBrush = { kind: 'house' }; setMapTool('paint'); } fillTilesets(); renderPalette(); };
    if ($('palHouseId')) $('palHouseId').oninput = () => { mapHouseId = parseInt($('palHouseId').value, 10) || 0; };
    $('palTileset').onchange = () => { palTileset = $('palTileset').value; palRawPage = 0; renderPalette(); };
    $('palSearch').addEventListener('input', debounce(() => { palRawPage = 0; renderPalette(); }, 150));
    $('mapSave').onclick = saveMap;
    loadBrushesAuto();
    cv.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // SÓ o botão esquerdo aplica/pinta; direito = menu de contexto
      if (miniClick(e)) return; // clicou no minimap → pula
      if (walkMode) { const t = tileAt(e); if (t.inside) { player = { x: t.x, y: t.y, z: mapZ, dir: 2, look: playerLook(), name: playerName }; $('status').textContent = '🚶 player em ' + t.x + ',' + t.y + ' — use as setas'; reqMap(); } return; }
      { const t = tileAt(e); if (t.inside) renderTilePropsDock(t.x + ',' + t.y + ',' + mapZ); } // atualiza o Tile Properties docado
      if (e.shiftKey && e.ctrlKey) { // Shift+Ctrl+arrastar = apaga o item da área (magic eraser)
        const t = tileAt(e); if (t.inside) { const id = mapMatchTargetAt(t.x, t.y, mapZ);
          if (id) { _delMatchDrag = { x0: t.x, y0: t.y, id }; mapSel = { x0: t.x, y0: t.y, x1: t.x, y1: t.y }; $('status').textContent = `🧽 apagar item ${id} na área — solte p/ aplicar`; reqMap(); }
          else $('status').textContent = 'Shift+Ctrl: clique sobre o item que quer apagar e arraste a área'; }
        return;
      }
      if (mapTool === 'pan') { _mapDrag = { x: e.clientX, y: e.clientY, ox: mapOX, oy: mapOY }; }
      else if (mapTool === 'spawn') { const t = tileAt(e); if (t.inside) { if (e.ctrlKey) removeSpawnAt(t.x, t.y, t.z); else addSpawn(t.x, t.y, t.z); } }
      else if (mapTool === 'waypoint') { const t = tileAt(e); if (t.inside) { if (e.ctrlKey) removeWaypointAt(t.x, t.y, t.z); else addWaypoint(t.x, t.y, t.z); } }
      else if (mapTool === 'bucket') { const t = tileAt(e); if (t.inside) bucketFill(t.x, t.y, t.z); }
      else if (mapTool === 'autocomplete') { const t = tileAt(e); if (t.inside) mapAutoComplete(t.x, t.y, t.z); }
      else if (mapTool === 'zone') { strokeBegin(); _mapPaint = true; mapZoneAt(e); }
      else if (mapTool === 'select') { const t = tileAt(e);
        if (mapSelShape === 'polygon') { if (!mapSelPoly) mapSelPoly = []; mapSelPoly.push({ x: t.x, y: t.y }); mapSel = null; $('status').textContent = `polígono: ${mapSelPoly.length} vértices (Enter/duplo-clique fecha · Esc limpa)`; reqMap(); }
        else { mapSelPoly = null; _selDrag = { x0: t.x, y0: t.y }; mapSel = { x0: t.x, y0: t.y, x1: t.x, y1: t.y }; reqMap(); } }
      else if (mapTool === 'paint' && e.shiftKey) { const t = tileAt(e); _fillDrag = { x0: t.x, y0: t.y }; mapSel = { x0: t.x, y0: t.y, x1: t.x, y1: t.y }; reqMap(); } // Shift+arrastar = preenche área (RME)
      else { strokeBegin(); _mapPaint = true; mapEditAt(e); }
    });
    window.addEventListener('mousemove', (e) => {
      if (mode !== 'map' || !mapData) return; // só faz algo no modo mapa
      if (_mapDrag) { const ts = 32 * mapZoom; mapOX = _mapDrag.ox - (e.clientX - _mapDrag.x) / ts; mapOY = _mapDrag.oy - (e.clientY - _mapDrag.y) / ts; reqMap(); return; }
      if (_delMatchDrag) { const t = tileAt(e); mapSel = { x0: _delMatchDrag.x0, y0: _delMatchDrag.y0, x1: t.x, y1: t.y }; reqMap(); return; }
      if (_fillDrag) { const t = tileAt(e); mapSel = { x0: _fillDrag.x0, y0: _fillDrag.y0, x1: t.x, y1: t.y }; reqMap(); return; }
      if (_selDrag) { const t = tileAt(e); mapSel = { x0: _selDrag.x0, y0: _selDrag.y0, x1: t.x, y1: t.y }; reqMap(); return; }
      if (_mapPaint) { mapHover(e); if (mapTool === 'zone') mapZoneAt(e); else mapEditAt(e); return; } // mapHover = cursor/preview acompanha o mouse enquanto pinta
      mapHover(e);
    });
    window.addEventListener('mouseup', () => { const wasDrag = !!_mapDrag; _mapDrag = null; if (_mapPaint) { _mapPaint = false; strokeEnd(); } if (_delMatchDrag) { const d = _delMatchDrag; _delMatchDrag = null; applyDelMatchRect(d.id); } if (_fillDrag) { _fillDrag = null; fillRectWithBrush(); } if (_selDrag) { _selDrag = null; updateMapBtns(); } if (wasDrag) reqMap(); }); // soltou o drag → render COMPLETO
    window.addEventListener('keydown', (e) => {
      if (mode !== 'map') return;
      if (e.target && e.target.tagName === 'INPUT') return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); mapUndoDo(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); mapRedoDo(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'c') { e.preventDefault(); mapCopySel(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'v') { e.preventDefault(); if (_mapLastHover) { const p = _mapLastHover.split(',').map(Number); mapPasteAt(p[0], p[1]); } }
      else if (e.key === 'Delete') { e.preventDefault(); mapDelSel(); }
      else if (e.key === 'a' || e.key === 'A') { e.preventDefault(); mapAutoBorder = !mapAutoBorder; localStorage.setItem('mapAutoBorder', mapAutoBorder ? '1' : '0'); if ($('mapAutoB')) $('mapAutoB').classList.toggle('active', mapAutoBorder); $('status').textContent = 'Automagic / auto-borda (A): ' + (mapAutoBorder ? 'LIGADO' : 'DESLIGADO'); }
      else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); const on = mapTool !== 'autocomplete'; setMapTool(on ? 'autocomplete' : 'paint'); $('status').textContent = on ? '🪄 Auto 10x10 (C): passe o mouse p/ ver o preview e CLIQUE p/ preencher' : 'ferramenta: pincel'; reqMap(); } // C = liga/desliga Auto-completar 10x10
      else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); rotateBrush(); } // girar brush (RME)
      else if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); if ($('mapShadow')) { $('mapShadow').checked = !$('mapShadow').checked; $('status').textContent = 'Sombra (andares abaixo): ' + ($('mapShadow').checked ? 'LIGADA' : 'DESLIGADA'); reqMap(); } } // Q = liga/desliga a sombra dos andares de baixo
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); if ($('mapAllFloors')) { $('mapAllFloors').checked = !$('mapAllFloors').checked; $('status').textContent = 'Mostrar todos os andares: ' + ($('mapAllFloors').checked ? 'LIGADO' : 'DESLIGADO'); reqMap(); } } // Ctrl+W = mostra todos os andares (cima e baixo)
      else if (e.key === 'PageUp') { e.preventDefault(); if (mapZ > (mapData ? mapData.zmin : 0)) { mapZ--; reqMap(); } } // sobe andar
      else if (e.key === 'PageDown') { e.preventDefault(); if (mapZ < (mapData ? mapData.zmax : 15)) { mapZ++; reqMap(); } } // desce andar
      else if (e.key === 'Escape') { if (mapSel || mapSelPoly) { mapSel = null; mapSelPoly = null; reqMap(); } }
      else if (e.key === 'Enter' && mapSelShape === 'polygon' && mapSelPoly && mapSelPoly.length >= 3) { e.preventDefault(); $('status').textContent = `polígono fechado (${mapSelPoly.length} vértices)`; reqMap(); }
      // setas: walk mode = segura p/ andar contínuo; Shift+seta move seleção; seta rola o mapa
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (walkMode) walkHold('ArrowUp', e.repeat); else if (e.shiftKey && mapSel) mapMoveSel(0, -1); else panHold('ArrowUp'); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (walkMode) walkHold('ArrowDown', e.repeat); else if (e.shiftKey && mapSel) mapMoveSel(0, 1); else panHold('ArrowDown'); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); if (walkMode) walkHold('ArrowLeft', e.repeat); else if (e.shiftKey && mapSel) mapMoveSel(-1, 0); else panHold('ArrowLeft'); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (walkMode) walkHold('ArrowRight', e.repeat); else if (e.shiftKey && mapSel) mapMoveSel(1, 0); else panHold('ArrowRight'); }
    });
    window.addEventListener('keyup', (e) => { if (WALK_DIRS[e.key]) { walkRelease(e.key); _panHeld.delete(e.key); } }); // soltar a seta = para de andar/rolar
    // FAILSAFE: se a janela perde foco com a seta segurada, o keyup nunca chega → pan infinito.
    // limpa tudo no blur/escape pra o pan SEMPRE parar.
    window.addEventListener('blur', () => { _panHeld.clear(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) _panHeld.clear(); });
    cv.addEventListener('wheel', (e) => { e.preventDefault();
      // ITEM 3 — scroll SOBRE o minimapa redimensiona o minimapa (não dá zoom no mapa)
      if (_miniRect && $('mapMini').checked) {
        const rr = _mapRect || cv.getBoundingClientRect();
        const mpx = (e.clientX - rr.left) * (cv.width / (rr.width || cv.width)), mpy = (e.clientY - rr.top) * (cv.height / (rr.height || cv.height));
        if (mpx >= _miniRect.ox - 2 && mpx <= _miniRect.ox + _miniRect.mw + 2 && mpy >= _miniRect.oy - 2 && mpy <= _miniRect.oy + _miniRect.mh + 2) {
          setMiniSize(_miniSize + (e.deltaY < 0 ? 40 : -40)); return;
        }
      }
      if (e.ctrlKey || e.metaKey) { // Ctrl + bolinha = troca de andar (out=sobe · in=desce)
        if (e.deltaY > 0) { if (mapZ > (mapData ? mapData.zmin : 0)) { mapZ--; reqMap(); } } // out → sobe andar
        else { if (mapZ < (mapData ? mapData.zmax : 15)) { mapZ++; reqMap(); } } // in → desce andar
        return;
      }
      const r = _mapRect || cv.getBoundingClientRect(); // zoom no cursor
      const px = (e.clientX - r.left) * (cv.width / (r.width || cv.width)), py = (e.clientY - r.top) * (cv.height / (r.height || cv.height));
      const tsOld = 32 * mapZoom; const wx = mapOX + px / tsOld, wy = mapOY + py / tsOld; // tile sob o cursor
      const f = e.deltaY < 0 ? 1.25 : 0.8; mapZoom = Math.max(0.08, Math.min(8, mapZoom * f));
      const tsNew = 32 * mapZoom; mapOX = wx - px / tsNew; mapOY = wy - py / tsNew; // mantém o cursor no mesmo tile (igual RME)
      reqMap();
    }, { passive: false });
    cv.addEventListener('dblclick', (e) => { if (mapTool === 'select' && mapSelShape === 'polygon' && mapSelPoly && mapSelPoly.length >= 4) { mapSelPoly.pop(); $('status').textContent = `polígono fechado (${mapSelPoly.length} vértices)`; reqMap(); } });
    cv.addEventListener('contextmenu', (e) => { e.preventDefault(); if (mapData) openMapContext(e); });
    window.addEventListener('resize', () => { if (mode === 'map') { resizeMapCanvas(); reqMap(); } });
    // canvas redimensionável: a resolução interna acompanha o tamanho exibido (inclui arrastar o grip do "tamanho livre")
    if (window.ResizeObserver && !_mapRO) { _mapRO = new ResizeObserver(() => { if (mode === 'map') { resizeMapCanvas(); reqMap(); } }); _mapRO.observe(cv); }
    restoreMapViewPrefs(); // lembra os toggles do menu Ver entre sessões
    // menus estilo RME: fecha ao clicar num item ou fora
    document.querySelectorAll('#mapMenu .menuPop').forEach((pop) => pop.addEventListener('click', (e) => { if (e.target.closest('button')) pop.closest('details').open = false; }));
    document.addEventListener('click', (e) => { if (!e.target.closest('#mapMenu .menu')) document.querySelectorAll('#mapMenu .menu[open]').forEach((d) => { d.open = false; }); });
  }
  resizeMapCanvas();
  setTimeout(() => { resizeMapCanvas(); reqMap(); }, 50); // re-mede após o painel aparecer (layout flex)
  if (!mapData) { const f = mapAutoFind(); if (f) loadMapFile(f); else $('mapInfo').textContent = 'abra um .otbm'; }
  else reqMap();
}
// menu de clique-direito (estilo RME)
function openMapContext(e) {
  const t = tileAt(e); if (!t.inside) return;
  const key = t.x + ',' + t.y + ',' + t.z; const node = mapData.map.get(key);
  const items = OTBM.itemsOf(node).map(OTBM.itemId); const topSid = items.length ? items[items.length - 1] : (node ? OTBM.getGround(node) || 0 : 0);
  const topCid = topSid ? ((otbMap && otbMap.get(topSid)) || topSid) : 0;
  // pré-computa brushes do tile p/ disabled correto no menu
  const _groundSid = node ? OTBM.getGround(node) : 0;
  const _allSids = _groundSid ? [_groundSid, ...items] : [...items];
  const _ctxGroundBrush = mapBrushData && _groundSid ? mapBrushData.groundToBrush.get(_groundSid) : null;
  const _ctxWallBrush = mapBrushData ? _allSids.map((id) => wallItemNameIndex().get(id)).find(Boolean) : null;
  const _ctxCarpetBrush = mapBrushData ? _allSids.map((id) => carpetItemNameIndex().get(id)).find(Boolean) : null;
  const _ctxTableBrush = mapBrushData ? _allSids.map((id) => tableItemNameIndex().get(id)).find(Boolean) : null;
  const _ctxDoodadBrush = mapBrushData ? (_allSids.map((id) => itemBrushIndex().get(id)).find((e) => e && e.type === 'doodad') || null) : null;
  document.querySelectorAll('.ctxMenu').forEach((m) => m.remove());
  const m = document.createElement('div'); m.className = 'ctxMenu';
  const add = (label, shortcut, fn, disabled) => { const it = document.createElement('div'); it.className = 'ctxItem' + (disabled ? ' disabled' : ''); it.innerHTML = `<span>${label}</span>${shortcut ? `<span class="ctxKey">${shortcut}</span>` : ''}`; if (!disabled) it.onclick = () => { m.remove(); fn(); }; m.appendChild(it); };
  const sep = () => { const s = document.createElement('div'); s.className = 'ctxSep'; m.appendChild(s); };
  add('Cut', 'Ctrl+X', () => { mapCopySel(); mapDelSel(); }, !mapSel);
  add('Copy', 'Ctrl+C', mapCopySel, !mapSel);
  add('Copy Position', '', () => { navigator.clipboard.writeText(`{x = ${t.x}, y = ${t.y}, z = ${t.z}}`); $('status').textContent = 'posição copiada'; });
  add('Paste', 'Ctrl+V', () => mapPasteAt(t.x, t.y), !mapClip);
  add('Delete', 'Del', () => { if (mapSel) mapDelSel(); else { strokeBegin(); strokeTouch(key); OTBM.clearTile(mapData, key); strokeEnd(); reqMap(); } }, !node && !mapSel);
  add('Replace tiles…', '', mapReplaceItem);
  sep();
  add('Copy Item Server Id', '', () => { navigator.clipboard.writeText(String(topSid)); $('status').textContent = 'server id ' + topSid; }, !topSid);
  add('Copy Item Client Id', '', () => { navigator.clipboard.writeText(String(topCid)); $('status').textContent = 'client id ' + topCid; }, !topSid);
  add('Copy Item Name', '', () => { navigator.clipboard.writeText(itemNameOf(topCid) || ''); $('status').textContent = 'nome: ' + (itemNameOf(topCid) || '—'); }, !topSid);
  add('Check Items.xml', '', () => { const e2 = itemEntryOf(topCid); alert(e2 ? `serverId ${serverIdOf(topCid)} "${e2.tagAttrs.name}"\n${e2.attributes.map((a) => a.key + '=' + a.value).join('\n')}` : 'sem entrada no items.xml'); }, !topSid);
  sep();
  add('Select RAW', '', () => paletteGoToRaw(topSid), !topSid);
  add('Select Wallbrush', '', () => paletteGoToWall(_ctxWallBrush), !_ctxWallBrush);
  add('Select Groundbrush', '', () => paletteGoToBrush(_ctxGroundBrush), !_ctxGroundBrush);
  add('Select Carpetbrush', '', () => paletteGoToCarpet(_ctxCarpetBrush), !_ctxCarpetBrush);
  add('Select Tablebrush', '', () => paletteGoToTable(_ctxTableBrush), !_ctxTableBrush);
  add('Select Doodadsbrush', '', () => paletteGoToDoodad(_ctxDoodadBrush.name), !_ctxDoodadBrush);
  sep();
  add('Rotate Item', 'X', () => { const rt = rotateOf(topSid); if (!rt) { $('status').textContent = 'item ' + topSid + ' não tem rotateTo'; return; } strokeBegin(); strokeTouch(key); OTBM.nodeReplace(mapData, node, topSid, rt); strokeEnd(); mapData._dirty = true; $('mapSave').style.display = ''; reqMap(); $('status').textContent = 'girado ' + topSid + ' → ' + rt; }, !topSid || !rotateOf(topSid));
  add('Properties / Flags…', '', () => openTileInspector(key), !node);
  add('Browse Field', '', () => alert(`tile ${key}\nitens (server ids): ${items.join(', ') || 'vazio'}\nground: ${OTBM.getGround(node) || '—'} · house: ${OTBM.getHouseId(node) || '—'} · flags: ${OTBM.getTileFlags(node)}`), !node);
  document.body.appendChild(m);
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.min(e.clientX, window.innerWidth - mw - 4) + 'px';
  m.style.top = Math.min(e.clientY, window.innerHeight - mh - 4) + 'px';
  const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', close); } };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}
const TILE_FLAGS = [{ b: 1, n: 'Protection Zone (PZ)' }, { b: 4, n: 'No PVP' }, { b: 8, n: 'No Logout' }, { b: 16, n: 'PVP Zone' }];
function openTileInspector(key) {
  const node = mapData.map.get(key);
  const ov = document.createElement('div'); ov.className = 'modal';
  const box = document.createElement('div'); box.className = 'modalBox tpBox'; box.style.maxWidth = '560px';
  const [tx, ty, tz] = key.split(',').map(Number);
  box.innerHTML = `<h3>Tile Properties — ${key}</h3>`;
  if (!node) { box.innerHTML += '<div class="alabel" style="padding:8px">tile vazio (pinte um item primeiro)</div>'; const f0 = document.createElement('div'); f0.className = 'modalFoot'; const ok0 = document.createElement('button'); ok0.className = 'miniBtn accent'; ok0.textContent = 'OK'; ok0.onclick = () => ov.remove(); f0.appendChild(ok0); box.appendChild(f0); ov.appendChild(box); document.body.appendChild(ov); return; }
  strokeBegin(); strokeTouch(key); // 1 transação undoable
  let selItem = null;
  const cols = document.createElement('div'); cols.className = 'tpCols'; box.appendChild(cols);
  // ===== coluna esquerda: Items =====
  const left = document.createElement('div'); left.className = 'tpSect'; cols.appendChild(left);
  left.innerHTML = '<div class="tpLbl">Items</div>';
  const bar = document.createElement('div'); bar.className = 'tpBar';
  const mkB = (t, title) => { const b = document.createElement('button'); b.className = 'tpIco'; b.textContent = t; b.title = title; return b; };
  const bUp = mkB('↑', 'subir no stack'), bDn = mkB('↓', 'descer no stack'), bDel = mkB('🗑', 'apagar item');
  bar.append(bUp, bDn, bDel); left.appendChild(bar);
  const list = document.createElement('div'); list.className = 'tpItems'; left.appendChild(list);
  const childItems = () => node.children.filter((c) => c.type === 6);
  function renderList() {
    list.innerHTML = ''; const its = childItems();
    for (let i = its.length - 1; i >= 0; i--) { const it = its[i]; const sid = it.props.readUInt16LE(0); const cid = (otbMap && otbMap.get(sid)) || sid;
      const row = document.createElement('div'); row.className = 'tpRow' + (it === selItem ? ' sel' : '');
      const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32; cv.className = 'palIcon'; palItemIcon(cv, sid);
      const nm = document.createElement('span'); nm.textContent = sid + ' - ' + (itemNameOf(cid) || ''); nm.title = nm.textContent;
      row.append(cv, nm); row.onclick = () => { selItem = it; renderList(); fillAction(); }; list.appendChild(row); }
    if (!its.length) list.innerHTML = '<div class="alabel" style="padding:8px;font-size:11px">tile sem itens</div>';
  }
  const move = (dir) => { if (!selItem) return; const ch = node.children; const idx = ch.indexOf(selItem); const step = dir === 'up' ? 1 : -1; let j = idx + step; while (j >= 0 && j < ch.length && ch[j].type !== 6) j += step; if (j < 0 || j >= ch.length) return; const t2 = ch[idx]; ch[idx] = ch[j]; ch[j] = t2; mapData._dirty = true; $('mapSave').style.display = ''; reqMap(); renderList(); };
  bUp.onclick = () => move('up'); bDn.onclick = () => move('down');
  bDel.onclick = () => { if (!selItem) return; const i = node.children.indexOf(selItem); if (i >= 0) node.children.splice(i, 1); selItem = null; mapData._dirty = true; $('mapSave').style.display = ''; reqMap(); renderList(); fillAction(); };
  // ===== coluna direita: Map Flags / Action / Spawn =====
  const right = document.createElement('div'); right.className = 'tpSect'; cols.appendChild(right);
  // Map Flags
  const ff = document.createElement('div'); ff.className = 'tpGroup'; ff.innerHTML = '<div class="tpLbl">Map Flags</div>'; let cur = OTBM.getTileFlags(node);
  for (const f of TILE_FLAGS) { const r = document.createElement('label'); r.className = 'tpChk'; const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!(cur & f.b); cb.onchange = () => { cur = cb.checked ? (cur | f.b) : (cur & ~f.b); OTBM.setTileFlags(mapData, node, cur); $('mapSave').style.display = ''; reqMap(); }; r.append(cb, document.createTextNode(' ' + f.n)); ff.appendChild(r); }
  right.appendChild(ff);
  // Action (do item selecionado)
  const ag = document.createElement('div'); ag.className = 'tpGroup'; ag.innerHTML = '<div class="tpLbl">Action</div>';
  const aRow = document.createElement('label'); aRow.className = 'tpField'; aRow.innerHTML = '<span>Action ID:</span>'; const aIn = document.createElement('input'); aIn.type = 'number'; aRow.appendChild(aIn);
  const uRow = document.createElement('label'); uRow.className = 'tpField'; uRow.innerHTML = '<span>Unique ID:</span>'; const uIn = document.createElement('input'); uIn.type = 'number'; uRow.appendChild(uIn);
  const txRow = document.createElement('label'); txRow.className = 'tpField'; txRow.innerHTML = '<span>Text:</span>'; const txIn = document.createElement('input'); txRow.appendChild(txIn);
  ag.append(aRow, uRow, txRow); right.appendChild(ag);
  function fillAction() { const on = !!selItem; aIn.disabled = uIn.disabled = txIn.disabled = !on; if (!on) { aIn.value = uIn.value = txIn.value = ''; return; } const p = OTBM.getItemProps(selItem); aIn.value = p.actionId || 0; uIn.value = p.uniqueId || 0; txIn.value = p.text || ''; }
  const applyAct = () => { if (!selItem) return; OTBM.setItemProps(mapData, selItem, { actionId: parseInt(aIn.value, 10) || 0, uniqueId: parseInt(uIn.value, 10) || 0, text: txIn.value || '' }); $('mapSave').style.display = ''; renderList(); };
  [aIn, uIn, txIn].forEach((i) => i.onchange = applyAct);
  // house id
  const hr = document.createElement('label'); hr.className = 'tpField'; hr.innerHTML = '<span>House ID:</span>'; const hi = document.createElement('input'); hi.type = 'number'; hi.value = OTBM.getHouseId(node); hi.onchange = () => { OTBM.setHouseTile(mapData, node._x, node._y, node._z, parseInt(hi.value, 10) || 0); $('mapSave').style.display = ''; reqMap(); }; hr.appendChild(hi);
  const hg = document.createElement('div'); hg.className = 'tpGroup'; hg.innerHTML = '<div class="tpLbl">House</div>'; hg.appendChild(hr); right.appendChild(hg);
  // Spawn / Creature
  const sg = document.createElement('div'); sg.className = 'tpGroup'; sg.innerHTML = '<div class="tpLbl">Spawn / Creature</div>'; right.appendChild(sg);
  renderSpawnSection(sg, [tx, ty, tz]);
  renderList(); fillAction();
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const ok = document.createElement('button'); ok.className = 'miniBtn accent'; ok.textContent = 'OK'; ok.onclick = () => { strokeEnd(); ov.remove(); };
  foot.appendChild(ok); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// ===== Tile Properties DOCADO (painel fixo direita; atualiza ao clicar num tile) =====
let _tpKey = null, _tpSel = null;
function renderTilePropsDock(key) {
  const body = $('tpDockBody'); if (!body) return; _tpKey = key; _tpSel = null;
  const node = mapData && mapData.map.get(key); if ($('tpDockPos')) $('tpDockPos').textContent = key ? '· ' + key : '';
  body.innerHTML = '';
  if (!node) { body.innerHTML = '<div class="alabel" style="font-size:11px;padding:4px">tile vazio</div>'; return; }
  const bar = document.createElement('div'); bar.className = 'tpBar';
  const mkB = (t, ti) => { const b = document.createElement('button'); b.className = 'tpIco'; b.textContent = t; b.title = ti; return b; };
  const bUp = mkB('↑', 'subir no stack'), bDn = mkB('↓', 'descer'), bDel = mkB('🗑', 'apagar item'), bSwap = mkB('🔁', 'trocar este item por outro'); bar.append(bUp, bDn, bDel, bSwap); body.appendChild(bar);
  const list = document.createElement('div'); list.className = 'tpItems'; list.style.height = '120px'; body.appendChild(list);
  const childItems = () => node.children.filter((c) => c.type === 6);
  function rl() { list.innerHTML = ''; const its = childItems(); for (let i = its.length - 1; i >= 0; i--) { const it = its[i]; const sid = it.props.readUInt16LE(0); const cid = (otbMap && otbMap.get(sid)) || sid; const row = document.createElement('div'); row.className = 'tpRow' + (it === _tpSel ? ' sel' : ''); const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32; cv.className = 'palIcon'; palItemIcon(cv, sid); const nm = document.createElement('span'); nm.textContent = sid + ' ' + (itemNameOf(cid) || ''); nm.title = nm.textContent; row.append(cv, nm); row.onclick = () => { _tpSel = it; rl(); fa(); }; list.appendChild(row); } if (!its.length) list.innerHTML = '<div class="alabel" style="font-size:11px;padding:4px">só ground</div>'; }
  const move = (dir) => { if (!_tpSel) return; const ch = node.children; const idx = ch.indexOf(_tpSel); const step = dir === 'up' ? 1 : -1; let j = idx + step; while (j >= 0 && j < ch.length && ch[j].type !== 6) j += step; if (j < 0 || j >= ch.length) return; strokeBegin(); strokeTouch(key); const t2 = ch[idx]; ch[idx] = ch[j]; ch[j] = t2; strokeEnd(); mapData._dirty = true; $('mapSave').style.display = ''; reqMap(); rl(); };
  bUp.onclick = () => move('up'); bDn.onclick = () => move('down');
  bDel.onclick = () => { if (!_tpSel) return; strokeBegin(); strokeTouch(key); const i = node.children.indexOf(_tpSel); if (i >= 0) node.children.splice(i, 1); strokeEnd(); _tpSel = null; mapData._dirty = true; $('mapSave').style.display = ''; reqMap(); rl(); fa(); };
  // 🔁 trocar: clica no item (acabamento/deco) e escolhe outro pra substituir no mesmo lugar
  bSwap.onclick = () => { if (!_tpSel) { $('status').textContent = 'selecione um item na lista primeiro'; return; }
    openMinPalette(bSwap, (item) => { if (!item || !item.id) return; strokeBegin(); strokeTouch(key); _tpSel.props.writeUInt16LE(item.id & 0xFFFF, 0); strokeEnd(); mapData._dirty = true; $('mapSave').style.display = ''; reqMap(); rl(); }); };
  const fg = document.createElement('div'); fg.className = 'tpGroup'; fg.innerHTML = '<div class="tpLbl">Map Flags</div>'; let cur = OTBM.getTileFlags(node);
  for (const f of TILE_FLAGS) { const r = document.createElement('label'); r.className = 'tpChk'; const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!(cur & f.b); cb.onchange = () => { strokeBegin(); strokeTouch(key); cur = cb.checked ? (cur | f.b) : (cur & ~f.b); OTBM.setTileFlags(mapData, node, cur); strokeEnd(); $('mapSave').style.display = ''; reqMap(); }; r.append(cb, document.createTextNode(' ' + f.n)); fg.appendChild(r); } body.appendChild(fg);
  const ag = document.createElement('div'); ag.className = 'tpGroup'; ag.innerHTML = '<div class="tpLbl">Action (item selecionado)</div>';
  const mkF = (lb) => { const w = document.createElement('label'); w.className = 'tpField'; w.innerHTML = '<span>' + lb + '</span>'; const i = document.createElement('input'); w.appendChild(i); ag.appendChild(w); return i; };
  const aIn = mkF('Action ID'); aIn.type = 'number'; const uIn = mkF('Unique ID'); uIn.type = 'number'; const txIn = mkF('Text'); body.appendChild(ag);
  function fa() { const on = !!_tpSel; aIn.disabled = uIn.disabled = txIn.disabled = !on; if (!on) { aIn.value = uIn.value = txIn.value = ''; return; } const p = OTBM.getItemProps(_tpSel); aIn.value = p.actionId || 0; uIn.value = p.uniqueId || 0; txIn.value = p.text || ''; }
  const ap = () => { if (!_tpSel) return; strokeBegin(); strokeTouch(key); OTBM.setItemProps(mapData, _tpSel, { actionId: parseInt(aIn.value, 10) || 0, uniqueId: parseInt(uIn.value, 10) || 0, text: txIn.value || '' }); strokeEnd(); $('mapSave').style.display = ''; rl(); };
  [aIn, uIn, txIn].forEach((i) => i.onchange = ap);
  const hg = document.createElement('div'); hg.className = 'tpGroup'; const hr = document.createElement('label'); hr.className = 'tpField'; hr.innerHTML = '<span>House ID</span>'; const hi = document.createElement('input'); hi.type = 'number'; hi.value = OTBM.getHouseId(node); hi.onchange = () => { strokeBegin(); strokeTouch(key); OTBM.setHouseTile(mapData, node._x, node._y, node._z, parseInt(hi.value, 10) || 0); strokeEnd(); $('mapSave').style.display = ''; reqMap(); }; hr.appendChild(hi); hg.appendChild(hr); body.appendChild(hg);
  rl(); fa();
}
// editor de spawn (radius + monstros) p/ o spawn cujo centro é este tile
function spawnBlockRe(x, y, z) { return new RegExp(`(<spawn\\b[^>]*?centerx="${x}"[^>]*?centery="${y}"[^>]*?centerz="${z}"[^>]*?>)([\\s\\S]*?)(<\\/spawn>)`, 'i'); }
function renderSpawnSection(box, p) {
  const [x, y, z] = p; if (!mapSpawnRaw) return;
  const re = spawnBlockRe(x, y, z); const mm = mapSpawnRaw.match(re); if (!mm) return;
  const div = document.createElement('div'); div.innerHTML = '<div class="opRow"><span>🔴 spawn neste tile</span></div>';
  const radRow = document.createElement('label'); radRow.className = 'opRow'; radRow.innerHTML = '<span>radius</span>';
  const rad = mm[1].match(/radius="(\d+)"/); const ri = document.createElement('input'); ri.type = 'number'; ri.value = rad ? rad[1] : 3; ri.style.width = '70px';
  ri.onchange = () => { const open = mm[1].replace(/radius="\d+"/, `radius="${parseInt(ri.value, 10) || 1}"`).replace(/(<spawn\b(?:(?!radius=)[^>])*?)>/i, (m2) => /radius=/.test(mm[1]) ? m2 : m2.replace('>', ` radius="${parseInt(ri.value, 10) || 1}">`)); mapSpawnRaw = mapSpawnRaw.replace(re, open + mm[2] + mm[3]); mapSpawnDirty = true; parseMapSpawns(); $('mapSave').style.display = ''; reqMap(); };
  radRow.appendChild(ri); div.appendChild(radRow);
  const list = document.createElement('div'); list.className = 'animBox';
  const drawMobs = () => {
    list.innerHTML = ''; const body = mapSpawnRaw.match(spawnBlockRe(x, y, z))[2];
    const mr = /<monster\b([^>]*?)\/?>/gi; let m; const mobs = [];
    while ((m = mr.exec(body))) { const nm = m[1].match(/name="([^"]*)"/i), st = m[1].match(/spawntime="(\d+)"/i); mobs.push({ name: nm ? nm[1] : '?', time: st ? +st[1] : 60, raw: m[0] }); }
    for (const mob of mobs) { const r = document.createElement('div'); r.className = 'animRow'; r.style.gridTemplateColumns = '1fr 60px 22px'; const nm = document.createElement('span'); nm.textContent = mob.name; const tm = document.createElement('input'); tm.type = 'number'; tm.value = mob.time; tm.title = 'spawntime'; tm.onchange = () => { const nb = mob.raw.replace(/spawntime="\d+"/, `spawntime="${parseInt(tm.value, 10) || 60}"`); mapSpawnRaw = mapSpawnRaw.replace(mob.raw, /spawntime=/.test(mob.raw) ? nb : mob.raw.replace(/\/?>$/, ` spawntime="${parseInt(tm.value, 10) || 60}"/>`)); mapSpawnDirty = true; $('mapSave').style.display = ''; }; const rm = document.createElement('button'); rm.className = 'expBtn'; rm.textContent = '✕'; rm.onclick = () => { mapSpawnRaw = mapSpawnRaw.replace(mob.raw, ''); mapSpawnDirty = true; $('mapSave').style.display = ''; drawMobs(); reqMap(); }; r.append(nm, tm, rm); list.appendChild(r); }
  };
  drawMobs(); div.appendChild(list);
  const add = document.createElement('button'); add.className = 'miniBtn'; add.textContent = '➕ monstro';
  add.onclick = () => { const name = prompt('nome do monstro:', $('mapSpawnMob').value || 'Rat'); if (!name) return; const tag = `\n\t\t<monster name="${name}" x="0" y="0" z="${z}" spawntime="60"/>`; const cur = mapSpawnRaw.match(spawnBlockRe(x, y, z)); mapSpawnRaw = mapSpawnRaw.replace(spawnBlockRe(x, y, z), cur[1] + cur[2] + tag + '\n\t' + cur[3]); mapSpawnDirty = true; $('mapSave').style.display = ''; drawMobs(); };
  div.appendChild(add); box.appendChild(div);
}
function mapFind() {
  if (!mapData) return; const s = prompt('achar item — serverId ou nome:'); if (!s) return;
  let id = parseInt(s, 10);
  if (!/^\d+$/.test(s.trim())) { // por nome: acha o serverId do item pelo nome
    const q = s.toLowerCase(); let found = 0;
    for (const [cid] of dat.items) { const sid = (otbInv && otbInv.get(cid)) || cid; if (itemNameOf(cid).toLowerCase().includes(q)) { found = sid; break; } }
    if (!found) { $('status').textContent = 'nome não achado no items.xml'; return; } id = found;
  }
  if (!id) return; const ks = OTBM.findItem(mapData, id);
  if (!ks.length) { $('status').textContent = `item ${id} não encontrado no mapa`; return; }
  const p = ks[0].split(',').map(Number); mapPushHist(); mapZ = p[2]; mapCenterOn(p[0], p[1]);
  $('status').textContent = `item ${id}: ${ks.length} no mapa — fui pro 1º (${ks[0]})`;
}
function mapReplaceItem() {
  if (!mapData) return; const inSel = hasSel() && confirm("Substituir APENAS na seleção? (Cancelar = mapa todo)");
  const s = prompt('substituir — "de_id, para_id":', ''); if (!s) return;
  const mm = s.match(/(\d+)\D+(\d+)/); if (!mm) return alert('formato: de_id, para_id');
  const from = +mm[1], to = +mm[2];
  let ks = OTBM.findItem(mapData, from); if (inSel) { const sset = new Set(selKeysFloors()); ks = ks.filter((k) => sset.has(k)); }
  if (!ks.length) { $('status').textContent = `id ${from} não achado` + (inSel ? ' na seleção' : ''); return; }
  if (!confirm(`Substituir ${ks.length} ocorrência(s) de #${from} por #${to}${inSel ? ' (seleção)' : ''}?`)) return;
  strokeBegin(); for (const k of ks) { const n = mapData.map.get(k); if (n) { strokeTouch(k); OTBM.nodeReplace(mapData, n, from, to); } } strokeEnd();
  reqMap(); $('status').textContent = `${ks.length} item(s) ${from}→${to} substituídos`;
}
// remove um item id da seleção (ou mapa todo)
function mapRemoveItemSel() {
  if (!mapData) return; const inSel = hasSel() && confirm("Remover APENAS na seleção? (Cancelar = mapa todo)");
  const s = prompt('remover item id do mapa:', ''); if (!s) return; const id = parseInt(s, 10); if (!id) return;
  let ks = OTBM.findItem(mapData, id); if (inSel) { const sset = new Set(selKeysFloors()); ks = ks.filter((k) => sset.has(k)); }
  if (!ks.length) { $('status').textContent = `id ${id} não achado` + (inSel ? ' na seleção' : ''); return; }
  if (!confirm(`Remover ${ks.length} ocorrência(s) de #${id}?`)) return;
  strokeBegin(); for (const k of ks) { const n = mapData.map.get(k); if (n) { strokeTouch(k); OTBM.removeItemId(mapData, n, id); } } strokeEnd();
  mapData._dirty = true; _miniDirty = true; $('mapSave').style.display = ''; reqMap(); $('status').textContent = `${ks.length} item(s) #${id} removidos`;
}
// preenche a seleção atual com o brush selecionado (menu)
function mapFillSel() { if (!hasSel()) return alert('faça uma seleção primeiro (ferramenta ⬚ → retângulo/círculo/polígono)'); fillRectWithBrush(); }
// ===== Busca por Action ID / Unique ID / texto (flagship do RME) =====
function mapSearchProp(mode) {
  if (!mapData) return alert('abra um .otbm');
  let needle = 0;
  if (mode === 'aid' || mode === 'uid') { const s = prompt(mode === 'aid' ? 'Action ID (vazio = qualquer com aid):' : 'Unique ID (vazio = qualquer com uid):', ''); if (s === null) return; needle = parseInt(s, 10) || 0; }
  $('status').textContent = 'buscando…';
  setTimeout(() => {
    const res = []; const LIM = 3000;
    outer: for (const [k, node] of mapData.map) {
      for (const it of OTBM.itemNodes(node)) {
        const p = OTBM.getItemProps(it); const id = it.props.readUInt16LE(0); let ok = false, val = '';
        if (mode === 'aid') { if (p.actionId && (!needle || p.actionId === needle)) { ok = true; val = 'aid ' + p.actionId; } }
        else if (mode === 'uid') { if (p.uniqueId && (!needle || p.uniqueId === needle)) { ok = true; val = 'uid ' + p.uniqueId; } }
        else { if (p.actionId || p.uniqueId || p.text) { ok = true; val = [p.actionId ? 'aid ' + p.actionId : '', p.uniqueId ? 'uid ' + p.uniqueId : '', p.text ? 'txt' : ''].filter(Boolean).join(' '); } }
        if (ok) { const pp = k.split(',').map(Number); res.push({ x: pp[0], y: pp[1], z: pp[2], id, val }); if (res.length >= LIM) break outer; }
      }
    }
    showPosResults(`Busca ${mode.toUpperCase()}` + (needle ? ' = ' + needle : ''), res);
    $('status').textContent = `${res.length} resultado(s)` + (res.length >= LIM ? ' (limite ' + LIM + ')' : '');
  }, 30);
}
function showPosResults(title, res) {
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '480px';
  box.innerHTML = `<h3>${title} — ${res.length}</h3><div class="alabel" style="font-size:11px;margin-bottom:6px">clique p/ ir no mapa</div>`;
  const list = document.createElement('div'); list.className = 'animBox'; list.style.maxHeight = '440px'; box.appendChild(list);
  if (!res.length) list.innerHTML = '<div class="alabel" style="padding:8px">nada encontrado</div>';
  for (const r of res) { const row = document.createElement('div'); row.className = 'animRow'; row.style.gridTemplateColumns = '1fr';
    const b = document.createElement('button'); b.className = 'miniBtn'; b.style.textAlign = 'left';
    b.textContent = `x=${r.x} y=${r.y} z=${r.z} · #${r.id} ${itemNameOf((otbMap && otbMap.get(r.id)) || r.id) || ''}${r.val ? ' · ' + r.val : ''}`;
    b.onclick = () => { mapPushHist(); mapZ = r.z; setTimeout(() => mapCenterOn(r.x, r.y), 30); $('status').textContent = `${r.x},${r.y},${r.z}`; };
    row.appendChild(b); list.appendChild(row); }
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// Ir para posição x,y,z
function mapGoToXYZ() {
  if (!mapData) return; const s = prompt('Ir para posição (x, y, z):', `${Math.round(mapOX + 10)}, ${Math.round(mapOY + 7)}, ${mapZ}`); if (!s) return;
  const m = s.match(/(\d+)\D+(\d+)(?:\D+(\d+))?/); if (!m) return alert('formato: x, y, z');
  mapPushHist(); if (m[3] != null) mapZ = Math.max(0, Math.min(15, +m[3])); mapCenterOn(+m[1], +m[2]);
}
// Jump to Brush — busca em todos os brushes por nome
function mapJumpToBrush() {
  if (!mapBrushData) return alert('carregue os materiais RME (📦)');
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '420px';
  box.innerHTML = '<h3>🖌 Jump to Brush</h3>';
  const inp = document.createElement('input'); inp.placeholder = 'nome do brush…'; inp.style.cssText = 'width:100%;margin-bottom:6px'; box.appendChild(inp);
  const list = document.createElement('div'); list.className = 'animBox'; list.style.maxHeight = '360px'; box.appendChild(list);
  const D = mapBrushData; const all = [];
  for (const b of D.brushes) all.push({ name: b.name, kind: 'ground' });
  for (const w of D.walls) all.push({ name: w.name, kind: 'wall' });
  for (const d of D.doodads) all.push({ name: d.name, kind: 'doodad' });
  for (const c of D.carpets) all.push({ name: c.name, kind: 'carpet' });
  for (const t of D.tables) all.push({ name: t.name, kind: 'table' });
  const draw = () => { const q = inp.value.trim().toLowerCase(); list.innerHTML = ''; let n = 0;
    for (const b of all) { if (q && !b.name.toLowerCase().includes(q)) continue; if (n++ > 200) break;
      const r = document.createElement('div'); r.className = 'animRow'; r.style.gridTemplateColumns = '1fr'; const btn = document.createElement('button'); btn.className = 'miniBtn'; btn.style.textAlign = 'left'; btn.textContent = `[${b.kind}] ${b.name}`;
      btn.onclick = () => { palBrush = { kind: b.kind, name: b.name }; palType = (b.kind === 'ground') ? 'terrain' : b.kind; $('palType').value = palType; fillTilesets(); setMapTool('paint'); renderPalette(); $('status').textContent = 'brush: ' + b.name; ov.remove(); };
      r.appendChild(btn); list.appendChild(r); } };
  inp.addEventListener('input', draw); draw(); setTimeout(() => inp.focus(), 30);
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// ========================= DATA EDITOR (monta borda/piso/parede) =========================
// grid 5×5 de borda (porta de data_editor_window.cpp) · -1=void 0=ground 1-12=edge
const DE_GRID = [[-1, 5, 1, 6, -1], [5, 9, 0, 10, 6], [4, 0, 0, 0, 2], [7, 12, 0, 11, 8], [-1, 7, 3, 8, -1]]; // n topo / s baixo / w esq / e dir (n,s e cantos/diagonais nas posições certas)
// swap 180° p/ GRAVAR: o que aparece na posição visual é salvo no edge que a engine pinta ali (n<->s, e<->w, cnw<->csw, cne<->cse, dnw<->dsw, dne<->dse)
const DE_SWAP = [0, 3, 4, 1, 2, 8, 7, 6, 5, 11, 12, 9, 10]; // 180°: n<->s, e<->w, cnw<->cse, cne<->csw, dnw<->dse, dne<->dsw (editor é 180° do layout real da engine)
const deEdgeSave = (i) => DE_EDGE[DE_SWAP[i] || i];
const DE_EDGE = ['none', 'n', 'e', 's', 'w', 'cnw', 'cne', 'csw', 'cse', 'dnw', 'dne', 'dse', 'dsw'];
function appendMaterials(file, snippet) {
  const p = path.join(mapBrushData.dir, file); let txt = fs.readFileSync(p, 'latin1');
  try { if (!fsp.existsSync(p + '.bak')) fsp.writeFileSync(p + '.bak', txt, 'latin1'); } catch (e) {}
  const i = txt.lastIndexOf('</materials>');
  txt = (i < 0) ? (txt + '\n' + snippet + '\n') : (txt.slice(0, i) + snippet + '\n' + txt.slice(i));
  fsp.writeFileSync(p, txt, 'latin1');
}
function openDataEditor(preset) {
  if (!mapBrushData) return alert('carregue os materiais RME primeiro (modo Mapa ▸ 📦)');
  if (!dat) return alert('abra o .dat/.spr');
  // ids selecionados no Object (client) → server id
  let ids = selectedIds().map((c) => serverIdOf(c)); ids = [...new Set(ids)].sort((a, b) => a - b);
  let type = preset ? preset.type : (ids.length >= 9 ? 'border' : ids.length === 4 ? 'wall' : 'ground');
  const state = preset ? preset.state : { border: {}, wall: { horizontal: 0, vertical: 0, corner: 0, pole: 0 }, ground: [], linkBorder: 0, mountBorder: 0, inner: [], center: 0, table: {}, composite: null };
  const autoFill = () => { state.border = {}; for (let i = 1; i <= 12; i++) if (ids[i - 1]) state.border[i] = ids[i - 1]; const ws = ['horizontal', 'vertical', 'corner', 'pole']; ws.forEach((w, i) => state.wall[w] = ids[i] || 0); state.ground = ids.slice(); };
  if (!preset) autoFill();
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '560px';
  const body = document.createElement('div'); body.id = '_deBody';
  const head = document.createElement('div'); head.innerHTML = `<h3>🧱 Data Editor — montar brush</h3><div class="alabel" style="font-size:11px">${preset ? ('🔍 ' + (preset.scanInfo || 'detectado pelo scan da seleção — revise e salve')) : (ids.length + ' item(ns) selecionado(s): ' + (ids.join(', ') || '(nenhum — seleciona itens no grid Object com Ctrl/Shift)'))}</div>`;
  box.appendChild(head);
  // tipo + nome + auto
  const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin:8px 0;flex-wrap:wrap';
  const tsel = document.createElement('select'); for (const o of [['border', 'Borda (12 edges)'], ['ground', 'Piso (ground)'], ['wall', 'Parede (4 tipos)'], ['mountain', 'Montanha (mountain)'], ['doodad', 'Doodad (decoração)'], ['carpet', 'Carpete (center+edges)'], ['table', 'Mesa/Table (auto-conecta)']]) { const op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; tsel.appendChild(op); } tsel.value = type;
  const nameInp = document.createElement('input'); nameInp.placeholder = 'nome do brush…'; nameInp.value = (preset && preset.name) || (type + ' custom'); nameInp.style.width = '180px';
  const autoBtn = document.createElement('button'); autoBtn.className = 'miniBtn'; autoBtn.textContent = '🔮 Auto-detectar';
  // campo da PALETTE (tileset) destino — escolhe existente ou cria uma nova
  const tsInp = document.createElement('input'); tsInp.placeholder = 'palette (tileset)…'; tsInp.value = 'Custom'; tsInp.title = 'em qual palette/tileset salvar (digite um nome novo p/ criar do zero)'; tsInp.style.width = '150px';
  const dl = document.createElement('datalist'); dl.id = '_deTilesets'; const tnames = new Set([...(mapBrushData ? mapBrushData.tilesets.order : []), 'Custom']); for (const t of tnames) { const o = document.createElement('option'); o.value = t; dl.appendChild(o); } tsInp.setAttribute('list', '_deTilesets');
  bar.append(tsel, nameInp, autoBtn, document.createTextNode('📂'), tsInp, dl); box.appendChild(bar); box.appendChild(body);
  const cellCanvas = (sid, label) => { const w = document.createElement('div'); w.style.cssText = 'display:flex;flex-direction:column;align-items:center'; const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32; cv.className = 'palIcon'; cv.style.cursor = 'pointer'; if (sid) palItemIcon(cv, sid); else { cv.getContext('2d').fillStyle = '#1a1d27'; cv.getContext('2d').fillRect(0, 0, 32, 32); } const lb = document.createElement('span'); lb.style.cssText = 'font-size:9px;color:#7a8aa8'; lb.textContent = label + (sid ? ' #' + sid : ''); w.append(cv, lb); return { w, cv }; };
  function draw() {
    type = tsel.value; body.innerHTML = ''; nameInp.style.display = (type === 'border' && !state.makeGround) ? 'none' : '';
    if (type === 'border') {
      const g = document.createElement('div'); g.style.cssText = 'display:grid;grid-template-columns:repeat(5,40px);gap:3px;justify-content:center;margin:8px 0';
      for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) { const idx = DE_GRID[r][c]; if (idx < 0) { g.appendChild(document.createElement('div')); continue; } if (idx === 0) { const d = document.createElement('div'); d.style.cssText = 'width:40px;height:40px;background:#11141c;border-radius:4px'; g.appendChild(d); continue; }
        const sid = state.border[idx] || 0; const cell = cellCanvas(sid, DE_EDGE[idx]); cell.cv.onclick = () => { const s = prompt('item id pra borda "' + DE_EDGE[idx] + '" (server id, 0=limpa):', sid || ''); if (s === null) return; state.border[idx] = parseInt(s, 10) || 0; draw(); }; g.appendChild(cell.w); }
      body.appendChild(g);
      const note = document.createElement('div'); note.className = 'alabel'; note.style.cssText = 'font-size:11px;text-align:center'; note.textContent = 'clique numa célula p/ trocar · ordem auto: n,e,s,w,cnw,cne,csw,cse,dnw,dne,dse,dsw'; body.appendChild(note);
      // ---- criar o PISO (ground) junto, já linkado nesta borda ----
      const gw = document.createElement('div'); gw.style.cssText = 'border-top:1px solid var(--border);margin-top:8px;padding-top:8px';
      const cl = document.createElement('label'); cl.className = 'opRow'; const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!state.makeGround; cb.onchange = () => { state.makeGround = cb.checked; nameInp.style.display = state.makeGround ? '' : 'none'; gr.style.display = state.makeGround ? '' : 'none'; }; cl.append(cb, document.createTextNode(' criar o PISO (ground) junto com esta borda')); gw.appendChild(cl);
      const gr = document.createElement('label'); gr.className = 'opRow'; gr.style.display = state.makeGround ? '' : 'none'; gr.innerHTML = '<span>itens do piso (ids, vírgula)</span>'; const gi = document.createElement('input'); gi.value = (state.ground || []).join(','); gi.style.width = '160px'; gi.placeholder = 'ex: 4526'; gi.onchange = () => state.ground = gi.value.split(',').map((x) => parseInt(x, 10)).filter((n) => n > 0); gr.appendChild(gi); gw.appendChild(gr);
      const gh = document.createElement('div'); gh.className = 'alabel'; gh.style.cssText = 'font-size:10px;margin-top:2px'; gh.textContent = 'marca isso → salva a borda E um piso que pinta auto-bordeando (dá um nome acima)'; gw.appendChild(gh);
      body.appendChild(gw);
    } else if (type === 'wall') {
      const g = document.createElement('div'); g.style.cssText = 'display:flex;gap:10px;justify-content:center;margin:10px 0';
      for (const w of ['horizontal', 'vertical', 'corner', 'pole']) { const cell = cellCanvas(state.wall[w], w); cell.cv.onclick = () => { const s = prompt('item id pra "' + w + '":', state.wall[w] || ''); if (s === null) return; state.wall[w] = parseInt(s, 10) || 0; draw(); }; g.appendChild(cell.w); }
      body.appendChild(g);
    } else if (type === 'mountain') {
      // montanha = piso (chão da montanha) + borda externa (penhasco) + itens internos (rochas no topo)
      const note = document.createElement('div'); note.className = 'alabel'; note.style.cssText = 'font-size:11px;text-align:center;margin-bottom:6px'; note.textContent = 'piso = chão da montanha · borda externa = penhasco em volta (id de uma Borda já criada) · internos = rochas aleatórias no topo'; body.appendChild(note);
      const g = document.createElement('div'); g.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:6px 0';
      for (const sid of state.ground) { const cell = cellCanvas(sid, 'piso'); g.appendChild(cell.w); } body.appendChild(g);
      const br = document.createElement('label'); br.className = 'opRow'; br.innerHTML = '<span>borda externa id (penhasco)</span>'; const bi = document.createElement('input'); bi.type = 'number'; bi.placeholder = '0 = nenhuma'; bi.value = state.mountBorder || ''; bi.style.width = '90px'; bi.onchange = () => state.mountBorder = parseInt(bi.value, 10) || 0; br.appendChild(bi); body.appendChild(br);
      const ir = document.createElement('label'); ir.className = 'opRow'; ir.innerHTML = '<span>itens internos (ids, vírgula)</span>'; const ii = document.createElement('input'); ii.placeholder = 'ex: 919,920,4471'; ii.value = (state.inner || []).join(','); ii.style.width = '160px'; ii.onchange = () => state.inner = ii.value.split(',').map((x) => parseInt(x, 10)).filter((n) => n > 0); ir.appendChild(ii); body.appendChild(ir);
    } else if (type === 'doodad') {
      const note = document.createElement('div'); note.className = 'alabel'; note.style.cssText = 'font-size:11px;text-align:center;margin-bottom:6px'; note.textContent = 'Doodad = decoração colocada aleatória.' + (state.composite ? ` Composição multi-tile detectada (${state.composite.length} tiles).` : ' Os itens abaixo entram como variações.'); body.appendChild(note);
      const g = document.createElement('div'); g.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:6px 0';
      for (const sid of state.ground) { g.appendChild(cellCanvas(sid, '').w); } body.appendChild(g);
      const lr = document.createElement('label'); lr.className = 'opRow'; lr.innerHTML = '<span>itens (ids, vírgula)</span>'; const li = document.createElement('input'); li.value = (state.ground || []).join(','); li.style.width = '200px'; li.onchange = () => { state.ground = li.value.split(',').map((x) => parseInt(x, 10)).filter((n) => n > 0); draw(); }; lr.appendChild(li); body.appendChild(lr);
    } else if (type === 'carpet') {
      const note = document.createElement('div'); note.className = 'alabel'; note.style.cssText = 'font-size:11px;text-align:center;margin-bottom:4px'; note.textContent = 'Carpete = centro + bordas (auto-conecta nas pontas). clique numa célula p/ trocar'; body.appendChild(note);
      const g = document.createElement('div'); g.style.cssText = 'display:grid;grid-template-columns:repeat(5,40px);gap:3px;justify-content:center;margin:8px 0';
      for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) { const idx = DE_GRID[r][c]; if (idx < 0) { g.appendChild(document.createElement('div')); continue; }
        if (idx === 0) { const sid = state.center || 0; const cell = cellCanvas(sid, 'center'); cell.cv.onclick = () => { const s = prompt('item id pro CENTRO do carpete:', sid || ''); if (s === null) return; state.center = parseInt(s, 10) || 0; draw(); }; g.appendChild(cell.w); continue; }
        const sid = state.border[idx] || 0; const cell = cellCanvas(sid, DE_EDGE[idx]); cell.cv.onclick = () => { const s = prompt('item id pra borda "' + DE_EDGE[idx] + '" (0=limpa):', sid || ''); if (s === null) return; state.border[idx] = parseInt(s, 10) || 0; draw(); }; g.appendChild(cell.w); }
      body.appendChild(g);
    } else if (type === 'table') {
      const note = document.createElement('div'); note.className = 'alabel'; note.style.cssText = 'font-size:11px;text-align:center;margin-bottom:4px'; note.textContent = 'Mesa = auto-conecta (alone/vertical/horizontal + 4 pontas). clique p/ trocar'; body.appendChild(note);
      const g = document.createElement('div'); g.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin:10px 0';
      for (const k of ['alone', 'vertical', 'horizontal', 'north', 'south', 'east', 'west']) { const sid = state.table[k] || 0; const cell = cellCanvas(sid, k); cell.cv.onclick = () => { const s = prompt('item id pra "' + k + '":', sid || ''); if (s === null) return; state.table[k] = parseInt(s, 10) || 0; draw(); }; g.appendChild(cell.w); }
      body.appendChild(g);
    } else {
      const g = document.createElement('div'); g.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:10px 0';
      for (const sid of state.ground) { const cell = cellCanvas(sid, ''); g.appendChild(cell.w); } body.appendChild(g);
      const lr = document.createElement('label'); lr.className = 'opRow'; lr.innerHTML = '<span>linkar borda id (opcional)</span>'; const li = document.createElement('input'); li.type = 'number'; li.placeholder = '0 = nenhuma'; li.value = state.linkBorder || ''; li.style.width = '90px'; li.onchange = () => state.linkBorder = parseInt(li.value, 10) || 0; lr.appendChild(li); body.appendChild(lr);
    }
  }
  tsel.onchange = draw; autoBtn.onclick = () => { type = tsel.value; autoFill(); draw(); }; draw();
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const save = document.createElement('button'); save.className = 'miniBtn accent'; save.textContent = '💾 Salvar no materials';
  save.onclick = () => { try { dataEditorSave(type, nameInp.value.trim(), state, tsInp.value.trim()); ov.remove(); } catch (e) { alert('erro ao salvar: ' + e.message); } };
  const cc = document.createElement('button'); cc.className = 'miniBtn'; cc.textContent = 'Cancelar'; cc.onclick = () => ov.remove();
  foot.append(cc, save); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
function dataEditorSave(type, name, state, tileset) {
  let maxId = 0; for (const id of mapBrushData.borders.keys()) if (id > maxId) maxId = id; let bid = maxId;
  saveBrushDef(type, name, state, { nextBorderId: () => ++bid, tileset });
  loadBrushesFrom(mapBrushData.dir); // recarrega → aparece na palette
}
// salva UM brush nos materials (sem recarregar). ctx.nextBorderId() dá ids únicos; ctx.tileset = palette destino.
function saveBrushDef(type, name, state, ctx) {
  const dir = mapBrushData.dir;
  const TS = ((ctx && ctx.tileset) || 'Custom').trim() || 'Custom';
  if (type === 'border') {
    const nid = ctx.nextBorderId();
    let items = ''; for (let i = 1; i <= 12; i++) if (state.border[i]) items += `\n\t\t<borderitem edge="${deEdgeSave(i)}" item="${state.border[i]}"/>`;
    if (!items) throw new Error('borda vazia');
    appendMaterials('borders.xml', `\t<border id="${nid}">${items}\n\t</border>`);
    $('status').textContent = `borda #${nid} salva no borders.xml (.bak feito)`;
    // cria o PISO (ground) junto, já linkado nesta borda → vira um brush paintável que auto-bordeia
    if (state.makeGround && state.ground && state.ground.length) {
      const gname = name || ('piso ' + state.ground[0] + ' (scan)'); const gfirst = state.ground[0];
      let gits = ''; for (const id of state.ground) gits += `\n\t\t<item id="${id}" chance="${Math.max(1, Math.floor(1000 / state.ground.length))}"/>`;
      appendMaterials('grounds.xml', `\t<brush name="${gname}" type="ground" server_lookid="${gfirst}">${gits}\n\t\t<border align="outer" to="none" id="${nid}"/>\n\t</brush>`);
      appendMaterials('tilesets.xml', `\t<tileset name="${TS}"><terrain><brush name="${gname}"/></terrain></tileset>`);
      $('status').textContent = `borda #${nid} + piso "${gname}" salvos (auto-bordeia ao pintar)`;
    }
  } else if (type === 'wall') {
    if (!name) throw new Error('dê um nome'); const first = state.wall.horizontal || state.wall.vertical || Object.values(state.wall).find(Boolean); if (!first) throw new Error('sem itens');
    let walls = ''; for (const w of ['horizontal', 'vertical', 'corner', 'pole']) if (state.wall[w]) walls += `\n\t\t<wall type="${w}"><item id="${state.wall[w]}" chance="100"/></wall>`;
    appendMaterials('walls.xml', `\t<brush name="${name}" type="wall" server_lookid="${first}">${walls}\n\t</brush>`);
    appendMaterials('tilesets.xml', `\t<tileset name="${TS}"><terrain><brush name="${name}"/></terrain></tileset>`);
    $('status').textContent = `parede "${name}" salva (walls.xml + tileset Custom)`;
  } else if (type === 'mountain') {
    // montanha nesta engine = ground brush + <optional> (penhasco/cliff em volta). É o que a engine pinta.
    if (!name) throw new Error('dê um nome'); if (!state.ground.length) throw new Error('sem item de piso'); const first = state.ground[0];
    // se não veio um id de penhasco mas o scan achou edges, cria a borda do cliff aqui e usa
    if (!state.mountBorder && ctx && ctx.nextBorderId) { let bitems = ''; for (let i = 1; i <= 12; i++) if (state.border[i]) bitems += `\n\t\t<borderitem edge="${deEdgeSave(i)}" item="${state.border[i]}"/>`; if (bitems) { const cid = ctx.nextBorderId(); appendMaterials('borders.xml', `\t<border id="${cid}">${bitems}\n\t</border>`); state.mountBorder = cid; } }
    if (!state.mountBorder) throw new Error('informe a "borda externa id" (penhasco) — crie uma Borda antes e use o id dela');
    let its = ''; for (const id of state.ground) its += `\n\t\t<item id="${id}" chance="${Math.max(1, Math.floor(1000 / state.ground.length))}"/>`;
    for (const id of (state.inner || []).filter((n) => n > 0)) its += `\n\t\t<item id="${id}" chance="40"/>`; // rochas internas = variações do chão
    const cliff = `\n\t\t<optional id="${state.mountBorder}"/>`;
    appendMaterials('grounds.xml', `\t<brush name="${name}" type="ground" server_lookid="${first}">${its}${cliff}\n\t</brush>`);
    appendMaterials('tilesets.xml', `\t<tileset name="${TS}"><terrain><brush name="${name}"/></terrain></tileset>`);
    $('status').textContent = `montanha "${name}" salva (grounds.xml + optional cliff + tileset Custom)`;
  } else if (type === 'doodad') {
    if (!name) throw new Error('dê um nome');
    const singles = (state.ground || []).filter((n) => n > 0); const comp = (state.composite || []).filter((t) => t && t.id);
    if (!singles.length && !comp.length) throw new Error('sem itens');
    const first = singles[0] || (comp[0] && comp[0].id) || 0;
    let inner = ''; for (const id of singles) inner += `\n\t\t<item id="${id}" chance="${Math.max(1, Math.floor(1000 / singles.length || 1))}"/>`;
    if (comp.length) { inner += `\n\t\t<composite chance="10">`; for (const t of comp) inner += `\n\t\t\t<tile x="${t.dx}" y="${t.dy}"><item id="${t.id}"/></tile>`; inner += `\n\t\t</composite>`; }
    appendMaterials('doodads.xml', `\t<brush name="${name}" type="doodad" server_lookid="${first}" draggable="true" on_blocking="false">${inner}\n\t</brush>`);
    appendMaterials('tilesets.xml', `\t<tileset name="${TS}"><doodad><brush name="${name}"/></doodad></tileset>`);
    $('status').textContent = `doodad "${name}" salvo (doodads.xml + tileset Custom)`;
  } else if (type === 'carpet') {
    if (!name) throw new Error('dê um nome'); if (!state.center) throw new Error('defina o item do CENTRO do carpete');
    let parts = `\n\t\t<carpet align="center" id="${state.center}"/>`; for (let i = 1; i <= 12; i++) if (state.border[i]) parts += `\n\t\t<carpet align="${deEdgeSave(i)}" id="${state.border[i]}"/>`;
    appendMaterials('grounds.xml', `\t<brush name="${name}" type="carpet" server_lookid="${state.center}">${parts}\n\t</brush>`);
    appendMaterials('tilesets.xml', `\t<tileset name="${TS}"><terrain><brush name="${name}"/></terrain></tileset>`);
    $('status').textContent = `carpete "${name}" salvo (grounds.xml + tileset Custom)`;
  } else if (type === 'table') {
    if (!name) throw new Error('dê um nome'); const keys = ['alone', 'vertical', 'horizontal', 'north', 'south', 'east', 'west']; const used = keys.filter((k) => state.table[k]); if (!used.length) throw new Error('sem itens'); const first = state.table[used[0]];
    let parts = ''; for (const k of used) parts += `\n\t\t<table align="${k}"><item id="${state.table[k]}" chance="10"/></table>`;
    appendMaterials('grounds.xml', `\t<brush name="${name}" type="table" server_lookid="${first}">${parts}\n\t</brush>`);
    appendMaterials('tilesets.xml', `\t<tileset name="${TS}"><terrain><brush name="${name}"/></terrain></tileset>`);
    $('status').textContent = `mesa "${name}" salva (grounds.xml + tileset Custom)`;
  } else {
    if (!name) throw new Error('dê um nome'); if (!state.ground.length) throw new Error('sem itens'); const first = state.ground[0];
    let its = ''; for (const id of state.ground) its += `\n\t\t<item id="${id}" chance="${Math.max(1, Math.floor(1000 / state.ground.length))}"/>`;
    let bord = state.linkBorder ? `\n\t\t<border align="outer" to="none" id="${state.linkBorder}"/>` : '';
    appendMaterials('grounds.xml', `\t<brush name="${name}" type="ground" server_lookid="${first}">${its}${bord}\n\t</brush>`);
    appendMaterials('tilesets.xml', `\t<tileset name="${TS}"><terrain><brush name="${name}"/></terrain></tileset>`);
    $('status').textContent = `piso "${name}" salvo (grounds.xml + tileset Custom)`;
  }
}
// ===== SCAN: 1 ou VÁRIOS exemplos numa seleção → detecta cada um (por ilhas) e monta os brushes =====
function scanSelectionToBrush() {
  if (!mapData) return alert('abra um mapa');
  if (!mapBrushData) return alert('carregue os materiais RME (modo Mapa ▸ 📦)');
  const tiles = selTiles2D();
  if (!tiles || tiles.length < 2) return alert('Faça uma SELEÇÃO sobre exemplos JÁ PINTADOS.\nDá p/ pôr VÁRIOS exemplos numa seleção só — basta separar cada um por espaços VAZIOS (1+ tile).');
  const z = mapZ;
  const cell = new Map();
  for (const [x, y] of tiles) {
    const node = mapData.map.get(x + ',' + y + ',' + z); if (!node) continue;
    const g = OTBM.getGround(node) || 0;
    const its = OTBM.itemsOf(node) || [];
    const top = its.length ? OTBM.itemId(its[its.length - 1]) : 0;
    const fill = g || top; if (!fill) continue;          // conteúdo do tile (ground OU item)
    const overlay = (g && top) ? top : 0;
    cell.set(x + ',' + y, { x, y, g, top, fill, overlay });
  }
  if (!cell.size) return alert('Seleção sem conteúdo. Selecione tiles JÁ pintados e tente de novo.');
  const clusters = clusterTiles(cell); // separa em ILHAS conectadas (cada exemplo = 1 ilha)
  const results = [];
  for (const cl of clusters) { if (!cl.length) continue; const r = analyzeCluster(cl); if (r) results.push(r); } // 1 tile = doodad solto (válido)
  if (!results.length) return alert('Não consegui identificar nenhum brush.\nPinte terreno+bordas, linha de parede ou um objeto, e tente de novo.');
  if (results.length === 1 && !results[0].existing) return openDataEditor(results[0]); // 1 brush NOVO → revisa no Data Editor
  scanBatchReview(results); // vários, ou brushes já existentes → lista de revisão e salva/organiza todos
}
// lista de revisão do scan em lote: confirma/ajusta o TIPO e o nome de cada um, depois salva todos
function scanBatchReview(results) {
  document.querySelectorAll('.scanBatchModal').forEach((m) => m.remove());
  const ov = document.createElement('div'); ov.className = 'modal scanBatchModal'; const b = document.createElement('div'); b.className = 'modalBox'; b.style.cssText = 'max-width:640px;max-height:84vh;overflow:auto';
  b.innerHTML = `<h3>🔍 Scan: ${results.length} brushes detectados</h3><div class="alabel" style="font-size:11px;margin-bottom:8px">Confirme/ajuste o <b>tipo</b> e o <b>nome</b> de cada um (carpet/table/montanha não dá p/ adivinhar só pela forma — troque aqui se for o caso). Escolha a <b>palette</b> destino (ou digite uma nova p/ criar do zero).</div>`;
  // palette destino (cria do zero ou usa existente)
  const tsBar = document.createElement('div'); tsBar.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:8px'; const tsl = document.createElement('span'); tsl.className = 'alabel'; tsl.textContent = '📂 Palette:'; const tsInp = document.createElement('input'); tsInp.value = 'Scan'; tsInp.placeholder = 'nome da palette/tileset'; tsInp.style.flex = '1'; tsInp.title = 'digite um nome novo p/ criar uma palette do zero, ou um existente p/ adicionar nela';
  const dl = document.createElement('datalist'); dl.id = '_scanTilesets'; for (const t of new Set([...(mapBrushData ? mapBrushData.tilesets.order : []), 'Custom'])) { const o = document.createElement('option'); o.value = t; dl.appendChild(o); } tsInp.setAttribute('list', '_scanTilesets');
  tsBar.append(tsl, tsInp, dl); b.appendChild(tsBar);
  const TYPES = [['border', 'Borda (+piso)'], ['ground', 'Piso'], ['wall', 'Parede'], ['mountain', 'Montanha'], ['doodad', 'Doodad'], ['carpet', 'Carpete'], ['table', 'Mesa']];
  results.forEach((r, i) => {
    const card = document.createElement('div'); card.className = 'scanCard';
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:6px;align-items:center';
    const idx = document.createElement('span'); idx.className = 'alabel'; idx.style.width = '18px'; idx.textContent = (i + 1) + '.';
    const ts = document.createElement('select'); for (const [v, l] of TYPES) { const o = document.createElement('option'); o.value = v; o.textContent = l; ts.appendChild(o); } ts.value = r.type;
    const nm = document.createElement('input'); nm.value = r.name; nm.style.flex = '1'; nm.oninput = () => r.name = nm.value;
    const info = document.createElement('span'); info.className = 'alabel'; info.style.cssText = 'font-size:10px;width:110px;text-align:right'; info.textContent = r.scanInfo;
    row.append(idx, ts, nm, info); card.appendChild(row);
    let prev = scanResultPreview(r); card.appendChild(prev);
    ts.onchange = () => { r.type = ts.value; const np = scanResultPreview(r); card.replaceChild(np, prev); prev = np; }; // troca o tipo → atualiza o visual
    b.appendChild(card);
  });
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const go = document.createElement('button'); go.className = 'miniBtn accent'; go.textContent = `💾 Salvar todos (${results.length})`; go.onclick = () => { const ts = tsInp.value.trim() || 'Custom'; ov.remove(); saveScanBatch(results, ts); };
  const cl = document.createElement('button'); cl.className = 'miniBtn'; cl.textContent = 'Cancelar'; cl.onclick = () => ov.remove();
  foot.append(go, cl); b.appendChild(foot); ov.appendChild(b); document.body.appendChild(ov);
}
// monta o PREVIEW visual de um brush detectado (grid de edges / itens) p/ a lista de revisão
function scanResultPreview(r) {
  prepareStateForType(r);
  const s = r.state;
  const box = document.createElement('div'); box.className = 'scanPrev';
  const EI = { n: 1, e: 2, s: 3, w: 4, cnw: 5, cne: 6, csw: 7, cse: 8, dnw: 9, dne: 10, dse: 11, dsw: 12 };
  // tile colado (32px, sem borda) p/ formar a "imagem pintada"
  const tile = (sid) => { const cv = document.createElement('canvas'); cv.width = cv.height = 32; cv.className = 'scanTile'; cv.title = sid ? '#' + sid : 'vazio'; if (sid) palItemIcon(cv, sid); else { const c = cv.getContext('2d'); c.fillStyle = '#0b0d12'; c.fillRect(0, 0, 32, 32); } return cv; };
  const labeled = (sid, lbl) => { const w = document.createElement('div'); w.className = 'scanPrevCell'; w.appendChild(tile(sid)); if (lbl) { const t = document.createElement('span'); t.textContent = lbl; w.appendChild(t); } return w; };
  if (r.type === 'border' || r.type === 'ground' || r.type === 'mountain' || r.type === 'carpet') {
    // 3×3 igual pintado: ground/centro no meio + bordas coladas em volta
    const centerId = (r.type === 'carpet') ? (s.center || 0) : (s.ground && s.ground[0] || 0);
    const edgeOf = (en) => (s.border[EI[en]] || 0);
    const POS = [['cnw', 'n', 'cne'], ['w', null, 'e'], ['csw', 's', 'cse']];
    const g = document.createElement('div'); g.className = 'scanPrevPatch';
    for (const row of POS) for (const en of row) g.appendChild(tile(en === null ? centerId : edgeOf(en)));
    box.appendChild(g);
    // diagonais (cantos côncavos) numa linha extra, se houver
    const dg = ['dnw', 'dne', 'dse', 'dsw'].filter((d) => edgeOf(d));
    if (dg.length) { const dl = document.createElement('div'); dl.className = 'scanPrev'; dl.style.marginTop = '4px'; for (const d of dg) dl.appendChild(labeled(edgeOf(d), d)); box.appendChild(dl); }
  } else if (r.type === 'wall') {
    // cruz: vertical em cima/baixo, horizontal nos lados, corner no meio
    const w = s.wall; const cells = [0, w.vertical, 0, w.horizontal, w.corner || w.pole, w.horizontal, 0, w.vertical, 0];
    const g = document.createElement('div'); g.className = 'scanPrevPatch'; for (const sid of cells) g.appendChild(tile(sid || 0)); box.appendChild(g);
  } else if (r.type === 'table') {
    const tb = s.table || {}; for (const k of ['west', 'horizontal', 'east']) box.appendChild(labeled(tb[k] || tb.alone || 0, k));
  } else { // doodad
    if (s.composite && s.composite.length) { // monta o OBJETO na posição (igual pintado)
      let mx = 0, my = 0; for (const t of s.composite) { if (t.dx > mx) mx = t.dx; if (t.dy > my) my = t.dy; }
      const grid = {}; for (const t of s.composite) grid[t.dx + ',' + t.dy] = t.id;
      const g = document.createElement('div'); g.className = 'scanPrevPatch'; g.style.gridTemplateColumns = `repeat(${mx + 1}, 32px)`;
      for (let y = 0; y <= my; y++) for (let x = 0; x <= mx; x++) g.appendChild(tile(grid[x + ',' + y] || 0));
      box.appendChild(g);
    } else for (const id of (s.ground || []).slice(0, 12)) box.appendChild(tile(id));
  }
  return box;
}
// ajusta o state pro tipo escolhido (converte borda↔carpete, parede↔mesa, etc.)
function prepareStateForType(r) {
  const s = r.state;
  if (r.type === 'carpet') { if (!s.center) s.center = r.domFill || r.domG || (s.ground && s.ground[0]) || 0; }
  else if (r.type === 'table') { if (!Object.keys(s.table || {}).length || !Object.values(s.table).some(Boolean)) { s.table = { vertical: s.wall.vertical, horizontal: s.wall.horizontal, alone: s.wall.pole || s.wall.corner || s.wall.horizontal, north: s.wall.corner, south: s.wall.corner, east: s.wall.corner, west: s.wall.corner }; } }
  else if (r.type === 'mountain') { if (!s.ground || !s.ground.length) s.ground = [r.domG || r.domFill].filter(Boolean); /* mountBorder é resolvido no saveBrushDef a partir dos edges */ }
}
// separa os tiles em grupos conectados (8-vizinhança) — cada grupo = um exemplo distinto
function clusterTiles(cell) {
  const visited = new Set(), clusters = [];
  for (const [k, c0] of cell) {
    if (visited.has(k)) continue;
    const stack = [c0]; visited.add(k); const cl = [];
    while (stack.length) { const c = stack.pop(); cl.push(c); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const nk = (c.x + dx) + ',' + (c.y + dy); if (cell.has(nk) && !visited.has(nk)) { visited.add(nk); stack.push(cell.get(nk)); } } }
    clusters.push(cl);
  }
  return clusters;
}
// índice: item de borda → nome do edge (n/e/s/w/cnw…) conforme DEFINIDO nos borders.xml dos materiais
function borderItemEdgeIndex() {
  if (!mapBrushData) return new Map();
  if (mapBrushData._borderEdge) return mapBrushData._borderEdge;
  const idx = new Map();
  for (const [, edges] of mapBrushData.borders || []) { for (const edge in edges) { const item = edges[edge]; if (item && !idx.has(item)) idx.set(item, edge); } }
  mapBrushData._borderEdge = idx; return idx;
}
// índice item → { type, name } do brush EXISTENTE nos materiais (montanha/carpete/doodad/parede/ground)
function itemBrushIndex() {
  if (!mapBrushData) return new Map();
  if (mapBrushData._itemBrush) return mapBrushData._itemBrush;
  const idx = new Map(); const set = (id, type, name) => { if (id && !idx.has(id)) idx.set(id, { type, name }); };
  // prioridade: ground/montanha primeiro (são os "chãos"), depois carpet/table/wall, doodad por último
  for (const b of mapBrushData.brushes || []) { const ty = (b.optional != null) ? 'mountain' : 'ground'; for (const id of b.items || []) set(id, ty, b.name); if (b.lookid) set(b.lookid, ty, b.name); }
  for (const c of mapBrushData.carpets || []) for (const id of c.allIds || []) set(id, 'carpet', c.name);
  for (const t of mapBrushData.tables || []) for (const id of t.allIds || []) set(id, 'table', t.name);
  for (const w of mapBrushData.walls || []) { const ww = w.walls || {}; for (const o in ww) for (const id of ww[o]) set(id, 'wall', w.name); }
  for (const d of mapBrushData.doodads || []) { for (const id of d.singles || []) set(id, 'doodad', d.name); for (const comp of d.composites || []) for (const tt of comp) set(tt.id, 'doodad', d.name); }
  mapBrushData._itemBrush = idx; return idx;
}
// índice item → orientação da PAREDE (horizontal/vertical/corner/pole) dos materiais — pra montar wall certo no scan
function wallItemTypeIndex() {
  if (!mapBrushData) return new Map();
  if (mapBrushData._wallType) return mapBrushData._wallType;
  const idx = new Map();
  for (const w of mapBrushData.walls || []) { const ww = w.walls || {}; for (const o in ww) for (const id of ww[o]) if (id && !idx.has(id)) idx.set(id, o); }
  mapBrushData._wallType = idx; return idx;
}
// índice item → align do CARPETE (center/n/e/s/w/cnw…) do grounds.xml
function carpetItemAlignIndex() {
  if (!mapBrushData) return new Map();
  if (mapBrushData._carpetAlign) return mapBrushData._carpetAlign;
  const idx = new Map();
  for (const c of mapBrushData.carpets || []) { const al = c.aligns || {}; for (const a in al) { const id = al[a]; if (id && !idx.has(id)) idx.set(id, a); } }
  mapBrushData._carpetAlign = idx; return idx;
}
// índice item → align da MESA (north/south/east/west/vertical/horizontal/alone) do grounds.xml
function tableItemAlignIndex() {
  if (!mapBrushData) return new Map();
  if (mapBrushData._tableAlign) return mapBrushData._tableAlign;
  const idx = new Map();
  for (const t of mapBrushData.tables || []) { const al = t.aligns || {}; for (const a in al) for (const it of (al[a] || [])) { if (it.id && !idx.has(it.id)) idx.set(it.id, a); } }
  mapBrushData._tableAlign = idx; return idx;
}
// índice item → nome do WALL brush
function wallItemNameIndex() {
  if (!mapBrushData) return new Map();
  if (mapBrushData._wallName) return mapBrushData._wallName;
  const idx = new Map();
  for (const w of mapBrushData.walls || []) { const ww = w.walls || {}; for (const o in ww) for (const id of ww[o]) if (id && !idx.has(id)) idx.set(id, w.name); }
  mapBrushData._wallName = idx; return idx;
}
// índice item → nome do CARPET brush
function carpetItemNameIndex() {
  if (!mapBrushData) return new Map();
  if (mapBrushData._carpetName) return mapBrushData._carpetName;
  const idx = new Map();
  for (const c of mapBrushData.carpets || []) { const al = c.aligns || {}; for (const a in al) { const id = al[a]; if (id && !idx.has(id)) idx.set(id, c.name); } }
  mapBrushData._carpetName = idx; return idx;
}
// índice item → nome do TABLE brush
function tableItemNameIndex() {
  if (!mapBrushData) return new Map();
  if (mapBrushData._tableName) return mapBrushData._tableName;
  const idx = new Map();
  for (const t of mapBrushData.tables || []) { const al = t.aligns || {}; for (const a in al) for (const it of (al[a] || [])) if (it.id && !idx.has(it.id)) idx.set(it.id, t.name); }
  mapBrushData._tableName = idx; return idx;
}
// analisa UM exemplo (lista de tiles) → {type,name,state,scanInfo} ou null
function analyzeCluster(arr) {
  const cell = new Map(); for (const c of arr) cell.set(c.x + ',' + c.y, c);
  const fillCount = {}, groundCount = {};
  for (const c of arr) { fillCount[c.fill] = (fillCount[c.fill] || 0) + 1; if (c.g) groundCount[c.g] = (groundCount[c.g] || 0) + 1; }
  let domFill = 0, bf = 0; for (const k in fillCount) if (fillCount[k] > bf) { bf = fillCount[k]; domFill = +k; }
  let domG = 0, bg = 0; for (const k in groundCount) if (groundCount[k] > bg) { bg = groundCount[k]; domG = +k; }
  const diff = (x, y) => { const c = cell.get(x + ',' + y); return !!(c && c.fill !== domFill); };
  // bits dos vizinhos na ordem do engine: NW N NE W E SW S SE (mesma do BORDER_TABLE)
  const OFF8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const invTd = (td) => { let r = 0; for (const [a, b] of [[1, 128], [2, 64], [4, 32], [8, 16]]) { if (td & a) r |= b; if (td & b) r |= a; } return r; }; // reflete pelo centro (N↔S, E↔W, diagonais)
  const EI = { n: 1, e: 2, s: 3, w: 4, cnw: 5, cne: 6, csw: 7, cse: 8, dnw: 9, dne: 10, dse: 11, dsw: 12 };
  const be = borderItemEdgeIndex();
  const wi = wallItemTypeIndex();
  const ci = carpetItemAlignIndex();
  const ti = tableItemAlignIndex();
  const edgeVotes = {}, otherTiles = [], wallKnown = [], carpetKnown = [], tableKnown = [];
  const addEdge = (eid, item) => { (edgeVotes[eid] = edgeVotes[eid] || {})[item] = (edgeVotes[eid][item] || 0) + 1; };
  for (const c of arr) {
    const item = c.overlay || c.fill;
    if (item && wi.has(item)) { wallKnown.push({ type: wi.get(item), id: item }); continue; } // PAREDE CONHECIDA → orientação exata dos materials (não vira borda)
    if (item && ci.has(item)) { carpetKnown.push({ align: ci.get(item), id: item }); continue; } // CARPETE CONHECIDO → align exato dos materials
    if (item && ti.has(item)) { tableKnown.push({ align: ti.get(item), id: item }); continue; } // MESA CONHECIDA → align exato dos materials
    const bItem = c.overlay || (c.fill !== domFill ? c.fill : 0);
    if (bItem && be.has(bItem)) { addEdge(EI[be.get(bItem)], bItem); continue; } // BORDA CONHECIDA → edge exato dos materials (100% certo)
    if (c.overlay) {
      // CASO A — borda overlay desconhecida: tabela do engine direto (td = vizinhos de ground diferente)
      let td = 0; for (let i = 0; i < 8; i++) { const nc = cell.get((c.x + OFF8[i][0]) + ',' + (c.y + OFF8[i][1])); const same = nc && nc.g === c.g; if (!same) td |= (1 << i); }
      const packed = (RB.BORDER_TABLE[td] || 0) >>> 0;
      if (!packed) { otherTiles.push(c); continue; }
      for (let sh = 0; sh < 4; sh++) { const eid = (packed >>> (sh * 8)) & 0xFF; if (!eid) break; addEdge(eid, c.overlay); }
    } else if (c.fill !== domFill) {
      // CASO B — pintado no limpo, borda desconhecida: tabela INVERTIDA (a borda vira pro fill)
      let fd = 0; for (let i = 0; i < 8; i++) { const nc = cell.get((c.x + OFF8[i][0]) + ',' + (c.y + OFF8[i][1])); if (nc && nc.fill === domFill) fd |= (1 << i); }
      if (!fd) { otherTiles.push(c); continue; }
      const packed = (RB.BORDER_TABLE[invTd(fd)] || 0) >>> 0;
      if (!packed) { otherTiles.push(c); continue; }
      for (let sh = 0; sh < 4; sh++) { const eid = (packed >>> (sh * 8)) & 0xFF; if (!eid) break; addEdge(eid, c.fill); }
    }
  }
  const state = { border: {}, wall: { horizontal: 0, vertical: 0, corner: 0, pole: 0 }, ground: [], linkBorder: 0, mountBorder: 0, inner: [], composite: null };
  const topVote = (v) => { let bi = 0, bc = 0; for (const id in v) if (v[id] > bc) { bc = v[id]; bi = +id; } return bi; };
  let edgeCount = 0;
  for (const eid in edgeVotes) { const bi = topVote(edgeVotes[eid]); if (bi) { state.border[+eid] = bi; edgeCount++; } } // eid (1-12) = índice DE direto
  const gset = new Set(); for (const c of arr) if (c.g) gset.add(c.g);
  state.ground = domG ? [domG, ...[...gset].filter((g) => g !== domG)] : (domFill ? [domFill] : []);
  const wallVotes = { horizontal: {}, vertical: {}, corner: {}, pole: {} };
  for (const w of wallKnown) { const k = wallVotes[w.type] ? w.type : 'pole'; wallVotes[k][w.id] = (wallVotes[k][w.id] || 0) + 1; } // paredes conhecidas → orientação dos materials
  for (const c of otherTiles) { const id = c.overlay || c.fill; const h = diff(c.x - 1, c.y) || diff(c.x + 1, c.y); const v = diff(c.x, c.y - 1) || diff(c.x, c.y + 1); const k = (h && v) ? 'corner' : h ? 'horizontal' : v ? 'vertical' : 'pole'; wallVotes[k][id] = (wallVotes[k][id] || 0) + 1; }
  for (const k in wallVotes) { const bi = topVote(wallVotes[k]); if (bi) state.wall[k] = bi; }
  const wallCount = wallKnown.length;
  // CARPETE: align EXATO dos materials (center + n/e/s/w/cnw…) — sem DE_SWAP (não é chute de geometria)
  const carpetCount = carpetKnown.length, tableCount = tableKnown.length;
  if (carpetCount) { const cv = {}; for (const k of carpetKnown) { (cv[k.align] = cv[k.align] || {})[k.id] = (cv[k.align][k.id] || 0) + 1; } for (const a in cv) { const id = topVote(cv[a]); if (a === 'center') state.center = id; else if (EI[a]) state.border[DE_SWAP[EI[a]]] = id; } } // edges no state.border (pré-swap → save devolve o align exato; Data Editor/preview mostram via state.border igual bordas)
  // MESA: align EXATO dos materials (north/south/east/west/vertical/horizontal/alone)
  if (tableCount) { state.table = {}; const tv = {}; for (const k of tableKnown) { (tv[k.align] = tv[k.align] || {})[k.id] = (tv[k.align][k.id] || 0) + 1; } for (const a in tv) state.table[a] = topVote(tv[a]); }
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const c of otherTiles) { if (c.x < minx) minx = c.x; if (c.x > maxx) maxx = c.x; if (c.y < miny) miny = c.y; if (c.y > maxy) maxy = c.y; }
  const bw = maxx - minx + 1, bh = maxy - miny + 1;
  const isLine = otherTiles.length >= 2 && Math.min(bw, bh) <= 1;
  const fillId = domFill || domG;
  const doodadFrom = () => { const ids = [...new Set(arr.map((c) => c.overlay || c.fill))]; if (arr.length <= 16 && bw * bh <= 36) { state.composite = arr.map((c) => ({ dx: c.x - minx, dy: c.y - miny, id: c.overlay || c.fill })); state.ground = ids; } else state.ground = ids; };
  // TIPO vindo dos MATERIAIS: procura entre TODOS os itens do exemplo um que seja um brush-base conhecido
  // (prioriza ground/montanha/carpete/mesa — o "chão" identifica o tipo mesmo se não for o dominante) → CRIA um brush NOVO
  const idxB = itemBrushIndex(), BASE = ['mountain', 'ground', 'carpet', 'table'];
  let eb = null, baseId = fillId;
  for (const fid in fillCount) { const e = idxB.get(+fid); if (!e) continue; if (!eb || (BASE.includes(e.type) && !BASE.includes(eb.type))) { eb = e; baseId = +fid; } }
  const mt = eb ? eb.type : null;
  let type, scanInfo;
  if (carpetCount && carpetCount >= edgeCount && carpetCount >= wallCount) { type = 'carpet'; if (!state.center) state.center = baseId; scanInfo = `🟥 carpete · ${carpetCount} peça(s)`; } // peças de carpete conhecidas → align exato dos materials
  else if (tableCount && tableCount >= edgeCount && tableCount >= wallCount) { type = 'table'; scanInfo = `🪑 mesa · ${tableCount} peça(s)`; }
  else if (wallCount && wallCount >= edgeCount) { type = 'wall'; scanInfo = `🧱 parede · ${wallCount} peça(s)`; } // peças de parede conhecidas dominam → wall (orientação dos materials)
  else if (mt === 'mountain') { type = 'mountain'; state.ground = [baseId]; state.makeGround = false; scanInfo = `🏔 montanha #${baseId} · ${edgeCount} cliff edges`; }
  else if (mt === 'carpet') { type = 'carpet'; state.center = baseId; scanInfo = `🟥 carpete #${baseId} · ${edgeCount} edges`; }
  else if (mt === 'table') { type = 'table'; scanInfo = `🪑 mesa #${baseId}`; }
  else if (mt === 'doodad') { type = 'doodad'; doodadFrom(); scanInfo = `🌳 doodad #${baseId}`; }
  else if (mt === 'wall') { type = 'wall'; scanInfo = `🧱 parede #${baseId}`; }
  else if (mt === 'ground') { if (edgeCount >= 2) { type = 'border'; state.ground = [baseId]; state.makeGround = true; scanInfo = `🌱 piso #${baseId} + ${edgeCount} edges`; } else { type = 'ground'; state.ground = [baseId]; scanInfo = `piso #${baseId}`; } }
  // sem match nos materiais → geometria pura
  else if (edgeCount >= 2) { type = 'border'; state.ground = fillId ? [fillId] : []; state.makeGround = !!fillId; scanInfo = `${edgeCount}/12 edges${fillId ? ' + piso #' + fillId : ''}`; }
  else if (domG) { type = 'ground'; state.ground = [domG]; scanInfo = `piso #${domG}`; }
  else if (otherTiles.length && isLine) { type = 'wall'; scanInfo = `parede ${otherTiles.length} tiles`; }
  else if (otherTiles.length) { type = 'doodad'; const ids = [...new Set(otherTiles.map((c) => c.overlay || c.fill))]; if (otherTiles.length <= 16 && bw * bh <= 36) { state.composite = otherTiles.map((c) => ({ dx: c.x - minx, dy: c.y - miny, id: c.overlay || c.fill })); state.ground = ids; } else state.ground = ids; scanInfo = `doodad ${otherTiles.length} tiles`; }
  else if (domFill) { type = 'doodad'; doodadFrom(); scanInfo = `doodad ${arr.length} tile(s)`; }
  else return null;
  const nm = ((eb && eb.name) || mapBrushData.groundToBrush.get(fillId) || ('scan' + (fillId || 'x'))) + ' (scan)';
  return { type, name: nm, state, scanInfo, domFill, domG };
}
// salva VÁRIOS brushes do scan de uma vez (ids de borda únicos + nomes únicos)
function saveScanBatch(results, tileset) {
  let maxId = 0; for (const id of mapBrushData.borders.keys()) if (id > maxId) maxId = id; let bid = maxId;
  const ctx = { nextBorderId: () => ++bid, tileset: tileset || 'Custom' };
  const used = new Set(); for (const r of results) { let nm = r.name; let i = 2; while (used.has(nm)) nm = r.name.replace(/ \(scan\)$/, '') + ' ' + (i++) + ' (scan)'; used.add(nm); r.name = nm; }
  let n = 0; const errs = [];
  for (const r of results) {
    try {
      if (r.existing) { const sec = r.type === 'doodad' ? 'doodad' : 'terrain'; appendMaterials('tilesets.xml', `\t<tileset name="${ctx.tileset}"><${sec}><brush name="${r.brushName}"/></${sec}></tileset>`); } // brush JÁ existe → só referencia na palette
      else { prepareStateForType(r); saveBrushDef(r.type, r.name, r.state, ctx); }
      n++;
    } catch (e) { errs.push(r.name + ': ' + (e.message || e)); }
  }
  loadBrushesFrom(mapBrushData.dir);
  $('status').textContent = `✅ ${n} brush(es) organizados na palette "${ctx.tileset}"${errs.length ? ' · ' + errs.length + ' falharam' : ''}`;
  if (errs.length) alert('Alguns não salvaram:\n' + errs.join('\n'));
}
// Novo mapa vazio / redimensionar
function mapNewEmpty() {
  const s = prompt('Novo mapa vazio — largura, altura:', '1024, 1024'); if (!s) return;
  const m = s.match(/(\d+)\D+(\d+)/); if (!m) return alert('formato: largura, altura');
  if (mapData && mapData._dirty && !confirm('Descartar o mapa atual (não salvo)?')) return;
  mapData = OTBM.createEmpty(+m[1], +m[2]); mapPath = null; mapZ = 7;
  mapUndo = []; mapRedo = []; mapSel = null; mapSpawns = null; mapSpawnRaw = null; mapSpawnPath = null; _miniDirty = true;
  mapCenterOn((+m[1]) >> 1, (+m[2]) >> 1);
  $('mapSave').style.display = ''; $('mapInfo').textContent = `novo mapa vazio ${m[1]}×${m[2]} — comece a pintar`; updateMapBtns(); reqMap();
}
function mapResizeDo() {
  if (!mapData) return; const s = prompt('Redimensionar — largura, altura:', `${mapData.width}, ${mapData.height}`); if (!s) return;
  const m = s.match(/(\d+)\D+(\d+)/); if (!m) return; OTBM.resize(mapData, +m[1], +m[2]); $('mapSave').style.display = ''; $('status').textContent = `mapa ${mapData.width}×${mapData.height}`;
}
// Limpar casas inválidas (house tile sem houseId) + remover corpses (por nome no items.xml)
function mapClearInvalidHouses() {
  if (!mapData) return; let n = 0; strokeBegin();
  for (const [k, node] of mapData.map) { if (node.type === 14 && OTBM.getHouseId(node) === 0) { const p = k.split(',').map(Number); strokeTouch(k); OTBM.setHouseTile(mapData, p[0], p[1], p[2], 0); n++; } }
  strokeEnd(); if (n) { mapData._dirty = true; $('mapSave').style.display = ''; reqMap(); } $('status').textContent = `${n} house tile(s) inválido(s) limpo(s)`;
}
function mapRemoveCorpsesDo() {
  if (!mapData) return;
  const rx = /corpse|remains|dead (rat|human|body|dog|sheep|wolf)|blood|pool of|slain|carcass|\bbones\b|skeleton of/i;
  const isCorpse = (sid) => { const cid = (otbMap && otbMap.get(sid)) || sid; return rx.test(itemNameOf(cid) || ''); };
  const hits = []; for (const [k, node] of mapData.map) for (const it of OTBM.itemNodes(node)) { const sid = it.props.readUInt16LE(0); if (isCorpse(sid)) { hits.push([k, sid]); break; } }
  if (!hits.length) return alert('nenhum corpse achado (busca por nome no items.xml — carregue items.otb+items.xml)');
  if (!confirm(`Remover corpses de ${hits.length} tile(s)?`)) return;
  strokeBegin();
  for (const [k] of hits) { const node = mapData.map.get(k); if (!node) continue; strokeTouch(k); for (const it of OTBM.itemNodes(node)) { const sid = it.props.readUInt16LE(0); if (isCorpse(sid)) OTBM.removeItemId(mapData, node, sid); } }
  strokeEnd(); mapData._dirty = true; _miniDirty = true; $('mapSave').style.display = ''; reqMap(); $('status').textContent = `corpses removidos de ${hits.length} tile(s)`;
}
function mapStatsShow() {
  if (!mapData) return; const st = OTBM.stats(mapData);
  const top = [...st.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  alert(`Mapa: ${st.tiles} tiles · ${st.items} itens · ${mapData.towns.length} towns · ${mapData.houses} house-tiles\n\nItens mais usados (serverId × qtd):\n` + top.map(([id, c]) => `  ${id} × ${c}`).join('\n'));
}
function mapCleanup() {
  if (!mapData || !dat) return alert('carregue .dat também');
  // acha ids inválidos (serverId que não tem thing no client)
  const st = OTBM.stats(mapData); const invalid = [];
  for (const id of st.counts.keys()) { const cid = (otbMap && otbMap.get(id)) || id; if (!dat.item(cid)) invalid.push(id); }
  if (!invalid.length) return alert('nenhum item inválido 👍');
  if (!confirm(`Remover ${invalid.length} tipo(s) de item inválido (sem sprite no client)?\nids: ${invalid.slice(0, 20).join(', ')}${invalid.length > 20 ? '…' : ''}`)) return;
  const invSet = new Set(invalid); let removed = 0;
  strokeBegin();
  for (const [k, n] of mapData.map) {
    let hit = false; for (const c of n.children) if (c.type === 6 && invSet.has(c.props.readUInt16LE(0))) { hit = true; break; }
    const g = (() => { for (const id of OTBM.itemsOf(n)) if (invSet.has(OTBM.itemId(id))) return true; return false; })();
    if (hit || g) { strokeTouch(k); for (const id of invalid) OTBM.removeItemId(mapData, n, id); if (invSet.has(OTBM.getGround(n))) OTBM.setGround(mapData, n._x, n._y, n._z, 0); removed++; }
  }
  // dedupe itens repetidos + remove tiles vazios
  let dup = 0; for (const n of mapData.map.values()) dup += OTBM.dedupeTile(mapData, n);
  const empty = OTBM.removeEmptyTiles(mapData);
  strokeEnd(); mapUndo = []; mapRedo = []; updateMapBtns(); _miniDirty = true; reqMap();
  $('status').textContent = `cleanup: ${invalid.length} ids inválidos (${removed} tiles) · ${dup} duplicados · ${empty} tiles vazios removidos`;
}
async function mapSaveAs() {
  if (!mapData) return; const f = await ipcRenderer.invoke('save-file', 'mapa.otbm'); if (!f) return;
  try { OTBM.save(mapData, f); mapPath = f; $('mapSave').style.display = 'none'; $('status').textContent = 'salvo como ' + f; } catch (e) { alert('erro: ' + e.message); }
}
async function mapMerge() {
  if (!mapData) return; const f = await ipcRenderer.invoke('pick-file', ['otbm']); if (!f) return;
  let other; try { other = OTBM.parse(f); } catch (e) { return alert('otbm inválido: ' + e.message); }
  // posição: tile sob o hover (ou centro), ancorado no canto do outro mapa
  let bx = 1e9, by = 1e9; for (const n of other.map.values()) { if (n._x < bx) bx = n._x; if (n._y < by) by = n._y; }
  const p = _mapLastHover ? _mapLastHover.split(',').map(Number) : [mapData.width >> 1, mapData.height >> 1, mapZ];
  if (!confirm(`Mesclar ${other.map.size} tiles de "${f.split(/[\\/]/).pop()}" a partir de ${p[0]},${p[1]},${mapZ}?`)) return;
  const n = OTBM.mergeRegion(mapData, other, p[0] - bx, p[1] - by, mapZ - (other.zmin || 7));
  mapUndo = []; mapRedo = []; updateMapBtns(); _miniDirty = true; $('mapSave').style.display = ''; reqMap();
  $('status').textContent = `merge: ${n} tiles importados (undo limpo)`;
}
let mapHist = [];
function mapPushHist() { mapHist.push({ ox: mapOX, oy: mapOY, z: mapZ }); if (mapHist.length > 50) mapHist.shift(); }
function mapBack() { const h = mapHist.pop(); if (!h) return; mapOX = h.ox; mapOY = h.oy; mapZ = h.z; reqMap(); }
// rola a câmera do mapa (setas) — passo de 2 tiles
function mapPan(dx, dy) { if (!mapData) return; mapOX += dx * 2; mapOY += dy * 2; reqMap(); }
// pan contínuo e suave (segura a seta → rola por tempo, sub-tile) — tipo RME, sem "tile em tile"
const _panHeld = new Set(); let _panRAF = null, _panLast = null;
const _panSeen = new Map(); // dir -> ts do último keydown. Failsafe: se o keyup se perder (travada), solta.
function panHold(dir) { if (!mapData) return; _panHeld.add(dir); _panSeen.set(dir, performance.now()); if (!_panRAF) { _panLast = null; _panRAF = requestAnimationFrame(panTick); } }
function panTick(t) {
  // OVERLOAD: se o frame anterior travou (>500ms), o main thread está saturado e o input (keyup) starva →
  // pan infinito. PARA o pan (input se recupera; é só re-apertar). Não afeta hold normal (frames <16ms).
  if (_panLast != null && (t - _panLast) > 500) { _panHeld.clear(); _panRAF = null; $('status').textContent = '⏸ pan pausado (frame pesado) — solte e aperte de novo'; reqMap(); return; }
  // FAILSAFE keyup perdido (WebView2 sob carga): solta a direção sem NENHUM keydown há >1,5s. NÃO é limite de
  // hold — segurar gera auto-repeat (~30/s) que renova _panSeen; só dispara quando tu REALMENTE soltou e o keyup sumiu.
  const _pn = performance.now(); for (const d of _panHeld) if (_pn - (_panSeen.get(d) || _pn) > 1500) _panHeld.delete(d);
  // sem corte por tempo: anda enquanto a seta estiver segurada. Quem para é o keyup (+ failsafe acima + blur).
  if (mode !== 'map' || !mapData || !_panHeld.size) { _panRAF = null; reqMap(); return; } // parou → 1 render COMPLETO
  if (_panLast == null) _panLast = t; const dt = Math.min(0.05, (t - _panLast) / 1000); _panLast = t;
  const tsz = 32 * mapZoom; const speed = 900 / Math.max(7, tsz); // tiles/seg ~ velocidade de tela constante
  let dx = 0, dy = 0;
  if (_panHeld.has('ArrowLeft')) dx -= 1; if (_panHeld.has('ArrowRight')) dx += 1;
  if (_panHeld.has('ArrowUp')) dy -= 1; if (_panHeld.has('ArrowDown')) dy += 1;
  mapOX += dx * speed * dt; mapOY += dy * speed * dt;
  // SEM warmMapViewport async aqui (criava trabalho concorrente que acumulava RAM no pan): o próprio
  // renderMap já enfileira os sprites faltando, que chegam e aparecem no frame seguinte.
  renderMap();
  _panRAF = requestAnimationFrame(panTick);
}
function mapMoveSel(dx, dy) {
  if (!mapSel) return; const keys = selKeys();
  const data = keys.map((k) => { const p = k.split(',').map(Number); return { x: p[0], y: p[1], items: OTBM.itemsOf(mapData.map.get(k)).map(OTBM.itemId) }; });
  strokeBegin();
  for (const k of keys) { strokeTouch(k); OTBM.clearTile(mapData, k); }
  for (const d of data) { const nk = (d.x + dx) + ',' + (d.y + dy) + ',' + mapZ; strokeTouch(nk); OTBM.clearTile(mapData, nk); OTBM.setTileItems(mapData, d.x + dx, d.y + dy, mapZ, d.items); }
  strokeEnd(); mapSel = { x0: mapSel.x0 + dx, y0: mapSel.y0 + dy, x1: mapSel.x1 + dx, y1: mapSel.y1 + dy }; reqMap();
}
function borderizeMap() {
  if (!mapData || !mapBrushData) return alert('carregue os brushes RME (📦)');
  if (!confirm('Recalcular bordas do MAPA INTEIRO? (pode demorar uns segundos)')) return;
  let n = 0; const t0 = Date.now();
  for (const node of mapData.map.values()) { RB.recomputeTile(mapBrushData, mapData, node._x, node._y, node._z); n++; }
  mapData._dirty = true; mapUndo = []; mapRedo = []; updateMapBtns(); _miniDirty = true; $('mapSave').style.display = ''; reqMap();
  $('status').textContent = `borderize mapa: ${n} tiles em ${Date.now() - t0}ms (undo limpo)`;
}
function exportMapPng() {
  if (!mapData) return; buildMini();
  if (!_mini) return alert('nada no andar atual');
  ipcRenderer.invoke('save-file', `mapa_z${mapZ}.png`).then((f) => { if (!f) return; fs.writeFileSync(f, canvasToPngBytes(_mini)); $('status').textContent = 'minimap exportado: ' + f; });
}
// PNG do andar atual em resolução de sprites (bbox dos tiles existentes; ts ajustável)
function exportMapFullPng() {
  if (!mapData || !dat) return alert('abra .otbm + .dat/.spr');
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, cnt = 0;
  for (const node of mapData.map.values()) { if (node._z !== mapZ) continue; cnt++; if (node._x < minx) minx = node._x; if (node._x > maxx) maxx = node._x; if (node._y < miny) miny = node._y; if (node._y > maxy) maxy = node._y; }
  if (!cnt) return alert('nada no andar z=' + mapZ);
  const w = maxx - minx + 1, h = maxy - miny + 1;
  let ts = 32; const MAXPX = 8000; while (w * ts > MAXPX || h * ts > MAXPX) ts -= 4; if (ts < 4) ts = 4;
  if (w * h > 4e6 && !confirm(`Andar grande (${w}×${h}). Exportar mesmo? Pode demorar/consumir RAM.`)) return;
  const cv = document.createElement('canvas'); cv.width = w * ts; cv.height = h * ts; const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
  const drawOne = (sid, sx, sy) => { if (!sid) return; const cid = (otbMap && otbMap.get(sid)) || sid; const thing = dat.item(cid); if (!thing) return; const c = composeThing(thing, 0, 0); if (!c) return; const d = thingDisp(cid); ctx.drawImage(c, sx - (thing.width - 1) * ts - d.x * (ts / 32), sy - (thing.height - 1) * ts - d.y * (ts / 32), thing.width * ts, thing.height * ts); };
  for (const node of mapData.map.values()) { if (node._z !== mapZ) continue; const sx = (node._x - minx) * ts, sy = (node._y - miny) * ts; const g = OTBM.getGround(node); if (g) drawOne(g, sx, sy); for (const c of node.children) if (c.type === 6) drawOne(c.props.readUInt16LE(0), sx, sy); }
  ipcRenderer.invoke('save-file', `mapa_full_z${mapZ}.png`).then((f) => { if (!f) return; fs.writeFileSync(f, canvasToPngBytes(cv)); $('status').textContent = `mapa completo z${mapZ} exportado (${w}×${h} @${ts}px): ${f}`; });
}
// exporta o minimap de TODOS os andares que têm tiles (PNG por andar numa pasta)
async function exportAllFloors() {
  if (!mapData) return alert('abra um .otbm');
  const floors = []; for (let z = mapData.zmin; z <= mapData.zmax; z++) { let has = false; for (const n of mapData.map.values()) if (n._z === z) { has = true; break; } if (has) floors.push(z); }
  if (!floors.length) return;
  const dir = await ipcRenderer.invoke('pick-dir'); if (!dir) return;
  const savedZ = mapZ; let n = 0;
  for (const z of floors) { mapZ = z; _miniDirty = true; buildMini(); if (_mini) { try { fs.writeFileSync(path.join(dir, `minimap_z${z}.png`), canvasToPngBytes(_mini)); n++; } catch (e) {} } }
  mapZ = savedZ; _miniDirty = true; reqMap();
  $('status').textContent = `${n} andar(es) exportado(s) em ${dir}`; alert(`${n} minimaps salvos em:\n${dir}`);
}
// randomize: troca o item de chão por uma variante aleatória do mesmo brush (seleção ou mapa)
function mapRandomize(all) {
  if (!mapData || !mapBrushData) return alert('carregue os brushes RME (📦)');
  const keys = all ? null : selKeys();
  if (!all && !keys.length) return alert('selecione uma área (ou use o de mapa inteiro)');
  if (all && !confirm('Randomizar o chão do MAPA INTEIRO?')) return;
  strokeBegin(); let n = 0;
  const iter = all ? mapData.map.values() : keys.map((k) => mapData.map.get(k)).filter(Boolean);
  for (const node of iter) { if (all && node._z !== mapZ) continue; const g = OTBM.getGround(node); if (!g) continue; const bn = mapBrushData.groundToBrush.get(g); if (!bn) continue; const b = mapBrushData.byName.get(bn); if (!b || !b.itemsW || b.itemsW.length < 2) continue;
    let tot = b.itemsW.reduce((s, it) => s + (it.chance || 1), 0); let r = 1 + Math.floor(Math.random() * tot); let pick = b.itemsW[0].id; for (const it of b.itemsW) { if (r <= (it.chance || 1)) { pick = it.id; break; } r -= (it.chance || 1); }
    if (pick !== g) { if (!all) strokeTouch(node._x + ',' + node._y + ',' + node._z); OTBM.setGround(mapData, node._x, node._y, node._z, pick); n++; } }
  strokeEnd(); if (all) { mapUndo = []; mapRedo = []; updateMapBtns(); } mapData._dirty = true; _miniDirty = true; $('mapSave').style.display = ''; reqMap();
  $('status').textContent = `randomize: ${n} tiles trocados`;
}
function mapProperties() {
  if (!mapData) return;
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '480px';
  box.innerHTML = `<h3>Propriedades do mapa</h3>
    <div class="opRow"><span>dimensões</span><b>${mapData.width} × ${mapData.height} · OTBM v${mapData.version} · items ${mapData.itemMajor}.${mapData.itemMinor}</b></div>
    <div class="opRow"><span>tiles · houses</span><b>${mapData.map.size} · ${mapData.houses}</b></div>`;
  const mk = (lbl, val, on) => { const w = document.createElement('label'); w.className = 'opRow'; w.innerHTML = `<span>${lbl}</span>`; const i = document.createElement('input'); i.value = val || ''; i.style.cssText = 'flex:1;max-width:230px'; i.onchange = () => on(i.value); w.appendChild(i); box.appendChild(w); };
  mk('descrição', (mapData.description || '').trim().split('\n')[0], (v) => OTBM.setMapInfo(mapData, { description: v }));
  mk('spawn file', mapData.spawnFile, (v) => { OTBM.setMapInfo(mapData, { spawnFile: v }); $('mapSave').style.display = ''; });
  mk('house file', mapData.houseFile, (v) => { OTBM.setMapInfo(mapData, { houseFile: v }); $('mapSave').style.display = ''; });
  // towns
  const th = document.createElement('div'); th.className = 'opRow'; th.innerHTML = '<span>towns</span>'; box.appendChild(th);
  const tl = document.createElement('div'); tl.className = 'animBox'; box.appendChild(tl);
  const drawTowns = () => { tl.innerHTML = ''; for (const t of mapData.towns) { const r = document.createElement('div'); r.className = 'animRow'; r.style.gridTemplateColumns = '1fr 70px 22px'; const nm = document.createElement('span'); nm.textContent = `${t.id}: ${t.name}`; const go = document.createElement('button'); go.className = 'expBtn'; go.textContent = '→'; go.title = 'ir'; go.onclick = () => { mapZ = t.z; mapCenterOn(t.x, t.y); ov.remove(); }; const rm = document.createElement('button'); rm.className = 'expBtn'; rm.textContent = '✕'; rm.onclick = () => { OTBM.removeTown(mapData, t.id); $('mapSave').style.display = ''; drawTowns(); }; r.append(nm, go, rm); tl.appendChild(r); } };
  drawTowns();
  const addT = document.createElement('button'); addT.className = 'miniBtn'; addT.textContent = '➕ town (usa último tile com hover)';
  addT.onclick = () => { const p = _mapLastHover ? _mapLastHover.split(',').map(Number) : [mapData.width >> 1, mapData.height >> 1, mapZ]; const name = prompt('nome do town:', 'Nova Cidade'); if (!name) return; const id = (mapData.towns.reduce((m, t) => Math.max(m, t.id), 0) || 0) + 1; OTBM.addTown(mapData, id, name, p[0], p[1], p[2]); $('mapSave').style.display = ''; drawTowns(); reqMap(); };
  box.appendChild(addT);
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'OK'; c.onclick = () => { ov.remove(); reqMap(); }; foot.appendChild(c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// espelha/rotaciona a seleção. PRESERVA o tile inteiro (ground+itens+flags) e aplica em
// TODOS os andares selecionados (selFloors) — ideal p/ girar caves/hunts completos.
function mapTransformSel(kind) {
  if (!mapData) return;
  if (!mapSel) return alert('selecione uma área primeiro (ferramenta ⬚)');
  const minx = Math.min(mapSel.x0, mapSel.x1), maxx = Math.max(mapSel.x0, mapSel.x1);
  const miny = Math.min(mapSel.y0, mapSel.y1), maxy = Math.max(mapSel.y0, mapSel.y1);
  const w = maxx - minx + 1, h = maxy - miny + 1;
  const floors = selFloors();
  // 1) captura os tiles INTEIROS (clone) de todos os andares selecionados
  const cells = [];
  for (const z of floors) for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
    const n = mapData.map.get(x + ',' + y + ',' + z);
    if (n) cells.push({ rx: x - minx, ry: y - miny, z, snap: OTBM.cloneNode(n) });
  }
  if (!cells.length) return alert('seleção vazia nesses andares');
  const swap = (kind === 'rot' || kind === 'rot90' || kind === 'rot270'); // 90/270 trocam W↔H
  const nw = swap ? h : w, nh = swap ? w : h;
  strokeBegin();
  // 2) limpa toda a área de origem (em cada andar)
  for (const z of floors) for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) { const k = x + ',' + y + ',' + z; strokeTouch(k); OTBM.setTile(mapData, k, null); }
  // 3) recoloca rotacionado/espelhado, corrigindo o byte de posição do tile
  for (const c of cells) {
    let nx, ny;
    if (kind === 'flipH')      { nx = w - 1 - c.rx; ny = c.ry; }
    else if (kind === 'flipV') { nx = c.rx; ny = h - 1 - c.ry; }
    else if (kind === 'rot180'){ nx = w - 1 - c.rx; ny = h - 1 - c.ry; }
    else if (kind === 'rot270'){ nx = c.ry; ny = w - 1 - c.rx; }   // 90° anti-horário
    else                        { nx = h - 1 - c.ry; ny = c.rx; }   // 'rot'/'rot90' = 90° horário
    const ax = minx + nx, ay = miny + ny, k = ax + ',' + ay + ',' + c.z;
    strokeTouch(k); OTBM.setTile(mapData, k, c.snap);
    const nn = mapData.map.get(k); if (nn && nn.props && nn.props.length >= 2) { nn.props[0] = ax & 0xFF; nn.props[1] = ay & 0xFF; }
  }
  strokeEnd(); mapData._dirty = true; if ($('mapSave')) $('mapSave').style.display = '';
  mapSel = { x0: minx, y0: miny, x1: minx + nw - 1, y1: miny + nh - 1 }; reqMap();
  const lbl = kind === 'flipH' ? 'espelho H' : kind === 'flipV' ? 'espelho V' : kind === 'rot180' ? '180°' : kind === 'rot270' ? '90° ↺' : '90° ↻';
  $('status').textContent = `${lbl} · ${cells.length} tile(s) em ${floors.length} andar(es)`;
}

function mapBorderize() {
  if (!mapData) return; if (!mapBrushData) return alert('carregue os brushes RME (📦) primeiro');
  if (!mapSel) return alert('selecione uma área primeiro (ferramenta ⬚)');
  strokeBegin();
  const x0 = Math.min(mapSel.x0, mapSel.x1) - 1, x1 = Math.max(mapSel.x0, mapSel.x1) + 1, y0 = Math.min(mapSel.y0, mapSel.y1) - 1, y1 = Math.max(mapSel.y0, mapSel.y1) + 1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { strokeTouch(x + ',' + y + ',' + mapZ); RB.recomputeTile(mapBrushData, mapData, x, y, mapZ); }
  strokeEnd(); reqMap(); $('status').textContent = 'bordas recalculadas na seleção';
}
// cor de minimap real (MinimapColor canon 28 → paleta Tibia 216 cubo 6x6x6×51) — memoizado
const _mmColor = new Map();
function minimapColorOfId(cid) {
  if (_mmColor.has(cid)) return _mmColor.get(cid);
  let col = null; const t = dat && dat.item(cid);
  if (t && t._attrs) { const a = t._attrs.find((x) => x.canon === 28); if (a && a.data.length >= 2) { const idx = a.data.readUInt16LE(0); if (idx > 0) col = [Math.floor(idx / 36) % 6 * 51, Math.floor(idx / 6) % 6 * 51, (idx % 6) * 51]; } }
  _mmColor.set(cid, col); return col;
}
function minimapColorOfTile(node) {
  const items = OTBM.itemsOf(node);
  for (let i = items.length - 1; i >= 0; i--) { const sid = OTBM.itemId(items[i]); const cid = (otbMap && otbMap.get(sid)) || sid; const c = minimapColorOfId(cid); if (c) return c; }
  if (node.type === 14) return [180, 120, 255];
  return [70, 72, 82];
}
// ---- minimap (canto sup-direito, cacheado por andar; clique = pular) ----
let _mini = null, _miniZ = null, _miniBounds = null, _miniDirty = true, _miniN = -1, _miniLastBuild = 0;
let _miniSize = Math.max(160, Math.min(700, parseInt(lsGet('miniSize'), 10) || 320)); // tamanho do minimapa (redimensionável)
function setMiniSize(px) { _miniSize = Math.max(160, Math.min(700, Math.round(px))); lsSet('miniSize', String(_miniSize)); _miniDirty = true; reqMap(); }
function buildMini() {
  _miniDirty = false; _miniZ = mapZ; _miniN = mapData ? mapData.map.size : -1; // nº de tiles parseados no build atual
  if (!mapData) { _mini = null; return; }
  let minx = 1e9, miny = 1e9, maxx = 0, maxy = 0, any = false;
  for (const n of mapData.map.values()) { if (n._z !== mapZ) continue; any = true; if (n._x < minx) minx = n._x; if (n._y < miny) miny = n._y; if (n._x > maxx) maxx = n._x; if (n._y > maxy) maxy = n._y; }
  if (!any) { _mini = null; return; }
  const w = maxx - minx + 1, h = maxy - miny + 1; const scale = Math.min(2, _miniSize / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale)), chh = Math.max(1, Math.round(h * scale));
  const c = document.createElement('canvas'); c.width = cw; c.height = chh; const cx = c.getContext('2d');
  cx.fillStyle = '#11141b'; cx.fillRect(0, 0, cw, chh);
  const img = cx.getImageData(0, 0, cw, chh); const d = img.data;
  for (const n of mapData.map.values()) { if (n._z !== mapZ) continue; const px = Math.floor((n._x - minx) * scale), py = Math.floor((n._y - miny) * scale); const o = (py * cw + px) * 4; const col = minimapColorOfTile(n); d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255; }
  cx.putImageData(img, 0, 0);
  _mini = c; _miniZ = mapZ; _miniBounds = { minx, miny, scale, cw, chh }; _miniDirty = false;
}
function drawMini(ctx, cvW) {
  if (!$('mapMini').checked || !mapData) return;
  // refaz na hora se forçado/trocou de andar; mas o crescimento por streaming (map.size) é THROTTLED
  // (a cada 500ms) — senão reconstruía os 340k tiles TODO frame ao arrastar/streamar = trava feia.
  const _now = performance.now();
  if (_miniDirty || _miniZ !== mapZ || (_miniN !== mapData.map.size && _now - _miniLastBuild > 500)) { buildMini(); _miniLastBuild = _now; }
  if (!_mini) return;
  const pad = 8, mw = _mini.width, mh = _mini.height; const ox = Math.max(pad, cvW - mw - pad), oy = pad;
  ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(ox - 2, oy - 2, mw + 4, mh + 4);
  ctx.drawImage(_mini, ox, oy);
  // viewport rect — CLAMPADO às bordas do minimapa (nunca sai da caixa)
  const b = _miniBounds; const ts = 32 * mapZoom; const vw = ($('mapCanvas').width / ts) * b.scale, vh = ($('mapCanvas').height / ts) * b.scale;
  const vx = ox + (mapOX - b.minx) * b.scale, vy = oy + (mapOY - b.miny) * b.scale;
  const cx1 = Math.max(ox, vx), cy1 = Math.max(oy, vy), cx2 = Math.min(ox + mw, vx + vw), cy2 = Math.min(oy + mh, vy + vh);
  if (cx2 > cx1 && cy2 > cy1) { ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 1; ctx.strokeRect(cx1 + 0.5, cy1 + 0.5, (cx2 - cx1) - 1, (cy2 - cy1) - 1); }
  _miniRect = { ox, oy, mw, mh, b };
}
let _miniRect = null;
function miniClick(e) {
  if (!_miniRect || !$('mapMini').checked) return false;
  const cv = $('mapCanvas'); const r = cv.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
  const { ox, oy, mw, mh, b } = _miniRect;
  if (mx < ox || mx > ox + mw || my < oy || my > oy + mh) return false;
  const tx = b.minx + (mx - ox) / b.scale, ty = b.miny + (my - oy) / b.scale;
  mapPushHist(); mapCenterOn(Math.round(tx), Math.round(ty)); return true;
}
function addWaypoint(x, y, z) { const name = ($('mapSpawnMob').value.trim() || ('wp' + ((mapData.waypoints || []).length + 1))); OTBM.addWaypoint(mapData, name, x, y, z); $('mapSave').style.display = ''; reqMap(); $('status').textContent = `waypoint "${name}" em ${x},${y},${z}`; }
function removeWaypointAt(x, y, z) { if (OTBM.removeWaypointAt(mapData, x, y, z)) { $('mapSave').style.display = ''; reqMap(); $('status').textContent = 'waypoint removido'; } else $('status').textContent = 'nenhum waypoint nesse tile'; }
function saveMap() {
  if (!mapData || !mapPath) return alert('nenhum mapa aberto');
  if (!confirm('Salvar o mapa?\n' + mapPath + (mapSpawnDirty ? '\n+ spawns: ' + mapSpawnPath : '') + '\n(backup .bak)')) return;
  try {
    backup(mapPath); OTBM.save(mapData, mapPath);
    if (mapSpawnDirty && mapSpawnPath) { backup(mapSpawnPath); fs.writeFileSync(mapSpawnPath, mapSpawnRaw, 'latin1'); mapSpawnDirty = false; }
    $('mapSave').style.display = 'none'; $('status').textContent = '.otbm salvo: ' + mapPath;
  } catch (e) { alert('Erro ao salvar mapa: ' + e.message); }
}
// persiste os toggles do menu Ver entre sessões (localStorage)
// NÃO inclui mapIngame (modo transitório que esconde tudo — não deve persistir e travar o usuário)
// mapGPU agora persiste (WebGL funciona com pre-warm + guarda de composite completo). Default OFF; o usuário liga se quiser GPU.
const MAP_VIEW_CHK = ['mapStack', 'mapOverlays', 'mapShadow', 'mapAnim', 'mapMini', 'mapGrid', 'mapDisp', 'mapGPU', 'mapShowHouses', 'mapShowCreatures', 'mapGhostUp', 'mapAllFloors', 'mapAllBelow', 'mapTooltips', 'mapShowPathing', 'mapHighlightItems', 'mapShowSpecial'];
try { localStorage.removeItem('mv.mapIngame'); } catch (e) {} // mapIngame nunca persiste
let _mvPrefsDone = false;
function restoreMapViewPrefs() {
  if (_mvPrefsDone) return; _mvPrefsDone = true;
  for (const id of MAP_VIEW_CHK) { const el = $(id); if (!el) continue;
    el.addEventListener('change', () => { try { localStorage.setItem('mv.' + id, el.checked ? '1' : '0'); } catch (e) {} });
    const s = localStorage.getItem('mv.' + id);
    if (s !== null) { const want = s === '1'; if (el.checked !== want) { el.checked = want; el.dispatchEvent(new Event('change')); } }
  }
  reqMap();
}
function resizeMapCanvas() {
  const cv = $('mapCanvas');
  // usa o tamanho REAL exibido (flex) → resolução interna = display, sem esticar.
  // clampa ao viewport disponível (evita estourar a janela / minimap fora da tela)
  const r = cv.getBoundingClientRect();
  const maxW = Math.max(300, window.innerWidth - r.left - 2);
  const maxH = Math.max(300, window.innerHeight - r.top - 2);
  let w = Math.round(r.width) || (($('mapStage').clientWidth || 900) - 212);
  let h = Math.round(r.height) || ($('mapStage').clientHeight || 560);
  cv.width = Math.max(300, Math.min(w, maxW));
  cv.height = Math.max(300, Math.min(h, maxH));
  _mapRect = cv.getBoundingClientRect();
}
function mapAutoFind() {
  const cands = [datPath && path.join(path.dirname(datPath), 'MAP.otbm'), findUp('data/world/map.otbm'), findUp('data/things/860/MAP.otbm')];
  return cands.find((c) => c && fs.existsSync(c)) || null;
}
async function openMapFile() {
  const f = await ipcRenderer.invoke('pick-file', ['otbm']);
  if (f) loadMapFile(f);
}
function loadMapFile(f) {
  $('mapInfo').textContent = 'carregando…';
  try {
    const t0 = Date.now(); mapData = OTBM.parse(f); mapPath = f; lsSet('mapPath', f); const dt = Date.now() - t0;
    initMapIndex(); // hook do índice incremental ANTES de parsear áreas
    _lastEnsureKey = ''; _miniN = -1; // reseta caches do lazy/minimap p/ o novo mapa
    mapZ = Math.min(7, Math.max(mapData.zmin, Math.min(mapData.zmax, 7)));
    // centraliza: lazy começa com map vazio → usa a 1ª ÁREA (de preferência no andar atual) p/ não cair em 0,0 (tela preta)
    const first = mapData.map.values().next().value;
    if (first) mapCenterOn(first._x, first._y);
    else if (mapData.areaIndex && mapData.areaIndex.size) {
      let a = null; for (const ar of mapData.areaIndex.values()) { if (ar.bz === mapZ) { a = ar; break; } if (!a) a = ar; }
      if (a) { mapZ = a.bz; mapCenterOn(a.bx + 128, a.by + 128); } else { mapOX = 0; mapOY = 0; }
    } else { mapOX = 0; mapOY = 0; }
    $('mapInfo').textContent = `${mapData.areaIndex ? mapData.areaIndex.size : 0} áreas (lazy) · ${mapData.width}x${mapData.height} · ${dt}ms`;
    mapUndo = []; mapRedo = []; mapSel = null; updateMapBtns();
    loadMapSpawns();
    reqMap();
  } catch (e) { $('mapInfo').textContent = 'erro: ' + e.message; mapData = null; }
}
let mapBrushData = null, palType = 'terrain', palTileset = '', palBrush = null, mapHouseId = 0, palRawPage = 0;
let mapAnimOn = false, mapAnimFrame = 0, _mapAnimTimer = null;
const PAL_KIND = { terrain: 'ground', doodad: 'doodad', wall: 'wall', creature: 'creature', raw: 'raw' };
// preenche o dropdown de tileset conforme o tipo
// abre a RAW palette no tileset/página onde o item está e rola até ele (igual "Select RAW" do RME)
function paletteGoToRaw(itemId) {
  if (!mapBrushData || !itemId) return;
  palType = 'raw'; if ($('palType')) $('palType').value = 'raw';
  if ($('palSearch')) $('palSearch').value = '';
  fillTilesets(); // monta o dropdown raw (inclui __all__/__others__)
  // procura um tileset RAW que contenha o item; senão usa "Todos os itens"
  let tileset = '__all__', list = allServerItemIds();
  for (const name of Object.keys(mapBrushData.tilesets.raw)) { const arr = mapBrushData.tilesets.raw[name]; if (arr && arr.indexOf(itemId) >= 0) { tileset = name; list = arr; break; } }
  palTileset = tileset; if ($('palTileset')) $('palTileset').value = tileset;
  const PER = 500, idx = list.indexOf(itemId); palRawPage = idx >= 0 ? Math.floor(idx / PER) : 0;
  palBrush = { kind: 'raw', id: itemId }; if ($('mapBrush')) $('mapBrush').value = itemId;
  setMapTool('paint'); renderPalette();
  setTimeout(() => { const b = $('palList'); const cell = b && b.querySelector('.palCell.sel'); if (cell) cell.scrollIntoView({ block: 'center' }); }, 30);
  $('status').textContent = `RAW → item ${itemId} (${tileset === '__all__' ? 'Todos os itens' : tileset} · pág ${palRawPage + 1})`;
}
// abre a palette de terreno no tileset onde o ground brush está e rola até ele (Select Groundbrush do RME)
function paletteGoToBrush(name) {
  if (!mapBrushData || !name) return;
  let tileset = null;
  for (const tn of Object.keys(mapBrushData.tilesets.terrain)) { const arr = mapBrushData.tilesets.terrain[tn]; if (arr && arr.indexOf(name) >= 0) { tileset = tn; break; } }
  palType = 'terrain'; if ($('palType')) $('palType').value = 'terrain';
  if ($('palSearch')) $('palSearch').value = '';
  fillTilesets();
  if (tileset) { palTileset = tileset; if ($('palTileset')) $('palTileset').value = tileset; }
  palBrush = { kind: 'ground', name };
  setMapTool('paint'); renderPalette();
  setTimeout(() => { const b = $('palList'); const cell = b && b.querySelector('.palCell.sel'); if (cell) cell.scrollIntoView({ block: 'center' }); }, 30);
  $('status').textContent = `ground brush: ${name}${tileset ? ' (' + tileset + ')' : ''}`;
}
function paletteGoToWall(name) {
  if (!mapBrushData || !name) return;
  palType = 'wall'; if ($('palType')) $('palType').value = 'wall';
  if ($('palSearch')) $('palSearch').value = '';
  fillTilesets(); palBrush = { kind: 'wall', name };
  setMapTool('paint'); renderPalette();
  setTimeout(() => { const b = $('palList'); const cell = b && b.querySelector('.palCell.sel'); if (cell) cell.scrollIntoView({ block: 'center' }); }, 30);
  $('status').textContent = `wall brush: ${name}`;
}
function paletteGoToCarpet(name) {
  if (!mapBrushData || !name) return;
  palType = 'carpet'; if ($('palType')) $('palType').value = 'carpet';
  if ($('palSearch')) $('palSearch').value = '';
  fillTilesets(); palBrush = { kind: 'carpet', name };
  setMapTool('paint'); renderPalette();
  setTimeout(() => { const b = $('palList'); const cell = b && b.querySelector('.palCell.sel'); if (cell) cell.scrollIntoView({ block: 'center' }); }, 30);
  $('status').textContent = `carpet brush: ${name}`;
}
function paletteGoToTable(name) {
  if (!mapBrushData || !name) return;
  palType = 'table'; if ($('palType')) $('palType').value = 'table';
  if ($('palSearch')) $('palSearch').value = '';
  fillTilesets(); palBrush = { kind: 'table', name };
  setMapTool('paint'); renderPalette();
  setTimeout(() => { const b = $('palList'); const cell = b && b.querySelector('.palCell.sel'); if (cell) cell.scrollIntoView({ block: 'center' }); }, 30);
  $('status').textContent = `table brush: ${name}`;
}
function paletteGoToDoodad(name) {
  if (!mapBrushData || !name) return;
  let tileset = null;
  for (const tn of Object.keys(mapBrushData.tilesets.doodad || {})) { const arr = mapBrushData.tilesets.doodad[tn]; if (arr && arr.indexOf(name) >= 0) { tileset = tn; break; } }
  palType = 'doodad'; if ($('palType')) $('palType').value = 'doodad';
  if ($('palSearch')) $('palSearch').value = '';
  fillTilesets();
  if (tileset) { palTileset = tileset; if ($('palTileset')) $('palTileset').value = tileset; }
  palBrush = { kind: 'doodad', name };
  setMapTool('paint'); renderPalette();
  setTimeout(() => { const b = $('palList'); const cell = b && b.querySelector('.palCell.sel'); if (cell) cell.scrollIntoView({ block: 'center' }); }, 30);
  $('status').textContent = `doodad brush: ${name}${tileset ? ' (' + tileset + ')' : ''}`;
}
function fillTilesets() {
  const sel = $('palTileset'); if (!sel) return; sel.innerHTML = '';
  if (!mapBrushData) return;
  let names = [];
  if (palType === 'terrain') names = Object.keys(mapBrushData.tilesets.terrain);
  else if (palType === 'doodad') names = Object.keys(mapBrushData.tilesets.doodad);
  else if (palType === 'raw') names = Object.keys(mapBrushData.tilesets.raw);
  else { sel.style.display = 'none'; return; } // wall/creature: sem tileset
  sel.style.display = '';
  // ordena pela ordem do tilesets.xml
  names.sort((a, b) => mapBrushData.tilesets.order.indexOf(a) - mapBrushData.tilesets.order.indexOf(b));
  // raw: opções virtuais "Todos os itens" e "Others" (não configurados) — igual RME
  if (palType === 'raw') { const a = document.createElement('option'); a.value = '__all__'; a.textContent = '✦ Todos os itens (All)'; sel.appendChild(a); const o = document.createElement('option'); o.value = '__others__'; o.textContent = '◇ Others (não configurados)'; sel.appendChild(o); }
  for (const n of names) { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); }
  if (!names.includes(palTileset)) palTileset = names[0] || '';
  sel.value = palTileset;
}
// todos os server ids do jogo: do items.otb se carregado, senão range do .dat
let _allIdsCache = null, _allIdsKey = '';
function allServerItemIds() {
  const key = (otbMap ? 'otb' + otbMap.size : '') + '|' + (dat ? dat.itemCount : 0);
  if (_allIdsCache && _allIdsKey === key) return _allIdsCache;
  let ids = [];
  if (otbMap && otbMap.size) ids = [...otbMap.keys()].sort((a, b) => a - b);
  else if (dat) { for (let id = 100; id <= dat.itemCount; id++) ids.push(id); }
  _allIdsCache = ids; _allIdsKey = key; return ids;
}
// displacement do .dat (canon 24) — desloca o sprite p/ cima-esquerda (efeito 3D de parede do RME)
const _dispCache = new Map(); const _ZERO_DISP = { x: 0, y: 0 }; let mapDisp = true;
function thingDisp(cid) {
  if (_dispCache.has(cid)) return _dispCache.get(cid);
  let d = { x: 0, y: 0 }; const t = dat && dat.item(cid);
  if (t && t._attrs) { const a = t._attrs.find((x) => x.canon === 24); if (a && a.data && a.data.length >= 4) d = { x: a.data.readUInt16LE(0), y: a.data.readUInt16LE(2) }; }
  _dispCache.set(cid, d); return d;
}
// carrega houses.xml (referenciado pelo mapData.houseFile) → [{id,name}]
let _mapHouses = null, _mapHousesKey = '';
function loadMapHouses() {
  const key = (mapPath || '') + '|' + (mapData && mapData.houseFile || '');
  if (_mapHouses && _mapHousesKey === key) return _mapHouses;
  _mapHouses = []; _mapHousesKey = key;
  try { if (mapData && mapData.houseFile && mapPath) { const f = path.join(path.dirname(mapPath), mapData.houseFile); if (fsp.existsSync(f)) { const raw = fsp.readFileSync(f, 'latin1'); const re = /<house\b([^>]*?)\/?>/gi; let m; const at = (s, k) => (s.match(new RegExp(k + '\\s*=\\s*"([^"]*)"', 'i')) || [])[1]; while ((m = re.exec(raw))) { const a = m[1]; const id = parseInt(at(a, 'houseid') || at(a, 'id') || '0', 10); if (!id) continue; _mapHouses.push({ id, name: at(a, 'name') || '', entryx: +at(a, 'entryx') || 0, entryy: +at(a, 'entryy') || 0, entryz: +at(a, 'entryz') || 7, rent: +at(a, 'rent') || 0, townid: +at(a, 'townid') || 0, size: +at(a, 'size') || 0 }); } } } } catch (e) {}
  return _mapHouses;
}
// gerenciador de casas — lista com rent/town/size + ir até a entrada
function housesManager() {
  const houses = loadMapHouses(); if (!houses.length) return alert('não achei houses.xml (defina o house file nas Propriedades do mapa)');
  document.querySelectorAll('.housesMgr').forEach((m) => m.remove());
  const ov = document.createElement('div'); ov.className = 'modal housesMgr'; const b = document.createElement('div'); b.className = 'modalBox'; b.style.maxWidth = '560px'; b.innerHTML = `<h3>🏠 Casas (${houses.length})</h3>`;
  const search = document.createElement('input'); search.placeholder = 'buscar por nome/id…'; search.style.cssText = 'width:100%;margin-bottom:6px'; b.appendChild(search);
  const tot = houses.reduce((a, h) => a + (h.rent || 0), 0); const sz = houses.reduce((a, h) => a + (h.size || 0), 0);
  const sum = document.createElement('div'); sum.className = 'alabel'; sum.style.cssText = 'font-size:11px;margin-bottom:6px'; sum.textContent = `rent total: ${tot.toLocaleString()} · tiles totais: ${sz} · towns: ${new Set(houses.map((h) => h.townid)).size}`; b.appendChild(sum);
  const list = document.createElement('div'); list.style.cssText = 'max-height:400px;overflow:auto'; b.appendChild(list);
  const draw = () => { const q = search.value.toLowerCase(); list.innerHTML = ''; houses.filter((h) => (h.name || '').toLowerCase().includes(q) || String(h.id).includes(q)).slice(0, 500).forEach((h) => { const r = document.createElement('div'); r.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 6px;border-bottom:1px solid var(--border);font-size:12px'; const nm = document.createElement('div'); nm.style.flex = '1'; nm.innerHTML = `🏠 <b>#${h.id}</b> ${h.name || ''} <span style="color:var(--muted)">· rent ${(h.rent || 0).toLocaleString()} · ${h.size || '?'} tiles · town ${h.townid || '?'}</span>`; const go = document.createElement('button'); go.className = 'miniBtn'; go.textContent = '🎯 entrada'; go.disabled = !(h.entryx); go.onclick = () => { mapPushHist && mapPushHist(); mapZ = h.entryz; setTimeout(() => mapCenterOn(h.entryx, h.entryy), 30); $('status').textContent = `casa #${h.id} entrada ${h.entryx},${h.entryy},${h.entryz}`; ov.remove(); }; r.append(nm, go); list.appendChild(r); }); };
  search.oninput = draw; draw(); const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); b.appendChild(foot); ov.appendChild(b); document.body.appendChild(ov); setTimeout(() => search.focus(), 30);
}
const _ckey = (x, y) => y * 100000 + x; // x,y < 100000 (coords Tibia 16-bit) → chave única (sem string/GC)
// ÍNDICE INCREMENTAL por andar: {z -> Map(ckey -> node)}. Mantido por _onTile/_offTile do otbm conforme os
// tiles entram (lazy/edição) — NUNCA reconstrói o índice inteiro (era o que travava ao parsear área nova).
function initMapIndex() {
  if (!mapData || mapData._fidx) return;
  const fidx = new Map(); mapData._fidx = fidx;
  mapData._onTile = (tn) => { let m = fidx.get(tn._z); if (!m) { m = new Map(); fidx.set(tn._z, m); } m.set(_ckey(tn._x, tn._y), tn); };
  mapData._offTile = (tn) => { const m = fidx.get(tn._z); if (m) m.delete(_ckey(tn._x, tn._y)); };
  for (const tn of mapData.map.values()) mapData._onTile(tn); // tiles já presentes (createEmpty/merge/non-lazy)
}
function floorMap(z) { if (!mapData._fidx) initMapIndex(); let m = mapData._fidx.get(z); if (!m) { m = new Map(); mapData._fidx.set(z, m); } return m; }
function floorIndex(z) { return floorMap(z); } // per-cell lookup (zoom normal)
// gerenciador de teleports — varre o mapa por itens com destino (TELE_DEST), lista origem→destino + ir até
function teleportsManager() {
  if (!mapData) return alert('abra um .otbm primeiro');
  const tps = [];
  for (const [k, node] of mapData.map) { for (const it of OTBM.itemNodes(node)) { const d = OTBM.getTeleportDest(it); if (d) { const p = k.split(',').map(Number); tps.push({ x: p[0], y: p[1], z: p[2], sid: it.props.readUInt16LE(0), dest: d }); break; } } }
  document.querySelectorAll('.tpMgr').forEach((m) => m.remove());
  const ov = document.createElement('div'); ov.className = 'modal tpMgr'; const b = document.createElement('div'); b.className = 'modalBox'; b.style.maxWidth = '560px'; b.innerHTML = `<h3>🌀 Teleports (${tps.length})</h3>`;
  if (!tps.length) { b.innerHTML += '<div class="alabel" style="padding:8px">nenhum teleport encontrado no mapa</div>'; }
  const search = document.createElement('input'); search.placeholder = 'buscar por coordenada…'; search.style.cssText = 'width:100%;margin-bottom:6px'; b.appendChild(search);
  const list = document.createElement('div'); list.style.cssText = 'max-height:420px;overflow:auto'; b.appendChild(list);
  const go = (x, y, z) => { mapPushHist && mapPushHist(); mapZ = z; setTimeout(() => mapCenterOn(x, y), 30); $('status').textContent = `${x},${y},${z}`; };
  const draw = () => { const q = search.value.toLowerCase(); list.innerHTML = ''; tps.filter((t) => `${t.x},${t.y},${t.z}`.includes(q) || `${t.dest.x},${t.dest.y},${t.dest.z}`.includes(q)).slice(0, 500).forEach((t) => { const r = document.createElement('div'); r.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 6px;border-bottom:1px solid var(--border);font-size:12px'; const nm = document.createElement('div'); nm.style.flex = '1'; nm.innerHTML = `🌀 <b>${t.x},${t.y},${t.z}</b> <span style="color:var(--muted)">→ ${t.dest.x},${t.dest.y},${t.dest.z}</span>`; const a = document.createElement('button'); a.className = 'miniBtn'; a.textContent = '⮕ origem'; a.onclick = () => { go(t.x, t.y, t.z); ov.remove(); }; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = '🎯 destino'; c.onclick = () => { go(t.dest.x, t.dest.y, t.dest.z); ov.remove(); }; r.append(nm, a, c); list.appendChild(r); }); };
  search.oninput = draw; draw(); const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); b.appendChild(foot); ov.appendChild(b); document.body.appendChild(ov); setTimeout(() => search.focus(), 30);
}
// resolve o TIPO real de um brush pelo nome (tileset terrain mistura ground/wall/table/carpet/doodad)
function resolveBrushKind(name) {
  const D = mapBrushData;
  if (D.byName.has(name)) return { kind: 'ground', look: D.byName.get(name).lookid };
  if (D.wallByName.has(name)) return { kind: 'wall', look: D.wallByName.get(name).lookid };
  if (D.tableByName && D.tableByName.has(name)) return { kind: 'table', look: D.tableByName.get(name).lookid };
  if (D.carpetByName && D.carpetByName.has(name)) return { kind: 'carpet', look: D.carpetByName.get(name).lookid };
  if (D.doodadByName.has(name)) return { kind: 'doodad', look: D.doodadByName.get(name).lookid };
  return { kind: 'ground', look: 0 };
}
// ícone de um item server-id num canvas
function palItemIcon(cv, sid) { if (!dat) return; const cid = (otbMap && otbMap.get(sid)) || sid; const t = dat.item(cid); if (t) drawScaled(cv, composeThing(t, 0, 0)); }
function palBrushIcon(cv, look) { if (look) palItemIcon(cv, look); }
function renderPalette() {
  const box = $('palList'); if (!box) return; box.innerHTML = '';
  if (!mapBrushData) { box.innerHTML = '<div class="alabel" style="padding:8px;font-size:11px">Defina a pasta dos materiais RME:<br>Arquivo ▸ 📦 Carregar materiais RME<br>(escolha a pasta <b>data</b> do RME ou data/&lt;versão&gt;)</div>'; return; }
  const q = ($('palSearch').value || '').toLowerCase();
  const frag = document.createDocumentFragment();
  const addRow = (icon, label, sel, on) => { const cell = document.createElement('div'); cell.className = 'palCell' + (sel ? ' sel' : ''); cell.title = label; const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32; cv.className = 'palIcon'; icon(cv); cell.appendChild(cv); cell.onclick = on; frag.appendChild(cell); };
  let n = 0;
  if (palType === 'terrain' || palType === 'doodad') {
    const names = (mapBrushData.tilesets[palType][palTileset] || []);
    for (const name of names) { if (n >= 500) break;
      if (typeof name === 'number') { const sid = name; if (q && !String(sid).includes(q) && !itemNameOf((otbMap && otbMap.get(sid)) || sid).toLowerCase().includes(q)) continue; addRow((cv) => palItemIcon(cv, sid), sid + '', palBrush && palBrush.kind === 'raw' && palBrush.id === sid, () => { palBrush = { kind: 'raw', id: sid }; $('mapBrush').value = sid; setMapTool('paint'); renderPalette(); $('status').textContent = 'item ' + sid; }); n++; continue; }
      if (q && !name.toLowerCase().includes(q)) continue; const r = resolveBrushKind(name);
      addRow((cv) => palBrushIcon(cv, r.look), name, palBrush && palBrush.kind === r.kind && palBrush.name === name, () => { palBrush = { kind: r.kind, name }; setMapTool('paint'); renderPalette(); $('status').textContent = `${r.kind}: ${name}`; }); n++; }
  } else if (palType === 'wall') {
    for (const w of mapBrushData.walls) { if (n >= 500) break; if (q && !w.name.toLowerCase().includes(q)) continue; addRow((cv) => palBrushIcon(cv, w.lookid), w.name, palBrush && palBrush.kind === 'wall' && palBrush.name === w.name, () => { palBrush = { kind: 'wall', name: w.name }; setMapTool('paint'); renderPalette(); $('status').textContent = 'wall: ' + w.name; }); n++; }
  } else if (palType === 'door') {
    for (const w of mapBrushData.walls) { if (n >= 500) break; if (!w.doors || !Object.keys(w.doors).length) continue; if (q && !w.name.toLowerCase().includes(q)) continue; addRow((cv) => palBrushIcon(cv, w.lookid), w.name, palBrush && palBrush.kind === 'door' && palBrush.name === w.name, () => { palBrush = { kind: 'door', name: w.name }; setMapTool('paint'); renderPalette(); $('status').textContent = 'door: ' + w.name; }); n++; }
  } else if (palType === 'carpet') {
    for (const c of mapBrushData.carpets) { if (n >= 500) break; if (q && !c.name.toLowerCase().includes(q)) continue; addRow((cv) => palBrushIcon(cv, c.lookid), c.name, palBrush && palBrush.kind === 'carpet' && palBrush.name === c.name, () => { palBrush = { kind: 'carpet', name: c.name }; setMapTool('paint'); renderPalette(); $('status').textContent = 'carpet: ' + c.name; }); n++; }
  } else if (palType === 'table') {
    for (const tb of mapBrushData.tables) { if (n >= 500) break; if (q && !tb.name.toLowerCase().includes(q)) continue; addRow((cv) => palBrushIcon(cv, tb.lookid), tb.name, palBrush && palBrush.kind === 'table' && palBrush.name === tb.name, () => { palBrush = { kind: 'table', name: tb.name }; setMapTool('paint'); renderPalette(); $('status').textContent = 'table: ' + tb.name; }); n++; }
  } else if (palType === 'waypoint') {
    box.innerHTML = ''; if (!mapData || !(mapData.waypoints || []).length) { box.innerHTML = '<div class="alabel" style="padding:8px;font-size:11px">sem waypoints no mapa. Use a ferramenta 📍 pra criar.</div>'; return; }
    for (const w of mapData.waypoints) { if (q && !w.name.toLowerCase().includes(q)) continue; const r = document.createElement('div'); r.className = 'palRow'; r.style.cssText = 'display:flex;gap:6px;padding:4px 8px;cursor:pointer;font-size:12px'; r.textContent = `📍 ${w.name} (${w.x},${w.y},${w.z})`; r.onclick = () => { mapZ = w.z; mapCenterOn(w.x, w.y); $('status').textContent = 'waypoint: ' + w.name; }; box.appendChild(r); }
    return;
  } else if (palType === 'house') {
    box.innerHTML = ''; const houses = loadMapHouses();
    const mgr = document.createElement('button'); mgr.className = 'miniBtn accent'; mgr.textContent = '⚙ Gerenciar casas'; mgr.style.cssText = 'width:100%;margin-bottom:4px'; mgr.onclick = housesManager; box.appendChild(mgr);
    if (!houses.length) { const d = document.createElement('div'); d.className = 'alabel'; d.style.cssText = 'padding:8px;font-size:11px'; d.innerHTML = 'House Palette: digite o <b>house id</b> acima e pinte. (não achei houses.xml)'; box.appendChild(d); return; }
    for (const h of houses) { if (q && !((h.name || '').toLowerCase().includes(q) || String(h.id).includes(q))) continue; const r = document.createElement('div'); r.className = 'palRow'; r.style.cssText = 'display:flex;gap:6px;padding:4px 8px;cursor:pointer;font-size:12px' + (mapHouseId === h.id ? ';background:#1c2740' : ''); r.textContent = `🏠 #${h.id} ${h.name || ''}`; r.onclick = () => { mapHouseId = h.id; if ($('palHouseId')) $('palHouseId').value = h.id; palBrush = { kind: 'house' }; setMapTool('paint'); renderPalette(); $('status').textContent = `house #${h.id} ${h.name || ''}`; }; box.appendChild(r); }
    return;
  } else if (palType === 'creature') {
    for (const c of mapBrushData.creatures) { if (n >= 500) break; if (q && !c.name.toLowerCase().includes(q)) continue; addRow((cv) => { const t = dat && dat.creature(c.looktype); if (t) drawScaled(cv, composeThing(t, t.px >= 4 ? 2 : 0, 0)); }, c.name, palBrush && palBrush.kind === 'creature' && palBrush.name === c.name, () => { palBrush = { kind: 'creature', name: c.name }; $('mapSpawnMob').value = c.name; setMapTool('spawn'); renderPalette(); $('status').textContent = 'creature: ' + c.name; }); n++; }
  } else if (palType === 'raw') {
    let ids;
    if (palTileset === '__all__' || palTileset === '__others__') {
      ids = allServerItemIds();
      if (palTileset === '__others__') { const used = new Set(); for (const arr of Object.values(mapBrushData.tilesets.raw)) for (const id of arr) used.add(id); ids = ids.filter((id) => !used.has(id)); }
    } else ids = mapBrushData.tilesets.raw[palTileset] || [];
    // filtra (busca por id ou nome) sobre a lista COMPLETA, depois pagina → dá p/ ver TODOS do início ao fim
    let filtered = ids;
    if (q) filtered = ids.filter((sid) => String(sid).includes(q) || itemNameOf((otbMap && otbMap.get(sid)) || sid).toLowerCase().includes(q));
    const PER = 500;
    const pages = Math.max(1, Math.ceil(filtered.length / PER));
    if (palRawPage >= pages) palRawPage = pages - 1; if (palRawPage < 0) palRawPage = 0;
    const slice = filtered.slice(palRawPage * PER, palRawPage * PER + PER);
    for (const sid of slice) { addRow((cv) => palItemIcon(cv, sid), sid + '', palBrush && palBrush.kind === 'raw' && palBrush.id === sid, () => { palBrush = { kind: 'raw', id: sid }; $('mapBrush').value = sid; setMapTool('paint'); renderPalette(); $('status').textContent = 'item ' + sid; }); n++; }
    if (filtered.length > PER) {
      const nav = document.createElement('div'); nav.style.cssText = 'grid-column:1/-1;display:flex;gap:6px;align-items:center;justify-content:center;padding:6px;font-size:11px';
      const prev = document.createElement('button'); prev.className = 'miniBtn'; prev.textContent = '◀'; prev.disabled = palRawPage <= 0; prev.onclick = () => { palRawPage--; renderPalette(); const b = $('palList'); if (b) b.scrollTop = 0; };
      const next = document.createElement('button'); next.className = 'miniBtn'; next.textContent = '▶'; next.disabled = palRawPage >= pages - 1; next.onclick = () => { palRawPage++; renderPalette(); const b = $('palList'); if (b) b.scrollTop = 0; };
      const lbl = document.createElement('span'); lbl.className = 'alabel'; lbl.textContent = `pág ${palRawPage + 1}/${pages} · ${filtered.length} itens`;
      nav.append(prev, lbl, next); frag.appendChild(nav);
    }
  }
  box.appendChild(frag);
  if (!n) box.innerHTML = '<div class="alabel" style="padding:8px;font-size:11px">vazio (troque o Tileset ou o filtro)</div>';
  updateToolPreview();
}
function loadBrushesFrom(dir) {
  try {
    // CLÁSSICO = grounds.xml direto na pasta. CANARY/15.x = materials.xml com <include> aninhados.
    const hasClassic = fsp.existsSync(path.join(dir, 'grounds.xml'));
    const matPath = path.join(dir, 'materials.xml');
    if (!hasClassic && fsp.existsSync(matPath)) { mapBrushData = RB.loadFromMaterials(matPath); }
    else { mapBrushData = RB.load(dir); }
    fillTilesets(); renderPalette();
    const src = (!hasClassic && mapBrushData.dir) ? ' (Canary/15.x)' : '';
    $('status').textContent = `materiais RME${src}: ${mapBrushData.brushes.length} terrain · ${mapBrushData.walls.length} wall · ${mapBrushData.doodads.length} doodad · ${mapBrushData.creatures.length} creature · ${mapBrushData.tilesets.order.length} tilesets`;
    return true;
  }
  catch (e) { $('status').textContent = 'brushes: ' + e.message; return false; }
}
// reconhece tanto o RME clássico (grounds.xml direto) quanto o Canary/15.x (materials.xml com includes)
function brushDirHas(dir) {
  if (!dir) return false;
  if (fsp.existsSync(path.join(dir, 'borders.xml')) && fsp.existsSync(path.join(dir, 'grounds.xml'))) return true;
  if (fsp.existsSync(path.join(dir, 'materials.xml'))) return true;
  return false;
}
// dado um root (pasta de materiais OU pasta "data" com subpastas por versão), acha a pasta certa
function resolveBrushDir(root) {
  if (!root || !fsp.existsSync(root)) return null;
  if (brushDirHas(root)) return root;
  let dirs = []; try { dirs = fsp.readdirSync(root).map((d) => path.join(root, d)).filter(brushDirHas); } catch (e) {}
  if (!dirs.length) return null;
  const v = String(datVersion); // prefere a subpasta da versão do client (ids/sprites batem)
  return dirs.find((d) => path.basename(d) === v) || dirs.find((d) => path.basename(d).startsWith(v)) || dirs[0];
}
async function loadBrushesAuto() {
  if (mapBrushData) return;
  // candidatos: pasta salva + pasta do .dat. No Tauri o fs é cacheado → PRÉ-CARREGA a pasta antes de resolver.
  const cands = [localStorage.getItem('rmeData'), datPath ? path.dirname(datPath) : null].filter(Boolean);
  for (const cand of cands) {
    try { if (window.__preloadTree) await window.__preloadTree(cand); } catch (e) {}
    const dir = resolveBrushDir(cand);
    if (dir) { loadBrushesFrom(dir); return; }
  }
  if ($('palType')) renderPalette();
  $('status').textContent = 'defina a pasta dos materiais RME (menu File ▸ Reload materials)';
}
// usuário escolhe a própria pasta (data/ do RME) — fica salva
async function loadBrushesPick() {
  const d = await ipcRenderer.invoke('pick-dir'); if (!d) return;
  const dir = resolveBrushDir(d);
  if (!dir) { alert('Não achei borders.xml/grounds.xml nessa pasta (nem nas subpastas).\nEscolha a pasta "data" do RME (ou a pasta da versão, ex: data/860).'); return; }
  localStorage.setItem('rmeData', d);
  loadBrushesFrom(dir);
}
let mapSpawns = null, mapSpawnRaw = null, mapSpawnPath = null, mapSpawnDirty = false;
function parseMapSpawns() {
  const list = []; if (!mapSpawnRaw) { mapSpawns = list; return; }
  const re = /<spawn\b([^>]*?)>/gi; let m;
  while ((m = re.exec(mapSpawnRaw))) { const a = m[1]; const gx = a.match(/centerx="(\d+)"/i), gy = a.match(/centery="(\d+)"/i), gz = a.match(/centerz="(\d+)"/i), gr = a.match(/radius="(\d+)"/i); if (gx && gy && gz) list.push({ x: +gx[1], y: +gy[1], z: +gz[1], radius: gr ? +gr[1] : 3 }); }
  mapSpawns = list;
}
function loadMapSpawns() {
  mapSpawns = null; mapSpawnRaw = null; mapSpawnPath = null; mapSpawnDirty = false;
  if (!mapData || !mapData.spawnFile || !mapPath) return;
  try { const f = path.join(path.dirname(mapPath), mapData.spawnFile); if (!fs.existsSync(f)) return; mapSpawnPath = f; mapSpawnRaw = fs.readFileSync(f, 'latin1'); parseMapSpawns(); }
  catch (e) { console.error('spawns', e); }
}
function addSpawn(x, y, z) {
  const mob = $('mapSpawnMob').value.trim() || 'Rat'; const rad = parseInt($('mapSpawnRad').value, 10) || 3;
  if (!mapSpawnRaw) { if (!mapSpawnPath && mapPath && mapData.spawnFile) mapSpawnPath = path.join(path.dirname(mapPath), mapData.spawnFile); mapSpawnRaw = '<?xml version="1.0"?>\n<spawns>\n</spawns>\n'; }
  const block = `\t<spawn centerx="${x}" centery="${y}" centerz="${z}" radius="${rad}">\n\t\t<monster name="${mob}" x="0" y="0" z="${z}" spawntime="60"/>\n\t</spawn>\n`;
  const i = mapSpawnRaw.search(/<\/spawns>/i); if (i < 0) return; mapSpawnRaw = mapSpawnRaw.slice(0, i) + block + mapSpawnRaw.slice(i);
  mapSpawnDirty = true; parseMapSpawns(); $('mapSave').style.display = ''; reqMap(); $('status').textContent = `spawn de ${mob} (r${rad}) em ${x},${y},${z} — 💾 salva o mapa`;
}
function removeSpawnAt(x, y, z) {
  if (!mapSpawnRaw) return;
  const re = new RegExp(`\\t*<spawn\\b[^>]*centerx="${x}"[^>]*centery="${y}"[^>]*centerz="${z}"[^>]*>[\\s\\S]*?<\\/spawn>\\s*`, 'i');
  if (re.test(mapSpawnRaw)) { mapSpawnRaw = mapSpawnRaw.replace(re, ''); mapSpawnDirty = true; parseMapSpawns(); $('mapSave').style.display = ''; reqMap(); $('status').textContent = `spawn removido em ${x},${y},${z}`; }
  else $('status').textContent = 'nenhum spawn exatamente nesse tile';
}
function mapCenterOn(x, y) {
  const cv = $('mapCanvas'); const ts = 32 * mapZoom;
  mapOX = x - (cv.width / ts) / 2; mapOY = y - (cv.height / ts) / 2; reqMap();
}
// pré-aquece (async) os sprites EXATOS que o viewport vai desenhar — evita o flicker preto do .spr lazy.
// coleta ground+itens dos tiles visíveis (andares mapZ..zEnd) no frame atual e manda 1 lote pro cache.
let _lastWarmKey = '', _warmRunning = null;
// LAZY .otbm: parseia SÓ as áreas (256x256) visíveis no viewport, em todos os andares desenhados.
// Roda no warm E no render (warm vem antes) — senão o pulo p/ área nova fica preto (sprites não aquecidos).
const LAZY_VIEW_MIN = 1000; // pré-carrega ~1000x1000 ao redor da view (pan/zoom suave, sem preto)
const LAZY_BUDGET = 900;    // nós TILE_AREA parseados POR FRAME → streaming (não trava); resto vem no próx frame
let _lazyMore = false, _lastEnsureKey = '';
function scheduleLazyMore() { if (_lazyMore) return; _lazyMore = true; requestAnimationFrame(() => { _lazyMore = false; if (mode === 'map') reqMap(); }); }
function ensureLazyView(x0, y0, cols, rows) {
  if (!mapData || !mapData._lazy) return;
  // durante o arrasto de SETA (panTick = rAF contínuo) NÃO parseia: frame pesado starva o keyup no WebView2
  // → o keyup se perde → _panHeld nunca limpa → anda pra sempre. Mantém leve; parseia quando soltar a seta.
  if (_panRAF && _panHeld.size) return; // (ao soltar a seta, panTick chama reqMap → parseia a região)
  initMapIndex(); // garante o hook _onTile ANTES de parsear (senão os tiles não entram no índice)
  const cxv = x0 + cols / 2, cyv = y0 + rows / 2;
  const halfW = Math.max(cols, LAZY_VIEW_MIN) / 2 + 18, halfH = Math.max(rows, LAZY_VIEW_MIN) / 2 + 18;
  const bx0 = Math.floor(cxv - halfW) & 0xFF00, bx1 = Math.floor(cxv + halfW);
  const by0 = Math.floor(cyv - halfH) & 0xFF00, by1 = Math.floor(cyv + halfH);
  const z0 = Math.min(mapZ, mapData.zmin), z1 = Math.max(mapZ, mapData.zmax);
  const key = bx0 + ',' + by0 + ',' + bx1 + ',' + by1 + ',' + z0 + ',' + z1;
  if (key === _lastEnsureKey) return; // MESMA região já totalmente garantida → não varre nada (arrasto liso)
  const zs = [mapZ]; for (let z = z0; z <= z1; z++) if (z !== mapZ) zs.push(z); // andar ATUAL primeiro (aparece já)
  let n = 0;
  for (const z of zs) for (let ay = by0; ay <= by1; ay += 256) for (let ax = bx0; ax <= bx1; ax += 256) {
    const lst = mapData.lazyIndex.get(ax + ',' + ay + ',' + z); if (!lst || lst._allParsed) continue;
    for (const a of lst) { if (a._parsed) continue; OTBM.ensureArea(mapData, a); if (++n >= LAZY_BUDGET) { scheduleLazyMore(); return; } }
    lst._allParsed = true; // completou a base inteira → nunca mais itera ela
  }
  _lastEnsureKey = key; // região concluída → próximos frames na mesma região pulam o loop
}
async function warmMapViewport() {
  if (!mapData || !dat || !spr || !spr.warm) return;
  const cv = $('mapCanvas'); const ts = 32 * mapZoom;
  const x0 = Math.floor(mapOX), y0 = Math.floor(mapOY);
  const cols = Math.ceil(cv.width / ts) + 1, rows = Math.ceil(cv.height / ts) + 1;
  ensureLazyView(x0, y0, cols, rows); // garante as áreas parseadas ANTES de coletar/aquecer os sprites
  const allBelow = $('mapAllBelow') && $('mapAllBelow').checked;
  const wkey = x0 + ',' + y0 + ',' + cols + ',' + rows + ',' + mapZ + ',' + (mapAnimOn ? mapAnimFrame : 0) + ',' + (allBelow ? 1 : 0);
  if (wkey === _lastWarmKey) { if (_warmRunning) await _warmRunning; return false; } // mesmo viewport → nada novo
  _lastWarmKey = wkey;
  const shadow = $('mapShadow') && $('mapShadow').checked;
  const stack = $('mapStack').checked;
  const ids = new Set();
  let _wAnim = mapAnimOn; // animação só no andar atual (igual o render) → não decodifica frames dos de baixo
  const collect = (sid) => {
    const cid = (otbMap && otbMap.get(sid)) || sid; const t = dat.item(cid); if (!t || !t.sprites) return;
    const a = (_wAnim && t.frames > 1) ? (mapAnimFrame % t.frames) : 0;
    for (let w = 0; w < t.width; w++) for (let h = 0; h < t.height; h++) { const idx = dat.spriteIndex(t, w, h, 0, 0, 0, 0, a); if (idx >= 0 && idx < t.sprites.length) { const s = t.sprites[idx]; if (s) ids.add(s); } }
  };
  const collectTile = (node) => {
    const g = tileGroundC(node); if (g) collect(g);
    const ch = node.children;
    if (stack) { for (let i = 0; i < ch.length; i++) if (ch[i].type === 6) collect(ch[i].props.readUInt16LE(0)); }
    else { for (let i = ch.length - 1; i >= 0; i--) if (ch[i].type === 6) { collect(ch[i].props.readUInt16LE(0)); break; } }
  };
  // só os andares realmente desenhados (atual + abaixo). MESMA estratégia do drawFloor (rect vs tiles-existentes)
  const floors = [mapZ];
  if (allBelow) { for (let zz = mapZ + 1; zz <= (mapData.zmax || 15); zz++) floors.push(zz); }
  else if (shadow && mapZ < (mapData.zmax || 15)) floors.push(mapZ + 1);
  for (const zz of floors) {
    _wAnim = mapAnimOn && zz === mapZ;
    const o = zz - mapZ; const vx0 = x0 - o - 1, vx1 = x0 + cols + 1, vy0 = y0 - o - 1, vy1 = y0 + rows + 1;
    const fm = floorMap(zz);
    if ((vx1 - vx0) * (vy1 - vy0) > fm.size) { for (const nd of fm.values()) { if (nd._x < vx0 || nd._x > vx1 || nd._y < vy0 || nd._y > vy1) continue; collectTile(nd); } }
    else { for (let my = vy0; my <= vy1; my++) for (let mx = vx0; mx <= vx1; mx++) { const node = fm.get(_ckey(mx, my)); if (node) collectTile(node); } }
  }
  if (spr.ensureCapacity) spr.ensureCapacity(ids.size); // dimensiona o cache pro viewport (evita thrash no zoom out)
  if (ids.size) { const p = spr.warm([...ids]); _warmRunning = p; try { await p; } finally { if (_warmRunning === p) _warmRunning = null; } return true; }
  return false;
}
let _mapWarmTok = 0;
// reqMap NÃO bloqueia mais o frame esperando sprite: desenha JÁ com o cache (pan 100% liso) e aquece em
// BACKGROUND; quando chega sprite novo, faz 1 render extra p/ preencher (flicker de no máx 1 frame em tile novo).
function reqMap() {
  if (_mapRAF) return;
  if (_panRAF || _walkRAF) return; // pan(seta)/walk já redesenham todo frame → não dupliques o render
  _mapRAF = requestAnimationFrame(() => {
    _mapRAF = null;
    renderMap(); // desenha imediatamente (não espera o warm)
    // aquece sprites em background SÓ quando idle (não durante o arrasto). Ao terminar, 1 render EXTRA DIRETO
    // (não via reqMap → não re-dispara warm → IMPOSSÍVEL fazer loop). Durante o arrasto o próx mousemove redesenha.
    if (mode === 'map' && spr && spr.warm && !_mapDrag) {
      warmMapViewport().then((warmed) => { if (warmed && mode === 'map' && !_mapDrag && !_mapRAF && !_panRAF && !_walkRAF) renderMap(); }).catch(() => {});
    }
  });
}
function renderMap() {
  const cv = $('mapCanvas'); if (!cv.width) resizeMapCanvas();
  const ctx = cv.getContext('2d');
  // bilinear ao fazer zoom out (evita moiré/striping do nearest-neighbor); crisp em zoom normal/in
  ctx.imageSmoothingEnabled = mapZoom < 1;
  if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#0b0d12'; ctx.fillRect(0, 0, cv.width, cv.height);
  $('mapFloor').textContent = 'z=' + mapZ;
  $('mapZoomLbl').textContent = Math.round(mapZoom * 100) + '%';
  if (!mapData || !dat) { $('mapInfo').textContent = mapData ? 'carregue .dat/.spr p/ ver sprites' : 'abra um .otbm'; return; }
  const ts = 32 * mapZoom;
  const x0 = Math.floor(mapOX), y0 = Math.floor(mapOY);
  const cols = Math.ceil(cv.width / ts) + 1, rows = Math.ceil(cv.height / ts) + 1;
  ensureLazyView(x0, y0, cols, rows); // parseia as áreas visíveis ANTES de desenhar
  // dimensiona os caches pro viewport, com TETO firme (no zoom out cols*rows explode → RAM dispara).
  // Acima do teto não adianta cachear mais (LOD no zoom out já desenha menos).
  const _vw = Math.min(cols * rows, 2500);
  _sprCvCap = Math.max(2500, _vw * 2);
  if (spr && spr.ensureCapacity) spr.ensureCapacity(_vw * 2);
  const ingame = $('mapIngame') && $('mapIngame').checked; // modo in-game: sem grid/overlays/cursor
  // LOD: durante o MOVIMENTO (pan/drag) OU no zoom out (tiles minúsculos, detalhe invisível) renderiza
  // leve p/ não travar. Pula lighting/ghost/andares-abaixo/special/pathing/highlight.
  const fast = !!(_panRAF && _panHeld.size) || !!_mapDrag || mapZoom < 0.55;
  const stack = $('mapStack').checked;
  // animação SÓ no andar atual (os de baixo/ghost ficam no frame 0 = cacheados). drawFloor seta isso por andar.
  let _curAnimOn = mapAnimOn;
  const overlaysOn = $('mapOverlays').checked && !ingame;
  const showHouses = (!$('mapShowHouses') || $('mapShowHouses').checked) && !ingame;
  const showCreatures = !$('mapShowCreatures') || $('mapShowCreatures').checked;
  const showPath = !fast && $('mapShowPathing') && $('mapShowPathing').checked && !ingame;
  const hiItems = !fast && $('mapHighlightItems') && $('mapHighlightItems').checked && !ingame;
  const showSpecial = !fast && $('mapShowSpecial') && $('mapShowSpecial').checked && !ingame;
  const sw = Math.ceil(ts), sh = Math.ceil(ts); // tamanho de 1 sprite-tile em px — fixo por zoom, não por posição
  const drawOne = (sid, sx, sy) => {
    if (!sid) return; const cid = (otbMap && otbMap.get(sid)) || sid; const thing = dat.item(cid); if (!thing) return;
    const a = (_curAnimOn && thing.frames > 1) ? (mapAnimFrame % thing.frames) : 0;
    const d = mapDisp ? thingDisp(cid) : _ZERO_DISP;
    if (_glSink) {
      // GL: usa composite (atlas GPU)
      const c = composeThing(thing, 0, a); if (!c || c._incomplete) return;
      _glSink.draw(c, cid + ':' + a, Math.round(sx - (thing.width - 1) * ts - d.x * mapZoom), Math.round(sy - (thing.height - 1) * ts - d.y * mapZoom), thing.width * sw, thing.height * sh, _glAlpha);
      return;
    }
    // 2D: cada sprite 32×32 escalado individualmente p/ sw×sh (evita double-scaling do composite que gera scan-lines)
    // sprite (w,h) fica na posição (sx - w*ts - d.x*zoom, sy - h*ts - d.y*zoom)
    const bx = sx - d.x * mapZoom, by = sy - d.y * mapZoom;
    for (let w = 0; w < thing.width; w++) {
      for (let h = 0; h < thing.height; h++) {
        const idx = dat.spriteIndex(thing, w, h, 0, 0, 0, 0, a);
        if (idx < 0 || idx >= thing.sprites.length) continue;
        const spid = thing.sprites[idx]; if (!spid) continue;
        const sc = spriteCanvas(spid); if (!sc) continue;
        ctx.drawImage(sc, Math.round(bx - w * ts), Math.round(by - h * ts), sw, sh);
      }
    }
  };
  const drawItems = (node, sx, sy) => {
    const g = tileGroundC(node);
    if (stack) { if (g) drawOne(g, sx, sy); const ch = node.children; for (let i = 0; i < ch.length; i++) if (ch[i].type === 6) drawOne(ch[i].props.readUInt16LE(0), sx, sy); }
    else { if (g) drawOne(g, sx, sy); const ch = node.children; let top = 0; for (let i = ch.length - 1; i >= 0; i--) if (ch[i].type === 6) { top = ch[i].props.readUInt16LE(0); break; } if (top) drawOne(top, sx, sy); }
  };
  // projeção de andar estilo Tibia/RME: cada andar é deslocado (zz - mapZ) tiles em x e y.
  // andar de baixo (z maior) → SE (+); andar de cima (z menor) → NW (-).
  const floorProj = 1;
  // andares de BAIXO: "ver todos abaixo" empilha do mapZ+1 até zmax (mais fundo desenhado primeiro);
  // senão, só o andar de baixo (z+1) translúcido. ambos com projeção SE.
  // "Show all Floors below" OU "Show all Floors" → mostra TODOS os andares de baixo (inclusive andando,
  // senão ficava preto no topo). É escolha do usuário; quem liga aceita que pesa mais.
  const allBelow = ($('mapAllBelow') && $('mapAllBelow').checked) || ($('mapAllFloors') && $('mapAllFloors').checked);
  // GPU (WebGL): roteia TODAS as passadas de andar (baixo/ghost/atual) p/ o GL numa pass → zoom out fluido com sprites
  let _glBaseDone = false, glOn = false;
  // WebGL (opt-in pelo checkbox): com o pre-warm os sprites já estão prontos antes do render, e o drawOne só
  // sobe composites COMPLETOS pro atlas → sem o preto que tinha antes. Mais fluido no zoom out (GPU em vez de CPU).
  if ($('mapGPU') && $('mapGPU').checked && !ingame) {
    if (!_mapGL) { try { _mapGL = new MapGL(); } catch (e) { _mapGL = { ok: false }; } }
    if (_mapGL.ok) { try { _mapGL.begin(cv.width, cv.height); _glSink = _mapGL; glOn = true; } catch (e) { _glSink = null; glOn = false; } }
  }
  // desenha um andar inteiro (offset o, alpha) — via GL (sink) ou 2D (ctx.globalAlpha).
  // escolhe a estratégia mais barata: viewport pequeno → varre o retângulo; zoom out → varre só os tiles existentes
  const drawFloor = (zz, o, alpha) => {
    if (_glSink) _glAlpha = alpha; else ctx.globalAlpha = alpha;
    _curAnimOn = mapAnimOn && zz === mapZ; // só o andar atual anima; os outros usam frame 0 (cache estável)
    const vx0 = x0 - o - 1, vx1 = x0 + cols + 1, vy0 = y0 - o - 1, vy1 = y0 + rows + 1;
    const fm = floorMap(zz);
    if ((vx1 - vx0) * (vy1 - vy0) > fm.size) {
      for (const nd of fm.values()) { const mx = nd._x, my = nd._y; if (mx < vx0 || mx > vx1 || my < vy0 || my > vy1) continue; drawItems(nd, (mx + o - mapOX) * ts, (my + o - mapOY) * ts); }
    } else {
      for (let my = vy0; my <= vy1; my++) for (let mx = vx0; mx <= vx1; mx++) { const node = fm.get(_ckey(mx, my)); if (node) drawItems(node, (mx + o - mapOX) * ts, (my + o - mapOY) * ts); }
    }
  };
  // andares de BAIXO. "all below" → TODOS opacos (mesmo andando). Senão → 1 andar de baixo de leve
  // (sempre, p/ nunca ficar preto no topo vazio). "Show shade" (Q) deixa esse 1 andar mais visível.
  if (mapZ < mapData.zmax && mapZoom >= 0.3) {
    if (allBelow) { for (let zz = mapData.zmax; zz >= mapZ + 1; zz--) drawFloor(zz, (zz - mapZ) * floorProj, 1); }
    else { const shadeA = ($('mapShadow') && $('mapShadow').checked) ? 0.4 : 0.13; drawFloor(mapZ + 1, floorProj, shadeA); }
  }
  // ghost dos andares de CIMA (z menor) → NW, translúcido (pulado no movimento p/ fluidez)
  if (!fast && $('mapGhostUp') && $('mapGhostUp').checked) {
    const allUp = $('mapAllFloors') && $('mapAllFloors').checked;
    const zTop = allUp ? mapData.zmin : Math.max(mapData.zmin, mapZ - 1);
    for (let zz = mapZ - 1; zz >= zTop; zz--) drawFloor(zz, (zz - mapZ) * floorProj, allUp ? 0.25 : 0.4);
  }
  // andar ATUAL — no GL desenha aqui (base); no 2D fica p/ o loop de overlays
  if (glOn) {
    drawFloor(mapZ, 0, 1);
    try { _glSink = null; _mapGL.end(); ctx.drawImage(_mapGL.canvas, 0, 0); _glBaseDone = true; } catch (e) { _glBaseDone = false; }
  }
  ctx.globalAlpha = 1;
  // andar atual + overlays — corpo por tile; viewport pequeno varre o retângulo, zoom out varre só tiles existentes
  const tileBody = (node, mx, my) => {
    const sx = (mx - mapOX) * ts, sy = (my - mapOY) * ts;
    if (!_glBaseDone) drawItems(node, sx, sy);
    if (showHouses && node.type === 14) { ctx.fillStyle = 'rgba(180,120,255,.20)'; ctx.fillRect(sx, sy, ts, ts); }
    if (overlaysOn) {
      const fl = tileFlagsC(node);
      if (fl & 1) { ctx.fillStyle = 'rgba(80,220,120,.18)'; ctx.fillRect(sx, sy, ts, ts); }
      if (fl & 16) { ctx.fillStyle = 'rgba(255,80,80,.18)'; ctx.fillRect(sx, sy, ts, ts); }
      if (fl & 8) { ctx.strokeStyle = 'rgba(255,200,60,.4)'; ctx.strokeRect(sx + 1, sy + 1, ts - 2, ts - 2); }
    }
    if (showPath && tileBlocking(node)) { ctx.fillStyle = 'rgba(255,40,40,.28)'; ctx.fillRect(sx, sy, ts, ts); }
    if (hiItems) { const g = tileGroundC(node); if (node.children.some((c) => c.type === 6 && c.props.readUInt16LE(0) !== g)) { ctx.strokeStyle = 'rgba(120,200,255,.7)'; ctx.lineWidth = 1; ctx.strokeRect(sx + 0.5, sy + 0.5, ts - 1, ts - 1); } }
    if (showSpecial) { for (const it of OTBM.itemNodes(node)) { const p = OTBM.getItemProps(it); if (p.actionId || p.uniqueId || p.text) { ctx.fillStyle = 'rgba(255,180,40,.30)'; ctx.fillRect(sx, sy, ts, ts); break; } } }
  };
  _curAnimOn = mapAnimOn; // andar atual anima (2D: tileBody desenha; GL: já desenhou com anim)
  const _fmMain = floorMap(mapZ);
  if (cols * rows > _fmMain.size) {
    const vx1 = x0 + cols, vy1 = y0 + rows;
    for (const nd of _fmMain.values()) { if (nd._x < x0 || nd._x > vx1 || nd._y < y0 || nd._y > vy1) continue; tileBody(nd, nd._x, nd._y); }
  } else {
    for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) { const mx = x0 + tx, my = y0 + ty; const node = _fmMain.get(_ckey(mx, my)); if (node) tileBody(node, mx, my); }
  }
  const gridOn = $('mapGrid').checked && !ingame;
  if (gridOn || (mapZoom >= 1 && !ingame)) { ctx.strokeStyle = gridOn ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.04)'; ctx.lineWidth = 1; for (let tx = 0; tx <= cols; tx++) { const x = (x0 + tx - mapOX) * ts; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); ctx.stroke(); } for (let ty = 0; ty <= rows; ty++) { const y = (y0 + ty - mapOY) * ts; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke(); } }
  if (overlaysOn) {
    // spawns (círculos) do xml
    if (mapSpawns && showCreatures) { ctx.strokeStyle = 'rgba(255,90,90,.8)'; ctx.fillStyle = 'rgba(255,90,90,.10)'; ctx.lineWidth = 1.5;
      for (const sp of mapSpawns) { if (sp.z !== mapZ) continue; const cx = (sp.x + 0.5 - mapOX) * ts, cy = (sp.y + 0.5 - mapOY) * ts; const rad = sp.radius * ts; if (cx + rad < 0 || cx - rad > cv.width || cy + rad < 0 || cy - rad > cv.height) continue; ctx.beginPath(); ctx.arc(cx, cy, Math.max(4, rad), 0, 6.283); ctx.fill(); ctx.stroke(); } }
    // towns 🏛 e waypoints 📍
    ctx.font = Math.max(12, ts * 0.6) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const t of (mapData.towns || [])) if (t.z === mapZ) { ctx.fillText('🏛', (t.x + 0.5 - mapOX) * ts, (t.y + 0.5 - mapOY) * ts); }
    for (const w of (mapData.waypoints || [])) if (w.z === mapZ) { ctx.fillText('📍', (w.x + 0.5 - mapOX) * ts, (w.y + 0.5 - mapOY) * ts); }
  }
  // iluminação 2D (ambient + luzes dos itens) — porta simplificada do light_drawer
  if (mapLightOn && !fast) lightPass(ctx, cv, ts, x0, y0, cols, rows); // lighting é pesado: pula no movimento
  // preview do brush no cursor (ghost do que vai colocar) — igual RME
  if (!ingame && !walkMode && (mapTool === 'paint') && palBrush && _mapLastHover && dat) { const hp = _mapLastHover.split(',').map(Number); if (hp[2] === mapZ) drawBrushPreview(ctx, ts, hp[0], hp[1]); }
  // preview de bordas (checkbox "preview" no Tool Options) — ghosts das bordas que serão aplicadas
  if (!ingame && !walkMode && mapPreviewBorder && mapBrushData && _mapLastHover && dat && (mapTool === 'paint' || mapTool === 'optborder')) { const hp = _mapLastHover.split(',').map(Number); if (hp[2] === mapZ) { const gh = borderPreviewGhosts(hp[0], hp[1], mapZ); ctx.save(); ctx.globalAlpha = 0.5; for (const g of gh) drawPreviewSprite(ctx, ts, g.id, g.x, g.y); ctx.restore(); } }
  // preview do Auto-completar (10x10): quadrado da área + fantasma do chão dominante nos tiles vazios
  if (!ingame && !walkMode && mapTool === 'autocomplete' && mapBrushData && _mapLastHover && dat) {
    const hp = _mapLastHover.split(',').map(Number);
    if (hp[2] === mapZ) { const p = autoCompletePlan(hp[0], hp[1], mapZ); if (p) {
      if (p.cells.length) { const dens = $('mapAutoDensity') ? (parseInt($('mapAutoDensity').value, 10) || 0) : 100; ctx.save(); ctx.globalAlpha = 0.6;
        for (const c of p.cells) { const sx = (c.x - mapOX) * ts, sy = (c.y - mapOY) * ts; if (sx < -ts || sy < -ts || sx > cv.width || sy > cv.height) continue;
          drawPreviewSprite(ctx, ts, c.gid, c.x, c.y); // chão
          if (!c.edge && dens > 0 && c.items) for (let i = 0; i < c.items.length; i++) if (dens >= 100 || _acRand(c.x, c.y, i) * 100 < dens) drawPreviewSprite(ctx, ts, c.items[i], c.x, c.y); // itens (como vai ficar)
        } ctx.restore(); }
      ctx.save(); ctx.strokeStyle = p.best ? '#5bff9c' : '#ff6b6b'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.strokeRect((p.x0 - mapOX) * ts, (p.y0 - mapOY) * ts, (p.x1 - p.x0 + 1) * ts, (p.y1 - p.y0 + 1) * ts);
      ctx.setLineDash([]); ctx.fillStyle = p.best ? 'rgba(91,255,156,.10)' : 'rgba(255,107,107,.10)'; ctx.fillRect((p.x0 - mapOX) * ts, (p.y0 - mapOY) * ts, (p.x1 - p.x0 + 1) * ts, (p.y1 - p.y0 + 1) * ts); ctx.restore();
    } }
  }
  if (walkMode) drawPlayer(ctx, ts); // player walking simulation
  // seleção (retângulo / círculo / polígono)
  if (hasSel()) {
    ctx.fillStyle = 'rgba(91,140,255,.22)';
    const stiles = selTiles2D();
    for (const [x, y] of stiles) { const sx=(x-mapOX)*ts, sy=(y-mapOY)*ts; if(sx<-ts||sy<-ts||sx>cv.width||sy>cv.height)continue; ctx.fillRect(sx,sy,ts,ts); }
    // contorno da forma
    ctx.strokeStyle = '#5b8cff'; ctx.lineWidth = 2; ctx.setLineDash([4,3]);
    if (mapSelShape === 'polygon' && mapSelPoly && mapSelPoly.length) {
      ctx.beginPath();
      mapSelPoly.forEach((p,i) => { const px=(p.x+0.5-mapOX)*ts,py=(p.y+0.5-mapOY)*ts; if(i===0)ctx.moveTo(px,py); else ctx.lineTo(px,py); });
      if (mapSelPoly.length>=3) ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle='#9fc0ff'; for(const p of mapSelPoly){const px=(p.x+0.5-mapOX)*ts,py=(p.y+0.5-mapOY)*ts;ctx.beginPath();ctx.arc(px,py,3,0,6.283);ctx.fill();}
    } else if (mapSel) {
      const x0s=Math.min(mapSel.x0,mapSel.x1),x1s=Math.max(mapSel.x0,mapSel.x1);
      const y0s=Math.min(mapSel.y0,mapSel.y1),y1s=Math.max(mapSel.y0,mapSel.y1);
      const sx0=(x0s-mapOX)*ts,sy0=(y0s-mapOY)*ts,sw=(x1s-x0s+1)*ts,sh=(y1s-y0s+1)*ts;
      const cxs=sx0+sw/2,cys=sy0+sh/2;
      ctx.beginPath();
      if (mapSelShape==='rect') { ctx.rect(sx0,sy0,sw,sh); }
      else if (mapSelShape==='circle') { ctx.ellipse(cxs,cys,sw/2,sh/2,0,0,Math.PI*2); }
      else if (mapSelShape==='diamond') { ctx.moveTo(cxs,sy0);ctx.lineTo(sx0+sw,cys);ctx.lineTo(cxs,sy0+sh);ctx.lineTo(sx0,cys);ctx.closePath(); }
      else if (mapSelShape==='triangle') { ctx.moveTo(cxs,sy0);ctx.lineTo(sx0+sw,sy0+sh);ctx.lineTo(sx0,sy0+sh);ctx.closePath(); }
      else if (mapSelShape==='rtriangle') { ctx.moveTo(sx0,sy0);ctx.lineTo(sx0+sw,sy0+sh);ctx.lineTo(sx0,sy0+sh);ctx.closePath(); }
      else if (mapSelShape==='star') { for(let i=0;i<10;i++){const a=Math.PI*i/5-Math.PI/2,r=i%2===0?1:0.38;const px=cxs+sw/2*r*Math.cos(a),py=cys+sh/2*r*Math.sin(a);i===0?ctx.moveTo(px,py):ctx.lineTo(px,py);} ctx.closePath(); }
      else if (mapSelShape==='hexagon') { for(let i=0;i<6;i++){const a=Math.PI/3*i-Math.PI/6,px=cxs+sw/2*Math.cos(a),py=cys+sh/2*Math.sin(a);i===0?ctx.moveTo(px,py):ctx.lineTo(px,py);} ctx.closePath(); }
      else if (mapSelShape==='line') { ctx.moveTo(sx0,sy0);ctx.lineTo(sx0+sw,sy0+sh); }
      else { ctx.rect(sx0,sy0,sw,sh); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  if (typeof liveDrawCursors === 'function') liveDrawCursors(ctx, ts);
  drawMini(ctx, cv.width);
}
// desenha o sprite de um item no tile (usado no preview do cursor) com displacement
function drawPreviewSprite(ctx, ts, sid, mx, my) {
  const cid = (otbMap && otbMap.get(sid)) || sid; const thing = dat.item(cid); if (!thing) return; const c = composeThing(thing, 0, 0); if (!c) return;
  const d = thingDisp(cid); const sx = (mx - mapOX) * ts, sy = (my - mapOY) * ts;
  ctx.drawImage(c, sx - (thing.width - 1) * ts - d.x * mapZoom, sy - (thing.height - 1) * ts - d.y * mapZoom, thing.width * ts, thing.height * ts);
}
// preview fantasma do brush no cursor + caixa amarela do tile (igual RME)
// preview de bordas: simula o borderize/paint numa cópia (snapshot→aplica→lê→restaura) e devolve os sprites NOVOS
let _borderPrev = null;
function borderPreviewGhosts(mx, my, z) {
  if (!mapBrushData || !mapData) return [];
  const gb = (mapTool === 'paint' && palBrush && palBrush.kind === 'ground') ? palBrush.name : (mapTool === 'optborder' ? '__border__' : null);
  if (!gb) return [];
  const key = mx + ',' + my + ',' + z + '|' + gb;
  if (_borderPrev && _borderPrev.key === key) return _borderPrev.ghosts;
  const keys = []; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) keys.push((mx + dx) + ',' + (my + dy) + ',' + z);
  const snaps = keys.map((k) => ({ k, s: OTBM.snapTile(mapData, k) })); const dirtyWas = mapData._dirty; const ghosts = [];
  try {
    if (gb === '__border__') RB.borderize(mapBrushData, mapData, mx, my, z); else RB.paintGround(mapBrushData, mapData, mx, my, z, gb);
    for (const { k, s } of snaps) { const cur = mapData.map.get(k); if (!cur) continue; const p = k.split(',').map(Number);
      const oldIds = new Set(); if (s) { const og = OTBM.getGround(s); if (og) oldIds.add(og); for (const it of OTBM.itemNodes(s)) oldIds.add(it.props.readUInt16LE(0)); }
      const cg = OTBM.getGround(cur); if (cg && !oldIds.has(cg)) ghosts.push({ id: cg, x: p[0], y: p[1] });
      for (const it of OTBM.itemNodes(cur)) { const id = it.props.readUInt16LE(0); if (!oldIds.has(id)) ghosts.push({ id, x: p[0], y: p[1] }); }
    }
  } catch (e) { } finally { for (const { k, s } of snaps) OTBM.setTile(mapData, k, s); mapData._dirty = dirtyWas; }
  _borderPrev = { key, ghosts }; return ghosts;
}
function drawBrushPreview(ctx, ts, mx, my) {
  ctx.save(); ctx.globalAlpha = 0.6;
  if (palBrush.kind === 'doodad' && mapBrushData) { const dd = mapBrushData.doodadByName.get(palBrush.name); if (dd) { if (dd.composites.length) { const c = dd.composites[(palBrush._rot || 0) % dd.composites.length]; for (const t of c) drawPreviewSprite(ctx, ts, t.id, mx + t.dx, my + t.dy); } else if (dd.singles.length) drawPreviewSprite(ctx, ts, dd.singles[(palBrush._rot || 0) % dd.singles.length], mx, my); } }
  else { const look = brushLook(palBrush); if (look) { const tiles = brushTiles(mx, my); for (const [x, y] of tiles) drawPreviewSprite(ctx, ts, look, x, y); } }
  ctx.globalAlpha = 1;
  // caixa amarela do cursor — tamanho de TELA constante (não cresce/encolhe com o zoom), centrada no tile
  ctx.strokeStyle = 'rgba(255,225,40,.95)'; ctx.lineWidth = 1.5;
  const bs = Math.max(12, Math.min(ts, 40)); // 12..40px de tela, independente do zoom
  for (const [x, y] of brushTiles(mx, my)) { const cxp = (x + 0.5 - mapOX) * ts, cyp = (y + 0.5 - mapOY) * ts; ctx.strokeRect(cxp - bs / 2, cyp - bs / 2, bs, bs); }
  ctx.restore();
}
// ======== Similaridade visual de itens (porta do VisualSimilarityService — aHash perceptual) ========
const _ahashCache = new Map();
function itemAHash(serverId) {
  if (_ahashCache.has(serverId)) return _ahashCache.get(serverId);
  let res = null; const cid = (otbMap && otbMap.get(serverId)) || serverId; const t = dat && dat.item(cid);
  if (t) { const c = composeThing(t, 0, 0); if (c) {
    const tmp = document.createElement('canvas'); tmp.width = 8; tmp.height = 8; const tc = tmp.getContext('2d'); tc.imageSmoothingEnabled = true; tc.drawImage(c, 0, 0, c.width, c.height, 0, 0, 8, 8);
    const d = tc.getImageData(0, 0, 8, 8).data; const g = new Array(64); let sum = 0;
    for (let i = 0; i < 64; i++) { const v = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) * (d[i * 4 + 3] / 255); g[i] = v; sum += v; }
    const avg = sum / 64; let hi = 0, lo = 0;
    for (let i = 0; i < 64; i++) if (g[i] > avg) { if (i < 32) hi |= (1 << i); else lo |= (1 << (i - 32)); }
    res = [hi >>> 0, lo >>> 0];
  } }
  _ahashCache.set(serverId, res); return res;
}
function hamming64(a, b) { let x = (a[0] ^ b[0]) >>> 0, y = (a[1] ^ b[1]) >>> 0, c = 0; while (x) { c += x & 1; x >>>= 1; } while (y) { c += y & 1; y >>>= 1; } return c; }
function findSimilarItems(refId, count) {
  const ref = itemAHash(refId); if (!ref) return [];
  const pool = new Set(); for (const arr of Object.values(mapBrushData ? mapBrushData.tilesets.raw : {})) for (const id of arr) pool.add(id);
  if (pool.size < 50) for (const id of allServerItemIds()) pool.add(id); // fallback: todos
  const scored = [];
  for (const id of pool) { if (id === refId) continue; const h = itemAHash(id); if (!h) continue; const dist = hamming64(ref, h); scored.push({ id, score: 1 - dist / 64 }); }
  scored.sort((a, b) => b.score - a.score || a.id - b.id);
  return scored.slice(0, count || 30);
}
function mapFindSimilar() {
  if (!mapData || !dat) return alert('abra .otbm + .dat/.spr');
  const ref = parseInt(prompt('item de referência (server id) — acha os visualmente parecidos:', (palBrush && palBrush.kind === 'raw' ? palBrush.id : '') || ''), 10); if (!ref) return;
  $('status').textContent = 'calculando similaridade…';
  setTimeout(() => {
    const sims = findSimilarItems(ref, 36); if (!sims.length) return alert('sem sprite/similares p/ ' + ref);
    const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '520px';
    box.innerHTML = `<h3>Itens similares a #${ref}</h3><div class="alabel" style="font-size:11px;margin-bottom:6px">clique = vira o brush · botão "Substituir no mapa" troca #${ref} → escolhido</div>`;
    const grid = document.createElement('div'); grid.style.cssText = 'display:grid;grid-template-columns:repeat(6,1fr);gap:5px;max-height:340px;overflow:auto'; box.appendChild(grid);
    for (const s of sims) { const cell = document.createElement('div'); cell.className = 'palCell'; cell.title = `#${s.id} · ${Math.round(s.score * 100)}%`; const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32; cv.className = 'palIcon'; palItemIcon(cv, s.id); cell.appendChild(cv);
      cell.onclick = () => { palType = 'raw'; $('palType').value = 'raw'; palBrush = { kind: 'raw', id: s.id }; $('mapBrush').value = s.id; setMapTool('paint'); fillTilesets(); renderPalette(); $('status').textContent = 'brush → item ' + s.id; };
      const rep = document.createElement('button'); rep.className = 'expBtn'; rep.textContent = '↔'; rep.title = 'substituir #' + ref + ' por #' + s.id + ' no mapa'; rep.onclick = (ev) => { ev.stopPropagation(); const inSel = mapSel && confirm('Só na seleção? (Cancelar = mapa todo)'); let ks = OTBM.findItem(mapData, ref); if (inSel) { const ss = new Set(selKeys()); ks = ks.filter((k) => ss.has(k)); } if (!ks.length) return alert('#' + ref + ' não achado'); if (!confirm(`Trocar ${ks.length}× #${ref}→#${s.id}?`)) return; strokeBegin(); for (const k of ks) { const n = mapData.map.get(k); if (n) { strokeTouch(k); OTBM.nodeReplace(mapData, n, ref, s.id); } } strokeEnd(); $('mapSave').style.display = ''; reqMap(); $('status').textContent = `${ks.length}× #${ref}→#${s.id}`; ov.remove(); };
      cell.appendChild(rep); grid.appendChild(cell); }
    const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
    $('status').textContent = `${sims.length} similares a #${ref}`;
  }, 30);
}
// ======== Player walking simulation (porta de ingame_preview CanWalk/isBlocking) ========
let walkMode = false, player = null, playerName = 'Player', playerLookId = 0; // {x,y,z,dir,look,anim}
function tileBlocking(node) {
  if (!node) return true; // void = bloqueia
  const check = (sid) => { const cid = (otbMap && otbMap.get(sid)) || sid; const t = dat && dat.item(cid); return t && t._attrs && t._attrs.some((a) => a.canon === 12); }; // canon 12 = NotWalkable
  const g = OTBM.getGround(node); if (!g) return true; // sem chão = bloqueia
  if (check(g)) return true;
  for (const c of node.children) if (c.type === 6 && check(c.props.readUInt16LE(0))) return true;
  return false;
}
function playerLook() { if (playerLookId) return playerLookId; const c = mapBrushData && mapBrushData.creatures.find((c) => c.name === ($('mapSpawnMob').value || '').toLowerCase()) || (mapBrushData && mapBrushData.creatures[0]); return c ? c.looktype : 128; }
let _walkRAF = null;
const WALK_DIRS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
let _walkHeld = []; // pilha de setas seguradas (segurar = anda contínuo)
function walkHold(key, repeat) { if (repeat) return; if (!_walkHeld.includes(key)) _walkHeld.push(key); if (player && !player.anim) { const d = WALK_DIRS[key]; walkPlayer(d[0], d[1]); } }
function walkRelease(key) { _walkHeld = _walkHeld.filter((k) => k !== key); }
function walkPlayer(dx, dy) {
  if (!player || player.anim) return; // ignora setas durante o passo
  const nx = player.x + dx, ny = player.y + dy;
  player.dir = dy < 0 ? 0 : dy > 0 ? 2 : dx > 0 ? 1 : 3; // N E S W
  const node = mapData.map.get(nx + ',' + ny + ',' + player.z);
  if (tileBlocking(node)) { $('status').textContent = `🚶 bloqueado em ${nx},${ny}`; reqMap(); return; }
  player.anim = { fromX: player.x, fromY: player.y, start: Date.now(), dur: 180 }; // animação por tempo
  player.x = nx; player.y = ny; $('status').textContent = `🚶 ${nx},${ny}`;
  // se o player sair da área visível, rola a câmera 1x (sem snap durante o slide → sem flick)
  const cv = $('mapCanvas'); const tsv = 32 * mapZoom; const colsV = cv.width / tsv, rowsV = cv.height / tsv;
  if (nx < mapOX + 2 || nx > mapOX + colsV - 2 || ny < mapOY + 2 || ny > mapOY + rowsV - 2) { mapOX = nx - colsV / 2; mapOY = ny - rowsV / 2; }
  if (!_walkRAF) walkTick();
}
function walkTick() {
  _walkRAF = null;
  if (!player || !player.anim) { reqMap(); return; }
  if (Date.now() - player.anim.start >= player.anim.dur) { player.anim = null; reqMap();
    if (walkMode && player && _walkHeld.length) { const d = WALK_DIRS[_walkHeld[_walkHeld.length - 1]]; if (d) walkPlayer(d[0], d[1]); } // continua se a seta ainda está segurada
    return; }
  reqMap(); _walkRAF = requestAnimationFrame(walkTick);
}
function drawPlayer(ctx, ts) {
  if (!player || player.z !== mapZ || !dat) return; const t = dat.creature(playerLook()); if (!t) return;
  let fx = player.x, fy = player.y, frame = 0;
  if (player.anim) { const p = Math.min(1, (Date.now() - player.anim.start) / player.anim.dur); fx = player.anim.fromX + (player.x - player.anim.fromX) * p; fy = player.anim.fromY + (player.y - player.anim.fromY) * p; frame = (t.frames > 1) ? (1 + Math.floor(p * (t.frames - 1))) % t.frames : 0; } // cicla os frames de walk da sprite
  const c = composeThing(t, t.px >= 4 ? player.dir : 0, frame); if (!c) return;
  const sx = (fx - mapOX) * ts, sy = (fy - mapOY) * ts;
  ctx.drawImage(c, sx - (t.width - 1) * ts, sy - (t.height - 1) * ts, t.width * ts, t.height * ts);
  // nome acima
  ctx.font = 'bold ' + Math.max(9, ts * 0.32) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#9fe0ff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
  const txX = sx + ts / 2, tyY = sy - ts * 0.15; ctx.strokeText(playerName, txX, tyY); ctx.fillText(playerName, txX, tyY);
  ctx.strokeStyle = 'rgba(80,200,255,.5)'; ctx.lineWidth = 1.5; ctx.strokeRect(sx + 1, sy + 1, ts - 2, ts - 2);
}
// dialog: escolher name + looktype do player
function configPlayer() {
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '360px';
  box.innerHTML = '<h3>🚶 Personagem (walk)</h3>';
  const nr = document.createElement('label'); nr.className = 'opRow'; nr.innerHTML = '<span>nome</span>'; const ni = document.createElement('input'); ni.value = playerName; ni.style.cssText = 'flex:1;max-width:200px'; nr.appendChild(ni); box.appendChild(nr);
  const lr = document.createElement('label'); lr.className = 'opRow'; lr.innerHTML = '<span>looktype</span>'; const li = document.createElement('input'); li.type = 'number'; li.value = playerLook(); li.style.width = '90px'; lr.appendChild(li); box.appendChild(lr);
  const prev = document.createElement('canvas'); prev.width = 64; prev.height = 64; prev.className = 'toPrevCv'; prev.style.cssText = 'display:block;margin:8px auto'; box.appendChild(prev);
  const drawP = () => { const t = dat && dat.creature(parseInt(li.value, 10) || 0); if (t) drawScaled(prev, composeThing(t, t.px >= 4 ? 2 : 0, 0)); else prev.getContext('2d').clearRect(0, 0, 64, 64); };
  li.oninput = drawP; drawP();
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const ok = document.createElement('button'); ok.className = 'miniBtn accent'; ok.textContent = 'OK'; ok.onclick = () => { playerName = ni.value || 'Player'; playerLookId = parseInt(li.value, 10) || 0; if (player) { player.look = playerLookId; player.name = playerName; } reqMap(); ov.remove(); };
  const cc = document.createElement('button'); cc.className = 'miniBtn'; cc.textContent = 'Cancelar'; cc.onclick = () => ov.remove();
  foot.append(cc, ok); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// ---- painel Tool Options (RME) ----
let mapPreviewBorder = false, mapLockDoors = true;
function wireToolOptions() {
  const opts = document.querySelectorAll('#mapToolOpts .toBtn');
  const syncActive = () => { opts.forEach((b) => { let on = false; if (b.dataset.tool) on = (mapTool === b.dataset.tool) || (b.dataset.tool === 'paint' && mapTool === 'paint'); if (b.dataset.flag != null) on = mapTool === 'zone' && $('mapZoneFlag').value === b.dataset.flag; if (b.dataset.door != null) on = palBrush && palBrush.kind === 'door' && $('mapDoorType').value === b.dataset.door; b.classList.toggle('active', !!on); }); };
  opts.forEach((b) => {
    b.onclick = () => {
      if (b.dataset.tool) setMapTool(b.dataset.tool);
      else if (b.dataset.flag != null) { $('mapZoneFlag').value = b.dataset.flag; setMapTool('zone'); }
      else if (b.dataset.door != null) { $('mapDoorType').value = b.dataset.door; if ($('mapDoorType')) $('mapDoorType').style.display = ''; palType = 'door'; $('palType').value = 'door'; fillTilesets(); if (!(palBrush && palBrush.kind === 'door')) { const w = mapBrushData && mapBrushData.walls.find((w) => w.doors && Object.keys(w.doors).length); if (w) palBrush = { kind: 'door', name: w.name }; } setMapTool('paint'); renderPalette(); }
      syncActive();
    };
  });
  $('toSize').oninput = () => { brushSize = parseInt($('toSize').value, 10) || 0; $('toSizeLbl').textContent = brushSize; if ($('mapBrushSize')) { $('mapBrushSize').value = brushSize; $('mapBrushSizeLbl').textContent = brushSize; } };
  $('toShape').onclick = () => { brushShape = brushShape === 'square' ? 'circle' : 'square'; $('toShape').textContent = brushShape === 'square' ? '▢ quadrado' : '◯ círculo'; if ($('mapBrushShape')) { $('mapBrushShape').textContent = brushShape === 'square' ? '▢' : '◯'; $('mapBrushShape').classList.toggle('active', brushShape === 'circle'); } };
  $('toPreview').onchange = () => { mapPreviewBorder = $('toPreview').checked; };
  $('toLockDoors').onchange = () => { mapLockDoors = $('toLockDoors').checked; };
  $('toClose').onclick = () => { $('mapToolOpts').style.display = 'none'; if ($('toShow')) $('toShow').style.display = ''; };
  $('toShow').onclick = () => { $('mapToolOpts').style.display = ''; $('toShow').style.display = 'none'; };
  if ($('mapToggleToolOpts')) $('mapToggleToolOpts').onclick = () => { const p = $('mapToolOpts'); const hidden = p.style.display === 'none'; p.style.display = hidden ? '' : 'none'; if ($('toShow')) $('toShow').style.display = hidden ? 'none' : ''; $('status').textContent = hidden ? 'Tool Options visível' : 'Tool Options oculto'; };
  if ($('mapFreeSize')) $('mapFreeSize').onclick = () => { const cv = $('mapCanvas'); const free = cv.classList.toggle('freeSize'); $('status').textContent = free ? '🗖 tamanho livre: arraste o canto inferior-direito do mapa' : 'mapa: tamanho automático'; resizeMapCanvas(); reqMap(); };
  if ($('toRotate')) $('toRotate').onclick = rotateBrush;
  _toSync = syncActive; syncActive();
}
let _toSync = null;
// lookid do brush atual (p/ preview)
function brushLook(pb) { if (!pb) return 0; if (pb.kind === 'raw') return pb.id; if (!mapBrushData) return 0; const m = { ground: mapBrushData.byName, wall: mapBrushData.wallByName, table: mapBrushData.tableByName, carpet: mapBrushData.carpetByName, doodad: mapBrushData.doodadByName }[pb.kind]; const b = m && m.get(pb.name); return b ? (b.lookid || (b.items && b.items[0]) || 0) : 0; }
function updateToolPreview() {
  const cv = $('toPreviewCv'); if (!cv) return; const lbl = $('toPreviewLbl');
  const look = brushLook(palBrush); const cid = look ? ((otbMap && otbMap.get(look)) || look) : 0;
  const t = (cid && dat) ? dat.item(cid) : null;
  if (t) drawScaled(cv, composeThing(t, 0, 0)); else { const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height); }
  if (lbl) lbl.textContent = palBrush ? (palBrush.kind === 'raw' ? ('item ' + palBrush.id + (t ? '' : ' (sem sprite no .dat)')) : (palBrush.kind + ': ' + palBrush.name)) : '— nada —';
}
// X = girar: item raw usa rotateTo do items.xml; doodad cicla variantes
function rotateOf(serverId) { // rotateTo: 1) items.otb  2) items.xml (igual RME doRotate)
  if (otbMap && otbMap.rotateTo && otbMap.rotateTo.get(serverId)) return otbMap.rotateTo.get(serverId);
  const cid = (otbMap && otbMap.get(serverId)) || serverId; const e = itemEntryOf(cid); const a = e && e.attributes && e.attributes.find((x) => x.key === 'rotateTo'); if (a) return parseInt(a.value, 10) || 0; return 0;
}
function rotateBrush() {
  if (palBrush && palBrush.kind === 'raw') { const rt = rotateOf(palBrush.id); if (rt) { palBrush.id = rt; $('mapBrush').value = rt; updateToolPreview(); reqMap(); $('status').textContent = 'girado → item ' + rt; return; } $('status').textContent = 'item ' + palBrush.id + ' não tem rotateTo (este items.otb/items.xml não define rotação p/ ele)'; return; }
  if (palBrush && palBrush.kind === 'doodad') { const d = mapBrushData.doodadByName.get(palBrush.name); const n = (d && (d.composites.length || d.singles.length)) || 1; palBrush._rot = ((palBrush._rot || 0) + 1) % n; $('status').textContent = 'variante ' + (palBrush._rot + 1) + '/' + n + (n < 2 ? ' (doodad sem variantes)' : ''); updateToolPreview(); reqMap(); return; }
  $('status').textContent = 'rotação: selecione um item (raw) ou doodad';
}
// ---- iluminação 2D ----
let mapLightOn = false, _lightCv = null;
const _lightCache = new Map(); // clientId -> {level,color}|null
function thingLight(cid) {
  if (_lightCache.has(cid)) return _lightCache.get(cid);
  let res = null; const t = dat && dat.item(cid);
  if (t && t._attrs) { const a = t._attrs.find((x) => x.canon === 21); if (a && a.data && a.data.length >= 4) { const lvl = a.data.readUInt16LE(0); if (lvl > 0) res = { level: lvl, color: a.data.readUInt16LE(2) }; } }
  _lightCache.set(cid, res); return res;
}
function lightColorRGB(c) { // índice de cor 215 do Tibia → rgb
  if (!c || c >= 216) return [255, 255, 200];
  return [Math.floor(c / 36) % 6 * 51, Math.floor(c / 6) % 6 * 51, (c % 6) * 51].map((v) => Math.max(40, v));
}
function lightPass(ctx, cv, ts, x0, y0, cols, rows) {
  const amb = (parseInt($('mapLightAmb').value, 10) || 0) / 100; // 0=noite 1=dia
  const darkness = 1 - amb; if (darkness <= 0.02) return;
  const intMul = (parseInt($('mapLightInt').value, 10) || 6) / 6;
  if (!_lightCv) _lightCv = document.createElement('canvas');
  const lc = _lightCv; if (lc.width !== cv.width || lc.height !== cv.height) { lc.width = cv.width; lc.height = cv.height; }
  const lx = lc.getContext('2d');
  lx.globalCompositeOperation = 'source-over';
  lx.fillStyle = `rgba(4,6,14,${0.92 * darkness})`; lx.fillRect(0, 0, lc.width, lc.height);
  // coleta luzes do andar
  lx.globalCompositeOperation = 'lighter';
  const _lfi = floorIndex(mapZ);
  for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
    const mx = x0 + tx, my = y0 + ty; const node = _lfi.get(_ckey(mx, my)); if (!node) continue;
    let best = null; const g = OTBM.getGround(node); if (g) { const l = thingLight((otbMap && otbMap.get(g)) || g); if (l) best = l; }
    for (const c of node.children) if (c.type === 6) { const l = thingLight((otbMap && otbMap.get(c.props.readUInt16LE(0))) || c.props.readUInt16LE(0)); if (l && (!best || l.level > best.level)) best = l; }
    if (!best) continue;
    const cx = (mx + 0.5 - mapOX) * ts, cy = (my + 0.5 - mapOY) * ts; const rad = Math.max(ts, best.level * ts * 0.55 * intMul);
    const [r, gg, b] = lightColorRGB(best.color); const grd = lx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    grd.addColorStop(0, `rgba(${r},${gg},${b},${0.95 * darkness})`); grd.addColorStop(1, 'rgba(0,0,0,0)');
    lx.fillStyle = grd; lx.beginPath(); lx.arc(cx, cy, rad, 0, 6.283); lx.fill();
  }
  ctx.drawImage(lc, 0, 0);
}
let _mapLastHover = null;
function mapHover(e) {
  if (!mapData) return;
  const t = tileAt(e); if (!t.inside) return;
  const key = t.x + ',' + t.y + ',' + mapZ;
  if (key === _mapLastHover) return; // só atualiza quando muda de tile (evita layout thrash)
  _mapLastHover = key;
  const node = mapData.map.get(key);
  const _mi = $('mapInfo'); if (_mi) _mi.textContent = `x=${t.x} y=${t.y} z=${mapZ}` + (node ? ` · itens: ${OTBM.itemsOf(node).map(OTBM.itemId).join(', ')}` : ' · (vazio)');
  if ((palBrush || mapPreviewBorder) && !walkMode) reqMap(); // redesenha o preview ao mover (qualquer ferramenta de preview)
  // tooltip flutuante (nome do item + aid/uid) — igual RME
  const tip = $('mapTooltip');
  if (tip) { const on = $('mapTooltips') && $('mapTooltips').checked && node;
    if (on) { const its = OTBM.itemsOf(node).map(OTBM.itemId); const sid = its.length ? its[its.length - 1] : OTBM.getGround(node); const cid = (otbMap && otbMap.get(sid)) || sid;
      let txt = sid ? (`${sid} - ${itemNameOf(cid) || '?'}`) : '(sem itens)';
      const inodes = OTBM.itemNodes(node); if (inodes.length) { const p = OTBM.getItemProps(inodes[inodes.length - 1]); if (p.actionId) txt += `\naid: ${p.actionId}`; if (p.uniqueId) txt += `\nuid: ${p.uniqueId}`; if (p.text) txt += `\n"${p.text}"`; }
      const fl = OTBM.getTileFlags(node); if (fl & 1) txt += '\n[PZ]'; if (fl & 16) txt += '\n[PVP]'; const hid = OTBM.getHouseId(node); if (hid) txt += `\nhouse #${hid}`;
      tip.textContent = txt; tip.style.display = '';
      tip.style.left = e.clientX + 'px'; tip.style.top = (e.clientY - 14) + 'px'; tip.style.transform = 'translate(-50%, -100%)'; // fixed → coords do viewport, centralizado no mouse
    } else tip.style.display = 'none';
  }
  if (mapTool === 'paint' && palBrush) reqMap(); // move o preview do brush junto com o cursor
  else if (mapTool === 'autocomplete') reqMap(); // move o preview do Auto 10x10 junto com o cursor
}
// ---------- IA (gera scripts pro servidor) ----------
let aiProvider = localStorage.getItem('ai.provider') || 'openrouter';
let aiHistory = []; // {role, content}
let _aiInit = false;
const AI_TEMPLATES = [
  { t: '🐲 Monstro', p: 'Gere um monstro TFS completo em XML (data/monster/). Me pergunte nome/level se faltar, senão crie um exemplo balanceado.' },
  { t: '✨ Spell', p: 'Gere uma spell TFS (revscriptsys, data/scripts/spells/). Diga se é instant/conjure/rune.' },
  { t: '⚔ Action item', p: 'Gere um action script TFS (data/scripts/actions/) para o item selecionado.' },
  { t: '🏃 Movement', p: 'Gere um movement script TFS (data/scripts/movements/).' },
  { t: '💬 Talkaction', p: 'Gere um talkaction TFS (data/scripts/talkactions/).' },
  { t: '🗨 NPC', p: 'Gere um NPC TFS completo (data/npc/ + script Lua).' },
  { t: '🔎 Explicar', p: 'Explique o que este código faz e aponte problemas.' },
  { t: '🐛 Achar bug', p: 'Ache e corrija o bug neste código. Mostre o diff.' },
];
function initAi() {
  if (_aiInit) return; _aiInit = true;
  const sel = $('aiProvider'); sel.innerHTML = '';
  for (const k of Object.keys(AI.PROVIDERS)) { const o = document.createElement('option'); o.value = k; o.textContent = AI.PROVIDERS[k].label; sel.appendChild(o); }
  sel.value = aiProvider;
  const tpl = $('aiTemplates');
  for (const x of AI_TEMPLATES) { const b = document.createElement('button'); b.className = 'miniBtn'; b.textContent = x.t; b.onclick = () => { $('aiPrompt').value = x.p; $('aiPrompt').focus(); }; tpl.appendChild(b); }
  aiLoadProvider();
  sel.onchange = () => { aiProvider = sel.value; localStorage.setItem('ai.provider', aiProvider); aiLoadProvider(); };
  $('aiSaveKey').onclick = () => { localStorage.setItem('ai.key.' + aiProvider, $('aiKey').value.trim()); if (AI.PROVIDERS[aiProvider].custom) localStorage.setItem('ai.customUrl', $('aiCustomUrl').value.trim()); $('status').textContent = 'config salva (local) p/ ' + aiProvider; };
  $('aiRefresh').onclick = aiRefreshModels;
  if ($('aiClaudeLogin')) $('aiClaudeLogin').onclick = aiClaudeLoginFlow;
  if ($('aiNew')) $('aiNew').onclick = aiNewConversation;
  if ($('aiSaveConv')) $('aiSaveConv').onclick = aiSaveConversation;
  if ($('aiLoadConv')) $('aiLoadConv').onclick = aiLoadConversation;
  if ($('aiTemp')) { $('aiTemp').value = localStorage.getItem('ai.temp') || '0.3'; $('aiTempLbl').textContent = $('aiTemp').value; $('aiTemp').oninput = () => { $('aiTempLbl').textContent = $('aiTemp').value; localStorage.setItem('ai.temp', $('aiTemp').value); }; }
  if ($('aiSysPrompt')) $('aiSysPrompt').onclick = () => { const cur = localStorage.getItem('ai.systemPrompt') || AI.SYSTEM_PROMPT; const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '600px'; box.innerHTML = '<h3>📝 System Prompt</h3>'; const ta = document.createElement('textarea'); ta.value = cur; ta.style.cssText = 'width:100%;height:240px;font-family:monospace;font-size:12px'; box.appendChild(ta); const foot = document.createElement('div'); foot.className = 'modalFoot'; const rst = document.createElement('button'); rst.className = 'miniBtn'; rst.textContent = '↺ padrão'; rst.onclick = () => ta.value = AI.SYSTEM_PROMPT; const ok = document.createElement('button'); ok.className = 'miniBtn accent'; ok.textContent = 'Salvar'; ok.onclick = () => { localStorage.setItem('ai.systemPrompt', ta.value); $('status').textContent = 'system prompt salvo'; ov.remove(); }; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Cancelar'; c.onclick = () => ov.remove(); foot.append(c, rst, ok); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov); };
  $('aiSend').onclick = aiSend;
  $('aiPrompt').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); aiSend(); } };
}
// ===== Login / verificação do Claude Code CLI =====
function aiClaudeLoginFlow() {
  const { spawn } = require('child_process');
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
  const btn = $('aiClaudeLogin'); btn.disabled = true; $('status').textContent = '🔑 procurando Claude Code no PC…';
  const ver = spawn('claude', ['--version'], { shell: true, env, windowsHide: true });
  let vout = '';
  ver.stdout.on('data', (d) => { vout += d; });
  ver.on('error', () => { btn.disabled = false; alert('Claude Code não encontrado no PC.\nInstale em claude.ai/code e tente de novo.'); $('status').textContent = 'Claude Code não instalado'; });
  ver.on('close', (code) => {
    if (code !== 0) { btn.disabled = false; alert('Claude Code não respondeu (instale/atualize).'); $('status').textContent = 'Claude Code não respondeu'; return; }
    $('status').textContent = `🔑 Claude Code v${vout.trim()} achado — verificando login…`;
    const test = spawn('claude', ['-p', '--output-format', 'text'], { shell: true, env, windowsHide: true });
    let tout = '', terr = ''; const to = setTimeout(() => { try { test.kill(); } catch (e) {} }, 25000);
    test.stdout.on('data', (d) => { tout += d; }); test.stderr.on('data', (d) => { terr += d; });
    test.on('error', () => { clearTimeout(to); btn.disabled = false; askClaudeLogin(env); });
    test.on('close', (c) => { clearTimeout(to); btn.disabled = false;
      if (c === 0 && tout.trim()) { btn.textContent = '✅ Logado'; $('status').textContent = '✅ Claude Code logado — pode usar a IA (provider Claude Code CLI)'; }
      else askClaudeLogin(env); // erro/auth/timeout → oferece login
    });
    try { test.stdin.write('ping'); test.stdin.end(); } catch (e) {}
  });
}
function askClaudeLogin(env) {
  if (!confirm('Não está logado no Claude Code (ou o login expirou).\n\nAbrir o terminal de login agora? (vai abrir o navegador pra autenticar)')) { $('status').textContent = 'login cancelado'; return; }
  const { spawn } = require('child_process');
  try { spawn('cmd', ['/c', 'start', 'Claude Code Login', 'cmd', '/k', 'claude'], { env, detached: true, windowsHide: false }); } catch (e) { alert('não consegui abrir o terminal: ' + e.message); return; }
  alert('Abri um terminal do Claude Code.\n\n1) Complete o login (abre o navegador)\n2) Depois feche o terminal\n3) Clique em "🔑 Login Claude" de novo pra confirmar (deve virar ✅ Logado)');
  $('status').textContent = 'complete o login no terminal aberto, depois clique 🔑 de novo';
}
function aiLoadProvider() {
  const p = AI.PROVIDERS[aiProvider];
  const dl = $('aiModels'); dl.innerHTML = '';
  for (const m of p.models) { const o = document.createElement('option'); o.value = m; dl.appendChild(o); }
  $('aiModel').value = localStorage.getItem('ai.model.' + aiProvider) || p.models[0];
  $('aiKey').value = localStorage.getItem('ai.key.' + aiProvider) || '';
  $('aiKey').placeholder = p.nokey ? '(sem key — usa login/local)' : 'API key…';
  $('aiKey').style.display = p.nokey ? 'none' : '';
  // campo de URL só p/ custom
  $('aiCustomUrl').style.display = p.custom ? '' : 'none';
  if (p.custom) $('aiCustomUrl').value = localStorage.getItem('ai.customUrl') || 'http://localhost:1234/v1/chat/completions';
  // refresh de modelos só p/ runtimes com /tags (ollama/lmstudio)
  $('aiRefresh').style.display = p.tags ? '' : 'none';
  if ($('aiClaudeLogin')) { $('aiClaudeLogin').style.display = (aiProvider === 'claudecode') ? '' : 'none'; $('aiClaudeLogin').textContent = '🔑 Login Claude'; }
  if (p.tags) aiRefreshModels();
}
async function aiRefreshModels() {
  const p = AI.PROVIDERS[aiProvider]; if (!p.local) return;
  const base = aiProvider === 'custom' ? $('aiCustomUrl').value.trim() : null;
  const models = await AI.listModels(aiProvider, base);
  if (models.length) {
    const dl = $('aiModels'); dl.innerHTML = '';
    for (const m of models) { const o = document.createElement('option'); o.value = m; dl.appendChild(o); }
    if (!models.includes($('aiModel').value)) $('aiModel').value = models[0];
    $('status').textContent = `${models.length} modelo(s) local(is) detectado(s)`;
  } else $('status').textContent = `nenhum modelo local detectado — o ${aiProvider} está rodando?`;
}
// contexto automático conforme o modo de onde veio
function aiContext() {
  if (!$('aiUseCtx').checked) return '';
  if ($('aiAllTabs') && $('aiAllTabs').checked && openTabs.length) { let ctx = ''; for (const t of openTabs.slice(0, 8)) { const txt = (t.doc ? t.doc.getValue() : '').slice(0, 4000); ctx += `\n--- ${t.name} ---\n\`\`\`\n${txt}\n\`\`\`\n`; } return 'Contexto — arquivos abertos:' + ctx; }
  if (activeTab && activeTab.doc) return `Contexto — arquivo ${activeTab.name}:\n\`\`\`\n${activeTab.doc.getValue().slice(0, 8000)}\n\`\`\``;
  if (current) { const xml = current._raw || current.raw || (current.name ? `monstro "${current.name}"` : ''); if (xml) return `Contexto — monstro:\n\`\`\`xml\n${String(xml).slice(0, 8000)}\n\`\`\``; }
  if (objSel) return `Contexto — item #${objSel.id} "${itemNameOf(objSel.id)}", flags: ${objSel.t._attrs.map((a) => a.canon).join(',')}`;
  return '';
}
function aiAddMsg(role, content) {
  const chat = $('aiChat');
  const div = document.createElement('div'); div.className = 'aiMsg ai-' + role;
  // render markdown simples: blocos ``` viram <pre> com botões
  const parts = content.split(/```(\w*)\n?([\s\S]*?)```/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) { if (parts[i].trim()) { const t = document.createElement('div'); t.className = 'aiText'; t.textContent = parts[i].trim(); div.appendChild(t); } }
    else if (i % 3 === 2) {
      const code = parts[i];
      const box = document.createElement('div'); box.className = 'aiCode';
      const pre = document.createElement('pre'); pre.textContent = code; box.appendChild(pre);
      const bar = document.createElement('div'); bar.className = 'aiCodeBar';
      const cp = document.createElement('button'); cp.className = 'miniBtn'; cp.textContent = '📋 copiar'; cp.onclick = () => { navigator.clipboard.writeText(code); $('status').textContent = 'código copiado'; };
      const ins = document.createElement('button'); ins.className = 'miniBtn'; ins.textContent = '⤵ inserir'; ins.title = 'inserir no cursor da aba ativa'; ins.onclick = () => aiInsertCode(code);
      const rep = document.createElement('button'); rep.className = 'miniBtn'; rep.textContent = '📄 substituir arquivo'; rep.title = 'substitui TODO o conteúdo da aba ativa'; rep.onclick = () => aiReplaceFile(code);
      bar.append(cp, ins, rep);
      // detecta FILE: na primeira linha → botão de salvar direto no disco
      const fileMatch = code.match(/^(?:--|\/\/|#)\s*FILE:\s*(.+)/m);
      if (fileMatch) {
        const relPath = fileMatch[1].trim();
        const absPath = aiResolveDestPath(relPath);
        // exibe o caminho resolvido na barra
        const pathLbl = document.createElement('span'); pathLbl.style.cssText = 'font-size:10px;color:var(--accent2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; pathLbl.textContent = relPath; pathLbl.title = absPath || relPath;
        // remove a linha FILE: do conteúdo que vai para o disco
        const cleanContent = code.replace(/^(?:--|\/\/|#)\s*FILE:\s*.+\n?/, '');
        const saveBtn = document.createElement('button'); saveBtn.className = 'miniBtn accent'; saveBtn.textContent = '💾 Salvar arquivo'; saveBtn.title = absPath ? 'Salvar em: ' + absPath : 'Abra Pasta A ou B primeiro';
        saveBtn.onclick = () => {
          if (!absPath) return alert('Abra a Pasta A ou B primeiro (modo Arquivos) para definir o root do servidor.');
          if (fsp.existsSync(absPath) && !confirm(`Sobrescrever arquivo existente?\n${absPath}`)) return;
          if (aiApplyFile(absPath, cleanContent)) { saveBtn.textContent = '✅ Salvo'; saveBtn.disabled = true; $('status').textContent = '💾 Salvo: ' + absPath; }
        };
        bar.insertBefore(pathLbl, bar.firstChild); bar.append(saveBtn);
      }
      box.appendChild(bar); div.appendChild(box);
    }
  }
  chat.appendChild(div); chat.scrollTop = chat.scrollHeight;
}
function aiInsertCode(code) {
  if (activeTab && filesCM) { filesCM.replaceSelection(code); setMode('files'); $('status').textContent = 'código inserido na aba ativa'; }
  else { navigator.clipboard.writeText(code); $('status').textContent = 'sem arquivo aberto — código copiado. Abra um arquivo p/ inserir.'; }
}
function aiReplaceFile(code) {
  if (!activeTab || !filesCM) { navigator.clipboard.writeText(code); return alert('Abra um arquivo no modo Arquivos primeiro (o código foi copiado).'); }
  if (!confirm(`Substituir TODO o conteúdo de "${activeTab.name}" por este código?`)) return;
  filesCM.setValue(code); setMode('files'); $('status').textContent = 'arquivo ' + activeTab.name + ' substituído (não salvo — Ctrl+S)';
}
// ============================================================
// IA com acesso COMPLETO a Pasta A, OTC A, Pasta B, OTC B
// ============================================================
const AI_BINARY_EXT = /\.(otb|dat|spr|cwm|png|jpg|jpeg|gif|ico|otbm|dll|exe|bin|ttf|wav|ogg|mp3|zip|rar|7z|otui\.png|db|sqlite)$/i;

// Lê TODOS os arquivos texto de uma pasta recursivamente
// Retorna array de {rel, abs, content}
function aiReadAllFiles(root, label, budgetKb) {
  if (!root) return [];
  const budget = (budgetKb || 200) * 1024;
  const result = [];
  let used = 0;
  const walk = (d, depth) => {
    if (depth > 8) return;
    let ents; try { ents = fsp.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    // pastas primeiro, depois arquivos
    const dirs = [], files = [];
    for (const e of ents) { if (/^\./.test(e.name) || e.name === 'node_modules') continue; (e.isDirectory() ? dirs : files).push(e); }
    for (const e of files) {
      if (used >= budget) return;
      if (AI_BINARY_EXT.test(e.name)) continue;
      const abs = path.join(d, e.name);
      const rel = abs.replace(root, '').replace(/^[\\/]/, '').replace(/\\/g, '/');
      try {
        const raw = fsp.readFileSync(abs, 'utf8');
        const chunk = raw.slice(0, 8000); // max 8KB por arquivo
        used += chunk.length;
        result.push({ rel, abs, content: chunk, truncated: raw.length > 8000 });
      } catch (e) {}
    }
    for (const e of dirs) walk(path.join(d, e.name), depth + 1);
  };
  walk(root, 0);
  return result;
}

// Gera tree listing compacto (só estrutura de pastas, sem conteúdo)
function aiFolderTree(root) {
  if (!root) return '';
  const lines = [];
  const walk = (d, prefix, depth) => {
    if (depth > 6) return;
    let ents; try { ents = fsp.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (/^\./.test(e.name) || e.name === 'node_modules') continue;
      if (e.isDirectory()) { lines.push(prefix + e.name + '/'); walk(path.join(d, e.name), prefix + '  ', depth + 1); }
      else if (!AI_BINARY_EXT.test(e.name)) lines.push(prefix + e.name);
    }
  };
  walk(root, '', 0);
  return lines.join('\n');
}

// Encontra arquivos mencionados no prompt e os lê de QUALQUER das 4 pastas
function aiFindMentionedFiles(promptText) {
  const allRoots = [
    { root: filesRoot, label: 'Servidor A' }, { root: filesRootOtc, label: 'OTCv8 A' },
    { root: filesRoot2, label: 'Servidor B' }, { root: filesRootC, label: 'OTCv8 B' },
  ].filter((r) => r.root);
  if (!allRoots.length) return [];
  const tokens = [...new Set(
    (promptText.match(/[\w\-./\\]+\.\w{2,5}/g) || []).map((t) => t.toLowerCase().replace(/\\/g, '/'))
  )];
  if (!tokens.length) return [];
  const found = [];
  for (const { root, label } of allRoots) {
    const walk = (d, depth) => {
      if (depth > 6 || found.length >= 20) return;
      let ents; try { ents = fsp.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        if (found.length >= 20) break;
        if (/^\./.test(e.name)) continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs, depth + 1); }
        else {
          const el = e.name.toLowerCase();
          if (tokens.some((t) => el === t || el === path.basename(t) || abs.toLowerCase().replace(/\\/g, '/').includes(t))) {
            try { const raw = fsp.readFileSync(abs, 'utf8').slice(0, 10000); found.push({ root, label, rel: abs.replace(root, '').replace(/^[\\/]/, '').replace(/\\/g, '/'), abs, content: raw }); } catch (_) {}
          }
        }
      }
    };
    walk(root, 0);
  }
  return found;
}

// Monta contexto COMPLETO de todas as pastas para a IA
function aiFolderContext(promptText) {
  const parts = [];
  const allRoots = [
    { root: filesRoot, label: 'Servidor A (SEU servidor — escrever aqui)', key: 'A' },
    { root: filesRootOtc, label: 'OTCv8/MEHAH A (SEU cliente — escrever aqui)', key: 'OTC_A' },
    { root: filesRoot2, label: 'Servidor B (FONTE — só ler daqui)', key: 'B' },
    { root: filesRootC, label: 'OTCv8/MEHAH B (FONTE — só ler daqui)', key: 'OTC_B' },
  ].filter((r) => r.root);

  if (!allRoots.length) return '';

  // 1. Tree listing de todas as pastas (estrutura completa, sem conteúdo)
  for (const { root, label } of allRoots) {
    const tree = aiFolderTree(root);
    if (tree) parts.push(`=== ESTRUTURA: ${label} (${root}) ===\n${tree}`);
  }

  // 2. Conteúdo COMPLETO de todas as pastas (budget dividido entre pastas)
  const budgetPerRoot = Math.floor(300 / allRoots.length); // 300KB total dividido
  for (const { root, label } of allRoots) {
    const files = aiReadAllFiles(root, label, budgetPerRoot);
    if (!files.length) continue;
    const block = files.map((f) => `\n--- [${label}] ${f.rel}${f.truncated ? ' (truncado)' : ''} ---\n${f.content}`).join('\n');
    parts.push(`=== CONTEÚDO: ${label} ===\n${block}`);
  }

  // 3. Arquivos mencionados explicitamente no prompt (leitura extra, prioridade alta)
  const mentioned = aiFindMentionedFiles(promptText);
  if (mentioned.length) {
    parts.push('=== ARQUIVOS MENCIONADOS NO PROMPT ===\n' + mentioned.map((f) => `\n--- [${f.label}] ${f.rel} ---\n${f.content}`).join('\n'));
  }

  return parts.length ? '\n\n' + parts.join('\n\n') : '';
}

// Status bar com info das pastas carregadas na IA
function updateAiFolderStatus() {
  const loaded = [
    filesRoot    ? '🖥 Servidor A' : null,
    filesRootOtc ? '🎮 OTCv8 A'   : null,
    filesRoot2   ? '📦 Servidor B' : null,
    filesRootC   ? '🕹 OTCv8 B'   : null,
  ].filter(Boolean);
  if ($('status') && loaded.length) $('status').textContent = 'IA tem acesso a: ' + loaded.join(' · ');
}

// Resolve um caminho relativo contra a pasta destino correta
// Lua/XML do servidor → Servidor A; OTUI/Lua do cliente → OTC A
function aiResolveDestPath(relPath) {
  const lp = relPath.toLowerCase();
  const isClient = /\.(otui|otml)$/i.test(lp) || /^(modules|mods|init|layouts|skins)\//i.test(lp);
  const root = isClient ? (filesRootOtc || filesRoot) : (filesRoot || filesRootOtc);
  if (!root) return null;
  return path.isAbsolute(relPath) ? relPath : path.join(root, relPath);
}

// Aplica um arquivo: escreve no disco e abre/atualiza na aba
function aiApplyFile(absPath, content) {
  try {
    // garante que a pasta existe
    const dir = path.dirname(absPath); if (!fsp.existsSync(dir)) fsp.mkdirSync(dir, { recursive: true });
    fsp.writeFileSync(absPath, content, 'utf8');
    // abre na aba do editor
    const name = path.basename(absPath);
    const existing = openTabs.find((t) => t.file === absPath);
    if (existing) { existing.doc = CodeMirror.Doc(content, guessMode(name)); existing.savedGen = existing.doc.changeGeneration(); activateTab(existing); }
    else { const doc = CodeMirror.Doc(content, guessMode(name)); const tab = { file: absPath, name, doc, savedGen: doc.changeGeneration() }; openTabs.push(tab); activateTab(tab); renderTabs(); }
    setMode('files');
    return true;
  } catch (e) { alert('Erro ao salvar ' + absPath + ': ' + e.message); return false; }
}

// Detecta blocos FILE: na resposta da IA — retorna [{relPath, absPath, content}]
function aiParseFileBlocks(responseText) {
  const blocks = [];
  const re = /```[\w]*\n((?:--\s*FILE:|\/\/\s*FILE:|#\s*FILE:|<!--\s*FILE:)\s*(.+?)(?:\s*-->)?\n)([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(responseText))) {
    const relPath = m[2].trim().replace(/\\/g, '/');
    const absPath = aiResolveDestPath(relPath);
    if (!absPath) continue;
    const content = m[3];
    blocks.push({ relPath, absPath, content });
  }
  return blocks;
}

// Verifica se uma função existe (CodeMirror pode não ter guessMode)
function guessMode(name) {
  if (/\.lua$/i.test(name)) return 'text/x-lua';
  if (/\.xml$/i.test(name)) return 'xml';
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.sql$/i.test(name)) return 'text/x-sql';
  return 'text/plain';
}

const AI_FILE_SYSTEM_ADDON = `\n\nACESSO A ARQUIVOS DO SERVIDOR:
Você tem acesso COMPLETO ao conteúdo das pastas do usuário (listadas acima). Regras:
- "Servidor A" e "OTCv8/MEHAH A" = pasta DO usuário — você PODE criar/modificar arquivos aqui
- "Servidor B" e "OTCv8/MEHAH B" = pastas FONTE (outro servidor) — você só LÊ daqui

Quando o usuário pedir para copiar, portar ou implementar algo da pasta B/OTCv8 B para A, você deve:
1. Analisar o código-fonte da pasta FONTE (B)
2. Adaptar para o estilo e estrutura da pasta DESTINO (A)
3. Gerar o(s) arquivo(s) completo(s) resultado

Para CADA arquivo que criar ou modificar, use EXATAMENTE este formato:
\`\`\`lua
-- FILE: caminho/relativo/desde/raiz/arquivo.lua
-- conteúdo completo aqui
\`\`\`
Para XML: \`<!-- FILE: caminho/arquivo.xml -->\` na primeira linha do bloco.
O caminho é SEMPRE relativo à raiz da pasta A (Servidor A) ou OTCv8 A, conforme o tipo.
Se o arquivo já existir, reproduza o arquivo COMPLETO modificado (nunca só o trecho).
O sistema detecta o marcador FILE: e mostra botão 💾 para salvar direto no disco.`;

function aiTokenEstimate(s) { return Math.round((s || '').length / 4); } // aprox (~4 chars/token)
function aiNewConversation() { aiHistory = []; const c = $('aiChat'); if (c) c.innerHTML = ''; $('status').textContent = 'nova conversa'; }
function aiSaveConversation() {
  if (!aiHistory.length) return alert('conversa vazia');
  ipcRenderer.invoke('save-file', 'conversa-ia.json').then((f) => { if (!f) return; fs.writeFileSync(f, JSON.stringify(aiHistory, null, 2)); $('status').textContent = 'conversa salva: ' + f; });
}
async function aiLoadConversation() {
  const f = await ipcRenderer.invoke('pick-file'); if (!f) return;
  try { const arr = JSON.parse(fs.readFileSync(f, 'utf8')); if (!Array.isArray(arr)) throw new Error('formato inválido'); aiHistory = arr; const c = $('aiChat'); c.innerHTML = ''; for (const m of aiHistory) aiAddMsg(m.role === 'assistant' ? 'assistant' : 'user', m.content); $('status').textContent = 'conversa carregada (' + arr.length + ' msgs)'; }
  catch (e) { alert('erro ao carregar: ' + e.message); }
}
async function aiSend() {
  const promptEl = $('aiPrompt'); const text = promptEl.value.trim();
  if (!text) return;
  const key = $('aiKey').value.trim();
  const pInfo = AI.PROVIDERS[aiProvider];
  if (!pInfo.local && !pInfo.nokey && !key) return alert('cole a API key do ' + aiProvider + ' (e clique 💾)');
  const baseUrl = pInfo.custom ? $('aiCustomUrl').value.trim() : undefined;
  const model = $('aiModel').value.trim() || AI.PROVIDERS[aiProvider].models[0];
  localStorage.setItem('ai.model.' + aiProvider, model);
  if (key) localStorage.setItem('ai.key.' + aiProvider, key);
  const ctx = aiContext();
  const folderCtx = (filesRoot || filesRoot2 || filesRootOtc || filesRootC) ? aiFolderContext(text) : '';
  const userMsg = [ctx, folderCtx, text].filter(Boolean).join('\n\n');
  aiAddMsg('user', text);
  aiHistory.push({ role: 'user', content: userMsg });
  promptEl.value = '';
  const btn = $('aiSend'); btn.disabled = true; btn.textContent = '… pensando';
  const chat = $('aiChat'); const wait = document.createElement('div'); wait.className = 'aiMsg ai-assistant'; wait.textContent = '…'; chat.appendChild(wait);
  try {
    let acc = '', _firstTok = true;
    const baseSys = localStorage.getItem('ai.systemPrompt') || AI.SYSTEM_PROMPT;
    const sysP = (filesRoot || filesRoot2 || filesRootOtc || filesRootC) ? baseSys + AI_FILE_SYSTEM_ADDON : baseSys;
    const temp = parseFloat(localStorage.getItem('ai.temp')) || 0.3;
    // append incremental (evita O(n²) de reatribuir textContent inteiro por token)
    const resp = await AI.chatStream(aiProvider, key, model, aiHistory.slice(-10), { system: sysP, temperature: temp, maxTokens: 4096, baseUrl }, (delta) => { acc += delta; if (_firstTok) { wait.textContent = ''; _firstTok = false; } wait.appendChild(document.createTextNode(delta)); chat.scrollTop = chat.scrollHeight; });
    wait.remove();
    aiHistory.push({ role: 'assistant', content: resp });
    aiAddMsg('assistant', resp);
    // se tiver múltiplos FILE: blocks, mostra botão "Aplicar tudo"
    const fileBlocks = aiParseFileBlocks(resp);
    if (fileBlocks.length > 1) {
      const applyAll = document.createElement('button'); applyAll.className = 'miniBtn accent'; applyAll.style.margin = '6px 0'; applyAll.textContent = `💾 Aplicar todos os ${fileBlocks.length} arquivo(s)`;
      applyAll.onclick = () => {
        if (!confirm(`Salvar ${fileBlocks.length} arquivo(s) no servidor?\n${fileBlocks.map((b) => b.relPath).join('\n')}`)) return;
        let ok = 0; for (const b of fileBlocks) { if (aiApplyFile(b.absPath, b.content)) ok++; }
        applyAll.textContent = `✅ ${ok}/${fileBlocks.length} arquivo(s) salvo(s)`; applyAll.disabled = true;
        $('status').textContent = `💾 ${ok} arquivo(s) aplicado(s) no servidor`;
      };
      $('aiChat').appendChild(applyAll);
    }
    $('status').textContent = `IA respondeu (${aiProvider}/${model}) · ~${aiTokenEstimate(userMsg) + aiTokenEstimate(resp)} tokens${fileBlocks.length ? ' · ' + fileBlocks.length + ' arquivo(s) detectado(s)' : ''}`;
  } catch (e) {
    wait.remove();
    aiAddMsg('assistant', '❌ erro: ' + e.message);
  } finally { btn.disabled = false; btn.textContent = '▶ Enviar'; }
}
// ---------- explorador de arquivos (otserv inteiro) ----------
const BINARY_EXT = ['.otb', '.dat', '.spr', '.cwm', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.otbm', '.dll', '.exe', '.bin', '.ttf', '.wav', '.ogg'];

// ---------- abas (tabs estilo VS Code: 1 editor, varias abas) ----------
let openTabs = [];        // { file, name, doc, savedGen }
let activeTab = null;
let filesCM = null;

function ensureFilesCM() {
  if (filesCM) return filesCM;
  filesCM = CodeMirror.fromTextArea($('filesArea'), { lineNumbers: true, theme: 'material-darker', mode: 'text/plain', indentUnit: 4, tabSize: 4 });
  filesCM.setOption('extraKeys', Object.assign({ 'Ctrl-S': () => saveActiveTab() }, CM_KEYS));
  filesCM.on('changes', () => renderTabs());
  return filesCM;
}
function renderTabs() {
  const bar = $('fileTabs');
  bar.innerHTML = '';
  for (const t of openTabs) {
    const el = document.createElement('div');
    el.className = 'fileTab' + (t === activeTab ? ' active' : '');
    const nm = document.createElement('span'); nm.className = 'ftName'; nm.textContent = t.name; nm.title = t.file;
    if (!t.doc.isClean(t.savedGen)) { const d = document.createElement('span'); d.className = 'ftDot'; d.textContent = '●'; nm.appendChild(d); }
    const x = document.createElement('span'); x.className = 'ftClose'; x.textContent = '✕';
    el.append(nm, x);
    el.onclick = (e) => { if (e.target !== x) activateTab(t); };
    x.onclick = (e) => { e.stopPropagation(); closeTab(t); };
    bar.appendChild(el);
  }
}
function activateTab(tab) {
  activeTab = tab;
  const cm = ensureFilesCM();
  cm.swapDoc(tab.doc);
  renderTabs();
  setTimeout(() => { cm.refresh(); cm.focus(); }, 10);
}
function closeTab(tab) {
  if (!tab.doc.isClean(tab.savedGen) && !confirm(`"${tab.name}" tem alteracoes nao salvas. Fechar mesmo assim?`)) return;
  const i = openTabs.indexOf(tab);
  openTabs.splice(i, 1);
  if (activeTab === tab) {
    const next = openTabs[i] || openTabs[i - 1] || null;
    if (next) activateTab(next);
    else { activeTab = null; ensureFilesCM().swapDoc(CodeMirror.Doc('', 'text/plain')); renderTabs(); }
  } else renderTabs();
}
function saveActiveTab() {
  if (!activeTab) return;
  try { fsp.writeFileSync(activeTab.file, activeTab.doc.getValue(), 'latin1'); } catch (e) { return alert(e.message); }
  activeTab.savedGen = activeTab.doc.changeGeneration();
  renderTabs();
  $('status').textContent = 'Salvo: ' + activeTab.file;
  reloadAfterEdit(activeTab.file);
}
function closeAllTabs() {
  const dirty = openTabs.filter((t) => !t.doc.isClean(t.savedGen));
  if (dirty.length && !confirm(`${dirty.length} aba(s) com alteracoes nao salvas. Fechar todas mesmo assim?`)) return;
  openTabs = []; activeTab = null;
  ensureFilesCM().swapDoc(CodeMirror.Doc('', 'text/plain'));
  renderTabs();
}

function renderTreeInto(rootPath, containerId, lblId, hint) {
  const root = $(containerId);
  root.innerHTML = '';
  if (lblId) $(lblId).textContent = rootPath ? path.basename(rootPath) : '';
  if (!rootPath || !fsp.existsSync(rootPath)) { root.innerHTML = `<div class="alabel" style="padding:10px">${hint}</div>`; return; }
  fillDir(root, rootPath, 0);
}
function renderTree()    { renderTreeInto(filesRoot,    'fileTree',    'filesRootLbl',    'Clique 🖥 Servidor A'); }
function renderTreeB()   { renderTreeInto(filesRoot2,   'fileTreeB',   'filesRootLblB',   'Clique 📦 Servidor B (fonte)'); if ($('btnCloseB'))   $('btnCloseB').style.display   = filesRoot2   ? '' : 'none'; }
function renderTreeOtc() { renderTreeInto(filesRootOtc, 'fileTreeOtc', 'filesRootLblOtc', 'Clique 🎮 OTCv8/MEHAH'); if ($('btnCloseOtc')) $('btnCloseOtc').style.display = filesRootOtc ? '' : 'none'; }
function renderTreeC()   { renderTreeInto(filesRootC,   'fileTreeC',   'filesRootLblC',   'Clique 🕹 OTCv8 B (fonte)');  if ($('btnCloseC'))   $('btnCloseC').style.display   = filesRootC   ? '' : 'none'; }

function fillDir(container, dir, depth) {
  let items;
  try { items = fsp.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  items.sort((a, b) => { if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1; return a.name.localeCompare(b.name); });
  for (const it of items) container.appendChild(treeNode(path.join(dir, it.name), it.name, it.isDirectory(), depth));
}
function treeNode(full, name, isDir, depth) {
  const el = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'treeRow';
  row.style.paddingLeft = (depth * 12 + 6) + 'px';
  row.textContent = (isDir ? '📁 ' : '📄 ') + name;
  el.appendChild(row);
  if (isDir) {
    const kids = document.createElement('div');
    kids.style.display = 'none';
    el.appendChild(kids);
    let loaded = false;
    row.onclick = () => {
      if (kids.style.display === 'none') {
        if (!loaded) { loaded = true; fillDir(kids, full, depth + 1); }
        kids.style.display = ''; row.classList.add('open');
      } else { kids.style.display = 'none'; row.classList.remove('open'); }
    };
  } else {
    row.onclick = () => openInFiles(full, row);
  }
  row.oncontextmenu = (e) => fileCtxMenu(e, full, isDir);
  return el;
}
// ---- operações de arquivo (criar/renomear/deletar) ----
function fileNew(dir, isFolder) {
  const name = prompt(isFolder ? 'Nome da nova pasta:' : 'Nome do novo arquivo (ex: script.lua):', isFolder ? 'nova_pasta' : 'novo.lua'); if (!name) return;
  const p = path.join(dir, name);
  try { if (isFolder) fsp.mkdirSync(p, { recursive: true }); else { if (fsp.existsSync(p)) return alert('já existe'); fsp.writeFileSync(p, ''); } renderTree(); if (!isFolder) openInFiles(p); $('status').textContent = 'criado: ' + name; }
  catch (e) { alert('erro: ' + e.message); }
}
function fileRename(full) {
  const old = path.basename(full); const name = prompt('Renomear para:', old); if (!name || name === old) return;
  try { fsp.renameSync(full, path.join(path.dirname(full), name)); renderTree(); $('status').textContent = 'renomeado → ' + name; } catch (e) { alert('erro: ' + e.message); }
}
function fileDelete(full, isDir) {
  if (!confirm(`Deletar ${isDir ? 'a PASTA (e todo o conteúdo!)' : 'o arquivo'} "${path.basename(full)}"?`)) return;
  try { if (isDir) fsp.rmSync(full, { recursive: true, force: true }); else fsp.unlinkSync(full); const tab = openTabs.find((t) => t.file === full); if (tab) closeTab(tab); renderTree(); $('status').textContent = 'deletado'; } catch (e) { alert('erro: ' + e.message); }
}
function fileCtxMenu(e, full, isDir) {
  e.preventDefault(); document.querySelectorAll('.ctxMenu').forEach((m) => m.remove());
  const m = document.createElement('div'); m.className = 'ctxMenu';
  const add = (label, fn) => { const it = document.createElement('div'); it.className = 'ctxItem'; it.innerHTML = `<span>${label}</span>`; it.onclick = () => { m.remove(); fn(); }; m.appendChild(it); };
  const dir = isDir ? full : path.dirname(full);
  add('➕ Novo arquivo', () => fileNew(dir, false)); add('📁 Nova pasta', () => fileNew(dir, true));
  add('✏ Renomear', () => fileRename(full)); add('🗑 Deletar', () => fileDelete(full, isDir));
  add('📂 Abrir no Explorer', () => { try { require('electron').shell.showItemInFolder(full); } catch (e) { alert(e.message); } });
  add('⧉ Copiar caminho', () => { navigator.clipboard.writeText(full); $('status').textContent = 'caminho copiado'; });
  document.body.appendChild(m); m.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px'; m.style.top = Math.min(e.clientY, window.innerHeight - 160) + 'px';
  const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', close); } }; setTimeout(() => document.addEventListener('mousedown', close), 0);
}
// ---- find in files (busca em toda a Pasta A) ----
function findInFiles() {
  if (!filesRoot) return alert('abra a Pasta A primeiro (📂)');
  const q = prompt('Buscar em TODOS os arquivos da Pasta A:\n(envolva em /regex/ para usar regex)'); if (!q) return;
  let rx = null; const rxm = q.match(/^\/(.+)\/([gimsuy]*)$/); if (rxm) { try { rx = new RegExp(rxm[1], rxm[2].includes('i') ? rxm[2] : rxm[2] + 'i'); } catch (e) { return alert('regex inválido: ' + e.message); } }
  $('status').textContent = `buscando "${q}"…`;
  setTimeout(() => {
    const results = []; const LIM = 1500, SIZE = 2 * 1024 * 1024; let scanned = 0; const ql = q.toLowerCase();
    const walk = (dir) => { if (results.length >= LIM) return; let items; try { items = fsp.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const it of items) { if (results.length >= LIM) return; const full = path.join(dir, it.name);
        if (it.isDirectory()) { if (/^(node_modules|\.git|dist|build)$/i.test(it.name)) continue; walk(full); }
        else { const ext = path.extname(it.name).toLowerCase(); if (BINARY_EXT.includes(ext)) continue; try { if (fsp.statSync(full).size > SIZE) continue; const lines = fsp.readFileSync(full, 'latin1').split('\n'); scanned++; for (let i = 0; i < lines.length; i++) { const hit = rx ? rx.test(lines[i]) : lines[i].toLowerCase().includes(ql); if (hit) { results.push({ file: full, line: i + 1, text: lines[i].trim().slice(0, 140) }); if (results.length >= LIM) break; } } } catch (e) {} } } };
    walk(filesRoot);
    const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '640px';
    box.innerHTML = `<h3>🔍 "${q}" — ${results.length} em ${scanned} arquivos${results.length >= LIM ? ' (limite)' : ''}</h3>`;
    const list = document.createElement('div'); list.className = 'animBox'; list.style.maxHeight = '460px'; box.appendChild(list);
    for (const r of results) { const row = document.createElement('div'); row.className = 'animRow'; row.style.gridTemplateColumns = '1fr'; const b = document.createElement('button'); b.className = 'miniBtn'; b.style.cssText = 'text-align:left;font-size:11px'; b.textContent = `${path.relative(filesRoot, r.file)}:${r.line}  ${r.text}`; b.onclick = () => { openInFiles(r.file); setMode('files'); setTimeout(() => { if (filesCM) { filesCM.setCursor(r.line - 1, 0); filesCM.scrollIntoView({ line: r.line - 1, ch: 0 }, 100); } }, 120); ov.remove(); }; row.appendChild(b); list.appendChild(row); }
    if (!results.length) list.innerHTML = '<div class="alabel" style="padding:8px">nada encontrado</div>';
    const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
    $('status').textContent = `${results.length} resultado(s) em ${scanned} arquivos`;
  }, 20);
}
// ===== Editor de config.lua (key = value) =====
async function configEditor() {
  const root = filesRoot || (monDir ? path.resolve(monDir, '..', '..') : null);
  let cf = null; for (const p of [root && path.join(root, 'config.lua'), root && path.join(root, '..', 'config.lua')]) if (p && fsp.existsSync(p)) { cf = p; break; }
  if (!cf) { cf = await ipcRenderer.invoke('pick-file'); if (!cf) return; }
  let raw; try { raw = fsp.readFileSync(cf, 'latin1'); } catch (e) { return alert('erro: ' + e.message); }
  // parse top-level key = value (string/number/bool)
  const re = /^[ \t]*([A-Za-z_]\w*)\s*=\s*(".*?"|'.*?'|true|false|-?\d+\.?\d*)/gm; const entries = []; let m;
  while ((m = re.exec(raw))) entries.push({ key: m[1], raw: m[2], val: m[2].replace(/^["']|["']$/g, ''), isStr: /^["']/.test(m[2]), isBool: /^(true|false)$/.test(m[2]) });
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '560px';
  box.innerHTML = `<h3>⚙ config.lua — ${entries.length} chaves</h3><div class="alabel" style="font-size:11px">${cf}</div>`;
  const search = document.createElement('input'); search.placeholder = 'filtrar…'; search.style.cssText = 'width:100%;margin:6px 0'; box.appendChild(search);
  const list = document.createElement('div'); list.className = 'animBox'; list.style.maxHeight = '440px'; box.appendChild(list);
  const draw = () => { const q = search.value.toLowerCase(); list.innerHTML = ''; for (const e of entries) { if (q && !e.key.toLowerCase().includes(q)) continue; const r = document.createElement('label'); r.className = 'tpField'; r.innerHTML = `<span style="font-size:11px">${e.key}</span>`;
    if (e.isBool) { const s = document.createElement('select'); ['true', 'false'].forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; s.appendChild(o); }); s.value = e.val; s.onchange = () => { e.val = s.value; e.dirty = true; }; r.appendChild(s); }
    else { const i = document.createElement('input'); i.value = e.val; if (!e.isStr) i.type = 'text'; i.onchange = () => { e.val = i.value; e.dirty = true; }; r.appendChild(i); }
    list.appendChild(r); } };
  search.oninput = draw; draw();
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Cancelar'; c.onclick = () => ov.remove();
  const ok = document.createElement('button'); ok.className = 'miniBtn accent'; ok.textContent = '💾 Salvar config.lua';
  ok.onclick = () => { let out = raw; for (const e of entries) { if (!e.dirty) continue; const nv = e.isStr ? `"${e.val}"` : e.val; const rr = new RegExp('^([ \\t]*' + e.key + '\\s*=\\s*)(".*?"|\'.*?\'|true|false|-?\\d+\\.?\\d*)', 'm'); out = out.replace(rr, `$1${nv}`); } try { backup(cf); fsp.writeFileSync(cf, out, 'latin1'); $('status').textContent = 'config.lua salvo'; ov.remove(); } catch (e2) { alert('erro: ' + e2.message); } };
  foot.append(c, ok); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// ===== Editor de quests.xml =====
async function questEditor() {
  const root = filesRoot || (monDir ? path.resolve(monDir, '..', '..') : null);
  let qf = null; for (const p of [root && path.join(root, 'data', 'XML', 'quests.xml'), root && path.join(root, 'data', 'quests.xml'), root && path.join(root, 'quests.xml')]) if (p && fsp.existsSync(p)) { qf = p; break; }
  if (!qf) { qf = await ipcRenderer.invoke('pick-file'); if (!qf) return; }
  let raw; try { raw = fsp.readFileSync(qf, 'latin1'); } catch (e) { return alert('erro: ' + e.message); }
  const quests = []; const qre = /<quest\b([^>]*)>([\s\S]*?)<\/quest>|<quest\b([^>]*)\/>/gi; let m;
  while ((m = qre.exec(raw))) { const at = m[1] || m[3] || ''; quests.push({ name: attrOf(at, 'name'), storageId: attrOf(at, 'startstorageid'), storageValue: attrOf(at, 'startstoragevalue'), missions: (m[2] || '').match(/<mission\b/gi) ? (m[2].match(/<mission\b/gi).length) : 0, orig: m[0] }); }
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '600px';
  box.innerHTML = `<h3>📜 Quests — ${quests.length}</h3><div class="alabel" style="font-size:11px">${qf}</div>`;
  const search = document.createElement('input'); search.placeholder = 'filtrar quest…'; search.style.cssText = 'width:100%;margin:6px 0'; box.appendChild(search);
  const list = document.createElement('div'); list.className = 'animBox'; list.style.maxHeight = '440px'; box.appendChild(list);
  const draw = () => { const q = search.value.toLowerCase(); list.innerHTML = ''; for (const qu of quests) { if (q && !qu.name.toLowerCase().includes(q)) continue; const r = document.createElement('div'); r.className = 'animRow'; r.style.gridTemplateColumns = '1fr 90px 70px 60px';
    const mk = (val, key, ph) => { const i = document.createElement('input'); i.value = val; i.placeholder = ph; i.onchange = () => { qu[key] = i.value; qu.dirty = true; }; return i; };
    const ms = document.createElement('span'); ms.className = 'alabel'; ms.textContent = qu.missions + ' miss';
    r.append(mk(qu.name, 'name', 'nome'), mk(qu.storageId, 'storageId', 'storage'), mk(qu.storageValue, 'storageValue', 'valor'), ms); list.appendChild(r); } };
  search.oninput = draw; draw();
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Cancelar'; c.onclick = () => ov.remove();
  const ok = document.createElement('button'); ok.className = 'miniBtn accent'; ok.textContent = '💾 Salvar quests.xml';
  ok.onclick = () => { let out = raw; for (const qu of quests) { if (!qu.dirty) continue; let nt = qu.orig; nt = nt.replace(/(name\s*=\s*")[^"]*"/i, `$1${qu.name}"`); if (qu.storageId) nt = /startstorageid/i.test(nt) ? nt.replace(/(startstorageid\s*=\s*")[^"]*"/i, `$1${qu.storageId}"`) : nt.replace(/<quest /i, `<quest startstorageid="${qu.storageId}" startstoragevalue="${qu.storageValue || 1}" `); out = out.replace(qu.orig, nt); qu.orig = nt; } try { backup(qf); fsp.writeFileSync(qf, out, 'latin1'); $('status').textContent = 'quests.xml salvo'; ov.remove(); } catch (e) { alert('erro: ' + e.message); } };
  foot.append(c, ok); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// ===== Editor de outfits.xml / mounts.xml (server) =====
async function outfitsEditor() {
  const root = filesRoot || (monDir ? path.resolve(monDir, '..', '..') : null);
  const find = (names) => { for (const base of [root && path.join(root, 'data', 'XML'), root && path.join(root, 'data'), root].filter(Boolean)) for (const n of names) { const p = path.join(base, n); if (fsp.existsSync(p)) return p; } return null; };
  let of = find(['outfits.xml']); let isMount = false;
  if (!of) { of = await ipcRenderer.invoke('pick-file'); if (!of) return; }
  let raw; try { raw = fsp.readFileSync(of, 'latin1'); } catch (e) { return alert('erro: ' + e.message); }
  isMount = /<mount\b/i.test(raw); const tag = isMount ? 'mount' : 'outfit';
  const rows = []; const re = new RegExp('<' + tag + '\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/' + tag + '>)', 'gi'); let m;
  while ((m = re.exec(raw))) rows.push({ at: m[1], orig: m[0], name: attrOf(m[1], 'name'), id: attrOf(m[1], 'id') || attrOf(m[1], 'clientid'), premium: /premium\s*=\s*"(?:1|yes|true)"/i.test(m[1]), enabled: !/enabled\s*=\s*"(?:0|no|false)"/i.test(m[1]) });
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '600px';
  box.innerHTML = `<h3>👕 ${tag}s — ${rows.length}</h3><div class="alabel" style="font-size:11px">${of}</div>`;
  const search = document.createElement('input'); search.placeholder = 'filtrar…'; search.style.cssText = 'width:100%;margin:6px 0'; box.appendChild(search);
  const list = document.createElement('div'); list.className = 'animBox'; list.style.maxHeight = '440px'; box.appendChild(list);
  const draw = () => { const q = search.value.toLowerCase(); list.innerHTML = ''; for (const r of rows) { if (q && !r.name.toLowerCase().includes(q)) continue; const row = document.createElement('div'); row.className = 'animRow'; row.style.gridTemplateColumns = '50px 1fr 70px 70px';
    const idi = document.createElement('input'); idi.value = r.id; idi.onchange = () => { r.id = idi.value; r.dirty = true; };
    const ni = document.createElement('input'); ni.value = r.name; ni.onchange = () => { r.name = ni.value; r.dirty = true; };
    const pl = document.createElement('label'); pl.style.fontSize = '10px'; const pc = document.createElement('input'); pc.type = 'checkbox'; pc.checked = r.premium; pc.onchange = () => { r.premium = pc.checked; r.dirty = true; }; pl.append(pc, document.createTextNode('prem'));
    const el = document.createElement('label'); el.style.fontSize = '10px'; const ec = document.createElement('input'); ec.type = 'checkbox'; ec.checked = r.enabled; ec.onchange = () => { r.enabled = ec.checked; r.dirty = true; }; el.append(ec, document.createTextNode('on'));
    row.append(idi, ni, pl, el); list.appendChild(row); } };
  search.oninput = draw; draw();
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Cancelar'; c.onclick = () => ov.remove();
  const ok = document.createElement('button'); ok.className = 'miniBtn accent'; ok.textContent = '💾 Salvar';
  ok.onclick = () => { let out = raw; for (const r of rows) { if (!r.dirty) continue; let nt = r.orig; nt = nt.replace(/(name\s*=\s*")[^"]*"/i, `$1${r.name}"`); if (r.id && /\b(id|clientid)\s*=/i.test(nt)) nt = nt.replace(/((?:id|clientid)\s*=\s*")[^"]*"/i, `$1${r.id}"`); nt = /premium\s*=/i.test(nt) ? nt.replace(/(premium\s*=\s*")[^"]*"/i, `$1${r.premium ? 'yes' : 'no'}"`) : nt; nt = /enabled\s*=/i.test(nt) ? nt.replace(/(enabled\s*=\s*")[^"]*"/i, `$1${r.enabled ? 'yes' : 'no'}"`) : nt; out = out.replace(r.orig, nt); r.orig = nt; } try { backup(of); fsp.writeFileSync(of, out, 'latin1'); $('status').textContent = tag + 's salvos'; ov.remove(); } catch (e) { alert('erro: ' + e.message); } };
  foot.append(c, ok); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// ===== Backup do servidor (cópia da pasta filesRoot) =====
function serverBackup() {
  const root = filesRoot || (monDir ? path.resolve(monDir, '..', '..') : null); if (!root) return alert('defina a pasta do servidor (Files ▸ 📂 Pasta A)');
  const d = new Date(); const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  const dest = root + '_backup_' + stamp;
  if (!confirm(`Copiar TODO o servidor para:\n${dest}\n\n(pode demorar e ocupar espaço)`)) return;
  $('status').textContent = 'fazendo backup…';
  setTimeout(() => { try { fsp.cpSync(root, dest, { recursive: true, errorOnExist: false, filter: (s) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(s) }); $('status').textContent = '✅ backup feito: ' + dest; alert('Backup criado:\n' + dest); } catch (e) { alert('erro no backup: ' + e.message); $('status').textContent = 'erro no backup'; } }, 30);
}
// ===== Health Check (validação geral do servidor) =====
function serverHealthCheck() {
  const issues = [];
  const itemExists = (id) => { id = parseInt(id, 10); if (!id) return true; return (otbMap && otbMap.has(id)) || (dat && dat.item(id)); };
  const monNames = new Set(monsters.map((m) => m.name.toLowerCase()));
  // monstros: loot ids, looktype, summons
  for (const m of monsters) {
    for (const a of (m.loot || [])) { const idm = a.match(/\bid\s*=\s*"(\d+)"/i); if (idm && !itemExists(idm[1])) issues.push({ t: 'Monster', who: m.name, msg: `loot item id ${idm[1]} não existe`, file: m.file }); }
    if (m.looktype && dat && !dat.creature(parseInt(m.looktype, 10))) issues.push({ t: 'Monster', who: m.name, msg: `looktype ${m.looktype} não existe no .dat`, file: m.file });
    const sblk = (m.raw.match(rawBlockRe('summons')) || [''])[0]; const sre = /<summon\b[^>]*\bname\s*=\s*"([^"]*)"/gi; let s; while ((s = sre.exec(sblk))) if (!monNames.has(s[1].toLowerCase())) issues.push({ t: 'Monster', who: m.name, msg: `summon "${s[1]}" não tem XML de monstro`, file: m.file });
  }
  // npcs: shop ids
  for (const n of npcs) for (const it of (n.items || [])) { if (it.id && !itemExists(it.id)) issues.push({ t: 'NPC', who: n.name, msg: `shop item id ${it.id} não existe`, file: n.file }); }
  // spawns: nomes de monstro existem?
  if (spawnStore) { const seen = new Set(); for (const e of spawnStore.entries) { if (seen.has(e.name)) continue; seen.add(e.name); if (!monNames.has((e.name || '').toLowerCase())) issues.push({ t: 'Spawn', who: e.name, msg: `monstro "${e.name}" do spawn não tem XML`, file: spawnFile }); } }
  // modal
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '640px';
  box.innerHTML = `<h3>🩺 Health Check — ${issues.length} problema(s)</h3><div class="alabel" style="font-size:11px;margin-bottom:6px">verifica loot/looktype/summons/shop/spawn vs items.otb e XMLs carregados</div>`;
  const list = document.createElement('div'); list.className = 'animBox'; list.style.maxHeight = '460px'; box.appendChild(list);
  if (!issues.length) list.innerHTML = '<div class="alabel" style="padding:10px;color:#5cf08a">✅ nenhum problema encontrado!</div>';
  for (const is of issues) { const r = document.createElement('div'); r.className = 'animRow'; r.style.gridTemplateColumns = '1fr'; const b = document.createElement('button'); b.className = 'miniBtn'; b.style.cssText = 'text-align:left;font-size:11px'; b.textContent = `[${is.t}] ${is.who}: ${is.msg}`; b.onclick = () => { if (is.file) { setMode('files'); openInFiles(is.file); } }; r.appendChild(b); list.appendChild(r); }
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
  $('status').textContent = `Health Check: ${issues.length} problema(s)`;
}
// templates de arquivo (boilerplate TFS)
const FILE_TEMPLATES = {
  'Monster (XML)': { ext: 'monster/Nome.xml', body: `<?xml version="1.0" encoding="UTF-8"?>\n<monster name="Nome" nameDescription="a nome" race="blood" experience="0" speed="200" manacost="0">\n\t<health now="100" max="100"/>\n\t<look type="100" corpse="0"/>\n\t<targetchange interval="4000" chance="0"/>\n\t<flags>\n\t\t<flag summonable="0"/>\n\t\t<flag attackable="1"/>\n\t\t<flag hostile="1"/>\n\t\t<flag illusionable="0"/>\n\t\t<flag convinceable="0"/>\n\t\t<flag pushable="0"/>\n\t\t<flag canpushitems="1"/>\n\t\t<flag canpushcreatures="0"/>\n\t\t<flag targetdistance="1"/>\n\t\t<flag staticattack="90"/>\n\t\t<flag runonhealth="0"/>\n\t</flags>\n\t<attacks>\n\t\t<attack name="melee" interval="2000" skill="10" attack="10"/>\n\t</attacks>\n\t<defenses armor="0" defense="0"/>\n\t<loot>\n\t</loot>\n</monster>` },
  'Spell (revscript)': { ext: 'scripts/spells/nome.lua', body: `local combat = Combat()\ncombat:setParameter(COMBAT_PARAM_TYPE, COMBAT_FIREDAMAGE)\ncombat:setParameter(COMBAT_PARAM_EFFECT, CONST_ME_FIREAREA)\ncombat:setFormula(COMBAT_FORMULA_LEVELMAGIC, -1.0, -10, -1.5, -20)\n\nlocal spell = Spell("instant")\nfunction spell.onCastSpell(creature, var)\n\treturn combat:execute(creature, var)\nend\nspell:name("Nome")\nspell:words("exori nome")\nspell:level(8)\nspell:mana(20)\nspell:cooldown(2000)\nspell:needLearn(false)\nspell:isSelfTarget(false)\nspell:register()` },
  'Action (revscript)': { ext: 'scripts/actions/nome.lua', body: `local action = Action()\nfunction action.onUse(player, item, fromPosition, target, toPosition, isHotkey)\n\tplayer:sendTextMessage(MESSAGE_INFO_DESCR, "Usado!")\n\treturn true\nend\naction:id(0)\naction:register()` },
  'Movement (revscript)': { ext: 'scripts/movements/nome.lua', body: `local move = MoveEvent()\nfunction move.onStepIn(creature, item, position, fromPosition)\n\tlocal player = creature:getPlayer()\n\tif not player then return true end\n\treturn true\nend\nmove:type("stepin")\nmove:id(0)\nmove:register()` },
  'Talkaction (revscript)': { ext: 'scripts/talkactions/nome.lua', body: `local talk = TalkAction("!nome")\nfunction talk.onSay(player, words, param, type)\n\tplayer:sendTextMessage(MESSAGE_INFO_DESCR, "Oi!")\n\treturn false\nend\ntalk:separator(" ")\ntalk:register()` },
  'NPC (XML)': { ext: 'npc/Nome.xml', body: `<?xml version="1.0" encoding="UTF-8"?>\n<npc name="Nome" script="default.lua" walkinterval="2000" floorchange="0">\n\t<health now="100" max="100"/>\n\t<look type="130" head="0" body="0" legs="0" feet="0" addons="0"/>\n\t<parameters>\n\t\t<parameter key="message_greet" value="Hello |PLAYERNAME|!"/>\n\t\t<parameter key="message_farewell" value="Bye!"/>\n\t</parameters>\n</npc>` },
};
function showTemplates() {
  if (!filesRoot) return alert('abra a Pasta A primeiro (📂)');
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '420px';
  box.innerHTML = '<h3>📋 Novo arquivo de template</h3>';
  const sel = document.createElement('select'); sel.style.width = '100%'; for (const k of Object.keys(FILE_TEMPLATES)) { const o = document.createElement('option'); o.value = k; o.textContent = k; sel.appendChild(o); } box.appendChild(sel);
  const pr = document.createElement('label'); pr.className = 'opRow'; pr.innerHTML = '<span>caminho (relativo à Pasta A)</span>'; const pi = document.createElement('input'); pi.style.cssText = 'flex:1;max-width:240px'; pi.value = FILE_TEMPLATES[sel.value].ext; pr.appendChild(pi); box.appendChild(pr);
  sel.onchange = () => pi.value = FILE_TEMPLATES[sel.value].ext;
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Cancelar'; c.onclick = () => ov.remove();
  const ok = document.createElement('button'); ok.className = 'miniBtn accent'; ok.textContent = 'Criar';
  ok.onclick = () => { const full = path.join(filesRoot, pi.value); try { fsp.mkdirSync(path.dirname(full), { recursive: true }); if (fsp.existsSync(full) && !confirm('já existe, sobrescrever?')) return; fsp.writeFileSync(full, FILE_TEMPLATES[sel.value].body, 'latin1'); renderTree(); openInFiles(full); ov.remove(); $('status').textContent = 'template criado: ' + pi.value; } catch (e) { alert('erro: ' + e.message); } };
  foot.append(c, ok); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// recentes
function pushRecent(file) { try { let r = JSON.parse(localStorage.getItem('recentFiles') || '[]'); r = r.filter((x) => x !== file); r.unshift(file); r = r.slice(0, 20); localStorage.setItem('recentFiles', JSON.stringify(r)); } catch (e) {} }
function showRecent() {
  let r = []; try { r = JSON.parse(localStorage.getItem('recentFiles') || '[]'); } catch (e) {}
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '560px';
  box.innerHTML = '<h3>🕘 Arquivos recentes</h3>'; const list = document.createElement('div'); list.className = 'animBox'; list.style.maxHeight = '420px'; box.appendChild(list);
  for (const f of r) { if (!fsp.existsSync(f)) continue; const b = document.createElement('button'); b.className = 'miniBtn'; b.style.cssText = 'text-align:left;display:block;width:100%;font-size:11px'; b.textContent = f; b.onclick = () => { ov.remove(); setMode('files'); openInFiles(f); }; list.appendChild(b); }
  if (!list.children.length) list.innerHTML = '<div class="alabel" style="padding:8px">nenhum recente</div>';
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const cl = document.createElement('button'); cl.className = 'miniBtn'; cl.textContent = '🗑 limpar'; cl.onclick = () => { localStorage.removeItem('recentFiles'); ov.remove(); }; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.append(cl, c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// abre o arquivo numa ABA (clica na aba -> mostra na tela toda)
function openInFiles(file, row) {
  const ext = path.extname(file).toLowerCase();
  if (BINARY_EXT.includes(ext)) { alert('Arquivo binário (nao editavel como texto): ' + path.basename(file)); return; }
  pushRecent(file);
  const existing = openTabs.find((t) => t.file === file);
  if (existing) { activateTab(existing); return; }
  if (window.__fileCached && !window.__fileCached(file)) { window.__preloadFile(file).then(() => openInFiles(file, row)); return; } // preload sob demanda
  let text;
  try { text = fsp.readFileSync(file, 'latin1'); } catch (e) { return alert(e.message); }
  if (text.length > 3_000_000) { if (!confirm('Arquivo grande (' + Math.round(text.length / 1e6) + 'MB). Abrir mesmo assim?')) return; }
  const mode = modeFor(file);
  const doc = CodeMirror.Doc(text, mode);
  let name = path.basename(file);
  if (filesRoot2) { // 2 pastas -> prefixa pra diferenciar
    if (filesRoot && file.startsWith(filesRoot + path.sep)) name = '[A] ' + name;
    else if (file.startsWith(filesRoot2 + path.sep)) name = '[B] ' + name;
  }
  const tab = { file, name, doc, savedGen: doc.changeGeneration() };
  openTabs.push(tab);
  activateTab(tab);
}

// ---------- diff entre pastas (multi-client) ----------
let _diffMV = null, _diffTargetFile = null;
function counterpartOf(file) {
  if (filesRoot && file.startsWith(filesRoot + path.sep)) return filesRoot2 ? path.join(filesRoot2, file.slice(filesRoot.length)) : null;
  if (filesRoot2 && file.startsWith(filesRoot2 + path.sep)) return filesRoot ? path.join(filesRoot, file.slice(filesRoot2.length)) : null;
  return null;
}
function openDiff() {
  if (!activeTab) return alert('Abra um arquivo primeiro (clique na árvore).');
  if (!filesRoot2) return alert('Defina a Pasta B primeiro (botão 📂 Pasta B).');
  const other = counterpartOf(activeTab.file);
  if (!other) return alert('Esse arquivo não está dentro da Pasta A nem da Pasta B.');
  if (!fsp.existsSync(other)) return alert('Não existe o equivalente na outra pasta:\n' + other);
  let curText, otherText;
  try { curText = activeTab.doc.getValue(); otherText = fsp.readFileSync(other, 'latin1'); } catch (e) { return alert(e.message); }
  const mode = modeFor(activeTab.file);
  const aIsCurrent = filesRoot && activeTab.file.startsWith(filesRoot + path.sep);
  $('diffView').innerHTML = '';
  $('diffTitle').textContent = `◀ ${aIsCurrent ? 'Pasta B' : 'Pasta A'} (outra)   vs   ${aIsCurrent ? 'Pasta A' : 'Pasta B'} (atual, editável) ▶ — ${path.basename(activeTab.file)}`;
  _diffMV = CodeMirror.MergeView($('diffView'), {
    value: curText, orig: otherText, mode, theme: 'material-darker',
    lineNumbers: true, highlightDifferences: true, connect: 'align', collapseIdentical: false, revertButtons: true,
  });
  _diffTargetFile = activeTab.file;
  $('diffModal').style.display = 'flex';
  setTimeout(() => { try { _diffMV.editor().refresh(); _diffMV.leftOriginal().refresh(); } catch (e) {} }, 40);
}

// ---------- modal: nome ao criar ----------
let _nameCb = null;
function askName(title, def, cb) {
  $('nameTitle').textContent = title;
  $('nameInput').value = def || '';
  _nameCb = cb;
  $('nameModal').style.display = 'flex';
  $('nameInput').focus(); $('nameInput').select();
}

// ---------- modal: seletor visual de looktype ----------
let _lookCb = null;
function openLookPicker(cb) {
  if (!dat || !spr) { alert('carregue .dat/.spr primeiro'); return; }
  _lookCb = cb;
  $('lookFilter').value = '';
  $('lookPicker').style.display = 'flex';
  renderLookGrid();
  $('lookFilter').focus();
}
function renderLookGrid() {
  const grid = $('lookGrid');
  grid.innerHTML = '';
  if (!dat) return;
  const q = $('lookFilter').value.trim();
  let ids = Array.from(dat.creatures.keys()).sort((a, b) => a - b);
  if (q) ids = ids.filter((id) => String(id).includes(q));
  const shown = ids.slice(0, 300);
  for (const id of shown) {
    const tile = document.createElement('div');
    tile.className = 'lookTile';
    const cv = document.createElement('canvas'); cv.width = 52; cv.height = 52;
    const t = dat.creature(id);
    drawScaled(cv, composeThing(t, t && t.px >= 4 ? 2 : 0));
    const sp = document.createElement('span'); sp.textContent = id;
    tile.append(cv, sp);
    tile.onclick = () => { $('lookPicker').style.display = 'none'; const cb = _lookCb; _lookCb = null; if (cb) cb(id); };
    grid.appendChild(tile);
  }
  if (ids.length > 300) {
    const more = document.createElement('div');
    more.style.cssText = 'grid-column:1/-1;color:#888;font-size:11px;padding:6px';
    more.textContent = `… ${ids.length - 300} a mais — filtre por id`;
    grid.appendChild(more);
  }
}

// ---------- validacao ----------
function buildIndexNameFor() {
  if (!monDir) return () => undefined;
  const idx = path.join(monDir, 'monsters.xml');
  if (!fsp.existsSync(idx)) return () => undefined;
  let raw; try { raw = fsp.readFileSync(idx, 'latin1'); } catch (e) { return () => undefined; }
  const map = new Map();
  const re = /<monster\b[^>]*?>/gi; let m;
  while ((m = re.exec(raw)) !== null) {
    const tag = m[0];
    const nm = tag.match(/\bname\s*=\s*"([^"]*)"/i);
    const fl = tag.match(/\bfile\s*=\s*"([^"]*)"/i);
    if (fl) map.set(path.basename(fl[1]), nm ? nm[1] : '');
  }
  return (file) => { const b = path.basename(file); return map.has(b) ? map.get(b) : null; };
}

function runValidation() {
  const ctx = {
    creatureExists: (lt) => (dat ? dat.creatures.has(lt) : true),
    itemServerExists: (id) => (otbMap ? otbMap.has(id) : true),
    indexNameFor: buildIndexNameFor(),
  };
  const issues = VAL.validateAll(monsters, npcs, ctx);
  $('valTitle').textContent = `Validação — ${issues.length} problema(s)`;
  const box = $('valList'); box.innerHTML = '';
  if (!issues.length) box.innerHTML = '<div class="valEmpty">✓ Nenhum problema encontrado</div>';
  issues.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'valRow ' + (it.sev || 'err');
    row.innerHTML = `<span class="dot"></span><span class="vname">${escapeHtml(it.name)}</span>` +
      `<span class="vkind">${it.kind}</span><span class="vmsg">${escapeHtml(it.msg)}</span>`;
    row.onclick = () => {
      $('valModal').style.display = 'none';
      if (it.kind === 'npc') { setMode('npc'); selectNpc(it.entity); }
      else { setMode('mon'); select(it.entity); }
    };
    box.appendChild(row);
  });
  $('valModal').style.display = 'flex';
}

// ---------- modal de logs de erro ----------
function renderErrModal() {
  $('errTitle').textContent = `Logs de erro (${errorLog.length})`;
  const box = $('errList');
  box.innerHTML = '';
  if (!errorLog.length) { box.innerHTML = '<div class="valEmpty">✓ Nenhum erro registrado</div>'; }
  for (let i = errorLog.length - 1; i >= 0; i--) {
    const e = errorLog[i];
    const row = document.createElement('div');
    row.className = 'errRow';
    row.innerHTML = `<div class="errHead"><span class="errTime">${e.time}</span><span class="errMsg">${escapeHtml(e.msg)}</span></div>` +
      (e.stack ? `<pre class="errStack">${escapeHtml(e.stack)}</pre>` : '');
    box.appendChild(row);
  }
  $('errModal').style.display = 'flex';
}

// ---------- acoes ----------
$('btnGold').onclick = () => {
  if (!current) return;
  current.loot.unshift(economy.suggestedGoldAttrs(current.exp));
  markDirty(current);
  renderLoot();
};
$('btnAdd').onclick = () => {
  if (mode === 'npc') {
    if (!currentNpc) return;
    currentNpc.items.push({ role: 'buy', name: 'novo item', id: 0, price: 0 });
    markDirty(currentNpc);
    renderShop();
    return;
  }
  if (!current) return;
  current.loot.push('id="0" countmax="1" chance="1000"');
  markDirty(current);
  renderLoot();
};
$('btnApplySug').onclick = () => {
  if (!currentNpc || !npcCtx) return;
  for (const it of currentNpc.items) it.price = economy.npcSuggest(it, npcCtx).price;
  markDirty(currentNpc);
  renderShop();
};
$('btnSave').onclick = () => {
  if (mode === 'voc') {
    if (!vocStore) return;
    try { V.saveVocations(vocStore); vocList().forEach((v) => { v._dirty = false; }); updateSaveAll(); fillVocSelect(); renderList(); $('status').textContent = 'Vocations salvas.'; }
    catch (e) { alert('Erro ao salvar vocations: ' + e.message); }
    return;
  }
  if (mode === 'npc') {
    if (!currentNpc) return;
    try {
      N.save(currentNpc); currentNpc._dirty = false; updateSaveAll();
      rebuildNpcCtx();
      $('status').textContent = 'NPC salvo: ' + currentNpc.file;
      renderShop();
    } catch (e) { alert('Erro ao salvar NPC: ' + e.message); }
    return;
  }
  if (!current) return;
  const exp = parseInt($('mExp').value, 10);
  if (isNaN(exp)) { alert('Experience invalida'); return; }
  current.exp = exp;
  current.tier = economy.tierName(exp);
  try {
    M.save(current); current._dirty = false; updateSaveAll();
    rebuildNpcCtx();
    $('status').textContent = 'Salvo: ' + current.file;
    select(current);
  } catch (e) { alert('Erro ao salvar: ' + e.message); }
};

// balanceamento
$('balVoc').addEventListener('change', renderBalance);
$('balLevel').addEventListener('input', renderBalance);
$('balExpApply').onclick = () => {
  if (!current) return;
  const v = parseInt($('balExpApply').dataset.v, 10);
  if (isNaN(v)) return;
  current.exp = v;
  current.tier = economy.tierName(v);
  $('mExp').value = v;
  markDirty(current);
  renderBalance();
};
$('balDmgApply').onclick = () => {
  if (!current) return;
  const target = parseInt($('balDmgApply').dataset.v, 10);
  const cur = curMaxHit(current);
  if (!cur || !target) return;
  const f = target / cur;
  for (const a of current.attacks) {
    for (const k of ['min', 'max']) {
      const val = M.lget(a.attrs, k);
      if (val == null) continue;
      const n = parseInt(val, 10);
      if (isNaN(n)) continue;
      a.attrs = M.lset(a.attrs, k, String(Math.round(n * f)));
    }
  }
  markDirty(current);
  renderBalance();
};
$('balLifeApply').onclick = () => {
  if (!current) return;
  const v = parseInt($('balLifeApply').dataset.v, 10);
  if (isNaN(v) || v <= 0) return;
  current.health = v;
  if (current.healthTag) { M.tagSet(current.healthTag, 'now', String(v)); M.tagSet(current.healthTag, 'max', String(v)); }
  markDirty(current);
  renderAttrs();      // atualiza os campos now/max no painel
  renderBalance();    // atualiza a sugestão
};

// remover a entidade atual (nova = descarta; existente = apaga arquivo)
$('btnDelete').onclick = () => {
  if (mode === 'voc') {
    if (!currentVoc) return;
    if (!currentVoc._new && !confirm(`Remover a vocation "${vname(currentVoc)}" do vocations.xml?`)) return;
    const wasNew = currentVoc._new;
    V.deleteVocation(vocStore, currentVoc);
    if (!wasNew) { try { V.saveVocations(vocStore); } catch (e) { alert(e.message); } }
    currentVoc = null; $('vocFields').innerHTML = ''; fillVocSelect(); updateSaveAll(); renderList();
    $('status').textContent = 'Vocation removida.';
    return;
  }
  if (mode === 'npc') {
    if (!currentNpc) return;
    if (!currentNpc._new && !confirm(`Remover o NPC "${currentNpc.name}"? (apaga o arquivo ${require('path').basename(currentNpc.file)})`)) return;
    try { N.deleteNpc(currentNpc); } catch (e) { return alert(e.message); }
    npcs = npcs.filter((x) => x !== currentNpc); currentNpc = null;
    $('lootBody').innerHTML = ''; $('mName').textContent = '—'; $('mMeta').textContent = '';
    drawSprite(); updateSaveAll(); renderList();
    $('status').textContent = 'NPC removido.';
    return;
  }
  if (!current) return;
  if (!current._new && !confirm(`Remover o mob "${current.name}"? (apaga o arquivo e tira do monsters.xml)`)) return;
  try { M.deleteMonster(current); } catch (e) { return alert(e.message); }
  monsters = monsters.filter((x) => x !== current); current = null;
  $('lootBody').innerHTML = ''; $('attacksBox').innerHTML = ''; $('mName').textContent = '—'; $('mMeta').textContent = '';
  drawSprite(); rebuildNpcCtx(); updateSaveAll(); renderList();
  $('status').textContent = 'Mob removido.';
};

$('btnValidate').onclick = runValidation;
if ($('btnHealth')) $('btnHealth').onclick = serverHealthCheck;
if ($('btnBackup')) $('btnBackup').onclick = serverBackup;
if ($('btnConfig')) $('btnConfig').onclick = configEditor;
if ($('btnQuests')) $('btnQuests').onclick = questEditor;
if ($('btnOutfits')) $('btnOutfits').onclick = outfitsEditor;
$('valClose').onclick = () => { $('valModal').style.display = 'none'; };
$('btnLogs').onclick = renderErrModal;
// idioma EN/PT (bandeira)
let uiLang = localStorage.getItem('uiLang') || 'pt';
function setLang(l) { uiLang = l; localStorage.setItem('uiLang', l); try { I18N.apply(document, l); } catch (e) {} const b = $('btnLang'); if (b) b.textContent = l === 'pt' ? '🇧🇷' : '🇺🇸'; }
if ($('btnLang')) { $('btnLang').onclick = () => setLang(uiLang === 'pt' ? 'en' : 'pt'); setTimeout(() => setLang(uiLang), 30); }
// tema claro/escuro
function setTheme(t) { document.documentElement.dataset.theme = t === 'light' ? 'light' : ''; localStorage.setItem('uiTheme', t); const b = $('btnTheme'); if (b) b.textContent = t === 'light' ? '☀' : '🌙'; }
if ($('btnTheme')) { $('btnTheme').onclick = () => setTheme(localStorage.getItem('uiTheme') === 'light' ? 'dark' : 'light'); setTheme(localStorage.getItem('uiTheme') || 'dark'); }
// ============================ SPELL EDITOR ============================
const SP_COMBAT = ['PHYSICALDAMAGE', 'ENERGYDAMAGE', 'EARTHDAMAGE', 'FIREDAMAGE', 'ICEDAMAGE', 'HOLYDAMAGE', 'DEATHDAMAGE', 'HEALING', 'MANADRAIN', 'LIFEDRAIN'];
const SP_COMBAT_COLOR = { PHYSICALDAMAGE: '#cccccc', ENERGYDAMAGE: '#9b6bff', EARTHDAMAGE: '#5fae3b', FIREDAMAGE: '#ff6a2a', ICEDAMAGE: '#5fd6e6', HOLYDAMAGE: '#ffe06a', DEATHDAMAGE: '#7a5a8f', HEALING: '#4cd986', MANADRAIN: '#5b8cff', LIFEDRAIN: '#b53a4d' };
// CONST_ME (magic effects) → id no .dat (8.6). nome p/ o Lua + id p/ preview
const SP_EFFECTS = { 1: 'DRAWBLOOD', 3: 'POFF', 5: 'EXPLOSIONAREA', 6: 'EXPLOSIONHIT', 7: 'FIREAREA', 8: 'YELLOW_RINGS', 9: 'GREEN_RINGS', 10: 'HITAREA', 11: 'TELEPORT', 12: 'ENERGYHIT', 13: 'MAGIC_BLUE', 14: 'MAGIC_RED', 15: 'MAGIC_GREEN', 16: 'HITBYFIRE', 17: 'HITBYPOISON', 18: 'MORTAREA', 21: 'POISONAREA', 28: 'STONES', 29: 'SMALLPLANTS', 30: 'CARNIPHILA', 31: 'PURPLEENERGY', 32: 'YELLOWENERGY', 35: 'BIGCLOUDS', 39: 'ICEAREA', 40: 'ICETORNADO', 41: 'ICEATTACK', 42: 'STONES2', 43: 'ENERGYAREA' };
const SP_MISSILES = { 0: '(nenhum)', 1: 'SPEAR', 2: 'BOLT', 3: 'ARROW', 4: 'FIRE', 5: 'ENERGY', 6: 'POISONARROW', 7: 'BURSTARROW', 8: 'THROWINGSTAR', 9: 'THROWINGKNIFE', 10: 'SMALLSTONE', 11: 'DEATH', 12: 'LARGEROCK', 13: 'SNOWBALL', 14: 'POWERBOLT', 15: 'POISON', 16: 'INFERNALBOLT', 18: 'ENERGYBALL', 20: 'SMALLICE', 21: 'SMALLHOLY', 22: 'SMALLEARTH', 23: 'EARTHARROW', 24: 'EXPLOSION', 25: 'SOULFIRE' };
// AREAS (matriz; 3=caster/centro alvo, 1=afetado)
const SP_AREAS = {
  single: { name: 'Alvo único', m: [[1]] },
  ball3: { name: 'Bola 3x3', m: [[0, 1, 0], [1, 1, 1], [0, 1, 0]] },
  ball5: { name: 'Bola 5x5', m: [[0, 0, 1, 0, 0], [0, 1, 1, 1, 0], [1, 1, 1, 1, 1], [0, 1, 1, 1, 0], [0, 0, 1, 0, 0]] },
  square3: { name: 'Quadrado 3x3', m: [[1, 1, 1], [1, 1, 1], [1, 1, 1]] },
  cross: { name: 'Cruz', m: [[0, 1, 0], [1, 1, 1], [0, 1, 0]] },
  beam: { name: 'Feixe (5)', m: [[1], [1], [1], [1], [1]] },
  wave: { name: 'Onda (cone)', m: [[0, 0, 1, 0, 0], [0, 1, 1, 1, 0], [1, 1, 1, 1, 1]] },
  custom: { name: '✏️ Customizada', m: [[1]] },
};
const SP_CONDITIONS = { none: '(nenhuma)', FIRE: 'Fogo (DOT)', POISON: 'Veneno/Earth (DOT)', ENERGY: 'Energia (DOT)', FREEZING: 'Gelo (DOT)', DAZZLED: 'Holy (DOT)', CURSED: 'Death (DOT)', PARALYZE: 'Paralisia (lentidão)', HASTE: 'Haste (buff vel)', DRUNK: 'Bêbado', ATTRIBUTES: 'Buff skill/stat', REGENERATION: 'Regeneração hp/mana', OUTFIT: 'Outfit (visual)' };
const SP_CONDITIONS_COLOR = { FIRE: '#ff6a2a', POISON: '#5fae3b', ENERGY: '#9b6bff', FREEZING: '#5fd6e6', DAZZLED: '#ffe06a', CURSED: '#7a5a8f', PARALYZE: '#c9a14a', HASTE: '#4cd986', DRUNK: '#d98f4c', ATTRIBUTES: '#5b8cff', REGENERATION: '#4cd986', OUTFIT: '#b06fd8' };
const SP_SKILLS = ['SKILL_FIST', 'SKILL_CLUB', 'SKILL_SWORD', 'SKILL_AXE', 'SKILL_DISTANCE', 'SKILL_SHIELD'];
const SP_STATS = ['', 'STAT_MAXHITPOINTS', 'STAT_MAXMANAPOINTS', 'STAT_MAGICPOINTS'];
const SP_DISPEL = { '': '(nenhum)', PARALYZE: 'remove paralisia', HASTE: 'remove haste', INVISIBLE: 'remove invisível', DRUNK: 'remove bêbado', BLEEDING: 'remove sangramento', FIRE: 'remove fogo', POISON: 'remove veneno', ENERGY: 'remove energia', CURSED: 'remove curse', ATTRIBUTES: 'remove buffs' };
const SP_VOCS = ['Sorcerer', 'Master Sorcerer', 'Druid', 'Elder Druid', 'Paladin', 'Royal Paladin', 'Knight', 'Elite Knight'];
const SP_TEMPLATES = {
  'Ki Blast (ataque alvo, multi-hit)': { name: 'Ki Blast', words: 'ki blast', folder: 'Attack', group: 'attack', combat: 'PHYSICALDAMAGE', effect: 0, missile: 8, area: 'single', lvl: 1, mana: 100, tier: 50, facMin: 0.78, facMax: 0.82, multiHit: 3, hitDelay: 200, needTarget: true, range: 6, aggressive: true },
  'Explosion Wave (área)': { name: 'Explosion Wave', words: 'explosion wave', folder: 'Attack', group: 'attack', combat: 'PHYSICALDAMAGE', effect: 60, missile: 0, area: 'ball5', lvl: 100, mana: 2000, tier: 100, facMin: 0.98, facMax: 1.02, needTarget: false, aggressive: true },
  'Regeneration (cura self)': { name: 'Regeneration', words: 'regeneration', folder: 'Healing', group: 'healing', combat: 'HEALING', effect: 88, missile: 0, area: 'single', lvl: 1, mana: 1000, isHealing: true, tier: 100, facMin: 1, facMax: 1, aggressive: false, selftarget: true, needTarget: false },
  'Aura (suporte)': { name: 'Aura', words: 'aura', folder: 'Support', group: 'support', combat: 'HEALING', effect: 13, missile: 0, area: 'single', lvl: 1, mana: 10, isHealing: true, aggressive: false, selftarget: true, needTarget: false },
};
// tiers de fórmula do servidor (DAMAGE_FACTOR_LEVEL<T>/SKILL<T>) — valores reais de lib/core/combat.lua
const SP_TIERS = [1, 50, 100, 150, 200, 250, 300, 400];
const SP_FACTORS = { 1: [5, 30], 50: [5, 35], 100: [65, 260], 150: [10, 85], 200: [25, 200], 250: [28, 205], 300: [30, 205], 400: [45, 240] };
const SP_FOLDERS = ['Attack', 'Healing', 'Support', 'Custom', 'Goku', 'Vegeta', 'Broly', 'Freeza', 'Cell', 'Buu', 'Gohan', 'Piccolo', 'Trunks', 'Monster'];
// carrega o spell_skills.md (base de spells do servidor) p/ alimentar a IA
const _spFiles = {};
function spLoadFile(name) { if (_spFiles[name] != null) return _spFiles[name]; _spFiles[name] = ''; for (const p of [path.join(__dirname, name), path.join(process.cwd(), name)]) { try { if (fsp.existsSync(p)) { _spFiles[name] = fsp.readFileSync(p, 'utf8'); break; } } catch (e) {} } return _spFiles[name]; }
function spLoadSkills() { return kbLoad('spell'); }
// ============== BASE DE CONHECIMENTO IA (padrão TFS vs custom do servidor do usuário) ==============
// O usuário pode gerar a base do PRÓPRIO servidor (OTX/Canary/custom) com IA paga/local, ou usar a minha padrão.
const KB_DEFS = {
  spell: { file: 'spell_skills.md', label: 'Spells', folders: ['spells'] },
  action: { file: 'skills_actions.md', label: 'Actions', folders: ['actions'] },
  movement: { file: 'skills_movements.md', label: 'Movements', folders: ['movements'] },
  talkaction: { file: 'skills_talkactions.md', label: 'Talkactions', folders: ['talkactions'] },
  creaturescript: { file: 'skills_creaturescripts.md', label: 'Creaturescripts', folders: ['creaturescripts'] },
  globalevent: { file: 'skills_globalevents.md', label: 'Globalevents', folders: ['globalevents'] },
};
// retorna a base ativa: custom (do servidor do user) se ligada+presente, senão a padrão embutida.
function kbLoad(kind) { const d = KB_DEFS[kind]; const file = d ? d.file : kind; if (localStorage.getItem('kb.useCustom.' + kind) === '1') { const c = localStorage.getItem('kb.custom.' + kind); if (c) return c; } return spLoadFile(file); }
function kbIsCustom(kind) { return localStorage.getItem('kb.useCustom.' + kind) === '1' && !!localStorage.getItem('kb.custom.' + kind); }
// coleta amostras de .lua/.xml da pasta do servidor, priorizando a pasta-alvo do tipo
function kbCollectSamples(dir, folders) {
  const all = [];
  const walk = (dd, depth) => { if (depth > 5) return; let e; try { e = fsp.readdirSync(dd, { withFileTypes: true }); } catch (x) { return; } for (const en of e) { if (/^\.|node_modules/.test(en.name)) continue; const full = path.join(dd, en.name); if (en.isDirectory()) walk(full, depth + 1); else if (/\.lua$/i.test(en.name)) all.push(full); else if (/\.xml$/i.test(en.name) && folders.some((f) => en.name.toLowerCase().includes(f.replace(/s$/, '')))) all.push(full); } };
  walk(dir, 0);
  const score = (f) => { const l = f.toLowerCase().replace(/\\/g, '/'); return folders.some((x) => l.includes('/' + x + '/') || l.includes('/' + x + '.')) ? 0 : 1; };
  all.sort((a, b) => score(a) - score(b));
  let text = '', files = [], budget = 32000;
  for (const f of all.slice(0, 16)) { let raw = ''; try { raw = fsp.readFileSync(f, 'utf8'); } catch (e) { continue; } raw = raw.slice(0, 2600); const blk = `\n===== ${f.replace(dir, '').replace(/^[\\/]/, '')} =====\n${raw}\n`; if (text.length + blk.length > budget) break; text += blk; files.push(f); }
  return { files, text };
}
// gera a base de conhecimento do servidor do usuário via IA (paga ou local)
async function kbBuildAI(kind, onDone) {
  const d = KB_DEFS[kind]; if (!d) return;
  const pInfo = AI.PROVIDERS[aiProvider]; const key = localStorage.getItem('ai.key.' + aiProvider) || '';
  if (!pInfo.local && !pInfo.nokey && !key) return alert('configure a IA na aba 🤖 (provider + key). Pode ser paga ou LOCAL (Ollama/LM Studio).');
  const model = localStorage.getItem('ai.model.' + aiProvider) || pInfo.models[0];
  const dir = await ipcRenderer.invoke('pick-dir'); if (!dir) return;
  $('status').textContent = 'lendo scripts do servidor…';
  const s = kbCollectSamples(dir, d.folders);
  if (!s.files.length) return alert('nenhum .lua encontrado nessa pasta (aponte pra raiz do data/ do servidor)');
  const sys = `Você é engenheiro de scripts de OTServ. Analise os ARQUIVOS REAIS do servidor do usuário (pode ser TFS, OTX/OTXServer, Canary, revscriptsys ou custom). Produza uma BASE DE CONHECIMENTO em markdown (português) capturando as convenções DESTE servidor para criar ${d.label}:\n- estrutura do .lua e callbacks/funções usados\n- API real (objetos e métodos) que APARECEM nos exemplos\n- convenção de exhaustion/cooldown\n- estilo de fórmula de dano (se houver)\n- COMO registra (tag xml? revscript :register()? nome do arquivo?)\n- constantes/libs próprias que aparecem\n- 1-2 exemplos curtos anotados\nSeja FIEL aos arquivos — NÃO invente API que não aparece. Saída: APENAS markdown.`;
  const btnTxt = $('status').textContent;
  try {
    $('status').textContent = `IA analisando ${s.files.length} arquivos…`;
    const resp = await AI.chat(aiProvider, key, model, [{ role: 'user', content: `Pasta: ${dir}\nExemplos (${s.files.length}):\n${s.text}` }], { system: sys, temperature: 0.3, maxTokens: 3500 });
    const md = resp.replace(/^```\w*\n?|\n?```$/g, '').trim();
    if (!md) throw new Error('IA não retornou conteúdo');
    localStorage.setItem('kb.custom.' + kind, md); localStorage.setItem('kb.useCustom.' + kind, '1');
    _spFiles['spell_skills.md'] = undefined; // limpa cache p/ relers
    $('status').textContent = `✅ base do seu servidor gerada (${md.length} chars) p/ ${d.label}`;
    if (onDone) onDone(md);
  } catch (e) { alert('erro IA: ' + e.message); $('status').textContent = 'erro IA'; }
}
// gerenciador da base (modal): escolher padrão vs custom, gerar, editar, importar, limpar
function kbManager(kind) {
  const d = KB_DEFS[kind] || { label: kind, file: kind, folders: [] };
  document.querySelectorAll('.kbModal').forEach((m) => m.remove());
  const ov = document.createElement('div'); ov.className = 'modal kbModal'; const b = document.createElement('div'); b.className = 'modalBox'; b.style.maxWidth = '640px';
  const head = document.createElement('h3'); b.appendChild(head);
  const info = document.createElement('div'); info.className = 'alabel'; info.style.cssText = 'font-size:11px;margin-bottom:8px'; b.appendChild(info);
  const ta = document.createElement('textarea'); ta.style.cssText = 'width:100%;height:300px;font-family:monospace;font-size:11px;white-space:pre'; b.appendChild(ta);
  const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px'; b.appendChild(bar);
  const refresh = () => {
    const custom = kbIsCustom(kind);
    head.textContent = `📚 Base de conhecimento IA — ${d.label}`;
    info.innerHTML = `Fonte ativa: <b style="color:${custom ? 'var(--accent2)' : 'var(--muted)'}">${custom ? 'PERSONALIZADA (do seu servidor)' : 'PADRÃO (TFS embutida)'}</b>. A IA usa esta base pra gerar ${d.label.toLowerCase()} no estilo do seu servidor.`;
    ta.value = kbLoad(kind) || '(vazia)';
  };
  const mk = (txt, cls, fn) => { const x = document.createElement('button'); x.className = 'miniBtn ' + (cls || ''); x.textContent = txt; x.onclick = fn; return x; };
  bar.append(
    mk('🤖 Gerar do MEU servidor (IA)', 'accent', () => kbBuildAI(kind, () => refresh())),
    mk('💾 Salvar edição', '', () => { localStorage.setItem('kb.custom.' + kind, ta.value); localStorage.setItem('kb.useCustom.' + kind, '1'); $('status').textContent = 'base personalizada salva'; refresh(); }),
    mk('📥 Importar .md', '', async () => { const f = await ipcRenderer.invoke('pick-file', ['md', 'txt']); if (!f) return; try { const raw = fsp.readFileSync(f, 'utf8'); localStorage.setItem('kb.custom.' + kind, raw); localStorage.setItem('kb.useCustom.' + kind, '1'); refresh(); } catch (e) { alert('erro: ' + e.message); } }),
    mk('📤 Exportar .md', '', () => { ipcRenderer.invoke('save-file', `${kind}_skills.md`).then((f) => { if (f) { fs.writeFileSync(f, ta.value); $('status').textContent = 'salvo: ' + f; } }); }),
    mk('↩ Usar PADRÃO', '', () => { localStorage.setItem('kb.useCustom.' + kind, '0'); refresh(); }),
    mk('🗑 Limpar personalizada', 'danger', () => { if (!confirm('apagar a base personalizada deste tipo?')) return; localStorage.removeItem('kb.custom.' + kind); localStorage.setItem('kb.useCustom.' + kind, '0'); refresh(); }),
  );
  const foot = document.createElement('div'); foot.className = 'modalFoot'; foot.appendChild(mk('Fechar', '', () => ov.remove())); b.appendChild(foot);
  refresh(); ov.appendChild(b); document.body.appendChild(ov);
}
// injeta o botão "Base IA" ao lado de um botão "Gerar com IA"
function ensureKbBtn(genBtnId, kindFn) { const g = $(genBtnId); if (!g || g._kbWired) return; g._kbWired = true; const btn = document.createElement('button'); btn.className = 'miniBtn'; btn.textContent = '📚 Base IA'; btn.title = 'usar a base padrão (TFS) ou GERAR a do seu servidor (OTX/Canary/custom) com IA paga/local'; btn.style.marginLeft = '6px'; btn.onclick = () => kbManager(kindFn()); g.parentNode.insertBefore(btn, g.nextSibling); }
let spell = null, _spellRAF = null, _spSpeed = 1, _spPlay = true;
function spellDefault() { return { name: 'Nova Spell', words: 'kamehameha', type: 'instant', spellid: 100, folder: 'Attack', group: 'attack', combat: 'PHYSICALDAMAGE', effect: 35, missile: 0, area: 'single', customArea: null, castDir: 'N', lvl: 50, mana: 1000, magiclevel: 0, exhaustSecs: 2, aggressive: true, selftarget: false, needTarget: true, range: 6, isHealing: false, tier: 100, facMin: 0.78, facMax: 0.82, multiHit: 1, hitDelay: 200, premium: false, needLearn: false, runeId: 0, runeRange: 6, allowFarUse: true, cond: { type: 'none', dmg: 50, rounds: 5, interval: 9000, ticks: 10000, skill: 'SKILL_SWORD', skillVal: 30, stat: '', statVal: 0, hpGain: 0, hpTicks: 1000, manaGain: 0, manaTicks: 1000, speed: 400 }, simLevel: 100, simMagic: 80,
 useSetFormula: false, direction: false, extraStorages: '', animText: '', summonName: '', summonCount: 0, summonDur: 0, teleportTarget: false, transform: false, transformLook: 0, transformAura: 0, transformDur: 10, createItem: 0,
 enabled: true, premium: false, soul: 0, manaPercent: 0, vocations: '', useCooldown: false, cooldown: 2000, groupcooldown: 2000, secondaryGroup: '', secondaryGroupCd: 0, blockArmor: false, blockShield: false, dispel: '',
 previewLook: parseInt(localStorage.getItem('sp.prevLook'), 10) || 0, previewDir: 2, previewAnim: 'idle', previewCX: null, previewCY: null, previewTOX: null, previewTOY: null, dash: false, dashTiles: 3, previewTargetLook: parseInt(localStorage.getItem('sp.targetLook'), 10) || 0, previewTargetWalk: true }; }
function spCustomMatrix() { if (spell.customArea) return spell.customArea; const N = 7, m = Array.from({ length: N }, () => Array(N).fill(0)); m[(N - 1) / 2][(N - 1) / 2] = 3; return m; }
function initSpell() { if (!spell) spell = spellDefault(); fillSpTemplates(); renderSpellForm(); spellGenLua(); startSpellPreview(); ensureKbBtn('spIaGen', () => 'spell'); _updateSpServerBtn();
  // auto-carrega a pasta de spells salva (sidebar) — 1ª vez que entra no modo
  if (!spellStore.dir) { const d = lsGet('spellsDir') || spellsFile || ''; if (d) loadSpellFolder(d); }
}
function fillSpTemplates() { const s = $('spTemplate'); if (!s || s._filled) return; for (const k of Object.keys(SP_TEMPLATES)) { const o = document.createElement('option'); o.value = k; o.textContent = k; s.appendChild(o); } s._filled = true; s.onchange = () => { if (SP_TEMPLATES[s.value]) { spell = Object.assign(spellDefault(), SP_TEMPLATES[s.value]); renderSpellForm(); spellGenLua(); } s.value = ''; }; }
function renderSpellForm() {
  const box = $('spellForm'); if (!box) return; box.innerHTML = '';
  const row = (label, el) => { const l = document.createElement('label'); l.appendChild(document.createTextNode(label)); l.appendChild(el); box.appendChild(l); };
  const sec = (t) => { const d = document.createElement('div'); d.className = 'spSec'; d.textContent = t; box.appendChild(d); };
  const gp = (k) => k.includes('.') ? k.split('.').reduce((o, p) => o[p], spell) : spell[k];
  const sp = (k, v) => { if (k.includes('.')) { const ps = k.split('.'); const last = ps.pop(); ps.reduce((o, p) => o[p], spell)[last] = v; } else spell[k] = v; };
  const RELAYOUT = new Set(['type', 'cond.type', 'isHealing', 'area', 'needTarget', 'transform', 'dash', 'combat', 'useCooldown']);
  const after = (k) => { spellGenLua(); if (RELAYOUT.has(k)) renderSpellForm(); };
  const inp = (key, type) => { const i = document.createElement('input'); if (type) i.type = type; if (type === 'number') i.step = 'any'; i.value = gp(key); i.oninput = () => { sp(key, (type === 'number') ? (parseFloat(i.value) || 0) : i.value); after(key); }; return i; };
  const sel = (key, opts, labels) => { const s = document.createElement('select'); for (const o of opts) { const op = document.createElement('option'); op.value = o; op.textContent = labels ? labels[o] : o; s.appendChild(op); } s.value = gp(key); s.onchange = () => { sp(key, isNaN(+s.value) ? s.value : +s.value); after(key); }; return s; };
  const chk = (label, key) => { const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'; c.checked = gp(key); c.onchange = () => { sp(key, c.checked); after(key); }; l.append(document.createTextNode(label), c); box.appendChild(l); };
  const numPick = (label, key, cat) => { const l = document.createElement('label'); l.appendChild(document.createTextNode(label)); const wrap = document.createElement('span'); wrap.style.cssText = 'display:flex;gap:4px;align-items:center'; const cv = document.createElement('canvas'); cv.width = cv.height = 28; cv.style.cssText = 'background:#0b0d12;border:1px solid var(--border);border-radius:4px;cursor:pointer;image-rendering:pixelated'; cv.title = 'escolher visualmente (sprite do .dat)'; cv.onclick = () => spellPicker(cat, key); spDrawThumb(cv, cat, spell[key]); const i = document.createElement('input'); i.type = 'number'; i.value = spell[key]; i.style.width = '90px'; i.oninput = () => { spell[key] = parseInt(i.value, 10) || 0; spellGenLua(); spDrawThumb(cv, cat, spell[key]); }; wrap.append(cv, i); l.appendChild(wrap); box.appendChild(l); };
  // ===== Registro (spells.xml) =====
  sec('Registro (spells.xml)'); row('nome', inp('name')); row('palavras', inp('words')); row('spellid', inp('spellid', 'number'));
  row('tipo', sel('type', ['instant', 'rune'])); row('pasta script', sel('folder', SP_FOLDERS)); row('grupo', sel('group', ['attack', 'healing', 'support', 'special']));
  chk('precisa aprender (needlearn)', 'needLearn'); chk('só premium', 'premium'); chk('habilitada (enabled)', 'enabled');
  row('vocações (nomes/ids, vírgula; vazio=todas)', inp('vocations'));
  // ===== Combate =====
  sec('Combate'); row('tipo de dano', sel('combat', SP_COMBAT));
  numPick('effect (id)', 'effect', 'effects'); numPick('distance (id, 0=nenhum)', 'missile', 'missiles');
  if (spell.combat === 'PHYSICALDAMAGE') { chk('bloqueado por armadura (blockarmor)', 'blockArmor'); chk('bloqueado por escudo (blockshield)', 'blockShield'); }
  row('dispel (remove condição do alvo)', sel('dispel', Object.keys(SP_DISPEL), SP_DISPEL));
  row('área', sel('area', Object.keys(SP_AREAS), Object.fromEntries(Object.entries(SP_AREAS).map(([k, v]) => [k, v.name]))));
  if (spell.area === 'custom') { const cap = document.createElement('div'); cap.className = 'alabel'; cap.style.fontSize = '10px'; cap.textContent = 'clique: alterna célula · centro = origem'; box.appendChild(cap); const grid = document.createElement('div'); const m = spCustomMatrix(); spell.customArea = m; grid.style.cssText = `display:grid;grid-template-columns:repeat(${m[0].length},1fr);gap:2px;width:160px`; for (let r = 0; r < m.length; r++) for (let c = 0; c < m[0].length; c++) { const cell = document.createElement('div'); const isC = m[r][c] === 3; cell.style.cssText = `aspect-ratio:1;border:1px solid var(--border);border-radius:3px;cursor:pointer;background:${isC ? '#3fcf7a' : (m[r][c] ? '#2f6fe0' : '#0b0d12')}`; cell.onclick = () => { if (m[r][c] !== 3) { m[r][c] = m[r][c] ? 0 : 1; renderSpellForm(); spellGenLua(); } }; grid.appendChild(cell); } box.appendChild(grid); }
  if (['wave', 'beam', 'custom'].includes(spell.area)) row('direção (preview)', sel('castDir', ['N', 'E', 'S', 'W']));
  // ===== Custo / alvo =====
  sec('Custo & alvo'); row('level', inp('lvl', 'number')); row('mana', inp('mana', 'number')); row('mana % (0=usa mana fixa)', inp('manaPercent', 'number')); row('magic level', inp('magiclevel', 'number')); row('soul', inp('soul', 'number'));
  chk('cooldown nativo TFS (cooldown/groupcooldown)', 'useCooldown');
  if (spell.useCooldown) { row('cooldown (ms)', inp('cooldown', 'number')); row('groupcooldown (ms)', inp('groupcooldown', 'number')); row('secondarygroup', sel('secondaryGroup', ['', 'attack', 'healing', 'support', 'special'])); if (spell.secondaryGroup) row('secondarygroupcooldown (ms)', inp('secondaryGroupCd', 'number')); }
  else row('exhaustion (s)', inp('exhaustSecs', 'number'));
  chk('agressiva', 'aggressive'); chk('self target (cura/buff)', 'selftarget'); chk('precisa de alvo', 'needTarget'); if (spell.needTarget) row('range', inp('range', 'number'));
  if (spell.type === 'rune') { sec('Rune'); row('item id', inp('runeId', 'number')); row('range', inp('runeRange', 'number')); chk('allowFarUse', 'allowFarUse'); }
  const warn = spValidate(); if (warn.length) { const w = document.createElement('div'); w.style.cssText = 'background:#3a2a12;border:1px solid #7a5a1a;border-radius:5px;padding:5px;font-size:11px;color:#f0c060'; w.innerHTML = '⚠ ' + warn.join('<br>⚠ '); box.appendChild(w); }
  // ===== Fórmula (callback DAMAGE_FACTOR) =====
  sec('Fórmula (DAMAGE_FACTOR)'); chk('é cura (valores positivos)', 'isHealing'); row('tier', sel('tier', SP_TIERS)); row('fator min', inp('facMin', 'number')); row('fator max', inp('facMax', 'number'));
  if (!spell.isHealing) { row('multi-hit (golpes)', inp('multiHit', 'number')); if (spell.multiHit > 1) row('delay/golpe (ms)', inp('hitDelay', 'number')); }
  // simulador de dano
  const sim = document.createElement('div'); sim.className = 'tpGroup'; sim.style.fontSize = '11px';
  const simIn = (k) => { const i = document.createElement('input'); i.type = 'number'; i.value = spell[k]; i.style.width = '60px'; i.oninput = () => { spell[k] = parseInt(i.value, 10) || 0; spUpdateSim(); }; return i; };
  const sl = document.createElement('label'); sl.append(document.createTextNode('sim level'), simIn('simLevel')); const sm = document.createElement('label'); sm.append(document.createTextNode('sim magic'), simIn('simMagic'));
  sim.append(sl, sm); const simOut = document.createElement('div'); simOut.id = 'spSimOut'; simOut.style.cssText = 'margin-top:4px;font-weight:700;color:var(--accent2)'; sim.appendChild(simOut); box.appendChild(sim);
  // ===== Condição opcional =====
  sec('Condição (opcional)'); row('tipo', sel('cond.type', Object.keys(SP_CONDITIONS), SP_CONDITIONS));
  const ct = spell.cond.type;
  if (ct !== 'none') { const isDot = ['FIRE', 'POISON', 'ENERGY', 'FREEZING', 'DAZZLED', 'CURSED'].includes(ct); const cinp = (k) => inp('cond.' + k, 'number');
    if (isDot) { row('dano/tick', cinp('dmg')); row('rounds', cinp('rounds')); row('intervalo ms', cinp('interval')); }
    else if (ct === 'ATTRIBUTES') { row('duração ms', cinp('ticks')); row('skill', sel('cond.skill', SP_SKILLS)); row('skill +', cinp('skillVal')); row('stat', sel('cond.stat', SP_STATS)); row('stat +%', cinp('statVal')); }
    else if (ct === 'REGENERATION') { row('duração ms', cinp('ticks')); row('hp/tick', cinp('hpGain')); row('hp intervalo', cinp('hpTicks')); row('mana/tick', cinp('manaGain')); row('mana intervalo', cinp('manaTicks')); }
    else if (ct === 'HASTE') { row('duração ms', cinp('ticks')); row('velocidade +', cinp('speed')); }
    else if (ct === 'OUTFIT') { row('duração ms', cinp('ticks')); row('lookType', cinp('skillVal')); }
    else row('duração ms', cinp('ticks'));
  }
  // ===== Avançado (efeitos extras no onCastSpell) =====
  sec('Avançado (opcional)');
  row('cooldowns extra (storages, vírgula)', inp('extraStorages'));
  chk('usa setFormula direto (em vez de callback)', 'useSetFormula');
  chk('precisa de direção (wave)', 'direction');
  chk('teleporta até o alvo', 'teleportTarget');
  chk('dash (a outfit avança na direção)', 'dash'); if (spell.dash) row('dash: nº de tiles', inp('dashTiles', 'number'));
  row('texto flutuante (animatedText)', inp('animText'));
  row('cria item na pos (createitem id)', inp('createItem', 'number'));
  chk('transforma (setOutfit)', 'transform'); if (spell.transform) { row('lookType', inp('transformLook', 'number')); row('aura (lookAura)', inp('transformAura', 'number')); row('duração (s)', inp('transformDur', 'number')); }
  row('summon (nome, vazio=nenhum)', inp('summonName')); row('summon qtd', inp('summonCount', 'number')); row('summon duração (s, 0=perm)', inp('summonDur', 'number'));
  spUpdateSim();
}
// thumb do efeito/missile no form
function spDrawThumb(cv, cat, id) { const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height); ctx.imageSmoothingEnabled = false; if (!dat || !id) return; const th = dat.category(cat) && dat.category(cat).get(id); if (!th) return; const c = composeThing(th, 0, 0); if (c) ctx.drawImage(c, 0, 0, cv.width, cv.height); }
// simulador: fórmula real do servidor (DAMAGE_FACTOR_LEVEL<T>*level + DAMAGE_FACTOR_SKILL<T>*mlvl)*fator
function spUpdateSim() { const o = $('spSimOut'); if (!o) return; const fc = SP_FACTORS[spell.tier] || SP_FACTORS[100]; const base = fc[0] * spell.simLevel + fc[1] * spell.simMagic; let mn = Math.round(base * spell.facMin), mx = Math.round(base * spell.facMax); const hits = (!spell.isHealing && spell.multiHit > 1) ? spell.multiHit : 1; o.textContent = `${spell.isHealing ? '+' : ''}${Math.min(mn, mx)}–${Math.max(mn, mx)}${hits > 1 ? ` ×${hits} golpes (total ~${Math.min(mn, mx) * hits}–${Math.max(mn, mx) * hits})` : ''} · lvl ${spell.simLevel}/mlvl ${spell.simMagic} · tier ${spell.tier}`; }
// picker visual de effects/missiles — grid de sprites do .dat
function spellPicker(cat, key) {
  if (!dat) return alert('carregue o Tibia.dat primeiro (modo Object)');
  const map = dat.category(cat); const known = cat === 'effects' ? SP_EFFECTS : (cat === 'missiles' ? SP_MISSILES : {});
  document.querySelectorAll('.spPickModal').forEach((m) => m.remove());
  const ov = document.createElement('div'); ov.className = 'modal spPickModal'; const b = document.createElement('div'); b.className = 'modalBox'; b.style.maxWidth = '600px'; b.innerHTML = `<h3>Escolher ${cat === 'effects' ? 'efeito (CONST_ME)' : cat === 'missiles' ? 'missile (CONST_ANI)' : 'outfit (looktype)'}</h3>`;
  const search = document.createElement('input'); search.placeholder = 'buscar por id ou nome…'; search.style.cssText = 'width:100%;margin-bottom:6px'; b.appendChild(search);
  const grid = document.createElement('div'); grid.style.cssText = 'display:grid;grid-template-columns:repeat(8,1fr);gap:4px;max-height:420px;overflow:auto'; b.appendChild(grid);
  const draw = () => { grid.innerHTML = ''; const q = search.value.toLowerCase(); if (cat === 'missiles') { const cell = mkPickCell(cat, 0, '(nenhum)', key, ov); if (!q || '0nenhum'.includes(q)) grid.appendChild(cell); } for (const [id] of map) { const nm = known[id] || ''; if (q && !String(id).includes(q) && !nm.toLowerCase().includes(q)) continue; grid.appendChild(mkPickCell(cat, id, nm, key, ov)); } };
  search.oninput = draw; draw(); const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); b.appendChild(foot); ov.appendChild(b); document.body.appendChild(ov); setTimeout(() => search.focus(), 30);
}
function mkPickCell(cat, id, nm, key, ov) { const d = document.createElement('div'); d.style.cssText = 'border:1px solid var(--border);border-radius:4px;padding:3px;text-align:center;cursor:pointer;background:#0b0d12'; const cv = document.createElement('canvas'); cv.width = cv.height = 40; cv.style.imageRendering = 'pixelated'; spDrawThumb(cv, cat, id); d.appendChild(cv); const cap = document.createElement('div'); cap.style.cssText = 'font-size:9px;color:var(--muted);overflow:hidden;text-overflow:ellipsis'; cap.textContent = id + (nm ? ' ' + nm : ''); d.appendChild(cap); d.onclick = () => { spell[key] = id; try { if (key === 'previewLook') localStorage.setItem('sp.prevLook', id); if (key === 'previewTargetLook') localStorage.setItem('sp.targetLook', id); } catch (e) {} ov.remove(); renderSpellForm(); spellGenLua(); }; return d; }
// matriz da área atual (preset ou custom) com centro=3 (origem)
function spAreaMatrix() { if (spell.area === 'custom') return spCustomMatrix(); const src = (SP_AREAS[spell.area] || SP_AREAS.single).m; const m = src.map((r) => r.slice()); const cr = (m.length - 1) / 2 | 0, cc = (m[0].length - 1) / 2 | 0; if (m[cr] && m[cr][cc] !== undefined) m[cr][cc] = m[cr][cc] ? 3 : 2; return m; }
function spMatrixToLua(m) { return '{\n' + m.map((r) => '\t{' + r.join(', ') + '}').join(',\n') + '\n}'; }
// rotaciona matriz p/ direção (preview de wave/beam)
function spRotate(m, dir) { let r = m; const rot90 = (a) => a[0].map((_, c) => a.map((row) => row[c]).reverse()); if (dir === 'E') r = rot90(m); else if (dir === 'S') r = rot90(rot90(m)); else if (dir === 'W') r = rot90(rot90(rot90(m))); return r; }
// validador de sanidade (estilo otserv)
function spValidate() {
  const s = spell, w = [];
  if (s.isHealing && s.combat !== 'HEALING') w.push('marcado como cura mas tipo de dano ≠ HEALING');
  if (!s.isHealing && s.combat === 'HEALING') w.push('tipo HEALING mas "é cura" desmarcado → vai curar com sinal negativo');
  if (s.selftarget && s.needTarget) w.push('selftarget + needTarget juntos não fazem sentido');
  if (s.aggressive && s.isHealing) w.push('cura agressiva? normalmente cura usa aggressive=0');
  if (s.type === 'rune' && !s.runeId) w.push('rune sem item id');
  if (!s.spellid) w.push('spellid vazio (precisa ser único no spells.xml)');
  return w;
}
function spScriptFile() { return (spell.name || 'spell').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '.lua'; }
// <vocation .../> filhos a partir do campo livre "vocations" (nomes ou ids, vírgula)
function spVocXml(indent) {
  const list = (spell.vocations || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!list.length) return '';
  return list.map((v) => `${indent}<vocation ${/^\d+$/.test(v) ? `id="${v}"` : `name="${v}"`} />`).join('\n');
}
// linha de registro do spells.xml
function spellGenXml() {
  const s = spell; const scriptPath = `${s.folder}/${spScriptFile()}`; const voc = spVocXml('\t');
  const wrap = (tag, attrs) => voc ? `<${tag} ${attrs}>\n${voc}\n</${tag}>` : `<${tag} ${attrs}/>`;
  if (s.type === 'rune') { let a = `spellid="${s.spellid}" group="${s.group}" name="${s.name}" id="${s.runeId}" range="${s.runeRange}"`; if (s.lvl) a += ` lvl="${s.lvl}"`; if (s.magiclevel) a += ` magiclevel="${s.magiclevel}"`; if (s.soul) a += ` soul="${s.soul}"`; if (s.premium) a += ` premium="1"`; if (!s.enabled) a += ` enabled="0"`; if (s.allowFarUse) a += ` allowfaruse="1"`; if (s.useCooldown) { a += ` cooldown="${s.cooldown}" groupcooldown="${s.groupcooldown}"`; if (s.secondaryGroup) a += ` secondarygroup="${s.secondaryGroup}" secondarygroupcooldown="${s.secondaryGroupCd}"`; } a += ` script="${scriptPath}"`; return wrap('rune', a); }
  let a = `spellid="${s.spellid}" group="${s.group}" name="${s.name}" words="${s.words}" lvl="${s.lvl}" mana="${s.mana}"`;
  if (s.manaPercent) a += ` manapercent="${s.manaPercent}"`;
  if (s.magiclevel) a += ` magiclevel="${s.magiclevel}"`;
  if (s.soul) a += ` soul="${s.soul}"`;
  if (s.needTarget) a += ` needtarget="1"`;
  if (!s.aggressive) a += ` aggressive="0"`;
  if (s.selftarget) a += ` selftarget="1"`;
  if (s.useCooldown) { a += ` cooldown="${s.cooldown}" groupcooldown="${s.groupcooldown}"`; if (s.secondaryGroup) a += ` secondarygroup="${s.secondaryGroup}" secondarygroupcooldown="${s.secondaryGroupCd}"`; }
  else if (s.exhaustSecs) a += ` exhaustion="${s.exhaustSecs * 1000}"`;
  if (s.needLearn) a += ` needlearn="1"`;
  if (s.premium) a += ` premium="1"`;
  if (!s.enabled) a += ` enabled="0"`;
  if (s.direction) a += ` direction="1"`;
  a += ` script="${scriptPath}"`;
  return wrap('instant', a);
}
// monta o bloco da condição (suporta DOT, ATTRIBUTES, REGENERATION, HASTE, OUTFIT, etc)
function spCondLua() {
  const c = spell.cond; if (!c || c.type === 'none') return '';
  const isDot = ['FIRE', 'POISON', 'ENERGY', 'FREEZING', 'DAZZLED', 'CURSED'].includes(c.type);
  let l = `\nlocal condition = createConditionObject(CONDITION_${c.type})\n`;
  if (isDot) { l += `condition:setParameter(CONDITION_PARAM_DELAYED, 1)\ncondition:addDamage(${c.rounds}, ${c.interval}, -${c.dmg})\n`; }
  else if (c.type === 'ATTRIBUTES') { l += `condition:setParameter(CONDITION_PARAM_TICKS, ${c.ticks})\n`; if (c.skillVal) l += `condition:setParameter(CONDITION_PARAM_${c.skill.replace('SKILL_', 'SKILL_')}, ${c.skillVal})\n`.replace('PARAM_SKILL_', 'PARAM_SKILL_'); if (c.stat && c.statVal) l += `condition:setParameter(CONDITION_PARAM_${c.stat.replace('STAT_', 'STAT_')}PERCENT, ${100 + c.statVal})\n`; }
  else if (c.type === 'REGENERATION') { l += `condition:setParameter(CONDITION_PARAM_TICKS, ${c.ticks})\n`; if (c.hpGain) l += `condition:setParameter(CONDITION_PARAM_HEALTHGAIN, ${c.hpGain})\ncondition:setParameter(CONDITION_PARAM_HEALTHTICKS, ${c.hpTicks})\n`; if (c.manaGain) l += `condition:setParameter(CONDITION_PARAM_MANAGAIN, ${c.manaGain})\ncondition:setParameter(CONDITION_PARAM_MANATICKS, ${c.manaTicks})\n`; }
  else if (c.type === 'HASTE') { l += `condition:setParameter(CONDITION_PARAM_TICKS, ${c.ticks})\ncondition:setParameter(CONDITION_PARAM_SPEED, ${c.speed})\n`; }
  else if (c.type === 'OUTFIT') { l += `condition:setParameter(CONDITION_PARAM_TICKS, ${c.ticks})\ncondition:setOutfit({lookType = ${c.skillVal}})\n`; }
  else l += `condition:setParameter(CONDITION_PARAM_TICKS, ${c.ticks})\n`;
  return l;
}
function spellGenLua() {
  const s = spell; const heal = s.isHealing; const sign = heal ? '' : '-'; const fc = SP_FACTORS[s.tier] || SP_FACTORS[100];
  let lua = `-- ${s.folder}/${spScriptFile()}  ·  registre no spells.xml:\n-- ${spellGenXml().replace(/\n/g, '\n-- ')}\n\n`;
  if (!s.useCooldown) lua += `local storage = ${1000000 + (s.spellid || 0)}   -- storage do exhaustion\nlocal waittime = ${s.exhaustSecs || 1}\n\n`;
  lua += `local combat = Combat()\ncombat:setParameter(COMBAT_PARAM_TYPE, COMBAT_${s.combat})\n`;
  if (heal) lua += `combat:setParameter(COMBAT_PARAM_AGGRESSIVE, false)\n`;
  if (s.effect) lua += `combat:setParameter(COMBAT_PARAM_EFFECT, ${s.effect})\n`;
  if (s.missile) lua += `combat:setParameter(COMBAT_PARAM_DISTANCEEFFECT, ${s.missile})\n`;
  if (s.combat === 'PHYSICALDAMAGE' && s.blockArmor) lua += `combat:setParameter(COMBAT_PARAM_BLOCKARMOR, 1)\n`;
  if (s.combat === 'PHYSICALDAMAGE' && s.blockShield) lua += `combat:setParameter(COMBAT_PARAM_BLOCKSHIELD, 1)\n`;
  if (s.dispel) lua += `combat:setParameter(COMBAT_PARAM_DISPEL, CONDITION_${s.dispel})\n`;
  if (s.createItem) lua += `combat:setParameter(COMBAT_PARAM_CREATEITEM, ${s.createItem})\n`;
  if (s.area && s.area !== 'single') lua += `combat:setArea(createCombatArea(${spMatrixToLua(spAreaMatrix())}))\n`;
  // condição
  const condLua = spCondLua(); const condRef = condLua ? 'condition' : ''; lua += condLua; if (condLua && !s.cond._self) lua += `combat:addCondition(condition)\n`;
  // fórmula: callback ou setFormula direto
  if (s.useSetFormula) { lua += `combat:setFormula(COMBAT_FORMULA_LEVELMAGIC, ${sign}${fc[0]}, 0, ${sign}${fc[1]}, 0)\n\n`; }
  else lua += `\nfunction onGetFormulaValues(creature, level, maglevel)\n\tlocal min = ${sign}(DAMAGE_FACTOR_LEVEL${s.tier} * level + DAMAGE_FACTOR_SKILL${s.tier} * maglevel) * ${s.facMin}\n\tlocal max = ${sign}(DAMAGE_FACTOR_LEVEL${s.tier} * level + DAMAGE_FACTOR_SKILL${s.tier} * maglevel) * ${s.facMax}\n\treturn min, max\nend\ncombat:setCallback(CALLBACK_PARAM_LEVELMAGICVALUE, "onGetFormulaValues")\n\n`;
  // onCastSpell
  lua += `function onCastSpell(creature, variant)\n\tif not creature then return false end\n`;
  if (!s.useCooldown) lua += `\tif exhaustion.check(creature, storage) then\n\t\tcreature:sendCancelMessage("Aguarde " .. tostring(exhaustion.get(creature, storage)) .. " segundos.")\n\t\treturn false\n\tend\n`;
  let body = '';
  // teleporta até o alvo (antes do combat)
  if (s.teleportTarget) body += `\tlocal tgt = creature:getTarget()\n\tif tgt then creature:teleportTo(tgt:getPosition()) end\n`;
  // dash: avança N tiles na direção que o caster está virado (smooth, tile a tile)
  if (s.dash && s.dashTiles > 0) body += `\tlocal _dirs = {[DIRECTION_NORTH]={x=0,y=-1},[DIRECTION_EAST]={x=1,y=0},[DIRECTION_SOUTH]={x=0,y=1},[DIRECTION_WEST]={x=-1,y=0}}\n\tlocal _o = _dirs[creature:getDirection()]\n\tif _o then local _cid = creature:getId() for _i = 1, ${s.dashTiles} do addEvent(function() local _c = Creature(_cid) if not _c then return end local _p = _c:getPosition() local _np = Position(_p.x + _o.x, _p.y + _o.y, _p.z) local _t = Tile(_np) if _t and not _t:hasFlag(TILESTATE_BLOCKSOLID) then _c:teleportTo(_np) _np:sendMagicEffect(${s.effect || 'CONST_ME_NONE'}) end end, _i * 60) end end\n`;
  if (!heal && s.needTarget && !s.teleportTarget) {
    body += `\tlocal target = creature:getTarget()\n\tif not target or target:isInGhostMode() then return false end\n\tlocal cid, tid = creature:getId(), target:getId()\n`;
    if (s.multiHit > 1) body += `\tfor k = 1, ${s.multiHit} do\n\t\taddEvent(function()\n\t\t\tlocal c, t = Creature(cid), Creature(tid)\n\t\t\tif c and t and not t:isInGhostMode() then\n\t\t\t\tlocal tile = Tile(t:getPosition())\n\t\t\t\tif tile and tile:hasFlag(TILESTATE_PROTECTIONZONE) then return end\n\t\t\t\tcombat:execute(c, Variant(t:getPosition()))\n\t\t\tend\n\t\tend, 1 + ((k-1) * ${s.hitDelay}))\n\tend\n`;
    else body += `\tcombat:execute(creature, Variant(target:getPosition()))\n`;
  } else { body += `\tcombat:execute(creature, variant)\n`; if (condRef) body += `\tcreature:addCondition(${condRef})\n`; }
  // animatedText
  if (s.animText) body += `\tdoSendAnimatedText(creature:getPosition(), "${s.animText}", TEXTCOLOR_WHITE)\n`;
  // transformação (outfit) com reversão
  if (s.transform && s.transformLook) body += `\tlocal oldOutfit = creature:getOutfit()\n\tcreature:setOutfit({lookType = ${s.transformLook}${s.transformAura ? `, lookAura = ${s.transformAura}` : ''}})\n\taddEvent(function() local c = Creature(creature:getId()); if c then c:setOutfit(oldOutfit) end end, ${(s.transformDur || 10) * 1000})\n`;
  // summon
  if (s.summonName) { body += `\tfor i = 1, ${s.summonCount || 1} do\n\t\tlocal sm = Game.createMonster("${s.summonName}", creature:getPosition(), true, false)\n`; if (s.summonDur) body += `\t\tif sm then addEvent(function() if sm then sm:remove() end end, ${s.summonDur * 1000}) end\n`; body += `\tend\n`; }
  // cooldowns extra (combos)
  const extra = (s.extraStorages || '').split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
  for (const st of extra) body += `\texhaustion.set(creature, ${st}, waittime)\n`;
  lua += body;
  if (!s.useCooldown) lua += `\texhaustion.set(creature, storage, waittime)\n`; // cooldown nativo: o TFS já controla via xml
  lua += `\tif sendSpellbarCooldownAuto then sendSpellbarCooldownAuto(creature, "${s.name}") end\n\treturn true\nend`;
  if ($('spellLua')) $('spellLua').value = lua; if ($('spLuaName')) $('spLuaName').textContent = `${s.folder}/${spScriptFile()}`; spell._lua = lua; spell._xml = spellGenXml(); spKick();
  if (typeof liveOp === 'function' && LIVE.connected && !LIVE.applying) { const _c = Object.assign({}, spell); delete _c._lua; delete _c._xml; liveOp('spell', 'set', { spell: _c }); }
}
// syntax highlight Lua (escapa tudo; comentário/string/número/constante TFS/keyword/método)
function luaHighlight(code) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const re = /(--[^\n]*)|("(?:[^"\\]|\\.)*")|\b(\d+\.?\d*)\b|\b((?:COMBAT|CONST|CONDITION|DAMAGE_FACTOR|SPELL|CALLBACK|TILESTATE|TEXTCOLOR|MESSAGE|TALKTYPE)_[A-Z0-9_]+)\b|\b(local|function|end|if|then|else|elseif|return|for|do|while|not|and|or|true|false|nil)\b|:([a-zA-Z]\w*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    if (m[1]) out += '<span class="l-com">' + esc(m[1]) + '</span>';
    else if (m[2]) out += '<span class="l-str">' + esc(m[2]) + '</span>';
    else if (m[3]) out += '<span class="l-num">' + m[3] + '</span>';
    else if (m[4]) out += '<span class="l-cst">' + m[4] + '</span>';
    else if (m[5]) out += '<span class="l-kw">' + m[5] + '</span>';
    else if (m[6]) out += '<span class="l-op">:</span><span class="l-fn">' + m[6] + '</span>';
    last = re.lastIndex;
  }
  out += esc(code.slice(last)); return out;
}
// preview animado: grid + área tintada + sprite do efeito (e missile voando)
// otimizado: RAF só roda quando _spPlay; pausado desenha 1 frame e para. spKick() redesenha sob demanda.
let _spAnimT = 0, _spLastTs = null;
function _spLoop(ts) { if (mode !== 'spell') { _spellRAF = null; return; } if (_spLastTs != null && _spPlay) _spAnimT += (ts - _spLastTs) / 1000 * _spSpeed; _spLastTs = ts; drawSpellPreview(_spAnimT); _spellRAF = _spPlay ? requestAnimationFrame(_spLoop) : null; }
function spKick() { if (mode === 'spell' && !_spellRAF) { _spLastTs = null; _spellRAF = requestAnimationFrame(_spLoop); } }
function startSpellPreview() {
  if (_spellRAF) { cancelAnimationFrame(_spellRAF); _spellRAF = null; } _spLastTs = null;
  const ctl = $('spPreviewCtl'); if (ctl && !ctl._wired) { ctl._wired = true; ctl.innerHTML = ''; const pb = document.createElement('button'); pb.className = 'miniBtn'; pb.id = 'spPlayBtn'; pb.textContent = _spPlay ? '⏸' : '▶'; pb.onclick = () => { _spPlay = !_spPlay; pb.textContent = _spPlay ? '⏸' : '▶'; spKick(); }; const sp = document.createElement('select'); sp.style.cssText = 'font-size:11px;margin-left:4px'; for (const v of [0.25, 0.5, 1, 2]) { const o = document.createElement('option'); o.value = v; o.textContent = v + '×'; sp.appendChild(o); } sp.value = _spSpeed; sp.onchange = () => { _spSpeed = +sp.value; spKick(); };
    const ob = document.createElement('button'); ob.className = 'miniBtn'; ob.textContent = '👤'; ob.title = 'escolher a outfit do personagem'; ob.style.marginLeft = '6px'; ob.onclick = () => spellPicker('outfits', 'previewLook');
    const rot = document.createElement('button'); rot.className = 'miniBtn'; rot.title = 'girar a direção da outfit (N/E/S/W)'; const DLBL = ['N', 'L', 'S', 'O']; const updRot = () => rot.textContent = '🧭 ' + DLBL[spell.previewDir]; updRot(); rot.onclick = () => { spell.previewDir = (spell.previewDir + 1) % 4; updRot(); spKick(); };
    const anim = document.createElement('button'); anim.className = 'miniBtn'; const updAnim = () => anim.textContent = spell.previewAnim === 'walk' ? '🏃 andar' : '🧍 idle'; updAnim(); anim.title = 'idle (parado) ou andar'; anim.onclick = () => { spell.previewAnim = spell.previewAnim === 'walk' ? 'idle' : 'walk'; updAnim(); spKick(); };
    const tb = document.createElement('button'); tb.className = 'miniBtn'; tb.textContent = '🎯'; tb.title = 'escolher o ALVO (player/monstro) que anda e leva a spell'; tb.style.marginLeft = '6px'; tb.onclick = () => spellPicker('outfits', 'previewTargetLook');
    const tw = document.createElement('button'); tw.className = 'miniBtn'; const updTw = () => tw.textContent = spell.previewTargetWalk ? '🚶 alvo anda' : '🛑 alvo parado'; updTw(); tw.title = 'o alvo fica andando (esquiva) ou parado'; tw.onclick = () => { spell.previewTargetWalk = !spell.previewTargetWalk; updTw(); spKick(); };
    const rs = document.createElement('button'); rs.className = 'miniBtn'; rs.textContent = '🔄'; rs.title = 'resetar posições (player no centro, alvo na frente)'; rs.style.marginLeft = '6px'; rs.onclick = () => { spell.previewCX = spell.previewCY = spell.previewTOX = spell.previewTOY = null; spKick(); };
    ctl.append(pb, sp, ob, rot, anim, tb, tw, rs);
  }
  // arrastar a outfit no preview p/ reposicionar
  const pcv = $('spellPreview'); if (pcv && !pcv._dragWired) { pcv._dragWired = true; let drag = null; const G = 11;
    const toTile = (e) => { const r = pcv.getBoundingClientRect(); const tsz = pcv.width / G; return { x: (e.clientX - r.left) / tsz, y: (e.clientY - r.top) / tsz }; };
    const casterPos = () => ({ x: spell.previewCX != null ? spell.previewCX : (G - 1) / 2, y: spell.previewCY != null ? spell.previewCY : (G - 1) / 2 });
    const dirv = () => ([[0, -1], [1, 0], [0, 1], [-1, 0]][spell.previewDir] || [0, 1]);
    const selfTgt = () => spell.selftarget || (spell.isHealing && !spell.needTarget);
    const tgtPos = () => { const c = casterPos(), dv = dirv(), reach = selfTgt() ? 0 : 3; const ox = spell.previewTOX != null ? spell.previewTOX : dv[0] * reach, oy = spell.previewTOY != null ? spell.previewTOY : dv[1] * reach; return { x: c.x + ox, y: c.y + oy }; };
    const onMove = (e) => { if (!drag || mode !== 'spell') return; const t = toTile(e); const tx = Math.max(0, Math.min(G - 1, Math.floor(t.x))), ty = Math.max(0, Math.min(G - 1, Math.floor(t.y)));
      if (drag === 'caster') { spell.previewCX = tx; spell.previewCY = ty; } // move o player; o monstro segue (é offset)
      else { const c = casterPos(); spell.previewTOX = tx - c.x; spell.previewTOY = ty - c.y; } // move só o monstro
      spKick(); };
    pcv.style.cursor = 'move';
    pcv.addEventListener('mousedown', (e) => { const t = toTile(e), c = casterPos(), g = tgtPos();
      const dc = Math.hypot(t.x - (c.x + .5), t.y - (c.y + .5)), dg = Math.hypot(t.x - (g.x + .5), t.y - (g.y + .5));
      drag = (!selfTgt() && dg < dc) ? 'target' : 'caster'; onMove(e); });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', () => { drag = null; });
  }
  spKick();
}
function _hex2rgb(h) { h = (h || '#ffffff').replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
// desenha uma outfit no tile (gx,gy) com direção + grupo idle/walk. retorna se desenhou.
function spDrawOutfit(ctx, ts, look, gx, gy, dir, walk, t) {
  if (!look || !dat) return false; const th = dat.category('outfits').get(look); if (!th) return false;
  const d = Math.min((th.px || 1) - 1, dir); const grp = outfitGroups(th); const gi = walk ? grp.walk : grp.idle; const g = (th._groups && th._groups[gi]) || th; const frames = Math.max(1, g.frames || 1); const af = walk ? Math.floor(t * 7) % frames : 0; const c = composeThingG(th, gi, d, af); if (!c) return false;
  const gw = g.width || 1, gh = g.height || 1; ctx.drawImage(c, (gx + 1) * ts - gw * ts, (gy + 1) * ts - gh * ts, gw * ts, gh * ts); return true;
}
function drawSpellPreview(t) {
  const cv = $('spellPreview'); if (!cv) return; const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false; const W = cv.width, H = cv.height;
  const col = SP_COMBAT_COLOR[spell.combat] || '#ffffff'; const rgb = _hex2rgb(col); const RGB = rgb.join(',');
  // ---- fundo: gradiente radial + leve tint do tipo de dano + vinheta ----
  const bg = ctx.createRadialGradient(W / 2, H * 0.32, 20, W / 2, H * 0.5, W * 0.75);
  bg.addColorStop(0, '#1a2032'); bg.addColorStop(1, '#080a11'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const G = 11, ts = W / G, cx = (G - 1) / 2; let am = spell.area === 'custom' ? spCustomMatrix() : (SP_AREAS[spell.area] || SP_AREAS.single).m; if (['wave', 'beam', 'custom'].includes(spell.area)) am = spRotate(am, spell.castDir); const ah = am.length, aw = am[0].length;
  // grid sutil
  ctx.strokeStyle = 'rgba(255,255,255,.045)'; ctx.lineWidth = 1; for (let i = 0; i <= G; i++) { ctx.beginPath(); ctx.moveTo(i * ts, 0); ctx.lineTo(i * ts, H); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i * ts); ctx.lineTo(W, i * ts); ctx.stroke(); }
  const cyc = (t % 1.6) / 1.6; const impact = cyc > 0.5; const ip = impact ? (cyc - 0.5) / 0.5 : 0; // progresso do impacto 0..1
  const DIRV = [[0, -1], [1, 0], [0, 1], [-1, 0]]; const dv = DIRV[spell.previewDir] || DIRV[2];
  // ---- caster (arrastável + dash) ----
  const baseCX = spell.previewCX != null ? spell.previewCX : cx, baseCY = spell.previewCY != null ? spell.previewCY : cx;
  const dashProg = spell.dash ? (cyc < 0.5 ? cyc / 0.5 : 1) : 0; const dashing = spell.dash && dashProg > 0 && dashProg < 1;
  const cax = baseCX + dv[0] * (spell.dashTiles || 0) * dashProg, cay = baseCY + dv[1] * (spell.dashTiles || 0) * dashProg;
  // sombra do caster
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse((cax + .5) * ts, (cay + .92) * ts, ts * 0.32, ts * 0.12, 0, 0, 6.283); ctx.fill();
  if (!spDrawOutfit(ctx, ts, spell.previewLook, cax, cay, spell.previewDir, spell.previewAnim === 'walk' || dashing, t)) { ctx.fillStyle = '#3fcf7a'; ctx.shadowColor = '#3fcf7a'; ctx.shadowBlur = 8; ctx.beginPath(); ctx.arc((cax + .5) * ts, (cay + .5) * ts, ts * 0.3, 0, 6.283); ctx.fill(); ctx.shadowBlur = 0; }
  // ---- alvo (monstro dummy) + CENTRO do efeito ----
  // Regra: o PLAYER é quem solta. O efeito sai NO player (caster) — só quando a spell precisa de ALVO
  // (needTarget: projétil/golpe num inimigo) é que o efeito sai no MOB. Self/área saem no player.
  const selfOnly = spell.selftarget && !spell.needTarget;      // self puro → nem mostra monstro
  const onCaster = !spell.needTarget;                          // efeito no player se NÃO for spell de alvo
  const reach = selfOnly ? 0 : 3;
  const offX = spell.previewTOX != null ? spell.previewTOX : dv[0] * reach;
  const offY = spell.previewTOY != null ? spell.previewTOY : dv[1] * reach;
  const perp = [dv[1], -dv[0]]; const sway = spell.previewTargetWalk && !selfOnly ? Math.sin(t * 1.6) * 1.6 : 0;
  const tgtX = cax + offX + perp[0] * sway, tgtY = cay + offY + perp[1] * sway;
  const tRound = [Math.round(tgtX), Math.round(tgtY)];
  const aCenter = onCaster ? [Math.round(cax), Math.round(cay)] : tRound; // centro do efeito: player (não-alvo) ou mob (alvo)
  if (!selfOnly) { // monstro (dummy) — caster solta NELE só se for spell de alvo; senão ele é só bystander
    const moveDir = sway !== 0 ? (Math.cos(t * 1.6) * (perp[0] || 0) > 0 || Math.cos(t * 1.6) * (perp[1] || 0) > 0 ? 1 : 3) : 2;
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse((tgtX + .5) * ts, (tgtY + .92) * ts, ts * 0.32, ts * 0.12, 0, 0, 6.283); ctx.fill();
    const tw = spell.previewTargetWalk;
    if (!spDrawOutfit(ctx, ts, spell.previewTargetLook, tgtX, tgtY, tw ? moveDir : 2, tw, t)) { ctx.fillStyle = '#ff5a6a'; ctx.shadowColor = '#ff5a6a'; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc((tgtX + .5) * ts, (tgtY + .5) * ts, ts * 0.28, 0, 6.283); ctx.fill(); ctx.shadowBlur = 0; }
  }
  // aura de condição + flash de "hit" no CENTRO do efeito (player se não-alvo, mob se alvo)
  if (impact && spell.cond && spell.cond.type !== 'none') { const cc2 = SP_CONDITIONS_COLOR[spell.cond.type] || col; const pr = (0.5 + 0.25 * Math.sin(t * 9)) * ts; ctx.save(); ctx.globalAlpha = 0.5 * (1 - ip * 0.3); ctx.fillStyle = cc2; ctx.shadowColor = cc2; ctx.shadowBlur = 16; ctx.beginPath(); ctx.arc((aCenter[0] + .5) * ts, (aCenter[1] + .5) * ts, pr, 0, 6.283); ctx.fill(); ctx.restore(); ctx.shadowBlur = 0; }
  if (impact && ip < 0.4) { ctx.save(); ctx.globalAlpha = (0.4 - ip) * 1.6; ctx.fillStyle = '#fff'; ctx.globalCompositeOperation = 'lighter'; ctx.fillRect(aCenter[0] * ts, aCenter[1] * ts, ts, ts); ctx.restore(); }
  // ---- mísseis voando: TAMANHO REAL (width×height do .dat) + MULTI-HIT (um stream de N, igual o .lua) ----
  const effId = spell.effect, misId = spell.missile;
  if (misId && dat && spell.needTarget && !impact) {
    const th = dat.category('missiles') && dat.category('missiles').get(misId);
    if (th) { const c = composeMissileDir(th, dv[0], dv[1]);
      if (c) {
        const mw = (th.width || 1) * ts, mh = (th.height || 1) * ts;
        const n = Math.max(1, spell.multiHit || 1); const gap = n > 1 ? Math.min(0.22, 0.9 / n) : 0; // espaçamento entre os mísseis do stream
        ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 12;
        for (let k = 0; k < n; k++) { const pr = (cyc / 0.5) - k * gap; if (pr <= 0 || pr > 1) continue; const mx = (cax + .5) * ts + (tgtX - cax) * ts * pr, my = (cay + .5) * ts + (tgtY - cay) * ts * pr; ctx.drawImage(c, mx - mw / 2, my - mh / 2, mw, mh); }
        ctx.restore();
      }
    }
  }
  // ---- área + impacto (glow + efeito + dano) ----
  for (let r = 0; r < ah; r++) for (let cc = 0; cc < aw; cc++) { if (!am[r][cc]) continue; const gx = aCenter[0] + (cc - (aw - 1) / 2), gy = aCenter[1] + (r - (ah - 1) / 2); if (gx < -1 || gy < -1 || gx > G || gy > G) continue; const sx = gx * ts, sy = gy * ts;
    ctx.fillStyle = `rgba(${RGB},${impact ? 0.28 : 0.16})`; ctx.fillRect(sx, sy, ts, ts); ctx.strokeStyle = `rgba(${RGB},.55)`; ctx.strokeRect(sx + 1, sy + 1, ts - 2, ts - 2);
    if (impact && dat) { const eff = dat.category('effects') && dat.category('effects').get(effId); if (eff) { const fr = Math.floor(ip * Math.max(1, eff.frames)) % Math.max(1, eff.frames); const c = composeThing(eff, 0, fr); if (c) { const ew = (eff.width || 1) * ts, eh = (eff.height || 1) * ts; ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 14; ctx.drawImage(c, sx - ((eff.width || 1) - 1) / 2 * ts, sy - ((eff.height || 1) - 1) / 2 * ts, ew, eh); ctx.restore(); } }
      const fc = SP_FACTORS[spell.tier] || SP_FACTORS[100]; const bdmg = fc[0] * spell.simLevel + fc[1] * spell.simMagic; const seed = (r * 7 + cc * 13) % 100 / 100; const base = Math.round(bdmg * (spell.facMin + seed * (spell.facMax - spell.facMin)));
      ctx.save(); ctx.globalAlpha = 1 - ip; ctx.fillStyle = spell.isHealing ? '#6dffa6' : '#fff'; ctx.font = 'bold 13px Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; const tx = sx + ts / 2 + (seed - .5) * ts * .4, tyv = sy + ts / 2 - ip * ts * 1.1; ctx.strokeText((spell.isHealing ? '+' : '-') + base, tx, tyv); ctx.fillText((spell.isHealing ? '+' : '-') + base, tx, tyv); ctx.restore(); ctx.textAlign = 'left'; }
  }
  // ---- flash radial de impacto (anel expandindo) + sparkles ----
  if (impact) { const ctr = [(aCenter[0] + .5) * ts, (aCenter[1] + .5) * ts];
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const rr = ip * ts * 3.2; ctx.strokeStyle = `rgba(${RGB},${(1 - ip) * 0.8})`; ctx.lineWidth = Math.max(1, (1 - ip) * 6); ctx.beginPath(); ctx.arc(ctr[0], ctr[1], rr, 0, 6.283); ctx.stroke();
    const gl = ctx.createRadialGradient(ctr[0], ctr[1], 0, ctr[0], ctr[1], ts * 2.2); gl.addColorStop(0, `rgba(${RGB},${(1 - ip) * 0.5})`); gl.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = gl; ctx.fillRect(ctr[0] - ts * 2.2, ctr[1] - ts * 2.2, ts * 4.4, ts * 4.4);
    for (let k = 0; k < 8; k++) { const ang = (k / 8) * 6.283 + t; const d2 = ip * ts * 2.4; const px = ctr[0] + Math.cos(ang) * d2, py = ctr[1] + Math.sin(ang) * d2; ctx.fillStyle = `rgba(${RGB},${(1 - ip)})`; ctx.beginPath(); ctx.arc(px, py, Math.max(1, (1 - ip) * 3), 0, 6.283); ctx.fill(); }
    ctx.restore();
  }
  // ---- vinheta + rótulo ----
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.72); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.45)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#aeb8cd'; ctx.font = '11px Segoe UI, sans-serif'; ctx.fillText(`${spell.name} · ${spell.combat} · ef ${effId}${misId ? ' · dist ' + misId : ''}${spell.cond && spell.cond.type !== 'none' ? ' · ' + spell.cond.type : ''}`, 8, H - 8);
}
async function spellGenAI() {
  const desc = $('spIaPrompt').value.trim(); if (!desc) return alert('descreva a spell');
  const key = localStorage.getItem('ai.key.' + aiProvider) || ''; const pInfo = AI.PROVIDERS[aiProvider];
  if (!pInfo.local && !pInfo.nokey && !key) return alert('configure a IA na aba 🤖 (provider + key). Dica: Claude Code CLI é grátis.');
  const model = localStorage.getItem('ai.model.' + aiProvider) || pInfo.models[0];
  const skills = spLoadSkills();
  // inclui até 30KB de spells reais do servidor se pasta configurada
  let serverCtxForm = '';
  if (spGetServerRoot()) {
    const sc = spScanServerSpells(desc, 30);
    if (sc.files.length) serverCtxForm = `\n\nExemplos REAIS do servidor do usuário (${sc.files.length} arquivos) — use para calibrar combats, tiers e estilos:\n${sc.text}\n---\n`;
  }
  const sys = (skills ? skills + '\n\n---\n' : '') + serverCtxForm + `Com base na base de conhecimento ACIMA (servidor otserv, estilo Dragon Ball), gere uma SPELL. Responda APENAS um JSON válido (sem markdown) com os campos: name(str), words(str), spellid(int único), folder(um de ${SP_FOLDERS.join('/')}), group(attack/healing/support/special), type(instant/rune), combat(um de ${SP_COMBAT.join('/')}; quase sempre PHYSICALDAMAGE p/ ataque, HEALING p/ cura), effect(id numérico de magic effect), missile(id numérico de distance effect ou 0), area(um de ${Object.keys(SP_AREAS).join('/')}), lvl(int), mana(int), magiclevel(int ou 0), exhaustSecs(int), aggressive(bool), selftarget(bool), needTarget(bool), range(int 1-8), isHealing(bool), tier(um de ${SP_TIERS.join('/')}), facMin(float ~0.78-0.98), facMax(float ~0.82-1.02), multiHit(int golpes), hitDelay(ms), condition({type(um de ${Object.keys(SP_CONDITIONS).join('/')}),dmg,rounds,interval,ticks,skill,skillVal,hpGain,manaGain,speed}), extraStorages(str ids vírgula p/ combo), animText(str texto flutuante ou ""), createItem(item id ou 0), teleportTarget(bool), transform({look:int,aura:int,dur:int} ou null), summon({name:str,count:int,dur:int} ou null), direction(bool). NÃO use mana/level absurdos; escale pelo tier. Ataque ki = PHYSICALDAMAGE. Use transform p/ formas (ex Migatte), summon p/ invocar.`;
  $('spIaGen').disabled = true; $('spIaGen').textContent = '… gerando'; $('status').textContent = 'IA gerando a spell…';
  try {
    const resp = await AI.chat(aiProvider, key, model, [{ role: 'user', content: 'Descrição: ' + desc }], { system: sys, temperature: 0.4, maxTokens: 900 });
    const jm = resp.match(/\{[\s\S]*\}/); if (!jm) throw new Error('IA não retornou JSON');
    const j = JSON.parse(jm[0]);
    const sp = Object.assign(spellDefault(), {
      name: j.name || 'Spell', words: j.words || (j.name || 'spell').toLowerCase(), spellid: +j.spellid || 100,
      folder: SP_FOLDERS.includes(j.folder) ? j.folder : 'Attack', group: ['attack', 'healing', 'support', 'special'].includes(j.group) ? j.group : 'attack',
      type: j.type === 'rune' ? 'rune' : 'instant', combat: SP_COMBAT.includes(j.combat) ? j.combat : 'PHYSICALDAMAGE',
      effect: +j.effect || 0, missile: +j.missile || 0, area: SP_AREAS[j.area] ? j.area : 'single',
      lvl: +j.lvl || 1, mana: +j.mana || 100, magiclevel: +j.magiclevel || 0, exhaustSecs: +j.exhaustSecs || 2,
      aggressive: j.aggressive !== false, selftarget: !!j.selftarget, needTarget: !!j.needTarget, range: +j.range || 6,
      isHealing: !!j.isHealing || j.combat === 'HEALING', tier: SP_TIERS.includes(+j.tier) ? +j.tier : 100,
      facMin: +j.facMin || 0.78, facMax: +j.facMax || 0.82, multiHit: +j.multiHit || 1, hitDelay: +j.hitDelay || 200,
    });
    if (j.condition && SP_CONDITIONS[j.condition.type]) sp.cond = Object.assign(sp.cond, { type: j.condition.type, dmg: +j.condition.dmg || sp.cond.dmg, rounds: +j.condition.rounds || sp.cond.rounds, interval: +j.condition.interval || sp.cond.interval, ticks: +j.condition.ticks || sp.cond.ticks, skill: SP_SKILLS.includes(j.condition.skill) ? j.condition.skill : sp.cond.skill, skillVal: +j.condition.skillVal || sp.cond.skillVal, hpGain: +j.condition.hpGain || sp.cond.hpGain, manaGain: +j.condition.manaGain || sp.cond.manaGain, speed: +j.condition.speed || sp.cond.speed });
    if (typeof j.extraStorages === 'string') sp.extraStorages = j.extraStorages;
    if (typeof j.animText === 'string') sp.animText = j.animText;
    sp.createItem = +j.createItem || 0; sp.teleportTarget = !!j.teleportTarget; sp.direction = !!j.direction;
    if (j.transform && j.transform.look) { sp.transform = true; sp.transformLook = +j.transform.look || 0; sp.transformAura = +j.transform.aura || 0; sp.transformDur = +j.transform.dur || 10; }
    if (j.summon && j.summon.name) { sp.summonName = j.summon.name; sp.summonCount = +j.summon.count || 1; sp.summonDur = +j.summon.dur || 0; }
    spell = sp;
    renderSpellForm(); spellGenLua(); $('status').textContent = '✅ gerado pela IA: ' + spell.name;
  } catch (e) { alert('erro IA: ' + e.message); $('status').textContent = 'erro IA'; }
  finally { $('spIaGen').disabled = false; $('spIaGen').textContent = '🤖 Gerar com IA'; }
}
// ============================================================
// SERVIDOR ROOT — pasta raiz do servidor (data/) persistida
// ============================================================
function spGetServerRoot() { return localStorage.getItem('sp.serverRoot') || ''; }
function spSetServerRoot(dir) { localStorage.setItem('sp.serverRoot', dir); const b = $('spServerRoot'); if (b) b.title = 'Servidor: ' + dir; }

function _updateSpServerBtn() {
  const b = $('spServerRoot'); if (!b) return;
  const root = spGetServerRoot();
  b.textContent = root ? '📁 ' + root.split(/[\\/]/).slice(-2).join('/') : '📁 Servidor';
  b.title = root ? 'Servidor: ' + root + ' (clique p/ trocar)' : 'Definir pasta raiz do servidor (data/) — IA vasculha daqui';
  b.style.color = root ? 'var(--accent2)' : '';
}

// ============================================================
// SCAN inteligente — percorre toda a pasta, ranqueia por relevância
// ============================================================
function spScanServerSpells(desc, maxContextKb) {
  const root = spGetServerRoot(); if (!root) return { files: [], text: '', total: 0 };
  const keywords = desc.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const allFiles = [];
  const walk = (d, depth) => {
    if (depth > 6) return;
    let ents; try { ents = fsp.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (/^\./.test(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.lua$/i.test(e.name)) allFiles.push(full);
    }
  };
  // prioriza subpastas de spells/scripts
  const spellDirs = ['spells', 'scripts', 'creaturescripts', 'movements', 'actions', 'talkactions'];
  for (const sd of spellDirs) {
    const p = path.join(root, sd); if (fsp.existsSync && fsp.existsSync(p)) walk(p, 0);
    const p2 = path.join(root, 'data', sd); if (fsp.existsSync && fsp.existsSync(p2)) walk(p2, 0);
  }
  if (!allFiles.length) walk(root, 0); // fallback: raiz inteira

  // dedup por caminho
  const seen = new Set(); const unique = allFiles.filter((f) => { if (seen.has(f)) return false; seen.add(f); return true; });

  // score de relevância: conta keywords que aparecem no conteúdo/nome
  const scored = unique.map((f) => {
    const name = path.basename(f, '.lua').toLowerCase();
    let score = keywords.filter((k) => name.includes(k)).length * 3; // nome pesa mais
    let raw = '';
    try { raw = fsp.readFileSync(f, 'utf8').slice(0, 1200); } catch (e) { return null; }
    score += keywords.filter((k) => raw.toLowerCase().includes(k)).length;
    // bonus: pasta de spells
    if (/[\\/]spells[\\/]/i.test(f)) score += 2;
    return { f, raw, score };
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score);

  // monta contexto até atingir o budget em KB
  const budget = (maxContextKb || 80) * 1024;
  let text = '', files = [];
  for (const { f, score } of scored) {
    let content = '';
    try { content = fsp.readFileSync(f, 'utf8'); } catch (e) { continue; }
    // inclui mais chars em arquivos de alta relevância
    const chars = score > 4 ? 5000 : score > 1 ? 3000 : 1500;
    const blk = `\n===== ${f.replace(root, '').replace(/^[\\/]/, '')} =====\n${content.slice(0, chars)}\n`;
    if (text.length + blk.length > budget) { if (files.length < 5) { text += blk; files.push(f); } else break; }
    else { text += blk; files.push(f); }
  }
  return { files, text, total: unique.length };
}

// ============================================================
// GERAÇÃO LUA DIRETO — IA lê spells reais → gera .lua completo
// ============================================================
async function spellGenAILua() {
  const desc = $('spIaPrompt').value.trim(); if (!desc) return alert('descreva a spell');
  const root = spGetServerRoot();
  const key = localStorage.getItem('ai.key.' + aiProvider) || ''; const pInfo = AI.PROVIDERS[aiProvider];
  if (!pInfo.local && !pInfo.nokey && !key) return alert('configure a IA na aba 🤖 (provider + key).');
  const model = localStorage.getItem('ai.model.' + aiProvider) || pInfo.models[0];

  const btn = $('spIaGenLua'); btn.disabled = true; btn.textContent = '…';

  let serverCtx = '';
  let serverInfo = '';
  if (root) {
    $('status').textContent = 'Escaneando servidor…';
    const scan = spScanServerSpells(desc, 80);
    if (scan.files.length) {
      serverCtx = `\n\nARQUIVOS REAIS DO SERVIDOR (${scan.files.length} de ${scan.total} .lua encontrados):\n` + scan.text;
      serverInfo = `${scan.files.length} arquivos do servidor`;
    } else {
      serverInfo = 'pasta configurada mas sem .lua encontrados';
    }
  }

  const kb = spLoadSkills();
  const sys = (kb ? kb + '\n\n---\n' : '') + `Você é expert em scripts de OTServ/TFS. ${root ? 'Analise os ARQUIVOS REAIS do servidor do usuário acima — use EXATAMENTE o mesmo estilo, API, funções e convenções que aparecem nesses arquivos.' : 'Use o estilo TFS padrão.'}\n\nGere um arquivo .lua COMPLETO e funcional para a spell descrita. O arquivo deve:\n- Seguir EXATAMENTE o padrão dos exemplos do servidor (mesmas funções, mesmo estilo de registro, mesmo exhaustion/cooldown)\n- Incluir o XML de registro comentado no topo\n- Ser balanceado e funcional (não use valores absurdos)\n- Incluir TODOS os detalhes da spell pedida sem simplificar\n\nResponda APENAS com o código Lua completo, sem markdown, sem explicações fora do código.`;

  $('status').textContent = `IA gerando Lua${serverInfo ? ' (contexto: ' + serverInfo + ')' : ''}…`;
  try {
    const resp = await AI.chat(aiProvider, key, model, [
      { role: 'user', content: `Spell a criar: ${desc}${serverCtx}` }
    ], { system: sys, temperature: 0.3, maxTokens: 2400 });

    // limpa blocos de markdown se a IA insistir
    const lua = resp.replace(/^```(?:lua)?\n?/m, '').replace(/\n?```$/m, '').trim();
    if (!lua) throw new Error('IA não retornou código');

    // injeta no preview Lua diretamente
    if ($('spellLua')) $('spellLua').value = lua;
    if ($('spLuaName')) $('spLuaName').textContent = `IA direto (${desc.slice(0, 40)})`;
    if (spell) { spell._lua = lua; spell._luaDirect = true; }
    $('status').textContent = `✅ Lua gerado pela IA${serverInfo ? ' — contexto: ' + serverInfo : ''} · 💾 Exportar .lua`;
  } catch (e) {
    alert('erro IA: ' + e.message); $('status').textContent = 'erro IA';
  } finally {
    btn.disabled = false; btn.textContent = '🤖 Gerar Lua Direto';
  }
}

// navega a pasta de spells do servidor → lista .lua → abre no editor
let _spBrowseDir = null;
async function spellBrowseServer() {
  const dir = await ipcRenderer.invoke('pick-dir'); if (!dir) return; _spBrowseDir = dir;
  // CACHEIA a pasta TODA (.lua incl.) — senão readFileSync dá ENOENT (shim não bulk-cacheia .lua)
  $('status').textContent = 'carregando spells da pasta…';
  try { if (window.__preloadTreeLua) await window.__preloadTreeLua(dir); } catch (e) {}
  const files = [];
  const walk = (d, depth) => { if (depth > 6) return; let ents; try { ents = fsp.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } for (const e of ents) { const full = path.join(d, e.name); if (e.isDirectory()) walk(full, depth + 1); else if (/\.lua$/i.test(e.name)) files.push(full); } };
  walk(dir, 0);
  if (!files.length) return alert('nenhum .lua encontrado nessa pasta');
  // extrai nome/palavras de cada spell p/ exibir bonito (lê do cache já carregado)
  const meta = (f) => { let raw = ''; try { raw = fsp.readFileSync(f, 'utf8'); } catch (e) { return {}; } const nm = raw.match(/spell:name\(\s*["']([^"']+)["']/i) || raw.match(/\bname\s*=\s*["']([^"']+)["']/i); const wd = raw.match(/spell:words\(\s*["']([^"']+)["']/i); const grp = raw.match(/spell:group\(\s*["']?(\w+)/i); return { name: nm ? nm[1] : null, words: wd ? wd[1] : null, group: grp ? grp[1] : null }; };
  const info = new Map(); for (const f of files) info.set(f, meta(f));
  document.querySelectorAll('.spBrowseModal').forEach((m) => m.remove());
  const ov = document.createElement('div'); ov.className = 'modal spBrowseModal'; const b = document.createElement('div'); b.className = 'modalBox'; b.style.maxWidth = '600px'; b.innerHTML = `<h3>📂 Spells do servidor (${files.length})</h3>`;
  const search = document.createElement('input'); search.placeholder = 'buscar por nome, palavra ou caminho…'; search.style.cssText = 'width:100%;margin-bottom:6px'; b.appendChild(search);
  const list = document.createElement('div'); list.style.cssText = 'max-height:440px;overflow:auto'; b.appendChild(list);
  const rel = (f) => f.replace(dir, '').replace(/^[\\/]/, '');
  const hay = (f) => { const m = info.get(f) || {}; return (rel(f) + ' ' + (m.name || '') + ' ' + (m.words || '')).toLowerCase(); };
  const draw = () => { const q = search.value.toLowerCase(); list.innerHTML = ''; const sub = files.filter((f) => hay(f).includes(q)); sub.slice(0, 500).forEach((f) => { const m = info.get(f) || {}; const r = document.createElement('div'); r.style.cssText = 'padding:5px 8px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border)'; const ttl = m.name || rel(f).replace(/\.lua$/i, '').split(/[\\/]/).pop(); r.innerHTML = `🪄 <b>${ttl}</b>${m.words ? ` <span style="color:#7fd1ff">${m.words}</span>` : ''} <span style="color:var(--muted);font-size:10px">· ${rel(f)}</span>`; r.onclick = () => { try { spellImportRaw(fsp.readFileSync(f, 'utf8'), f); ov.remove(); } catch (e) { alert('erro: ' + e.message); } }; list.appendChild(r); }); if (!sub.length) list.innerHTML = '<div class="alabel" style="padding:8px">nada encontrado</div>'; };
  search.oninput = draw; draw(); const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); b.appendChild(foot); ov.appendChild(b); document.body.appendChild(ov); setTimeout(() => search.focus(), 30);
  $('status').textContent = `📂 ${files.length} spells carregadas de ${dir}`;
}
// ===== Sidebar fixa de spells (lista igual monsters/npcs) — carrega a pasta TODA =====
let spellStore = { dir: null, list: [] };
let _spellSel = null;
function spellMeta(raw) {
  const nm = raw.match(/spell:name\(\s*["']([^"']+)["']/i) || raw.match(/\bname\s*=\s*["']([^"']+)["']/i);
  const wd = raw.match(/spell:words\(\s*["']([^"']+)["']/i);
  const grp = raw.match(/spell:group\(\s*["']?(\w+)/i);
  const rune = /Spell\(\s*["']rune["']/i.test(raw) || /:runeId\(/i.test(raw);
  return { name: nm ? nm[1] : null, words: wd ? wd[1] : null, group: grp ? grp[1] : null, rune };
}
function _xmlAttr(s, k) { const m = s.match(new RegExp('\\b' + k + '\\s*=\\s*"([^"]*)"', 'i')); return m ? m[1] : null; }
async function loadSpellFolder(p) {
  if (!p) return;
  // aceita arquivo OU pasta. .xml = spells.xml; .lua = usa a pasta dele
  let dir = p, xmlPath = null;
  if (/\.xml$/i.test(p)) { xmlPath = p; dir = path.dirname(p); }
  else if (/\.lua$/i.test(p)) { dir = path.dirname(p); }
  $('status').textContent = 'carregando spells…';
  try { if (window.__preloadTreeLua) await window.__preloadTreeLua(dir); } catch (e) {}
  if (!xmlPath) { const c = path.join(dir, 'spells.xml'); if (fsp.existsSync(c)) xmlPath = c; } // TFS/OTX: índice
  const out = [];
  if (xmlPath) {
    // ---- TFS/OTX: lê o spells.xml e resolve cada script="...lua" (em scripts/ ou direto) ----
    let xml = ''; try { xml = fsp.readFileSync(xmlPath, 'utf8'); } catch (e) { try { xml = fsp.readFileSync(xmlPath, 'latin1'); } catch (e2) {} }
    const scriptsDir = path.join(dir, 'scripts');
    const re = /<(instant|rune|conjure)\b([^>]*?)\/?>/gi; let m;
    while ((m = re.exec(xml)) !== null) {
      const type = m[1].toLowerCase(), a = m[2];
      const script = _xmlAttr(a, 'script'); if (!script) continue;
      let file = path.join(scriptsDir, script); if (!fsp.existsSync(file)) { const alt = path.join(dir, script); if (fsp.existsSync(alt)) file = alt; }
      out.push({ file, type, rune: type === 'rune', name: _xmlAttr(a, 'name') || script.split(/[\\/]/).pop().replace(/\.lua$/i, ''), words: _xmlAttr(a, 'words'), group: _xmlAttr(a, 'group'), lvl: _xmlAttr(a, 'lvl'), mana: _xmlAttr(a, 'mana'), mlvl: _xmlAttr(a, 'magiclevel'), selftarget: _xmlAttr(a, 'selftarget'), needtarget: _xmlAttr(a, 'needtarget'), aggressive: _xmlAttr(a, 'aggressive'), premium: _xmlAttr(a, 'prem') || _xmlAttr(a, 'premium'), exhaustion: _xmlAttr(a, 'exhaustion'), range: _xmlAttr(a, 'range'), spellid: _xmlAttr(a, 'spellid'), rel: script });
    }
    spellStore = { dir, list: out, xml: xmlPath };
  } else {
    // ---- Canary/revscript: varre os .lua (cada um se auto-registra) ----
    const files = []; const walk = (d, depth) => { if (depth > 6) return; let ents; try { ents = fsp.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } for (const e of ents) { const full = path.join(d, e.name); if (e.isDirectory()) walk(full, depth + 1); else if (/\.lua$/i.test(e.name)) files.push(full); } };
    walk(dir, 0);
    for (const f of files) { let raw = ''; try { raw = fsp.readFileSync(f, 'utf8'); } catch (e) { continue; } if (!/\bSpell\s*\(|spell:register|spell:words|spell:name/i.test(raw)) continue; const mm = spellMeta(raw); out.push({ file: f, name: mm.name || path.basename(f, '.lua').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), words: mm.words, group: mm.group, rune: mm.rune, rel: f.replace(dir, '').replace(/^[\\/]/, '') }); }
    spellStore = { dir, list: out };
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  try { lsSet('spellsDir', xmlPath || dir); } catch (e) {}
  $('status').textContent = `📂 ${out.length} spells carregadas${xmlPath ? ' (spells.xml)' : ' (revscript)'}`;
  if (mode === 'spell') renderList();
}
function openSpellFromStore(entry) {
  _spellSel = entry;
  let raw; try { raw = fsp.readFileSync(entry.file, 'utf8'); } catch (e) { return alert('erro lendo: ' + e.message); }
  spellImportRaw(raw, entry.file);
  // metadados do spells.xml (words/name/lvl/mana/group/tipo) NÃO existem no .lua → aplica do índice
  if (spell) {
    if (entry.name) spell.name = entry.name;
    if (entry.words) spell.words = entry.words;
    if (entry.group) spell.group = String(entry.group).toLowerCase();
    if (entry.lvl) spell.lvl = parseInt(entry.lvl, 10) || spell.lvl;
    if (entry.mana != null && entry.mana !== '') spell.mana = parseInt(entry.mana, 10) || 0;
    if (entry.mlvl) spell.magiclevel = parseInt(entry.mlvl, 10) || spell.magiclevel;
    if (entry.spellid) spell.spellid = parseInt(entry.spellid, 10) || spell.spellid;
    if (entry.rune) spell.type = 'rune';
    // custo/alvo direto do spells.xml (autoritativo no TFS/OTX)
    if (entry.selftarget != null) spell.selftarget = entry.selftarget === '1';
    if (entry.needtarget != null) spell.needTarget = entry.needtarget === '1';
    if (entry.aggressive != null) spell.aggressive = entry.aggressive !== '0';
    if (entry.premium != null) spell.premium = entry.premium === '1';
    if (entry.exhaustion) spell.exhaustSecs = Math.max(1, Math.round(parseInt(entry.exhaustion, 10) / 1000));
    if (entry.range) spell.range = parseInt(entry.range, 10) || spell.range;
    if (spell.selftarget) spell.needTarget = false;
    if (spell.group === 'healing') spell.isHealing = true;
    renderSpellForm(); spellGenLua();
  }
  renderList();
}
// botão "📂 Abrir do servidor": agora popula a SIDEBAR (não mais só modal)
async function spellPickFolder() {
  const dir = await ipcRenderer.invoke('pick-dir'); if (!dir) return;
  if (mode !== 'spell') setMode('spell');
  await loadSpellFolder(dir);
}
function spLuaCurrent() { const ta = $('spellLua'); return (ta && ta.value) || (spell && spell._lua) || ''; }
function spellExport() { const lua = spLuaCurrent(); if (!lua) return alert('nenhum Lua gerado'); ipcRenderer.invoke('save-file', spScriptFile()).then((f) => { if (!f) return; fs.writeFileSync(f, lua); $('status').textContent = `salvo: ${f} · adicione no spells.xml: ${(spell && spell._xml) || spellGenXml()}`; }); }
function spellCopyLua() { const lua = spLuaCurrent(); if (!lua) return; try { (navigator.clipboard ? navigator.clipboard.writeText(lua) : Promise.reject()).then(() => { $('status').textContent = '📋 Lua copiado'; }, () => fallbackCopy(lua)); } catch (e) { fallbackCopy(lua); } }
function fallbackCopy(txt) { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); $('status').textContent = '📋 copiado'; } catch (e) {} ta.remove(); }
function spLibGet() { try { return JSON.parse(localStorage.getItem('spell.library') || '[]'); } catch (e) { return []; } }
function spLibSet(a) { localStorage.setItem('spell.library', JSON.stringify(a)); }
function spellLibrary() {
  document.querySelectorAll('.spLibModal').forEach((m) => m.remove());
  const ov = document.createElement('div'); ov.className = 'modal spLibModal'; const b = document.createElement('div'); b.className = 'modalBox'; b.style.maxWidth = '480px'; b.innerHTML = '<h3>📚 Biblioteca de Spells</h3>';
  const bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:6px;margin-bottom:8px';
  const saveB = document.createElement('button'); saveB.className = 'miniBtn accent'; saveB.textContent = '💾 Salvar atual'; saveB.onclick = () => { const lib = spLibGet(); const clone = JSON.parse(JSON.stringify(spell)); delete clone._lua; const i = lib.findIndex((x) => x.name === clone.name); if (i >= 0) lib[i] = clone; else lib.push(clone); spLibSet(lib); render(); };
  const expB = document.createElement('button'); expB.className = 'miniBtn'; expB.textContent = '📦 Exportar todas (.lua)'; expB.onclick = async () => { const lib = spLibGet(); if (!lib.length) return; const dir = await ipcRenderer.invoke('pick-dir'); if (!dir) return; const cur = spell; let n = 0; for (const sp of lib) { spell = Object.assign(spellDefault(), sp); spellGenLua(); fs.writeFileSync(path.join(dir, (sp.name || 'spell').toLowerCase().replace(/\s+/g, '_') + '.lua'), spell._lua); n++; } spell = cur; spellGenLua(); $('status').textContent = `${n} spells exportadas → ${dir}`; ov.remove(); };
  bar.append(saveB, expB); b.appendChild(bar);
  const list = document.createElement('div'); list.style.cssText = 'max-height:360px;overflow:auto'; b.appendChild(list);
  const render = () => { const lib = spLibGet(); list.innerHTML = lib.length ? '' : '<div class="alabel" style="padding:8px">vazia — salve a spell atual</div>'; lib.forEach((sp, i) => { const r = document.createElement('div'); r.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 6px;border-bottom:1px solid var(--border)'; const nm = document.createElement('div'); nm.style.flex = '1'; nm.style.fontSize = '12px'; nm.textContent = `🪄 ${sp.name} · ${sp.combat} · ${sp.area}`; const ld = document.createElement('button'); ld.className = 'miniBtn'; ld.textContent = 'abrir'; ld.onclick = () => { spell = Object.assign(spellDefault(), sp); renderSpellForm(); spellGenLua(); ov.remove(); }; const dl = document.createElement('button'); dl.className = 'miniBtn danger'; dl.textContent = '🗑'; dl.onclick = () => { const l = spLibGet(); l.splice(i, 1); spLibSet(l); render(); }; r.append(nm, ld, dl); list.appendChild(r); }); };
  render(); const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); b.appendChild(foot); ov.appendChild(b); document.body.appendChild(ov);
}
// importa um .lua de spell → preenche os campos (parse reverso)
async function spellImport() {
  const f = await ipcRenderer.invoke('pick-file', ['lua']); if (!f) return;
  let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { return alert('erro lendo: ' + e.message); }
  spellImportRaw(raw, f);
}
function spellImportRaw(raw, fpath) {
  const sp = spellDefault(); const g = (re, d) => { const m = raw.match(re); return m ? m[1] : d; };
  if (fpath) { const fn = fpath.replace(/\\/g, '/'); const parts = fn.split('/'); sp.name = (parts.pop() || '').replace(/\.lua$/i, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); const fld = parts.pop(); if (SP_FOLDERS.includes(fld)) sp.folder = fld; }
  const comN = g(/COMBAT_PARAM_TYPE,\s*COMBAT_(\w+)/) || g(/COMBAT_(\w+DAMAGE|HEALING)/);
  if (comN) sp.combat = comN; sp.isHealing = comN === 'HEALING';
  sp.effect = +g(/COMBAT_PARAM_EFFECT,\s*(\d+)/, sp.effect); sp.missile = +g(/COMBAT_PARAM_DISTANCEEFFECT,\s*(\d+)/, 0);
  // fórmula DAMAGE_FACTOR
  const fm = raw.match(/DAMAGE_FACTOR_LEVEL(\d+)[\s\S]*?\*\s*([\d.]+)[\s\S]*?DAMAGE_FACTOR_LEVEL\d+[\s\S]*?\*\s*([\d.]+)/);
  if (fm) { sp.tier = +fm[1]; sp.facMin = +fm[2]; sp.facMax = +fm[3]; }
  // multi-hit
  const mh = raw.match(/for\s+\w+\s*=\s*1,\s*(\d+)\s+do/); if (mh) { sp.multiHit = +mh[1]; const hd = raw.match(/\*\s*(\d+)\)\)/); if (hd) sp.hitDelay = +hd[1]; }
  sp.needTarget = /getTarget\(\)/.test(raw); sp.aggressive = !/AGGRESSIVE,\s*false/.test(raw);
  const exh = raw.match(/exhaustion\.set\([^,]+,\s*storage,\s*(\d+)/) || raw.match(/waittime\s*=\s*(\d+)/); if (exh) sp.exhaustSecs = +exh[1];
  const condN = g(/CONDITION_(\w+)/); if (condN && SP_CONDITIONS[condN]) { sp.cond.type = condN; const dm = raw.match(/addDamage\(\s*(\d+)\s*,\s*(\d+)\s*,\s*-?(\d+)/); if (dm) { sp.cond.rounds = +dm[1]; sp.cond.interval = +dm[2]; sp.cond.dmg = +dm[3]; } }
  const nameC = g(/sendSpellbarCooldownAuto\([^,]+,\s*"([^"]+)"/) || g(/STRING_SPELLNAME,\s*"([^"]+)"/); if (nameC) sp.name = nameC;
  // ---- revscript (Canary / TFS 1.3+): spell:X(...) e Spell("rune"/"instant") ----
  const numCall = (re, d) => { const m = raw.match(re); return m ? +m[1] : d; };
  const nm2 = raw.match(/spell:name\(\s*["']([^"']+)["']/i); if (nm2) sp.name = nm2[1];
  const wd2 = raw.match(/spell:words\(\s*["']([^"']+)["']/i); if (wd2) sp.words = wd2[1];
  sp.lvl = numCall(/spell:level\(\s*(\d+)/i, sp.lvl);
  sp.mana = numCall(/spell:mana\(\s*(\d+)/i, sp.mana);
  sp.magiclevel = numCall(/spell:magic[Ll]evel\(\s*(\d+)/i, sp.magiclevel);
  const cd = raw.match(/spell:cooldown\(\s*(\d+)/i); if (cd) sp.exhaustSecs = Math.max(1, Math.round(+cd[1] / 1000));
  const gr2 = raw.match(/spell:group\(\s*["']?(\w+)/i); if (gr2) sp.group = gr2[1].toLowerCase();
  const id2 = raw.match(/spell:id\(\s*(\d+)/i); if (id2) sp.spellid = +id2[1];
  const rg2 = raw.match(/spell:range\(\s*(\d+)/i); if (rg2) sp.range = +rg2[1];
  if (/Spell\(\s*["']rune["']/i.test(raw)) sp.type = 'rune';
  if (/spell:isSelfTarget\(\s*true/i.test(raw) || /setSelfTarget\(\s*true/i.test(raw)) sp.selftarget = true;
  if (/spell:needTarget\(\s*true/i.test(raw) || /setNeedTarget\(\s*true/i.test(raw)) sp.needTarget = true;
  if (/spell:isAggressive\(\s*false/i.test(raw) || /setNeedTarget.*false/i.test(raw)) sp.aggressive = false;
  if (/spell:isAggressive\(\s*true/i.test(raw)) sp.aggressive = true;
  // setFormula(COMBAT_FORMULA_LEVELMAGIC, a1, b1, a2, b2) → fatores min/max aproximados
  const sf = raw.match(/setFormula\(\s*COMBAT_FORMULA_\w+\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/i);
  if (sf) { const a1 = Math.abs(+sf[1]), a2 = Math.abs(+sf[3]); if (a1) sp.facMin = a1; if (a2) sp.facMax = a2; }
  if (sp.selftarget) sp.needTarget = false; // coerência
  // PRESERVA o layout do preview entre spells (posição do player/monstro, parado/andando, dir, outfits, dash)
  if (spell) for (const k of ['previewLook', 'previewTargetLook', 'previewCX', 'previewCY', 'previewTOX', 'previewTOY', 'previewDir', 'previewAnim', 'previewTargetWalk', 'dash', 'dashTiles', 'simLevel', 'simMagic']) if (spell[k] != null) sp[k] = spell[k];
  spell = sp; renderSpellForm(); spellGenLua(); $('status').textContent = '✅ spell importada: ' + sp.name;
}
// ============================ SCRIPT STUDIO ============================
const SCRIPT_TYPES = {
  action: { label: 'Action (item/baú/alavanca)', folder: 'actions', skills: 'skills_actions.md' },
  movement: { label: 'Movement (tile/equip)', folder: 'movements', skills: 'skills_movements.md' },
  talkaction: { label: 'Talkaction (comando)', folder: 'talkactions', skills: 'skills_talkactions.md' },
  creaturescript: { label: 'Creaturescript (evento)', folder: 'creaturescripts', skills: 'skills_creaturescripts.md' },
  globalevent: { label: 'Globalevent (tempo)', folder: 'globalevents', skills: 'skills_globalevents.md' },
};
const CS_EVENTS = ['login', 'logout', 'death', 'kill', 'advance', 'think', 'healthchange', 'preparedeath'];
const MV_EVENTS = ['StepIn', 'StepOut', 'Equip', 'DeEquip', 'AddItem', 'RemoveItem'];
const MV_SIG = { StepIn: 'onStepIn(creature, item, position, fromPosition)', StepOut: 'onStepOut(creature, item, position, fromPosition)', Equip: 'onEquip(player, item, slot)', DeEquip: 'onDeEquip(player, item, slot)', AddItem: 'onAddItem(moveitem, tileitem, position)', RemoveItem: 'onRemoveItem(item, tile, position)' };
const CS_SIG = { login: 'onLogin(player)', logout: 'onLogout(player)', death: 'onDeath(creature, corpse, killer, mostDamageKiller, lastHitUnjustified, mostDamageUnjustified)', kill: 'onKill(creature, target)', advance: 'onAdvance(player, skill, oldLevel, newLevel)', think: 'onThink(creature, interval)', healthchange: 'onHealthChange(creature, attacker, primaryDamage, primaryType, secondaryDamage, secondaryType, origin)', preparedeath: 'onPrepareDeath(creature, killer)' };
let scState = null;
function scDefault() { return { type: 'action', name: 'Novo Script', desc: '', trigKind: 'itemid', trigVal: '12345', trigTo: '', mvEvent: 'StepIn', slot: '', words: '!comando', separator: true, staffOnly: false, csEvent: 'login', csName: 'MyEvent', geMode: 'interval', geInterval: 60000, geTime: '10:00', _lua: '', _xml: '', _aiLua: null, _aiXml: null }; }
function initScript() { if (!scState) scState = scDefault(); const s = $('scType'); if (s && !s._filled) { for (const k of Object.keys(SCRIPT_TYPES)) { const o = document.createElement('option'); o.value = k; o.textContent = SCRIPT_TYPES[k].label; s.appendChild(o); } s._filled = true; s.value = scState.type; s.onchange = () => { scState.type = s.value; scState._aiLua = null; scState._aiXml = null; renderScriptForm(); scriptGen(); }; } renderScriptForm(); scriptGen(); ensureKbBtn('scIaGen', () => scState.type); }
function scFile() { return (scState.name || 'script').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '.lua'; }
function renderScriptForm() {
  const box = $('scriptForm'); if (!box) return; box.innerHTML = ''; const s = scState;
  const row = (label, el) => { const l = document.createElement('label'); l.appendChild(document.createTextNode(label)); l.appendChild(el); box.appendChild(l); };
  const sec = (t) => { const d = document.createElement('div'); d.className = 'spSec'; d.textContent = t; box.appendChild(d); };
  const RELAY = new Set(['trigKind', 'mvEvent', 'geMode', 'csEvent', 'separator', 'staffOnly']);
  const inp = (key, type) => { const i = document.createElement('input'); if (type) i.type = type; i.value = s[key]; i.oninput = () => { s[key] = type === 'number' ? (parseInt(i.value, 10) || 0) : i.value; scriptGen(); }; return i; };
  const sel = (key, opts, labels) => { const x = document.createElement('select'); for (const o of opts) { const op = document.createElement('option'); op.value = o; op.textContent = labels ? labels[o] : o; x.appendChild(op); } x.value = s[key]; x.onchange = () => { s[key] = x.value; scriptGen(); if (RELAY.has(key)) renderScriptForm(); }; return x; };
  const chk = (label, key) => { const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'; c.checked = s[key]; c.onchange = () => { s[key] = c.checked; scriptGen(); if (RELAY.has(key)) renderScriptForm(); }; l.append(document.createTextNode(label), c); box.appendChild(l); };
  sec(SCRIPT_TYPES[s.type].label); row('nome (arquivo)', inp('name'));
  if (s.type === 'action') { row('gatilho', sel('trigKind', ['itemid', 'actionid', 'uniqueid', 'fromid/toid'])); row(s.trigKind === 'fromid/toid' ? 'fromid' : 'valor', inp('trigVal')); if (s.trigKind === 'fromid/toid') row('toid', inp('trigTo')); }
  else if (s.type === 'movement') { row('evento', sel('mvEvent', MV_EVENTS)); row('gatilho', sel('trigKind', ['itemid', 'actionid', 'uniqueid', 'fromid/toid'])); row(s.trigKind === 'fromid/toid' ? 'fromid' : 'valor', inp('trigVal')); if (s.trigKind === 'fromid/toid') row('toid', inp('trigTo')); if (s.mvEvent === 'Equip' || s.mvEvent === 'DeEquip') row('slot', inp('slot')); }
  else if (s.type === 'talkaction') { row('words (!cmd ou /cmd)', inp('words')); chk('tem parâmetro (separator)', 'separator'); chk('só staff (access)', 'staffOnly'); }
  else if (s.type === 'creaturescript') { row('evento', sel('csEvent', CS_EVENTS)); row('nome do evento', inp('csName')); }
  else if (s.type === 'globalevent') { row('modo', sel('geMode', ['interval', 'time', 'startup', 'shutdown', 'record'])); if (s.geMode === 'interval') row('intervalo (ms)', inp('geInterval', 'number')); if (s.geMode === 'time') row('horário HH:MM', inp('geTime')); }
  sec('IA'); const d = document.createElement('textarea'); d.value = s.desc; d.placeholder = 'descrição p/ a IA gerar o corpo'; d.style.cssText = 'width:100%;height:60px;font-size:11px'; d.oninput = () => { s.desc = d.value; }; box.appendChild(d);
}
function scriptGenXml() {
  const s = scState, path = scFile();
  const trig = () => s.trigKind === 'fromid/toid' ? `fromid="${s.trigVal}" toid="${s.trigTo}"` : `${s.trigKind}="${s.trigVal}"`;
  if (s.type === 'action') return `<action ${trig()} script="${path}"/>`;
  if (s.type === 'movement') { const slot = (s.mvEvent === 'Equip' || s.mvEvent === 'DeEquip') && s.slot ? ` slot="${s.slot}"` : ''; return `<movevent event="${s.mvEvent}" ${trig()}${slot} script="${path}"/>`; }
  if (s.type === 'talkaction') return `<talkaction words="${s.words}"${s.separator ? ' separator=" "' : ''} script="${path}"/>`;
  if (s.type === 'creaturescript') return `<event type="${s.csEvent}" name="${s.csName}" script="${path}"/>`;
  if (s.type === 'globalevent') { const m = s.geMode === 'interval' ? ` interval="${s.geInterval}"` : s.geMode === 'time' ? ` time="${s.geTime}"` : ` type="${s.geMode}"`; return `<globalevent name="${s.name}"${m} script="${path}"/>`; }
  return '';
}
function scriptGenSig() {
  const s = scState;
  if (s.type === 'action') return 'onUse(player, item, fromPosition, target, toPosition, isHotkey)';
  if (s.type === 'talkaction') return 'onSay(player, words, param)';
  if (s.type === 'movement') return MV_SIG[s.mvEvent];
  if (s.type === 'creaturescript') return CS_SIG[s.csEvent];
  if (s.type === 'globalevent') return s.geMode === 'interval' ? 'onThink(interval, lastExecution)' : s.geMode === 'time' ? 'onTime(interval)' : s.geMode === 'startup' ? 'onStartup()' : s.geMode === 'shutdown' ? 'onShutdown()' : 'onRecord(current, old)';
  return '';
}
function scriptGen() {
  const s = scState; const xml = s._aiXml || scriptGenXml(); let lua;
  if (s._aiLua) lua = s._aiLua;
  else {
    const sig = scriptGenSig();
    lua = `-- ${SCRIPT_TYPES[s.type].folder}/scripts/${scFile()}\n-- registre em ${SCRIPT_TYPES[s.type].folder}.xml:\n-- ${xml}\n\n`;
    if (s.type === 'creaturescript' && s.csEvent === 'login') lua += `-- onLogin deve registrar os outros eventos: player:registerEvent("Nome")\n`;
    lua += `function ${sig}\n`;
    if (s.type === 'talkaction' && s.staffOnly) lua += `\tif not player:getGroup():getAccess() then return true end\n`;
    if (s.type === 'movement' && s.mvEvent === 'StepIn') lua += `\tif not creature:isPlayer() then return true end\n`;
    lua += `\t-- TODO: ${s.desc || 'lógica aqui'}\n`;
    if (s.type === 'creaturescript' && (s.csEvent === 'healthchange')) lua += `\treturn primaryDamage, primaryType, secondaryDamage, secondaryType\nend`;
    else if (s.type === 'talkaction') lua += `\treturn false\nend`;
    else lua += `\treturn true\nend`;
  }
  if ($('scriptLua')) $('scriptLua').textContent = lua;
  if ($('scriptXml')) $('scriptXml').textContent = xml;
  s._lua = lua; s._xml = xml;
}
async function scriptGenAI() {
  const s = scState; const desc = $('scIaPrompt').value.trim() || s.desc; if (!desc) return alert('descreva o script no campo');
  const key = localStorage.getItem('ai.key.' + aiProvider) || ''; const pInfo = AI.PROVIDERS[aiProvider];
  if (!pInfo.local && !pInfo.nokey && !key) return alert('configure a IA na aba 🤖');
  const model = localStorage.getItem('ai.model.' + aiProvider) || pInfo.models[0];
  const skills = kbLoad(s.type);
  const sys = (skills ? skills + '\n\n---\n' : '') + `Com base na base de conhecimento ACIMA, gere um ${s.type} do servidor (pasta ${SCRIPT_TYPES[s.type].folder}). Responda APENAS JSON válido (sem markdown): {"name": "nome curto", "xml": "<linha de registro pro ${SCRIPT_TYPES[s.type].folder}.xml>", "lua": "<script .lua completo e funcional>"}. Use a assinatura e padrões corretos do tipo. Escreva mensagens em português.`;
  $('scIaGen').disabled = true; $('scIaGen').textContent = '… gerando'; $('status').textContent = 'IA gerando script…';
  try {
    const resp = await AI.chat(aiProvider, key, model, [{ role: 'user', content: 'Descrição: ' + desc }], { system: sys, temperature: 0.4, maxTokens: 1500 });
    const jm = resp.match(/\{[\s\S]*\}/); if (!jm) throw new Error('IA não retornou JSON'); const j = JSON.parse(jm[0]);
    if (j.name) s.name = j.name; s.desc = desc; s._aiLua = j.lua || null; s._aiXml = j.xml || null;
    renderScriptForm(); scriptGen(); $('status').textContent = '✅ script gerado pela IA: ' + s.name;
  } catch (e) { alert('erro IA: ' + e.message); $('status').textContent = 'erro IA'; }
  finally { $('scIaGen').disabled = false; $('scIaGen').textContent = '🤖 Gerar com IA'; }
}
function scriptCopy() { const t = (scState._xml || '') + '\n\n' + (scState._lua || ''); fallbackCopy(t); }
function scriptExport() { if (!scState._lua) return; ipcRenderer.invoke('save-file', scFile()).then((f) => { if (!f) return; fs.writeFileSync(f, scState._lua); $('status').textContent = `salvo: ${f} · registre: ${scState._xml}`; }); }
async function scriptBrowse() {
  const dir = await ipcRenderer.invoke('pick-dir'); if (!dir) return; const files = [];
  const walk = (d, depth) => { if (depth > 4) return; let e; try { e = fsp.readdirSync(d, { withFileTypes: true }); } catch (x) { return; } for (const en of e) { const full = path.join(d, en.name); if (en.isDirectory()) walk(full, depth + 1); else if (/\.lua$/i.test(en.name)) files.push(full); } };
  walk(dir, 0); if (!files.length) return alert('nenhum .lua encontrado');
  document.querySelectorAll('.scBrowseModal').forEach((m) => m.remove());
  const ov = document.createElement('div'); ov.className = 'modal scBrowseModal'; const b = document.createElement('div'); b.className = 'modalBox'; b.style.maxWidth = '560px'; b.innerHTML = `<h3>📂 Scripts (${files.length})</h3>`;
  const search = document.createElement('input'); search.placeholder = 'buscar…'; search.style.cssText = 'width:100%;margin-bottom:6px'; b.appendChild(search);
  const list = document.createElement('div'); list.style.cssText = 'max-height:420px;overflow:auto'; b.appendChild(list);
  const rel = (f) => f.replace(dir, '').replace(/^[\\/]/, '');
  const draw = () => { const q = search.value.toLowerCase(); list.innerHTML = ''; files.filter((f) => rel(f).toLowerCase().includes(q)).slice(0, 300).forEach((f) => { const r = document.createElement('div'); r.style.cssText = 'padding:4px 8px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--border)'; r.textContent = '📜 ' + rel(f); r.onclick = () => { try { const raw = fsp.readFileSync(f, 'utf8'); scState.name = (rel(f).split(/[\\/]/).pop() || '').replace(/\.lua$/i, ''); scState._aiLua = raw; scState._aiXml = null; renderScriptForm(); scriptGen(); ov.remove(); } catch (e) { alert('erro: ' + e.message); } }; list.appendChild(r); }); };
  search.oninput = draw; draw(); const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); b.appendChild(foot); ov.appendChild(b); document.body.appendChild(ov); setTimeout(() => search.focus(), 30);
}
// Dashboard — resumo do servidor
function showDashboard() {
  const datItems = dat ? dat.items.size : 0, datOut = dat ? dat.outfits.size : 0;
  const stats = [
    ['🐲 Monstros', monsters.length], ['🛒 NPCs', npcs.length], ['📜 Vocações', vocList().length],
    ['🗺 Spawns (monstros)', spawnStore ? spawnStore.entries.length : 0],
    ['🧩 Items (.dat)', datItems], ['👕 Outfits (.dat)', datOut],
    ['🗃 items.otb', otbMap ? otbMap.size : 0], ['📋 items.xml', (itemsXml && itemsXml.items) ? itemsXml.items.length : 0],
    ['🗺 Mapa (tiles)', mapData ? mapData.map.size : 0], ['🏠 Houses', mapData ? loadMapHouses().length : 0],
  ];
  const decoder = (Spr.wasmActive && Spr.wasmActive()) ? '⚡ Rust/wasm' : 'JS';
  const dirty = monsters.filter((m) => m._dirty).length + npcs.filter((m) => m._dirty).length + vocList().filter((v) => v._dirty || v._new).length;
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '440px';
  box.innerHTML = '<h3>📊 Dashboard do servidor</h3>';
  const g = document.createElement('div'); g.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px';
  for (const [lbl, v] of stats) { const c = document.createElement('div'); c.className = 'tpGroup'; c.style.textAlign = 'center'; c.innerHTML = `<div style="font-size:22px;font-weight:800;color:var(--accent2)">${v.toLocaleString()}</div><div class="alabel" style="font-size:11px">${lbl}</div>`; g.appendChild(c); }
  box.appendChild(g);
  const dd = document.createElement('div'); dd.className = 'alabel'; dd.style.cssText = 'margin-top:8px;text-align:center'; dd.textContent = dirty ? `⚠ ${dirty} arquivo(s) com alteração não salva` : '✅ tudo salvo'; box.appendChild(dd);
  const de = document.createElement('div'); de.className = 'alabel'; de.style.cssText = 'margin-top:4px;text-align:center;font-size:11px'; de.textContent = `decoder de sprite: ${decoder}` + ((Spr.wasmActive && Spr.wasmActive()) ? '' : ' (rode build-wasm p/ acelerar)'); box.appendChild(de);
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'Fechar'; c.onclick = () => ov.remove(); foot.appendChild(c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// auto-save (a cada 2 min, se houver dirty)
let _autoSaveTimer = null;
function setupAutoSave() {
  const cb = $('chkAutoSave'); if (!cb) return; cb.checked = localStorage.getItem('autoSave') === '1';
  const apply = () => { localStorage.setItem('autoSave', cb.checked ? '1' : '0'); if (_autoSaveTimer) { clearInterval(_autoSaveTimer); _autoSaveTimer = null; } if (cb.checked) _autoSaveTimer = setInterval(() => { const dirty = monsters.some((m) => m._dirty) || npcs.some((m) => m._dirty) || (datDirty) || (mapData && mapData._dirty); if (dirty) { try { saveAll(); $('status').textContent = '💾 auto-save ' + new Date().toLocaleTimeString(); } catch (e) {} } }, 120000); };
  cb.onchange = apply; apply();
}
// command palette (Ctrl+P) — busca e dispara qualquer ação/botão do app
function commandPalette() {
  document.querySelectorAll('.cmdPal').forEach((m) => m.remove());
  const ov = document.createElement('div'); ov.className = 'modal cmdPal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '560px';
  box.innerHTML = '<h3>⌘ Command Palette</h3>';
  const inp = document.createElement('input'); inp.placeholder = 'digite uma ação… (ex: borderize, summon, backup, health)'; inp.style.cssText = 'width:100%;margin-bottom:6px'; box.appendChild(inp);
  const list = document.createElement('div'); list.className = 'animBox'; list.style.maxHeight = '440px'; box.appendChild(list);
  const cmds = []; const seen = new Set();
  for (const b of document.querySelectorAll('button')) { if (!b.id) continue; const lbl = (b.textContent || '').trim() || b.title; if (!lbl || seen.has(b.id)) continue; seen.add(b.id); cmds.push({ label: lbl + (b.title && b.title !== lbl ? ' — ' + b.title : ''), el: b }); }
  let sel = 0;
  const draw = () => { const q = inp.value.toLowerCase(); list.innerHTML = ''; const f = cmds.filter((c) => c.label.toLowerCase().includes(q)).slice(0, 60); sel = Math.min(sel, f.length - 1); f.forEach((c, i) => { const r = document.createElement('div'); r.className = 'animRow' + (i === sel ? ' cmdSel' : ''); r.style.cssText = 'grid-template-columns:1fr;cursor:pointer;padding:4px 8px' + (i === sel ? ';background:#2f6fe0;border-radius:4px' : ''); r.textContent = c.label; r.onclick = () => { ov.remove(); c.el.click(); }; list.appendChild(r); }); list._f = f; };
  inp.oninput = () => { sel = 0; draw(); };
  inp.onkeydown = (e) => { const f = list._f || []; if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, f.length - 1); draw(); e.preventDefault(); } else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); } else if (e.key === 'Enter') { if (f[sel]) { ov.remove(); f[sel].el.click(); } } else if (e.key === 'Escape') ov.remove(); };
  draw(); ov.appendChild(box); document.body.appendChild(ov); setTimeout(() => inp.focus(), 30);
}
window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P') && !e.shiftKey) { if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return; e.preventDefault(); commandPalette(); } });
// atalhos (cheat sheet)
function showShortcuts() {
  const ov = document.createElement('div'); ov.className = 'modal'; const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '560px';
  box.innerHTML = `<h3>⌨ Atalhos</h3>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;font-size:12px">
    <div><b>Geral</b><br>Ctrl+S — salvar tudo<br>🌐 — idioma · 🌙/☀ — tema</div>
    <div><b>Mapa</b><br>A — automagic · X — girar item<br>bolinha — zoom · Ctrl+bolinha — andar<br>setas — rolar · PageUp/Down — andar<br>Ctrl+arrasta — apaga · Shift+arrasta — preenche<br>Ctrl+Z/Y — undo/redo · Del — apaga seleção<br>Esc — limpa seleção · botão-dir — menu</div>
    <div><b>Object</b><br>Ctrl+Z/Y — undo/redo<br>Ctrl/Shift+clique — multi-seleção</div>
    <div><b>Walk (mapa)</b><br>🚶 + clica põe player<br>segura seta — anda · solta — para</div>
    <div><b>Files</b><br>Ctrl+F — buscar · Ctrl+H — substituir<br>🔍 — find-in-files · botão-dir — criar/renomear/deletar</div>
    <div><b>IA</b><br>Ctrl+Enter — enviar</div>
  </div>`;
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'OK'; c.onclick = () => ov.remove(); foot.appendChild(c); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
if ($('btnShortcuts')) $('btnShortcuts').onclick = showShortcuts;
if ($('btnDashboard')) $('btnDashboard').onclick = showDashboard;
// ITEM 2 — modo tela cheia do mapa (esconde toolbar + sidebar)
function setZen(on) {
  document.body.classList.toggle('zenMap', !!on);
  if (typeof resizeMapCanvas === 'function') { try { resizeMapCanvas(); } catch (e) {} }
  if (typeof reqMap === 'function') { try { reqMap(); } catch (e) {} }
  setTimeout(() => { if (typeof resizeMapCanvas === 'function') resizeMapCanvas(); if (typeof reqMap === 'function') reqMap(); }, 60);
}
if ($('btnZen')) $('btnZen').onclick = () => setZen(!document.body.classList.contains('zenMap'));
if ($('zenExit')) $('zenExit').onclick = () => setZen(false);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('zenMap')) { setZen(false); }
  else if (e.key === 'F11') { e.preventDefault(); setZen(!document.body.classList.contains('zenMap')); }
}, true);
setupAutoSave();
// selo do decoder de sprite (Rust/wasm vs JS) — visível na barra de cima
try { const tb = document.querySelector('.tbBrand'); if (tb && !document.getElementById('decoderBadge')) { const w = (Spr.wasmActive && Spr.wasmActive()); const b = document.createElement('span'); b.id = 'decoderBadge'; b.title = 'decoder de sprite ativo'; b.style.cssText = `margin-left:8px;font-size:11px;padding:1px 6px;border-radius:8px;background:${w ? '#1d4a2a' : '#3a2a12'};color:${w ? '#5cf08a' : '#f0c060'}`; b.textContent = w ? '⚡ Rust/wasm' : 'JS'; tb.after(b); } } catch (e) {}
$('errClose').onclick = () => { $('errModal').style.display = 'none'; };
$('errClear').onclick = () => { errorLog.length = 0; const b = $('btnLogs'); b.textContent = '⚠ Logs (0)'; b.classList.remove('hasErr'); renderErrModal(); };
$('errCopy').onclick = () => {
  const txt = errorLog.map((e) => `[${e.time}] ${e.msg}\n${e.stack}`).join('\n\n---\n\n');
  clipboard.writeText(txt || '(sem erros)');
  $('status').textContent = 'Logs copiados pra área de transferência';
};

$('modeMon').onclick = () => setMode('mon');
$('modeNpc').onclick = () => setMode('npc');
$('modeVoc').onclick = () => setMode('voc');
$('modeSpawn').onclick = () => setMode('spawn');
$('modeFiles').onclick = () => setMode('files');
$('modeObj').onclick = () => setMode('obj');
// ===== Assets Editor INLINE — browser+editor de objetos (.dat/assets) reusando o engine do Object Builder =====
let aeCat = 'items', aePage = 0, aeSel = null, _aeWarming = false, _aeSearchT = null;
const AE_PER = 240;
function aeCatMap() { try { return dat ? dat.category(aeCat) : null; } catch (e) { return null; } }
function renderAssetsPanel() {
  const grid = $('aeGrid'); if (!grid) return;
  if (!dat) { grid.innerHTML = '<div class="alabel" style="padding:24px;font-size:13px">Carregue o <b>.dat/.spr</b> ou <b>Assets 12+</b> nos botões acima.</div>'; if ($('aeInfo')) $('aeInfo').textContent = ''; if ($('aePage')) $('aePage').textContent = ''; return; }
  const map = aeCatMap(); if (!map) { grid.innerHTML = ''; return; }
  const q = ($('aeSearch') && $('aeSearch').value || '').trim().toLowerCase();
  let ids = [...map.keys()];
  if (q) ids = ids.filter((id) => String(id).includes(q) || (aeCat === 'items' && (itemNameOf(id) || '').toLowerCase().includes(q)));
  ids.sort((a, b) => a - b);
  const totalPages = Math.max(1, Math.ceil(ids.length / AE_PER));
  if (aePage >= totalPages) aePage = totalPages - 1; if (aePage < 0) aePage = 0;
  const shown = ids.slice(aePage * AE_PER, (aePage + 1) * AE_PER);
  if ($('aeInfo')) $('aeInfo').textContent = `${map.size} ${aeCat}`;
  if ($('aePage')) $('aePage').textContent = `${aePage + 1}/${totalPages}`;
  // pré-aquece sprites da página (lazy) e re-renderiza 1× quando prontos
  if (spr && spr.warm && !_aeWarming) {
    const need = new Set();
    for (const id of shown) { const t = map.get(id); if (!t || !t.sprites) continue; const x = (aeCat === 'outfits' && t.px >= 4) ? 2 : 0; for (let w = 0; w < t.width; w++) for (let h = 0; h < t.height; h++) { const idx = dat.spriteIndex(t, w, h, 0, x, 0, 0, 0); if (idx >= 0 && idx < t.sprites.length) { const s = t.sprites[idx]; if (s && spr.loaded && !spr.loaded(s)) need.add(s); } } }
    if (need.size) { _aeWarming = true; spr.warm([...need]).then(() => { _aeWarming = false; if (mode === 'assets') renderAssetsPanel(); }); }
  }
  const frag = document.createDocumentFragment();
  for (const id of shown) {
    const t = map.get(id); const tile = document.createElement('div'); tile.className = 'objTile' + (aeSel === id ? ' sel' : '');
    const cv = document.createElement('canvas'); cv.width = 40; cv.height = 40; const x = (aeCat === 'outfits' && t.px >= 4) ? 2 : 0;
    try { drawScaled(cv, composeG(t, (t._primary || 0), x, 0)); } catch (e) {}
    const sp = document.createElement('span'); sp.textContent = id;
    if (aeCat === 'items') { const nm = itemNameOf(id); tile.title = nm ? `#${id} — ${nm}` : `#${id}`; }
    tile.append(cv, sp); tile.onclick = () => aeSelect(id); frag.appendChild(tile);
  }
  grid.innerHTML = ''; grid.appendChild(frag);
}
function aeSelect(id) {
  aeSel = id; const map = aeCatMap(); if (!map) return; const t = map.get(id); if (!t) return;
  if ($('aeName')) $('aeName').textContent = (aeCat === 'items' ? (itemNameOf(id) || '') + ' ' : '') + '#' + id;
  try { setAnim($('aePreview'), t, (aeCat === 'outfits' && t.px >= 4) ? 2 : 0); } catch (e) { try { drawScaled($('aePreview'), composeThing(t, 0, 0)); } catch (e2) {} }
  try { renderFlagEditor(t, $('aeFlags'), 'both'); } catch (e) {}
  for (const el of $('aeGrid').querySelectorAll('.objTile.sel')) el.classList.remove('sel');
  renderAssetsPanel();
}
window.initAssetsPanel = () => { aeBuildActions(); renderAssetsPanel(); };
if ($('modeAssets')) $('modeAssets').onclick = () => { setMode('assets'); aeBuildActions(); renderAssetsPanel(); };
if ($('aeCat')) $('aeCat').onchange = () => { aeCat = $('aeCat').value; aePage = 0; aeSel = null; renderAssetsPanel(); };
if ($('aeSearch')) $('aeSearch').oninput = () => { clearTimeout(_aeSearchT); _aeSearchT = setTimeout(() => { aePage = 0; renderAssetsPanel(); }, 160); };
if ($('aePrev')) $('aePrev').onclick = () => { aePage--; renderAssetsPanel(); };
if ($('aeNext')) $('aeNext').onclick = () => { aePage++; renderAssetsPanel(); };
if ($('aeLoadDat')) $('aeLoadDat').onclick = async () => { const df = await ipcRenderer.invoke('pick-file', ['dat']); if (!df) return; const sf = await ipcRenderer.invoke('pick-file', ['spr']); assetsMode = false; datPath = df; lsSet('datPath', df); if (sf) { sprPath = sf; lsSet('sprPath', sf); } detectDatFormat(df); loadOtbNear(df); await reloadGraphics(); renderAssetsPanel(); };
if ($('aeLoadAssets')) $('aeLoadAssets').onclick = async () => { try { await loadAssets(); } catch (e) {} renderAssetsPanel(); };
if ($('aeSaveDat')) $('aeSaveDat').onclick = () => { try { saveDat(); } catch (e) { alert('Erro ao salvar .dat: ' + e.message); } };
// CONSOLE DE SCRIPT (equivalente ao Lua scripting do Assets Editor) — edita assets em massa por código
if ($('aeScript')) $('aeScript').onclick = openAssetsScript;
function openAssetsScript() {
  if (!dat) return alert('carregue o .dat/.spr ou Assets primeiro.');
  const FLAGS = {}; for (const f of OBJ_FLAGS) FLAGS[f.n] = f.c; // nome → canon
  const ov = document.createElement('div'); ov.className = 'modal';
  const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '760px';
  box.innerHTML = `<h3>📜 Script de Assets (batch)</h3>
    <div style="font-size:11px;color:var(--muted);margin-bottom:6px;line-height:1.6">Edita os assets em massa por código. API disponível:<br>
    <code>each(cat, t=>{})</code> · <code>get(cat,id)</code> · <code>hasFlag(t,name)</code> · <code>setFlag(t,name,on)</code> · <code>FLAGS</code> · <code>name(id)</code> · <code>log(...)</code> · <code>save()</code><br>
    cats: <code>items outfits effects missiles</code> · flags: <code>${Object.keys(FLAGS).join(' ')}</code></div>`;
  const ta = document.createElement('textarea'); ta.spellcheck = false; ta.style.cssText = 'width:100%;height:240px;font-family:monospace;font-size:12px;background:#0d1120;color:#c8d4f0;border:1px solid #2a3145;border-radius:6px;padding:8px;line-height:1.5;tab-size:2';
  ta.value = lsGet('aeScriptLast') || '// exemplo: deixa todas as paredes (range) sem atravessar\n// each("items", t => { /* t = thing */ });\nlet n=0;\neach("items", t => {\n  // exemplo: liga BlockProjectile em quem já é NotWalkable\n  if (hasFlag(t, "NotWalkable") && !hasFlag(t, "BlockProjectile")) { setFlag(t, "BlockProjectile", true); n++; }\n});\nlog("alterados:", n);\n// save();  // descomente p/ salvar o .dat';
  box.appendChild(ta);
  const out = document.createElement('pre'); out.style.cssText = 'max-height:120px;overflow:auto;background:#0a0e1a;border:1px solid #1e2a3a;border-radius:6px;padding:8px;font-size:11px;color:#9fe0b0;margin-top:8px;white-space:pre-wrap';
  box.appendChild(out);
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const cancel = document.createElement('button'); cancel.className = 'miniBtn'; cancel.textContent = 'Fechar'; cancel.onclick = () => ov.remove();
  const run = document.createElement('button'); run.className = 'miniBtn accent'; run.textContent = '▶ Rodar';
  run.onclick = () => {
    lsSet('aeScriptLast', ta.value); const lines = [];
    const api = {
      each: (cat, fn) => { const m = dat.category(cat); if (!m) throw new Error('cat inválida: ' + cat); for (const [id, t] of m) fn(t, id); },
      get: (cat, id) => { const m = dat.category(cat); return m ? m.get(id) : null; },
      hasFlag: (t, name) => { const c = FLAGS[name]; return c == null ? false : !!t._attrs.find((a) => a.canon === c); },
      setFlag: (t, name, on) => { const c = FLAGS[name]; if (c == null) throw new Error('flag inválida: ' + name); const h = !!t._attrs.find((a) => a.canon === c); if (on && !h) t._attrs.push({ op: VERS.inverseRemap(c, datVersion), canon: c, data: Buffer.alloc(0) }); else if (!on && h) t._attrs = t._attrs.filter((a) => a.canon !== c); dat.applyAttrs(t); datDirty = true; },
      FLAGS, name: (id) => itemNameOf(id) || '',
      log: (...a) => lines.push(a.map((x) => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')),
      save: () => { saveDat(); lines.push('💾 .dat salvo'); },
    };
    try { (new Function('each', 'get', 'hasFlag', 'setFlag', 'FLAGS', 'name', 'log', 'save', ta.value))(api.each, api.get, api.hasFlag, api.setFlag, api.FLAGS, api.name, api.log, api.save); out.style.color = '#9fe0b0'; out.textContent = (lines.join('\n') || '✓ executado (sem log)') + '\n— lembre de save() ou 💾 Salvar .dat'; if (typeof updateDatSaveBtn === 'function') updateDatSaveBtn(); if (mode === 'assets') renderAssetsPanel(); }
    catch (e) { out.style.color = '#e0556a'; out.textContent = '✗ ' + (e && e.message || e); }
  };
  foot.append(cancel, run); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
// sincroniza a seleção do Assets com o objSel global → reusa TODAS as ferramentas do Object Builder
function aeSyncToObj() { if (!dat || aeSel == null) return false; objCat = aeCat; if (typeof objMulti !== 'undefined' && objMulti.clear) objMulti.clear(); if (typeof selectObjThing === 'function') selectObjThing(aeSel); return true; }
function aeBuildActions() {
  const host = $('aeActions'); if (!host || host._built) return; host._built = true;
  // [label, fn, refreshAfter] — reusa as funções existentes (export, sheets, obd, png, compile, otb, anim, slicer, etc.)
  const defs = [
    ['🖼 PNG', () => exportSelection('png'), false], ['📤 .obd', () => exportSelection('obd'), false],
    ['🗇 sheet↑', () => exportSheet(), false], ['📥 sheet↓', () => importSheet(), true],
    ['🎨 pixel', () => { const t = aeCatMap().get(aeSel); openPixelEditorThing(t, t._primary || 0, (aeCat === 'outfits' && t.px >= 4) ? 2 : 0, 0); }, true],
    ['⧉ Duplicar', () => $('objDup').onclick(), true], ['➕ Novo', () => $('objNew').onclick(), true],
    ['📥 Importar', () => doImport(), true], ['🗑 Remover', () => removeThing(), true],
    ['🔄 Compile As', () => compileAs(), false], ['🗃 OTB attr', () => otbEditAttr(), false],
    ['🎬 Anim', () => animEditor(), true], ['⚙ Otimizar', () => spritesOptimizer(), true],
    ['✂ Slicer', () => slicer(), true],
  ];
  for (const [label, fn, refresh] of defs) {
    const b = document.createElement('button'); b.className = 'miniBtn'; b.textContent = label; b.style.fontSize = '10px';
    b.onclick = () => { if (!aeSyncToObj()) return alert('selecione um objeto primeiro'); try { fn(); } catch (e) { alert('Ferramenta indisponível ou erro: ' + (e && e.message || e)); } if (refresh) setTimeout(() => renderAssetsPanel(), 350); };
    host.appendChild(b);
  }
}
$('modeEcon').onclick = () => setMode('econ');
$('modeMap').onclick = () => setMode('map');
$('modeAi').onclick = () => setMode('ai');
$('modeSpell').onclick = () => setMode('spell');
$('modeScript').onclick = () => setMode('script');
if ($('scIaGen')) $('scIaGen').onclick = scriptGenAI;
if ($('scCopy')) $('scCopy').onclick = scriptCopy;
if ($('scBrowse')) $('scBrowse').onclick = scriptBrowse;
if ($('scExport')) $('scExport').onclick = scriptExport;
if ($('spIaGen')) $('spIaGen').onclick = spellGenAI;
if ($('spIaGenLua')) $('spIaGenLua').onclick = spellGenAILua;
// textarea editável: sincroniza spell._lua ao digitar
if ($('spellLua')) $('spellLua').oninput = () => { if (spell) spell._lua = $('spellLua').value; };
// botão Regerar — re-executa spellGenLua() sobrescrevendo edição manual
if ($('spLuaFmt')) $('spLuaFmt').onclick = () => { if (confirm('Regerar Lua do formulário? Edições manuais serão perdidas.')) spellGenLua(); };
if ($('spServerRoot')) {
  _updateSpServerBtn();
  $('spServerRoot').onclick = async () => {
    const dir = await ipcRenderer.invoke('pick-dir'); if (!dir) return;
    spSetServerRoot(dir); _updateSpServerBtn();
    $('status').textContent = 'Servidor configurado: ' + dir + ' — IA usará essa pasta ao Gerar Lua Direto';
  };
}
if ($('spExport')) $('spExport').onclick = spellExport;
if ($('spImport')) $('spImport').onclick = spellImport;
if ($('spBrowse')) $('spBrowse').onclick = spellPickFolder; // popula a sidebar fixa
if ($('spCopy')) $('spCopy').onclick = spellCopyLua;
if ($('spLib')) $('spLib').onclick = spellLibrary;
document.querySelectorAll('.objCat').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.objCat').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    objCat = b.dataset.cat; objSel = null; objPage = 0; objMulti.clear();
    if (typeof _updateColorizerVisibility === 'function') _updateColorizerVisibility();
    renderObjGrid();
  };
});
$('objFilter').addEventListener('input', debounce(() => { objPage = 0; renderObjGrid(); }, 160));
function objTotalPages() {
  if (!dat) return 1;
  const q = $('objFilter').value.trim();
  let ids = Array.from(dat.category(objCat).keys());
  if (q) ids = ids.filter((id) => String(id).includes(q));
  return Math.max(1, Math.ceil(ids.length / OBJ_PER_PAGE));
}
$('objFirst').onclick = () => { objPage = 0; renderObjGrid(); };
$('objLast').onclick = () => { objPage = objTotalPages() - 1; renderObjGrid(); };
$('objPrev').onclick = () => { if (objPage > 0) { objPage--; renderObjGrid(); } };
$('objNext').onclick = () => { if (objPage < objTotalPages() - 1) { objPage++; renderObjGrid(); } };
$('objPageInp').addEventListener('change', () => {
  const p = (parseInt($('objPageInp').value, 10) || 1) - 1;
  objPage = Math.max(0, Math.min(objTotalPages() - 1, p));
  renderObjGrid();
});
$('objSaveSpr').onclick = saveSpr;
$('objSaveDat').onclick = saveDat;
function gotoObjThing(id) {
  const ids = Array.from(dat.category(objCat).keys()).sort((a, b) => a - b);
  objPage = Math.max(0, Math.floor(ids.indexOf(id) / OBJ_PER_PAGE));
  selectObjThing(id);
  renderObjGrid();
}
$('objNew').onclick = () => {
  if (!dat) return alert('carregue o .dat');
  const r = dat.addThing(objCat, null);
  datDirty = true; updateDatSaveBtn();
  gotoObjThing(r.id);
  $('status').textContent = `novo ${objCat.replace(/s$/, '')} #${r.id} (não salvo) — edite e 💾 Salvar .dat`;
};
$('objDup').onclick = () => {
  if (!dat) return alert('carregue o .dat');
  if (!objSel) return alert('selecione um thing pra duplicar');
  const r = dat.addThing(objCat, objSel.t);
  datDirty = true; updateDatSaveBtn();
  gotoObjThing(r.id);
  $('status').textContent = `duplicado → #${r.id} (não salvo)`;
};
$('objImport').onclick = doImport;
if ($('objDataEditor')) $('objDataEditor').onclick = openDataEditor;
if ($('objUndo')) $('objUndo').onclick = objUndoDo;
if ($('objRedo')) $('objRedo').onclick = objRedoDo;
if ($('objFindSpr')) $('objFindSpr').onclick = objFindSpriteUsages;
if ($('objBatchSpr')) $('objBatchSpr').onclick = objBatchReplaceSprite;
if ($('objOtbAttr')) $('objOtbAttr').onclick = otbEditAttr;
if ($('objSearchAttr')) $('objSearchAttr').onclick = itemsSearchByAttr;
if ($('objLoadItemsXml')) $('objLoadItemsXml').onclick = loadItemsXmlPick;
window.addEventListener('keydown', (e) => { if (mode !== 'obj') return; if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return; if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); objUndoDo(); } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); objRedoDo(); } });
$('objSelAll').onclick = () => {
  if (!dat) return;
  const q = $('objFilter').value.trim();
  let ids = Array.from(dat.category(objCat).keys());
  if (q) ids = ids.filter((id) => String(id).includes(q));
  ids.forEach((id) => objMulti.add(id)); // TODAS as páginas (não só a atual)
  renderObjGrid();
  $('status').textContent = `${objMulti.size} selecionado(s) (todas as páginas${q ? ', filtro: ' + q : ''})`;
};
$('objSelNone').onclick = () => {
  objMulti.clear(); objSel = null;
  if (_objInspectCv) { _anims.delete(_objInspectCv); _objInspectCv = null; }
  $('objInspect').innerHTML = '<div class="alabel" style="padding:12px">clique num thing →</div>';
  renderObjGrid();
};
$('objExpObd').onclick = () => exportSelection('obd');
$('objExpPng').onclick = () => exportSelection('png');
$('objCopy').onclick = copyThing;
$('objPaste').onclick = pasteNewThing;
$('objPasteProps').onclick = pasteProps;
$('objPastePat').onclick = pastePatterns;
$('objObdVer').onchange = (e) => { obdExportVer = parseInt(e.target.value, 10) || 3; };
$('objFlagFilter').onchange = () => { objPage = 0; renderObjGrid(); };
// popula o filtro de flags 1x
(function fillFlagFilter() {
  const sel = $('objFlagFilter'); if (!sel) return;
  for (const fl of OBJ_FLAGS) { const o = document.createElement('option'); o.value = fl.c; o.textContent = fl.n; sel.appendChild(o); }
})();
$('objTools').onclick = () => {
  const ov = document.createElement('div'); ov.className = 'modal';
  const box = document.createElement('div'); box.className = 'modalBox';
  box.innerHTML = '<h3>🛠 Ferramentas</h3>';
  const list = document.createElement('div'); list.className = 'toolList';
  const mk = (txt, fn) => { const b = document.createElement('button'); b.className = 'miniBtn'; b.textContent = txt; b.onclick = () => { ov.remove(); fn(); }; return b; };
  list.append(
    mk('🧹 Sprites Optimizer (vazios/duplicados)', optimizeSprites),
    mk('🗜 Compactar sprites (remove não usados + renumera)', compactSprites),
    mk('🏷 Bulk edit de flags (multi-seleção)', bulkEditFlags),
    mk('⏱ Frame Durations Optimizer (ms em massa)', frameDurOptimizer),
    mk('🔁 Bulk Replace (faixa ← outro arquivo)', bulkReplace),
    mk('⟷ Comparar 2 things (multi-seleção)', compareThings),
    mk('👁 Object Viewer (preview .obd)', objectViewer),
    mk('✂ Slicer (PNG → sprites 32×32)', slicePng),
    mk('🖼 Exportar TODOS sprites (faixa)', exportAllSprites),
    mk('🔗 Merge outro .dat/.spr', mergeDat),
    mk('🧩 Criar OTB items faltantes', createMissingOtb),
    mk('🔢 Recalcular sprite hashes (otb)', recomputeHashes),
    mk('🧩 Salvar items.otb', saveOtbFile),
    mk('💾 Salvar como / converter versão', compileAs),
    mk('📄 Novo projeto em branco', newDatSpr),
    mk('🔄 Recarregar items.xml + otb (do disco)', () => { loadItemsXmlNear(datPath); rebuildOtbInv(); if (objSel) selectObjThing(objSel.id); renderObjGrid(); $('status').textContent = 'items.xml/otb recarregados do disco'; }),
    mk('🪟 Nova janela', () => ipcRenderer.invoke('new-window')),
    mk('⚙ Preferências', openPreferences),
  );
  box.appendChild(list);
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const cl = document.createElement('button'); cl.className = 'miniBtn'; cl.textContent = 'fechar'; cl.onclick = () => ov.remove();
  foot.appendChild(cl); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
};
// atalho Ctrl+C / Ctrl+V (só com thing selecionado e fora de inputs)
window.addEventListener('keydown', (e) => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === 'c' && objSel) copyThing();
  else if (e.key === 'v' && clipThing) pasteNewThing();
});
$('btnFilesRoot').onclick = async () => { const d = await ipcRenderer.invoke('pick-dir'); if (d) { filesRoot = d; lsSet('filesRoot', d); renderTree(); renderTabs(); } };
if ($('btnFindInFiles')) $('btnFindInFiles').onclick = findInFiles;
if ($('btnRecent')) $('btnRecent').onclick = showRecent;
if ($('btnTemplate')) $('btnTemplate').onclick = showTemplates;
if ($('btnFileNew')) $('btnFileNew').onclick = () => { if (!filesRoot) return alert('abra o Servidor A primeiro'); fileNew(filesRoot, false); };
$('btnFilesRootB').onclick  = async () => { const d = await ipcRenderer.invoke('pick-dir'); if (d) { filesRoot2   = d; lsSet('filesRoot2',   d); renderTreeB();   renderTabs(); updateAiFolderStatus(); } };
$('btnCloseB').onclick      = () => { filesRoot2   = null; lsSet('filesRoot2',   ''); renderTreeB();   renderTabs(); updateAiFolderStatus(); };
if ($('btnFilesRootOtc')) $('btnFilesRootOtc').onclick = async () => { const d = await ipcRenderer.invoke('pick-dir'); if (d) { filesRootOtc = d; lsSet('filesRootOtc', d); renderTreeOtc(); renderTabs(); updateAiFolderStatus(); } };
if ($('btnCloseOtc'))     $('btnCloseOtc').onclick     = () => { filesRootOtc = null; lsSet('filesRootOtc', ''); renderTreeOtc(); renderTabs(); updateAiFolderStatus(); };
if ($('btnFilesRootC'))   $('btnFilesRootC').onclick   = async () => { const d = await ipcRenderer.invoke('pick-dir'); if (d) { filesRootC   = d; lsSet('filesRootC',   d); renderTreeC();   renderTabs(); updateAiFolderStatus(); } };
if ($('btnCloseC'))       $('btnCloseC').onclick       = () => { filesRootC   = null; lsSet('filesRootC',   ''); renderTreeC();   renderTabs(); updateAiFolderStatus(); };
$('btnCloseAllTabs').onclick = closeAllTabs;
$('filesSave').onclick = saveActiveTab;
$('btnDiff').onclick = openDiff;
$('diffClose').onclick = () => { $('diffModal').style.display = 'none'; $('diffView').innerHTML = ''; _diffMV = null; };
$('diffSave').onclick = () => {
  if (!_diffMV || !_diffTargetFile) return;
  const txt = _diffMV.editor().getValue();
  try { fsp.writeFileSync(_diffTargetFile, txt, 'latin1'); } catch (e) { return alert(e.message); }
  const tab = openTabs.find((t) => t.file === _diffTargetFile);
  if (tab) { tab.doc.setValue(txt); tab.savedGen = tab.doc.changeGeneration(); renderTabs(); }
  $('status').textContent = 'Salvo (diff): ' + _diffTargetFile;
  reloadAfterEdit(_diffTargetFile);
  $('diffModal').style.display = 'none'; $('diffView').innerHTML = ''; _diffMV = null;
};
// auditoria: filtro + ordenar colunas
$('auditFilter').addEventListener('input', debounce(renderAudit, 150));
document.querySelectorAll('#auditTable th[data-col]').forEach((th) => {
  th.style.cursor = 'pointer';
  th.onclick = () => {
    const c = th.dataset.col;
    if (auditSort.col === c) auditSort.dir *= -1; else { auditSort.col = c; auditSort.dir = 1; }
    renderAudit();
  };
});

$('btnOpenSpawn').onclick = async () => {
  try {
    const f = await ipcRenderer.invoke('pick-file');
    if (f) loadSpawnFile(f);
  } catch (e) { alert('Erro ao abrir: ' + e.message); }
};
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; } // hoisted
$('spawnFilter').addEventListener('input', debounce(renderSpawns, 150)); // debounce: não trava a digitação
if ($('spawnValidate')) $('spawnValidate').onclick = spawnValidate;
if ($('spawnBulkResp')) $('spawnBulkResp').onclick = () => { if (!spawnStore) return alert('abra um spawn.xml'); const v = parseInt(prompt('Respawn (segundos) p/ TODOS os monstros:', '60'), 10); if (!v || v < 1) return; for (const e of spawnStore.entries) e.spawntime = v; spawnStore._dirty = true; updateSaveAll(); renderSpawns(); $('status').textContent = `respawn de todos = ${v}s (não salvo)`; };
if ($('spawnRandResp')) $('spawnRandResp').onclick = () => { if (!spawnStore) return alert('abra um spawn.xml'); const p = parseInt(prompt('Variação aleatória ± (segundos) sobre o respawn atual:', '15'), 10); if (isNaN(p)) return; for (const e of spawnStore.entries) { const d = Math.floor((Math.random() * 2 - 1) * p); e.spawntime = Math.max(1, (e.spawntime || 60) + d); } spawnStore._dirty = true; updateSaveAll(); renderSpawns(); $('status').textContent = `respawns randomizados ±${p}s (não salvo)`; };
if ($('econScenario')) $('econScenario').onclick = econScenario;
if ($('econCurve')) $('econCurve').onclick = econCurve;
$('spawnAddBtn').onclick = () => {
  if (!spawnStore) return alert('abra um spawn.xml primeiro');
  const name = $('spawnAddName').value.trim();
  if (!name) return alert('digite o nome do monstro');
  const st = parseInt($('spawnAddTime').value, 10) || 60;
  // tenta colocar no mesmo bloco de um monstro existente com esse nome; senão 1º bloco
  const ref = spawnStore.entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!SP.addMonster(spawnStore, name, st, ref)) return alert('nenhum bloco <spawn> encontrado no arquivo');
  $('spawnAddName').value = '';
  updateSaveAll(); renderSpawns();
  $('status').textContent = `"${name}" adicionado ao spawn (não salvo) — 💾 Salvar`;
};
$('search').addEventListener('input', debounce(renderList, 120));
// fecha o popover de formato ao clicar fora
document.addEventListener('click', (e) => { const d = $('fmtMenu'); if (d && d.open && !d.contains(e.target)) d.removeAttribute('open'); });

// exp do mob marca dirty ao editar direto
$('mExp').addEventListener('input', () => {
  if (!current || mode !== 'mon') return;
  const v = parseInt($('mExp').value, 10);
  if (!isNaN(v)) { current.exp = v; current.tier = economy.tierName(v); markDirty(current); }
});

// salvar tudo
$('btnSaveAll').onclick = saveAll;

// criar novo (mob / npc / voc conforme o modo) — pede o nome num modal
$('btnNew').onclick = () => {
  if (mode === 'spell') { _spellSel = null; spell = spellDefault(); renderSpellForm(); spellGenLua(); renderList(); $('status').textContent = 'nova spell — preencha e Exporte .lua na pasta'; return; }
  if (mode === 'voc') {
    if (!vocStore) return alert('vocations.xml nao carregado');
    askName('Nova vocation', 'NovaVoc', (name) => {
      const id = vocList().length ? Math.max(...vocList().map((v) => v.id)) + 1 : 1;
      const v = V.newVocation(id); V.attrSet(v, 'name', name); v.name = name; v._dirty = true;
      vocStore.list.push(v); fillVocSelect(); updateSaveAll(); selectVoc(v);
    });
  } else if (mode === 'npc') {
    if (!npcDir) return alert('pasta npc nao carregada');
    askName('Novo NPC', 'NovoNPC', (name) => {
      const m = N.newNpc(npcDir, name, 130); m._dirty = true; npcs.push(m);
      npcs.sort((a, b) => a.name.localeCompare(b.name)); updateSaveAll(); selectNpc(m);
    });
  } else {
    if (!monDir) return alert('pasta monster nao carregada');
    askName('Novo mob', 'NovoMob', (name) => {
      const m = M.newMonster(monDir, name, 1); m._dirty = true; monsters.push(m);
      monsters.sort((a, b) => a.name.localeCompare(b.name)); rebuildNpcCtx(); updateSaveAll();
      if (mode !== 'mon') setMode('mon'); select(m);
    });
  }
};

// modais: nome
$('nameOk').onclick = () => { const v = $('nameInput').value.trim(); $('nameModal').style.display = 'none'; const cb = _nameCb; _nameCb = null; if (cb && v) cb(v); };
$('nameCancel').onclick = () => { $('nameModal').style.display = 'none'; _nameCb = null; };
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('nameOk').click(); else if (e.key === 'Escape') $('nameCancel').click(); });

// modal: seletor de outfit
$('lookFilter').addEventListener('input', renderLookGrid);
$('lookClose').onclick = () => { $('lookPicker').style.display = 'none'; _lookCb = null; };
$('btnPickLook').onclick = () => {
  openLookPicker((id) => {
    if (mode === 'npc' && currentNpc) { currentNpc.looktype = id; markDirty(currentNpc); selectNpc(currentNpc); }
    else if (current) {
      if (current.lookTag) M.tagSet(current.lookTag, 'type', id);
      current.looktype = id; markDirty(current); drawSprite(); renderAttrs();
    }
  });
};

// (form de vocation agora é dinâmico — wiring dentro de renderVoc)

// economia: simulador reage aos inputs
for (const id of ['simLevel', 'simMob', 'simKill', 'simHeal', 'simCost'])
  $(id).addEventListener('input', renderSim);

// economia: aplicar em massa
$('batGold').onclick = () => {
  if (!confirm(`Aplicar gold por tier a ${monsters.length} mobs? (nao salva ainda)`)) return;
  for (const m of monsters) applyGoldToMob(m);
  updateSaveAll(); renderAudit();
  $('batMsg').textContent = `gold aplicado a ${monsters.length} mobs — revise e Salvar tudo`;
};
$('batExp').onclick = () => {
  if (!confirm(`Aplicar exp sugerida (stages) a ${monsters.length} mobs?`)) return;
  for (const m of monsters) {
    const lv = tierLevel(m.tier);
    const mult = serverCfg ? cfgLib.stageMult(serverCfg, lv) : 1;
    m.exp = B.suggestExp(lv, mult); m.tier = economy.tierName(m.exp); m._dirty = true;
  }
  updateSaveAll(); renderAudit();
  $('batMsg').textContent = 'exp aplicada — revise e Salvar tudo';
};
$('batDmg').onclick = () => {
  if (!confirm(`Escalar dano (vs HP do player) de ${monsters.length} mobs?`)) return;
  const voc = refVoc(); const gh = voc ? vnum(voc, 'gainhp') : 500;
  let done = 0;
  for (const m of monsters) {
    const cur = A.maxHit(m);
    if (!cur || !m.attacks.length) continue;
    const target = B.suggestMaxHit(tierLevel(m.tier), gh);
    const f = target / cur;
    for (const a of m.attacks) for (const k of ['min', 'max']) {
      const val = M.lget(a.attrs, k);
      if (val == null) continue;
      const n = parseInt(val, 10);
      if (!isNaN(n)) a.attrs = M.lset(a.attrs, k, String(Math.round(n * f)));
    }
    m._dirty = true; done++;
  }
  updateSaveAll(); renderAudit();
  $('batMsg').textContent = `dano escalado em ${done} mobs — revise e Salvar tudo`;
};
$('btnServer').onclick = openPathsModal;
// seletor de tipo de servidor + CENTRALIZA o carregamento: move o "Formato" pra dentro do modal e esconde os botões soltos
document.querySelectorAll('#srvTypeBar .srvType').forEach((b) => b.onclick = () => applySrvType(b.dataset.srv));
(function centralizeLoad(){
  const host = $('pFmtHost'), pop = document.querySelector('#fmtMenu .fmtPop');
  if (host && pop && !host.children.length) { while (pop.firstChild) host.appendChild(pop.firstChild); }
  const fm = $('fmtMenu'); if (fm) fm.style.display = 'none';      // Formato agora vive no modal Servidor
  const ba = $('btnAssets'); if (ba) { ba.style.display = 'none'; } // Assets agora é um campo do modal Servidor
})();
$('pathsOk').onclick = applyPaths;
if ($('pathsSave')) $('pathsSave').onclick = savePaths;
if ($('pathsCancel')) $('pathsCancel').onclick = () => { $('pathsModal').style.display = 'none'; };
if ($('pathsClose')) $('pathsClose').onclick = () => { $('pathsModal').style.display = 'none'; };
// Limpar: esvazia só os campos VISÍVEIS do tipo de servidor selecionado (linhas ocultas ficam intactas)
if ($('pathsClear')) $('pathsClear').onclick = () => {
  document.querySelectorAll('#pathsModal .pathRow').forEach((row) => {
    if (getComputedStyle(row).display === 'none') return;        // linha oculta p/ esse tipo → não mexe
    row.querySelectorAll('input').forEach((inp) => { if (inp.type !== 'checkbox') inp.value = ''; });
  });
  $('status').textContent = '🧹 Campos do tipo selecionado limpos — clique Salvar p/ persistir.';
};
$('pAuto').onclick = () => {
  const root = $('pRoot').value.trim();
  if (!root || !fsp.existsSync(root)) return alert('raiz invalida');
  const r = resolveServer(root);
  // só preenche campos VISÍVEIS do tipo de servidor selecionado (linha oculta = ignora)
  const vis = (id) => { const el = $(id); const row = el && el.closest('.pathRow'); return row && getComputedStyle(row).display !== 'none'; };
  const set = (id, v) => { if (v && vis(id)) $(id).value = v; };
  set('pCfg', r.cfgFile);
  set('pMon', r.monDir);
  set('pNpc', r.npcDir);
  set('pVoc', r.vocFile);
  set('pSpells', r.spellsFile);
  if (r.datFile) { const d = path.dirname(r.datFile); set('pDat', r.datFile); set('pSpr', path.join(d, 'Tibia.spr')); set('pOtb', path.join(d, 'items.otb')); }
  lsSet('serverRoot', root);
};
// botoes de browse (data-pick=dir|file, data-tgt=id do input)
document.querySelectorAll('[data-pick]').forEach((b) => {
  b.onclick = async () => {
    const f = b.dataset.pick === 'dir' ? await ipcRenderer.invoke('pick-dir') : await ipcRenderer.invoke('pick-file');
    if (f) $(b.dataset.tgt).value = f;
  };
});

// editor de arquivo cru
$('btnEditFile').onclick = async () => {
  const f = await ipcRenderer.invoke('pick-file');
  if (f) openEditor(f, () => reloadAfterEdit(f));
};
if ($('btnMonCompare')) $('btnMonCompare').onclick = monCompare;
if ($('btnLootSim')) $('btnLootSim').onclick = lootSim;
$('btnEditRaw').onclick = () => {
  let file = null, reload = null;
  if (mode === 'voc') { file = vocStore && vocStore.file; reload = () => { vocStore = V.loadVocations(file); fillVocSelect(); renderList(); }; }
  else if (mode === 'npc') { file = currentNpc && currentNpc.file; reload = () => reloadNpcFile(file); }
  else { file = current && current.file; reload = () => reloadMobFile(file); }
  if (!file) return alert('nada selecionado');
  openEditor(file, reload);
};
$('editSave').onclick = () => {
  if (!_editFile) return;
  const content = _cm ? _cm.getValue() : $('editArea').value;
  try { fsp.writeFileSync(_editFile, content, 'latin1'); } catch (e) { return alert(e.message); }
  $('editModal').style.display = 'none';
  $('status').textContent = 'Arquivo salvo: ' + _editFile;
  if (_editReload) try { _editReload(); } catch (e) { console.error(e); }
};
$('editCancel').onclick = $('editClose').onclick = () => { $('editModal').style.display = 'none'; };
$('btnDat').onclick = async () => {
  const f = await ipcRenderer.invoke('pick-file', ['dat']);
  if (f) { assetsMode = false; datPath = f; lsSet('datPath', f); detectDatFormat(f); loadOtbNear(f); reloadGraphics(); }
};
$('btnSpr').onclick = async () => {
  const f = await ipcRenderer.invoke('pick-file', ['spr']);
  if (f) { assetsMode = false; sprPath = f; lsSet('sprPath', f); reloadGraphics(); }
};
$('btnOtb').onclick = async () => {
  const f = await ipcRenderer.invoke('pick-file', ['otb']);
  if (f) {
    try { otbMap = loadOtb(f); otbPath = f; lsSet('otbPath', f); updateStatus(); refreshIcons(); }
    catch (e) { alert('items.otb invalido: ' + e.message); }
  }
};
if ($('btnAssets')) $('btnAssets').onclick = loadAssets;

// fiação dos itens do menu estilo RME (proxies p/ funções existentes + stubs + palette/floor)
// ====================================================================
// PNG → OTBM INTEGRADO — lê PNG, mapeia cores → IDs, carimba no mapa
// ====================================================================
// MINI PALETTE PICKER — popup reutilizável p/ escolher tile/item
// ====================================================================
function openMinPalette(anchorEl, onSelect) {
  // fecha picker anterior se existir
  const old = document.getElementById('__minPalPop');
  if (old) { old.remove(); if (old._anchor === anchorEl) return; }

  const pop = document.createElement('div');
  pop.id = '__minPalPop';
  pop._anchor = anchorEl;
  pop.style.cssText = 'position:fixed;z-index:9999;background:#141826;border:1px solid #2a3145;border-radius:6px;box-shadow:0 4px 20px #0007;padding:6px;width:320px;max-height:420px;display:flex;flex-direction:column;gap:4px';

  // posição inteligente: tenta direita → esquerda → abaixo → acima, sempre dentro da janela
  const rect = anchorEl.getBoundingClientRect();
  const PW = 320, PH = 420, GAP = 6;
  const vw = window.innerWidth, vh = window.innerHeight;
  let top, left;
  // preferência: abaixo do botão
  if (rect.bottom + PH + GAP <= vh) {
    top = rect.bottom + GAP;
  } else if (rect.top - PH - GAP >= 0) {
    top = rect.top - PH - GAP;
  } else {
    top = Math.max(GAP, vh - PH - GAP);
  }
  // horizontal: tenta alinhar à esquerda do âncora, senão empurra pra direita
  if (rect.left + PW <= vw) {
    left = rect.left;
  } else {
    left = Math.max(GAP, vw - PW - GAP);
  }
  // clamp vertical
  top = Math.max(GAP, Math.min(top, vh - PH - GAP));
  pop.style.top = top + 'px'; pop.style.left = left + 'px';

  // header: tipo + busca
  const hdr = document.createElement('div'); hdr.style.cssText = 'display:flex;gap:4px;align-items:center';
  const typeSel = document.createElement('select'); typeSel.style.cssText = 'flex:0 0 auto;font-size:11px;padding:2px 4px;background:#0d1120;color:#ccc;border:1px solid #2a3145;border-radius:3px';
  [['terrain','🌿 Terreno'],['raw','🔢 ID direto'],['doodad','🌲 Doodad'],['wall','🧱 Parede'],['carpet','🪞 Carpet'],['table','🪑 Mesa']].forEach(([v,l]) => { const o = document.createElement('option'); o.value=v; o.textContent=l; typeSel.appendChild(o); });
  const search = document.createElement('input'); search.placeholder = 'Buscar…'; search.style.cssText = 'flex:1;font-size:11px;padding:2px 4px;background:#0d1120;color:#ccc;border:1px solid #2a3145;border-radius:3px';
  const rawIdInp = document.createElement('input'); rawIdInp.type='number'; rawIdInp.min='1'; rawIdInp.placeholder='ID'; rawIdInp.style.cssText='width:60px;font-size:11px;padding:2px 4px;background:#0d1120;color:#ccc;border:1px solid #2a3145;border-radius:3px;display:none';
  const rawOkBtn = document.createElement('button'); rawOkBtn.textContent='OK'; rawOkBtn.className='miniBtn'; rawOkBtn.style.display='none';
  hdr.append(typeSel, search, rawIdInp, rawOkBtn); pop.appendChild(hdr);

  // grid de ícones
  const grid = document.createElement('div'); grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,32px);gap:2px;overflow-y:auto;flex:1;padding:2px';
  pop.appendChild(grid);

  function sprForId(sid) {
    if (!dat || !sid) return null;
    const cid = (otbMap && otbMap.get(sid)) || sid;
    const t = dat.item(cid); if (!t) return null;
    const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32;
    try { drawScaled(cv, composeThing(t, 0, 0)); } catch(e) { return null; }
    return cv;
  }

  function renderGrid(items) {
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    items.slice(0, 200).forEach(({ id, name, lookid }) => {
      const cell = document.createElement('div');
      cell.title = (name || '') + (id ? ' #'+id : '');
      cell.style.cssText = 'width:32px;height:32px;cursor:pointer;background:#0d1120;border:1px solid #1e2a3a;border-radius:3px;overflow:hidden;display:flex;align-items:center;justify-content:center';
      const spr = sprForId(lookid || id);
      if (spr) { cell.appendChild(spr); }
      else { cell.style.fontSize='9px'; cell.style.color='#888'; cell.textContent=id||'?'; }
      cell.onmouseenter = () => cell.style.borderColor = '#4a8fff';
      cell.onmouseleave = () => cell.style.borderColor = '#1e2a3a';
      cell.onclick = () => { pop.remove(); onSelect({ id: id || lookid, lookid: lookid || id, name: name || '' }); };
      frag.appendChild(cell);
    });
    grid.appendChild(frag);
  }

  function buildItems(type, q) {
    const D = mapBrushData;
    if (!D) return [];
    const lq = q.toLowerCase();
    const match = (n) => !lq || (n || '').toLowerCase().includes(lq);
    const items = [];
    if (type === 'terrain') {
      D.byName && D.byName.forEach((b, name) => { if (match(name)) items.push({ id: (b.items && b.items[0]) || b.lookid, lookid: b.lookid, name }); });
    } else if (type === 'doodad') {
      D.doodadByName && D.doodadByName.forEach((b, name) => { if (match(name)) items.push({ id: b.lookid, lookid: b.lookid, name }); });
    } else if (type === 'wall') {
      D.wallByName && D.wallByName.forEach((b, name) => { const id = (b.walls && (b.walls.pole || b.walls.horizontal || [])[0]) || b.lookid; if (match(name)) items.push({ id, lookid: b.lookid, name }); });
    } else if (type === 'carpet') {
      D.carpetByName && D.carpetByName.forEach((b, name) => { if (match(name)) items.push({ id: b.lookid, lookid: b.lookid, name }); });
    } else if (type === 'table') {
      D.tableByName && D.tableByName.forEach((b, name) => { if (match(name)) items.push({ id: b.lookid, lookid: b.lookid, name }); });
    }
    return items;
  }

  function refresh() {
    const type = typeSel.value;
    const isRaw = type === 'raw';
    rawIdInp.style.display = isRaw ? '' : 'none';
    rawOkBtn.style.display = isRaw ? '' : 'none';
    search.style.display = isRaw ? 'none' : '';
    if (isRaw) { grid.innerHTML = '<div style="color:#888;font-size:11px;padding:8px">Digite o ID do servidor acima</div>'; return; }
    if (!mapBrushData) { grid.innerHTML = '<div style="color:#888;font-size:11px;padding:8px">Carregue materiais RME primeiro</div>'; return; }
    renderGrid(buildItems(type, search.value));
  }

  typeSel.onchange = refresh;
  search.oninput = refresh;
  rawOkBtn.onclick = () => { const id = parseInt(rawIdInp.value, 10); if (id > 0) { pop.remove(); onSelect({ id, lookid: id, name: 'ID '+id }); } };

  document.body.appendChild(pop);
  refresh();

  // fecha ao clicar fora
  setTimeout(() => {
    const close = (e) => { if (!pop.contains(e.target) && e.target !== anchorEl) { pop.remove(); document.removeEventListener('mousedown', close); } };
    document.addEventListener('mousedown', close);
  }, 10);
}

// helper: cria botão picker com ícone de sprite
function _mkPickerBtn(labelText, savedId, onChange) {
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;align-items:center;gap:4px;flex:1';
  const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32; cv.style.cssText = 'border:1px solid #2a3145;border-radius:3px;background:#0d1120;flex-shrink:0';
  const lbl = document.createElement('span'); lbl.style.cssText = 'font-size:11px;color:#ccc;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; lbl.textContent = savedId ? '#'+savedId : '— escolher —';
  const btn = document.createElement('button'); btn.className = 'miniBtn'; btn.textContent = '📦'; btn.title = 'Selecionar da paleta';
  let currentId = savedId || 0;
  function setItem(item) {
    currentId = item.id || item.lookid || 0;
    lbl.textContent = (item.name || '') + ' #' + currentId;
    cv.getContext('2d').clearRect(0, 0, 32, 32);
    if (dat && currentId) {
      const cid = (otbMap && otbMap.get(currentId)) || currentId;
      const t = dat.item(cid); if (t) try { drawScaled(cv, composeThing(t, 0, 0)); } catch(e) {}
    }
    onChange(currentId, item);
  }
  if (savedId) setItem({ id: savedId, lookid: savedId, name: '' });
  btn.onclick = () => openMinPalette(btn, (item) => setItem(item));
  wrap.append(cv, lbl, btn);
  wrap._getId = () => currentId;
  return wrap;
}

// ====================================================================
function openPngToOtbm() {
  if (!mapData) return alert('Carregue um mapa (.otbm) primeiro.');
  const ov = document.createElement('div'); ov.className = 'modal';
  const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '860px';
  box.innerHTML = `<h3>🖼 PNG → Mapa</h3>
<div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">
  <div style="flex:0 0 auto;display:flex;flex-direction:column;gap:6px">
    <div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:3px">PNG original</div>
      <canvas id="pngPrev" width="240" height="240" style="border:1px solid #2a3145;background:#0d1120;image-rendering:pixelated;display:block"></canvas>
    </div>
    <div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
        <span style="font-size:11px;color:var(--muted)">Preview resultado</span>
        <button id="pngResFit" class="miniBtn" style="font-size:10px;padding:1px 5px" title="Ajustar à tela">⊞ Fit</button>
        <span style="font-size:10px;color:#555">Scroll=zoom · Drag=pan · Click=remap</span>
      </div>
      <canvas id="pngResPrev" width="380" height="340" style="border:1px solid #2a3145;background:#0d1120;image-rendering:pixelated;display:block;cursor:crosshair"></canvas>
    </div>
    <div style="font-size:11px;color:var(--muted)" id="pngInfo">nenhum PNG carregado</div>
  </div>
  <div style="flex:1;min-width:220px">
    <label class="opRow"><span>PNG</span><button id="pngPickFile" class="miniBtn">📂 Escolher PNG</button></label>
    <label class="opRow"><span>X inicial</span><input type="number" id="pngOX" value="${Math.round(mapOX)}" style="width:80px"></label>
    <label class="opRow"><span>Y inicial</span><input type="number" id="pngOY" value="${Math.round(mapOY)}" style="width:80px"></label>
    <label class="opRow"><span>Andar (Z)</span><input type="number" id="pngOZ" min="0" max="15" value="${mapZ}" style="width:60px"></label>
    <div style="margin-top:6px;padding:6px;background:#0a0e1a;border:1px solid #1e2a3a;border-radius:4px;font-size:11px">
      <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 6px;align-items:center">
        <span title="cada N×N pixels vira 1 tile (cor majoritária) — reduz mapas gigantes">Escala px→tile</span><input type="number" id="pngScale" value="1" min="1" max="16" style="width:50px">
        <span title="reduz a paleta p/ no máx N cores via median-cut (0=todas)">Máx cores</span><input type="number" id="pngMaxColors" value="0" min="0" max="256" style="width:50px">
      </div>
      <label style="display:block;margin-top:5px" title="pixels sem ID herdam o ID da cor mapeada mais próxima (bom p/ antialias)"><input type="checkbox" id="pngNearest" checked> Cor mais próxima p/ não mapeados</label>
      <label style="display:block;margin-top:2px" title="aplica bordas/transições automáticas RME após importar"><input type="checkbox" id="pngBorderize"> Bordas auto (RME) após importar</label>
      <label style="display:block;margin-top:2px" title="brilho do pixel define o andar (claro=topo, escuro=fundo)"><input type="checkbox" id="pngHeight"> Heightmap → andares</label>
      <div id="pngHeightOpts" style="display:none;margin-top:3px"><span title="quantos andares de altura a partir do Z">Níveis</span> <input type="number" id="pngHeightLv" value="4" min="2" max="15" style="width:44px"></div>
      <button id="pngReprocess" class="miniBtn" style="margin-top:5px;width:100%;font-size:10px">🔄 Reprocessar PNG</button>
    </div>
    <div style="margin-top:8px;padding:6px;background:#0a0e1a;border:1px solid #1e2a3a;border-radius:4px">
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Pixel transparente</div>
      <div id="pngTransRow" style="display:flex;align-items:center;gap:4px"></div>
    </div>
    <div style="margin-top:8px;display:flex;gap:4px;align-items:center">
      <b style="font-size:12px">Mapeamento de cores</b>
      <button id="pngBatchPick" class="miniBtn" title="Atribuir um tile a todas as cores sem ID">🎨 Atribuir tudo a…</button>
      <button id="pngClearAll" class="miniBtn" title="Limpar todos os mapeamentos">🗑</button>
    </div>
    <div id="pngColorList" style="max-height:320px;overflow:auto;margin-top:4px;display:flex;flex-direction:column;gap:3px"></div>
  </div>
</div>`;

  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const applyBtn = document.createElement('button'); applyBtn.className = 'miniBtn accent'; applyBtn.textContent = '✅ Aplicar no mapa';
  const cancelBtn = document.createElement('button'); cancelBtn.className = 'miniBtn'; cancelBtn.textContent = 'Cancelar'; cancelBtn.onclick = () => ov.remove();
  foot.append(cancelBtn, applyBtn); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);

  // --- estrutura compacta: paleta de cores + índice por pixel (2B/px vs 4B/px) ---
  // pngPalette: Array<{hex, cnt, id, lookid}> ordenado por frequência
  // pngPixelIdx: Uint16Array(W*H) — índice em pngPalette; 0xFFFF = transparente
  let pngPalette = null, pngPixelIdx = null, pngW = 0, pngH = 0, pngRaw = null;
  let pngFinish = null, pngFinishDirty = true; // overlay de bordas RME no preview (computado sob demanda)

  // picker para pixel transparente
  const transRow = document.getElementById('pngTransRow');
  const transPicker = _mkPickerBtn('Tile para transparente', 0, (id) => { transRow._id = id; drawResultPreview(); });
  transRow._id = 0; transRow.appendChild(transPicker);

  // ---- pincel do resultado PNG ----
  let resBrushItem = null;
  {
    const bbar = document.createElement('div');
    bbar.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;background:#0a0e1a;border:1px solid #1e2a3a;border-radius:4px;font-size:11px;margin-top:4px';
    bbar.innerHTML = '<span style="color:var(--muted);min-width:42px">Pincel:</span>';
    const rbp = _mkPickerBtn('— nenhum (pan) —', 0, (id, item) => {
      resBrushItem = id ? { id, lookid: item.lookid||id, name: item.name||'' } : null;
      document.getElementById('pngResPrev').style.cursor = resBrushItem ? 'crosshair' : 'grab';
    });
    rbp.style.flex = '1';
    const clrBtn = document.createElement('button'); clrBtn.className = 'miniBtn'; clrBtn.textContent = '✋ Pan';
    clrBtn.onclick = () => {
      resBrushItem = null;
      const sp = rbp.querySelector('span'); if (sp) sp.textContent = '— nenhum (pan) —';
      const cv2 = rbp.querySelector('canvas'); if (cv2) cv2.getContext('2d').clearRect(0,0,32,32);
      document.getElementById('pngResPrev').style.cursor = 'grab';
    };
    bbar.appendChild(rbp); bbar.appendChild(clrBtn);
    // insere antes do canvas de resultado
    const rcv = document.getElementById('pngResPrev');
    rcv.parentNode.insertBefore(bbar, rcv);
  }

  // cache de sprites (32×32 canvas por server-id)
  const _pngSprCache = new Map();
  function getSpr(id) {
    if (_pngSprCache.has(id)) return _pngSprCache.get(id);
    let spr = null;
    if (dat && id > 0) {
      const cid = (otbMap && otbMap.get(id)) || id;
      const t = dat.item(cid);
      if (t) { const c = document.createElement('canvas'); c.width = 32; c.height = 32; try { drawScaled(c, composeThing(t, 0, 0)); spr = c; } catch(e) {} }
    }
    _pngSprCache.set(id, spr); return spr;
  }

  // viewport estado para pngResPrev
  let resVpX = 0, resVpY = 0, resVpZoom = 1;
  const RES_TILE = 8; // px por pixel do PNG na zoom=1

  function fitResView() {
    const cv = document.getElementById('pngResPrev'); if (!cv || !pngW) return;
    const scale = Math.min(cv.width / pngW / RES_TILE, cv.height / pngH / RES_TILE, 4);
    resVpZoom = scale;
    resVpX = Math.round((cv.width  - pngW * RES_TILE * scale) / 2);
    resVpY = Math.round((cv.height - pngH * RES_TILE * scale) / 2);
  }

  // roda borderize num mapData temporário a partir do mapeamento atual → bordas no LUGAR CERTO no preview
  function computePngFinish() {
    if (!mapBrushData || !pngPixelIdx || pngW*pngH > 40000) return null; // grande demais p/ preview ao vivo
    const chk=id=>{ const e=document.getElementById(id); return e?e.checked:false; };
    const nearest=chk('pngNearest');
    const palRgb=pngPalette.map(p=>[parseInt(p.hex.substr(1,2),16),parseInt(p.hex.substr(3,2),16),parseInt(p.hex.substr(5,2),16)]);
    const palIds=new Int32Array(pngPalette.length); pngPalette.forEach((p,i)=>{palIds[i]=p.id||0;});
    if(nearest){ const mapped=[]; pngPalette.forEach((p,i)=>{if(palIds[i])mapped.push(i);}); if(mapped.length) for(let i=0;i<palIds.length;i++){ if(palIds[i])continue; let bj=-1,bd=1e9; for(const j of mapped){const dr=palRgb[i][0]-palRgb[j][0],dg=palRgb[i][1]-palRgb[j][1],db=palRgb[i][2]-palRgb[j][2];const d=dr*dr+dg*dg+db*db;if(d<bd){bd=d;bj=j;}} if(bj>=0)palIds[i]=palIds[bj]; } }
    const transId=transRow._id||0;
    const tmpMd={type:2,props:Buffer.alloc(0),children:[]};
    const tmp={map:new Map(),areaIndex:new Map(),mapDataNode:tmpMd,zmin:99,zmax:0,_dirty:false};
    let any=false;
    for(let y=0;y<pngH;y++)for(let x=0;x<pngW;x++){ const pi=pngPixelIdx[y*pngW+x]; let id=(pi===0xFFFF||pi===0xFFFE)?transId:(palIds[pi]||0); if(id){ OTBM.setGround(tmp,x,y,0,id); if(mapBrushData.groundToBrush.get(id))any=true; } }
    if(!any) return null;
    for(let y=-1;y<=pngH;y++)for(let x=-1;x<=pngW;x++){ if(x>=0&&x<pngW&&y>=0&&y<pngH)continue; OTBM.ensureTile(tmp,x,y,0); }
    for(let y=0;y<pngH;y++)for(let x=0;x<pngW;x++) RB.borderize(mapBrushData,tmp,x,y,0);
    const out=new Map();
    for(const[key,tn]of tmp.map){ const p=key.split(','); const gx=+p[0],gy=+p[1]; if(gx<0||gy<0||gx>=pngW||gy>=pngH)continue; const g=OTBM.getGround(tn); const items=OTBM.itemsOf(tn).map(OTBM.itemId).filter(id=>id&&id!==g); if(items.length)out.set(gx+','+gy,items); }
    return out;
  }

  let _prevReqId = null;
  let _pngBuf = null;
  function drawResultPreview() {
    if (!pngPixelIdx) return;
    if (_prevReqId) { cancelAnimationFrame(_prevReqId); _prevReqId = null; }
    _prevReqId = requestAnimationFrame(() => {
      _prevReqId = null;
      const cv = document.getElementById('pngResPrev'); if (!cv) return;
      if (!_pngBuf || _pngBuf.width !== cv.width || _pngBuf.height !== cv.height) { _pngBuf = document.createElement('canvas'); _pngBuf.width = cv.width; _pngBuf.height = cv.height; }
      const ctx = _pngBuf.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height); // offscreen → blita no fim (sem piscar)
      const cellPx = RES_TILE * resVpZoom;
      const transId = transRow._id || 0;
      const useSpr = cellPx >= 16;
      const be=document.getElementById('pngBorderize'); const showBorder = useSpr && be && be.checked;
      if (showBorder && pngFinishDirty) { pngFinish = computePngFinish(); pngFinishDirty = false; }
      // culling: só pixels visíveis
      const minPX = Math.max(0, Math.floor(-resVpX / cellPx));
      const minPY = Math.max(0, Math.floor(-resVpY / cellPx));
      const maxPX = Math.min(pngW - 1, Math.ceil((cv.width  - resVpX) / cellPx));
      const maxPY = Math.min(pngH - 1, Math.ceil((cv.height - resVpY) / cellPx));
      for (let py = minPY; py <= maxPY; py++) for (let px = minPX; px <= maxPX; px++) {
        const palIdx = pngPixelIdx[py * pngW + px];
        let id = 0;
        if (palIdx === 0xFFFF) { id = transId; }
        else if (pngPalette[palIdx]) { id = pngPalette[palIdx].id || 0; }
        const sx = resVpX + px * cellPx, sy = resVpY + py * cellPx;
        if (!id) {
          // sem id: mostra cor original
          const col = pngPalette[palIdx] ? pngPalette[palIdx].hex : '#333';
          ctx.fillStyle = col; ctx.fillRect(sx, sy, cellPx, cellPx);
          continue;
        }
        if (useSpr) { const s = getSpr(id); if (s) ctx.drawImage(s, sx, sy, cellPx, cellPx); else { ctx.fillStyle = '#4a6a4a'; ctx.fillRect(sx, sy, cellPx, cellPx); } }
        else { ctx.fillStyle = '#4a6a4a'; ctx.fillRect(sx, sy, cellPx, cellPx); }
        // overlay de bordas RME (acabamento no lugar certo)
        if (showBorder && pngFinish) { const bs=pngFinish.get(px+','+py); if(bs) for(const bid of bs){ const s2=getSpr(bid); if(s2) ctx.drawImage(s2,sx,sy,cellPx,cellPx); } }
      }
      cv.getContext('2d').drawImage(_pngBuf, 0, 0); // blit único → sem piscar
    });
  }

  function buildColorList() {
    const list = document.getElementById('pngColorList'); list.innerHTML = '';
    // mostra top 128 cores (evita DOM gigante p/ imagens com muitas cores únicas)
    const shown = pngPalette.slice(0, 128);
    const frag = document.createDocumentFragment();
    for (const pal of shown) {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:4px 6px;background:#141826;border:1px solid #2a3145;border-radius:4px';
      const swatch = document.createElement('span'); swatch.dataset.hex = pal.hex; swatch.style.cssText = `display:inline-block;width:22px;height:22px;background:${pal.hex};border:1px solid #444;border-radius:3px;flex-shrink:0`;
      const meta = document.createElement('span'); meta.style.cssText = 'font-size:10px;color:var(--muted);flex-shrink:0;min-width:80px'; meta.textContent = `${pal.hex} · ${pal.cnt}px`;
      const picker = _mkPickerBtn('', pal.id, (id, item) => {
        pal.id = id; pal.lookid = item.lookid || id;
        localStorage.setItem('pngOtbmMap.' + pal.hex, id);
        pngFinishDirty = true; drawResultPreview();
      });
      picker.style.flex = '1';
      row.append(swatch, meta, picker); frag.appendChild(row);
    }
    list.appendChild(frag);
    if (pngPalette.length > 128) {
      const more = document.createElement('div'); more.style.cssText = 'font-size:10px;color:var(--muted);padding:4px 6px';
      more.textContent = `+${pngPalette.length - 128} cores adicionais serão mapeadas com "Atribuir tudo a…"`;
      list.appendChild(more);
    }
  }

  document.getElementById('pngPickFile').onclick = async () => {
    const file = await ipcRenderer.invoke('pick-file', ['png', 'jpg', 'jpeg', 'bmp']);
    if (!file) return;
    const infoEl = document.getElementById('pngInfo'); infoEl.textContent = 'carregando…';
    try {
      const img = await loadPngImage(file);
      if (!img) { infoEl.textContent = 'erro ao carregar PNG'; return; }
      const W = img.width, H = img.height;

      // 1. desenha preview original
      const prevCv = document.getElementById('pngPrev');
      const sc = Math.min(240 / W, 240 / H);
      prevCv.width = Math.ceil(W * sc); prevCv.height = Math.ceil(H * sc);
      prevCv.getContext('2d').drawImage(img, 0, 0, prevCv.width, prevCv.height);

      // 2. extrai pixel data e GUARDA o raw (permite reprocessar com escala/quantização sem re-abrir)
      const tmpCv = document.createElement('canvas'); tmpCv.width = W; tmpCv.height = H;
      const tmpCtx = tmpCv.getContext('2d'); tmpCtx.drawImage(img, 0, 0);
      const raw = tmpCtx.getImageData(0, 0, W, H).data;
      if (img.src && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
      pngRaw = { data: raw, W, H };
      processPng(); // 3. monta paleta+índice (aplica downscale/quantização atuais)
    } catch (e) { document.getElementById('pngInfo').textContent = 'erro: ' + e.message; console.error(e); }
  };

  const _hx = (n) => (n >> 4).toString(16) + (n & 15).toString(16);
  // reduz a paleta p/ maxC cores via median-cut (ponderado por frequência) e remapeia o índice
  function quantizePalette(palette, pixelIdx, maxC, hexToIdx) {
    palette.forEach(p => { p.rgb = [parseInt(p.hex.substr(1,2),16), parseInt(p.hex.substr(3,2),16), parseInt(p.hex.substr(5,2),16)]; });
    let buckets = [palette.slice()];
    while (buckets.length < maxC) {
      let bi=-1, brange=-1, bch=0;
      buckets.forEach((b,k)=>{ if(b.length<2)return; for(let ch=0;ch<3;ch++){ let mn=255,mx=0; for(const p of b){const v=p.rgb[ch];if(v<mn)mn=v;if(v>mx)mx=v;} const r=mx-mn; if(r>brange){brange=r;bi=k;bch=ch;} } });
      if (bi<0) break;
      const b=buckets[bi]; b.sort((a,c)=>a.rgb[bch]-c.rgb[bch]); const mid=b.length>>1;
      buckets.splice(bi,1,b.slice(0,mid),b.slice(mid));
    }
    const old2new = new Int32Array(palette.length); const newPal=[];
    buckets.forEach(b=>{ if(!b.length)return; let r=0,g=0,bl=0,c=0; for(const p of b){r+=p.rgb[0]*p.cnt;g+=p.rgb[1]*p.cnt;bl+=p.rgb[2]*p.cnt;c+=p.cnt;} c=c||1;
      const rr=Math.round(r/c),gg=Math.round(g/c),bb=Math.round(bl/c); const hex='#'+_hx(rr)+_hx(gg)+_hx(bb); const ni=newPal.length;
      let id=0; for(const p of b){ if(p.id){id=p.id;break;} } if(!id)id=+(localStorage.getItem('pngOtbmMap.'+hex)||0);
      newPal.push({hex,cnt:c,id,lookid:id}); for(const p of b) old2new[hexToIdx.get(p.hex)]=ni; });
    for(let i=0;i<pixelIdx.length;i++){ const v=pixelIdx[i]; if(v!==0xFFFF&&v!==0xFFFE)pixelIdx[i]=old2new[v]; }
    palette.length=0; for(const p of newPal)palette.push(p);
  }

  // (re)processa o raw em paleta+índice aplicando escala (px→tile) e quantização atuais
  function processPng() {
    if (!pngRaw) return;
    const raw = pngRaw.data, RW = pngRaw.W, RH = pngRaw.H;
    const ds = Math.max(1, Math.min(16, parseInt(document.getElementById('pngScale').value,10) || 1));
    const W = Math.max(1, Math.ceil(RW/ds)), H = Math.max(1, Math.ceil(RH/ds));
    const hexToIdx = new Map(); const palette = []; const pixelIdx = new Uint16Array(W*H);
    for (let oy=0; oy<H; oy++) for (let ox=0; ox<W; ox++) {
      const pi = oy*W+ox;
      if (ds===1) {
        const i=(oy*RW+ox)*4; if(raw[i+3]<128){pixelIdx[pi]=0xFFFF;continue;}
        const hex='#'+_hx(raw[i])+_hx(raw[i+1])+_hx(raw[i+2]);
        let idx=hexToIdx.get(hex); if(idx===undefined){idx=palette.length;const s=+(localStorage.getItem('pngOtbmMap.'+hex)||0);palette.push({hex,cnt:0,id:s,lookid:s});hexToIdx.set(hex,idx);}
        palette[idx].cnt++; pixelIdx[pi]=idx<0xFFFE?idx:0xFFFE;
      } else {
        // bloco ds×ds → cor majoritária (ignora transparentes)
        const cnt=new Map(); let opaque=0;
        for(let by=0;by<ds;by++)for(let bx=0;bx<ds;bx++){ const sx=ox*ds+bx,sy=oy*ds+by; if(sx>=RW||sy>=RH)continue; const i=(sy*RW+sx)*4; if(raw[i+3]<128)continue; opaque++; const h='#'+_hx(raw[i])+_hx(raw[i+1])+_hx(raw[i+2]); cnt.set(h,(cnt.get(h)||0)+1); }
        if(!opaque){pixelIdx[pi]=0xFFFF;continue;}
        let best=null,bc=-1; for(const[h,c]of cnt)if(c>bc){bc=c;best=h;}
        let idx=hexToIdx.get(best); if(idx===undefined){idx=palette.length;const s=+(localStorage.getItem('pngOtbmMap.'+best)||0);palette.push({hex:best,cnt:0,id:s,lookid:s});hexToIdx.set(best,idx);}
        palette[idx].cnt++; pixelIdx[pi]=idx<0xFFFE?idx:0xFFFE;
      }
    }
    const maxC = parseInt(document.getElementById('pngMaxColors').value,10) || 0;
    if (maxC>0 && palette.length>maxC) { quantizePalette(palette, pixelIdx, maxC, hexToIdx); }
    else { palette.sort((a,b)=>b.cnt-a.cnt); const o2n=new Uint16Array(palette.length); palette.forEach((p,n)=>{o2n[hexToIdx.get(p.hex)]=n;}); for(let i=0;i<pixelIdx.length;i++){const v=pixelIdx[i];if(v!==0xFFFF&&v!==0xFFFE)pixelIdx[i]=o2n[v];} }
    pngW=W; pngH=H; pngPalette=palette; pngPixelIdx=pixelIdx; pngFinishDirty=true;
    document.getElementById('pngInfo').textContent = `${RW}×${RH}px → ${W}×${H} tiles${ds>1?` (÷${ds})`:''} · ${palette.length} cores`;
    fitResView(); buildColorList(); drawResultPreview();
  }

  document.getElementById('pngBatchPick').onclick = () => {
    openMinPalette(document.getElementById('pngBatchPick'), (item) => {
      // atualiza só entradas sem id — sem rebuild DOM
      pngPalette && pngPalette.forEach((pal) => {
        if (!pal.id) { pal.id = item.id; pal.lookid = item.lookid || item.id; localStorage.setItem('pngOtbmMap.' + pal.hex, item.id); }
      });
      // atualiza visualmente as rows sem id
      document.querySelectorAll('#pngColorList > div').forEach((row) => {
        const lbl = row.querySelector('div > span');
        if (lbl && lbl.textContent.includes('— escolher —')) {
          lbl.textContent = (item.name || '') + ' #' + item.id;
          const cv2 = row.querySelector('div > canvas');
          if (cv2 && dat) { const cid=(otbMap&&otbMap.get(item.id))||item.id; const t=dat.item(cid); if(t) try{drawScaled(cv2,composeThing(t,0,0));}catch(e){} }
        }
      });
      pngFinishDirty = true; drawResultPreview();
    });
  };

  document.getElementById('pngClearAll').onclick = () => {
    if (!confirm('Limpar todos os mapeamentos?')) return;
    pngPalette && pngPalette.forEach((pal) => { pal.id = 0; pal.lookid = 0; localStorage.removeItem('pngOtbmMap.' + pal.hex); });
    document.querySelectorAll('#pngColorList > div').forEach((row) => {
      const lbl = row.querySelector('div > span'); if (lbl) lbl.textContent = '— escolher —';
      const cv2 = row.querySelector('div > canvas'); if (cv2) cv2.getContext('2d').clearRect(0,0,32,32);
    });
    pngFinishDirty = true; drawResultPreview();
  };

  // ---- viewport pan/zoom no preview resultado ----
  {
    const rcv = document.getElementById('pngResPrev');
    document.getElementById('pngResFit').onclick = () => { fitResView(); drawResultPreview(); };
    rcv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = rcv.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.2 : 1/1.2;
      resVpX = mx - (mx - resVpX) * factor;
      resVpY = my - (my - resVpY) * factor;
      resVpZoom *= factor;
      drawResultPreview();
    }, { passive: false });
  function resPalClick(px, py, item) {
    if (px < 0 || py < 0 || px >= pngW || py >= pngH) return;
    const palIdx = pngPixelIdx[py * pngW + px]; if (palIdx === 0xFFFF) return;
    const pal = pngPalette[palIdx]; if (!pal) return;
    _pngSprCache.delete(pal.id);
    pal.id = item.id; pal.lookid = item.lookid || item.id;
    localStorage.setItem('pngOtbmMap.' + pal.hex, item.id);
    const rows = document.querySelectorAll('#pngColorList > div');
    rows.forEach((row) => {
      const sw = row.querySelector('span[data-hex]');
      if (sw && sw.dataset.hex === pal.hex) {
        const lbl = row.querySelector('div > span'); if(lbl) lbl.textContent = (item.name||'')+' #'+item.id;
        const cv2 = row.querySelector('div > canvas'); if(cv2&&dat){const cid=(otbMap&&otbMap.get(item.id))||item.id;const t=dat.item(cid);if(t)try{drawScaled(cv2,composeThing(t,0,0));}catch(e){}}
      }
    });
    pngFinishDirty = true; drawResultPreview();
  }

    let resDragging = false, resDragX = 0, resDragY = 0, resDragMoved = false, resPainting = false;
    rcv.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (resBrushItem && !e.shiftKey) {
        resPainting = true;
        const rect2 = rcv.getBoundingClientRect();
        const cellPx = RES_TILE * resVpZoom;
        resPalClick(Math.floor((e.clientX-rect2.left-resVpX)/cellPx), Math.floor((e.clientY-rect2.top-resVpY)/cellPx), resBrushItem);
      } else {
        resDragging = true; resDragMoved = false; resDragX = e.clientX - resVpX; resDragY = e.clientY - resVpY;
      }
    });
    const onResMove = (e) => {
      if (resPainting && resBrushItem) {
        const rect2 = rcv.getBoundingClientRect();
        const cellPx = RES_TILE * resVpZoom;
        resPalClick(Math.floor((e.clientX-rect2.left-resVpX)/cellPx), Math.floor((e.clientY-rect2.top-resVpY)/cellPx), resBrushItem);
        return;
      }
      if (!resDragging) return; resDragMoved = true; resVpX = e.clientX - resDragX; resVpY = e.clientY - resDragY; drawResultPreview();
    };
    const onResUp = (e) => {
      if (resPainting) { resPainting = false; return; }
      if (!resDragging) return; resDragging = false;
      if (resDragMoved || !pngPixelIdx) return;
      // click sem pincel → abre paleta pra escolher item
      const rect2 = rcv.getBoundingClientRect();
      const cellPx = RES_TILE * resVpZoom;
      const px = Math.floor((e.clientX - rect2.left - resVpX) / cellPx), py = Math.floor((e.clientY - rect2.top - resVpY) / cellPx);
      if (px < 0 || py < 0 || px >= pngW || py >= pngH) return;
      const palIdx = pngPixelIdx[py * pngW + px]; if (palIdx === 0xFFFF) return;
      const pal = pngPalette[palIdx]; if (!pal) return;
      openMinPalette(rcv, (item) => resPalClick(px, py, item));
    };
    document.addEventListener('mousemove', onResMove);
    document.addEventListener('mouseup', onResUp);
    const _origCancel = cancelBtn.onclick; cancelBtn.onclick = () => { document.removeEventListener('mousemove', onResMove); document.removeEventListener('mouseup', onResUp); _origCancel(); };
  }

  // ---- fiação dos controles de processamento ----
  { const rp=document.getElementById('pngReprocess'); if(rp) rp.onclick=()=>{ if(pngRaw)processPng(); };
    const hh=document.getElementById('pngHeight'); if(hh) hh.addEventListener('change',()=>{ const o=document.getElementById('pngHeightOpts'); if(o)o.style.display=hh.checked?'block':'none'; });
    // ATUALIZAÇÃO EM TEMPO REAL: qualquer controle do PNG re-processa (escala/cores) ou redesenha o resultado
    const live=(t)=>{ if(!t||!t.matches||!t.matches('input,select'))return;
      if(t.id==='pngScale'||t.id==='pngMaxColors'){ if(pngRaw)processPng(); }
      else { pngFinishDirty=true; drawResultPreview(); } };
    box.addEventListener('change', (e)=>live(e.target)); } // change (não input) — processPng é pesado, roda ao confirmar/blur

  applyBtn.onclick = () => {
    if (!pngPixelIdx) return alert('Escolha um PNG primeiro.');
    const ox = parseInt(document.getElementById('pngOX').value, 10) || 0;
    const oy = parseInt(document.getElementById('pngOY').value, 10) || 0;
    const oz = parseInt(document.getElementById('pngOZ').value, 10) || 7;
    const transId = transRow._id || 0;
    const chk=id=>{ const e=document.getElementById(id); return e?e.checked:false; };
    const nearest=chk('pngNearest'), heightOn=chk('pngHeight'), doBorder=chk('pngBorderize');
    const levels=Math.max(2,Math.min(15,parseInt(document.getElementById('pngHeightLv').value,10)||4));
    // rgb por paleta
    const palRgb=pngPalette.map(p=>[parseInt(p.hex.substr(1,2),16),parseInt(p.hex.substr(3,2),16),parseInt(p.hex.substr(5,2),16)]);
    const palIds = new Int32Array(pngPalette.length);
    pngPalette.forEach((p, i) => { palIds[i] = p.id || 0; });
    // cor-mais-próxima: entradas sem ID herdam o ID da cor mapeada mais próxima
    if (nearest){ const mapped=[]; pngPalette.forEach((p,i)=>{ if(palIds[i])mapped.push(i); });
      if(mapped.length) for(let i=0;i<palIds.length;i++){ if(palIds[i])continue; let bj=-1,bd=1e9; for(const j of mapped){ const dr=palRgb[i][0]-palRgb[j][0],dg=palRgb[i][1]-palRgb[j][1],db=palRgb[i][2]-palRgb[j][2]; const d=dr*dr+dg*dg+db*db; if(d<bd){bd=d;bj=j;} } if(bj>=0)palIds[i]=palIds[bj]; } }
    // heightmap: brilho → andar (claro=topo oz, escuro=fundo oz+levels-1)
    const palZ = heightOn ? palRgb.map(c=>oz+Math.round((1-(c[0]+c[1]+c[2])/3/255)*(levels-1))) : null;
    let placed=0, skipped=0; const touched = doBorder ? [] : null;
    strokeBegin();
    for (let y = 0; y < pngH; y++) for (let x = 0; x < pngW; x++) {
      const palIdx = pngPixelIdx[y * pngW + x];
      let id=0, z=oz;
      if (palIdx === 0xFFFF || palIdx === 0xFFFE) { id = transId; }
      else { id = palIds[palIdx] || 0; if(palZ)z=palZ[palIdx]; }
      if (id > 0) { const tx=ox+x, ty=oy+y; strokeTouch(tx+','+ty+','+z); OTBM.setGround(mapData, tx, ty, z, id); placed++; if(touched)touched.push([tx,ty,z]); }
      else skipped++;
    }
    if (doBorder && mapBrushData && touched) for(const[tx,ty,z]of touched) RB.borderize(mapBrushData,mapData,tx,ty,z);
    strokeEnd(); mapData._dirty = true; _miniDirty = true; reqMap();
    $('mapStatus').textContent = `PNG importado: ${placed} tiles${heightOn?' (heightmap)':''}${doBorder?' +bordas':''}, ${skipped} sem ID.`;
    ov.remove();
  };
}

// ====================================================================
// GERADOR PROCEDURAL DE MAPAS / DUNGEONS / QUESTS
// ====================================================================
function openMapGenerator() {
  if (!mapData) return alert('Carregue um mapa (.otbm) primeiro.');
  const ov = document.createElement('div'); ov.className = 'modal';
  const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '820px';

  box.innerHTML = `<h3>🗺 Gerador de Mapa / Dungeon / Quest</h3>
<div style="display:flex;gap:12px;align-items:flex-start">
  <div style="flex:1;min-width:290px;max-width:310px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px">
      <label class="opRow" style="grid-column:1/-1"><span>Tipo</span>
        <select id="genType" style="font-size:11px;flex:1">
          <option value="dungeon">🏰 Dungeon (BSP)</option>
          <option value="cave">🕳 Caverna</option>
          <option value="island">🏝 Ilha</option>
          <option value="quest">⚔ Quest</option>
          <option value="openarea">🌿 Área Aberta</option>
          <option value="maze">🌀 Labirinto</option>
          <option value="village">🏘 Vilarejo</option>
          <option value="city">🏙 Cidade (murada · distritos)</option>
          <option value="fortress">🏯 Fortaleza</option>
          <option value="forest">🌳 Floresta</option>
          <option value="river">🌊 Rio</option>
        </select>
      </label>
      <label class="opRow"><span>Seed</span><input type="number" id="genSeed" value="${Math.floor(Math.random()*99999)}" style="width:65px"><button id="genRandSeed" class="miniBtn" style="padding:2px 4px">🎲</button></label>
      <label class="opRow"><span>Salas</span><input type="number" id="genRooms" value="12" min="2" max="80" style="width:50px"></label>
      <label class="opRow"><span>Largura</span><input type="number" id="genW" value="60" min="10" max="500" style="width:55px"></label>
      <label class="opRow"><span>Altura</span><input type="number" id="genH" value="60" min="10" max="500" style="width:55px"></label>
      <label class="opRow"><span>X inicial</span><input type="number" id="genX" value="${Math.round(mapOX)}" style="width:60px"></label>
      <label class="opRow"><span>Y inicial</span><input type="number" id="genY" value="${Math.round(mapOY)}" style="width:60px"></label>
      <label class="opRow"><span>Andar (Z)</span><input type="number" id="genZ" min="0" max="15" value="${mapZ}" style="width:45px"></label>
      <label class="opRow" title="empilha N andares (cada um gerado diferente); ligados por escada"><span>Nº de andares</span><input type="number" id="genFloors" min="1" max="8" value="1" style="width:45px"></label>
      <label class="opRow" style="grid-column:1/-1" title="recorta a área gerada numa forma (igual seleção do RME). Polígono: clique no preview p/ marcar os cantos"><span>Forma</span>
        <select id="genShape" style="font-size:11px;flex:1">
          <option value="rect">▭ Retângulo (cheio)</option>
          <option value="circle">⬭ Círculo / Elipse</option>
          <option value="diamond">◇ Losango</option>
          <option value="cross">✚ Cruz</option>
          <option value="polygon">⬠ Polígono (clique os cantos)</option>
        </select>
      </label>
    </div>
    <div style="margin-top:7px;padding:6px;background:#0a0e1a;border:1px solid #1e2a3a;border-radius:4px">
      <b style="font-size:11px;color:#aaa">⚙ Opções do tipo</b>
      <div id="genTypeOpts" style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:5px"></div>
    </div>
    <div style="margin-top:7px"><b style="font-size:12px">Tiles</b>
    <div id="genBiomePresets" style="display:flex;flex-wrap:wrap;gap:3px;margin-top:4px"></div>
    <div id="genBrushPickers" style="margin-top:4px"></div>
    <div style="display:flex;flex-direction:column;gap:5px;margin-top:5px" id="genTileRows"></div></div>
    <div style="margin-top:7px;padding:6px;background:#0a0e1a;border:1px solid #1e2a3a;border-radius:4px">
      <b style="font-size:11px;color:#aaa">🎨 Acabamento (RME)</b>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px;margin-top:4px;font-size:11px">
        <label title="aplica as transições/bordas automáticas no resultado (igual ao preview)"><input type="checkbox" id="genFinBorder" checked> Bordas auto</label>
        <label title="paredes com canto/junção corretos (wall brush), não 1 sprite chapado"><input type="checkbox" id="genFinWall" checked> Paredes auto</label>
        <label title="garante que todo chão fique conectado (sem ilhas isoladas)"><input type="checkbox" id="genFinConnect" checked> Conectar</label>
        <label title="remove paredes soltas e chão isolado de 1 tile"><input type="checkbox" id="genFinClean" checked> Limpeza</label>
        <label title="mistura vários tipos de chão por ruído (grama/terra/pedra…)"><input type="checkbox" id="genFinBiome"> Multi-bioma</label>
        <label title="espalha árvores/pedras/tochas conforme o tipo"><input type="checkbox" id="genFinDeco" checked> Decoração</label>
        <label title="cria spawns de monstros nas salas (escreve no spawn.xml)"><input type="checkbox" id="genFinSpawn"> Spawns</label>
        <label title="conecta andares com escada/rampa real (ou marcador)"><input type="checkbox" id="genFinStairs" checked> Escadas</label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:6px">
        <label style="display:flex;flex-direction:column;gap:2px;font-size:10px;color:var(--muted)"><span>Deco %</span><input type="number" id="genDecoPct" value="6" min="0" max="80" style="width:100%"></label>
        <label style="display:flex;flex-direction:column;gap:2px;font-size:10px;color:var(--muted)" title="distância mínima entre decorações (evita ficarem grudadas/repetidas)"><span>Espaço</span><input type="number" id="genDecoGap" value="2" min="0" max="8" style="width:100%"></label>
        <label style="display:flex;flex-direction:column;gap:2px;font-size:10px;color:var(--muted)"><span>Mob/sala</span><input type="number" id="genSpawnPer" value="2" min="0" max="20" style="width:100%"></label>
      </div>
      <div style="margin-top:5px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:2px">Decorações a usar (vazio = automático por tipo)</div>
        <div id="genDecoList"></div>
      </div>
      <div style="display:flex;gap:4px;margin-top:5px">
        <button id="genPresetSave" class="miniBtn" style="flex:1;font-size:10px" title="salva tipo+opções+acabamento">💾 Preset</button>
        <select id="genPresetList" style="flex:1;font-size:10px;background:#0d1120;color:#ccc;border:1px solid #2a3145;border-radius:3px"></select>
        <button id="genPresetDel" class="miniBtn" style="font-size:10px" title="apaga o preset selecionado">🗑</button>
      </div>
    </div>
  </div>
  <div style="flex:1;display:flex;flex-direction:column;gap:4px">
    <div style="display:flex;align-items:center;gap:6px;font-size:11px;flex-wrap:wrap">
      <span style="color:var(--muted)">Preview</span>
      <span id="genPrevInfo" style="font-size:10px;color:#888"></span>
      <span style="flex:1"></span>
      <button id="genFitBtn" class="miniBtn" title="Ajustar à tela">⊞ Fit</button>
      <button id="genBrushClear" class="miniBtn" title="Limpar pincel (modo pan)">✋ Pan</button>
    </div>
    <div style="display:flex;align-items:center;gap:4px;padding:4px 6px;background:#0a0e1a;border:1px solid #1e2a3a;border-radius:4px;font-size:11px;flex-wrap:wrap" id="genBrushBar">
      <span style="color:var(--muted);min-width:42px">Pincel:</span>
      <div id="genBrushPicker" style="flex:1;min-width:140px"></div>
      <span style="color:#555;font-size:10px">· Drag=pintar · Scroll=zoom · Shift+drag=pan</span>
    </div>
    <canvas id="genPreview" width="460" height="400" style="border:1px solid #2a3145;background:#0d1120;image-rendering:pixelated;display:block;cursor:crosshair"></canvas>
    <div id="genExtrasList" style="max-height:50px;overflow:auto;font-size:10px;color:#aaa;display:flex;flex-wrap:wrap;gap:3px"></div>
  </div>
</div>`;

  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const prevBtn = document.createElement('button'); prevBtn.className = 'miniBtn'; prevBtn.textContent = '👁 Preview';
  const clearExtrasBtn = document.createElement('button'); clearExtrasBtn.className = 'miniBtn'; clearExtrasBtn.textContent = '🗑 Limpar extras';
  const applyBtn = document.createElement('button'); applyBtn.className = 'miniBtn accent'; applyBtn.textContent = '✅ Gerar no mapa';
  const cancelBtn = document.createElement('button'); cancelBtn.className = 'miniBtn'; cancelBtn.textContent = 'Cancelar'; cancelBtn.onclick = () => ov.remove();
  foot.append(cancelBtn, clearExtrasBtn, prevBtn, applyBtn);
  box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);

  let lastGrid = null, lastFinish = null, _finishMsg = '';
  let _prevTimer = null, _didFit = false;
  const tileConfig = { floor: { id: 103, lookid: 103, name: 'Chão' }, wall: { id: 1274, lookid: 1274, name: 'Parede' }, water: { id: 4608, lookid: 4608, name: 'Água' }, door: { id: 1234, lookid: 1234, name: 'Porta' }, wallMode: 'auto' };
  const extraItems = new Map();
  const genDecoSel = new Set(); // nomes de doodad escolhidos p/ decoração (vazio = automático por tipo)
  let genPoly = []; // pontos do polígono (forma) normalizados 0..1
  const paintMap = new Map();
  let brushItem = null;
  let vpX = 0, vpY = 0, vpZoom = 1;
  const TILE_PX = 32;

  // roda o PIPELINE COMPLETO (paredes auto, bordas, bioma, deco) num mapData temporário
  // → preview 100% fiel ao resultado. Retorna Map "x,y" -> { g:groundId, items:[ids] }
  function computeFinish(result) {
    if (!mapBrushData) return null;
    const { W, H } = result;
    const tmpMd = { type: 2, props: Buffer.alloc(0), children: [] };
    const tmp = { map: new Map(), areaIndex: new Map(), mapDataNode: tmpMd, zmin: 99, zmax: 0, _dirty: false };
    const gc = { W, H, grid: result.grid.slice(), rooms: result.rooms }; // clona o grid (stampFloor muta)
    const opts = { ...readFinishOpts(), ox: 0, oy: 0, stroke: false, preview: true, ground0: true };
    try { stampFloor(tmp, 0, gc, mkRng((gv('genSeed')||1)+1), opts); } catch (e) { console.error('preview', e); return null; }
    const out = new Map();
    for (const [key, tn] of tmp.map) {
      const p = key.split(','); const x=+p[0], y=+p[1];
      const g = OTBM.getGround(tn); const items = OTBM.itemsOf(tn).map(OTBM.itemId).filter(id => id && id !== g);
      if (g || items.length) out.set(x+','+y, { g, items });
    }
    return out;
  }

  function schedPreview(opts) { opts = opts || {}; clearTimeout(_prevTimer); _prevTimer = setTimeout(() => {
    if (!(opts.keepGrid && lastGrid)) lastGrid = buildGrid();   // toggles de acabamento reusam o grid (não regenera o mapa)
    lastFinish = computeFinish(lastGrid);
    if (!mapBrushData) _finishMsg = '<span style="color:#e6a23c">⚠ sem materiais RME (clique 📦)</span>';
    else if (!lastFinish || !lastFinish.size) _finishMsg = '<span style="color:#e6a23c">⚠ acabamento vazio</span>';
    else _finishMsg = `<span style="color:#67c23a">✓ acabamento RME (${lastFinish.size})</span>`;
    if (opts.refit || !_didFit) { fitView(lastGrid.W, lastGrid.H); _didFit = true; } // só re-enquadra na 1ª vez ou ao mudar tamanho (evita "piscada")
    drawPreview(lastGrid);
  }, 120); }

  function fitView(W, H) {
    const cv = document.getElementById('genPreview'); if (!cv) return;
    // Floor no zoom p/ o tile nunca ficar irreconhecível (~4.5px = zoom 0.14).
    // Mapas pequenos cabem inteiros; mapas GRANDES (ex: 200×200) não encolhem até virar borrão —
    // transbordam e o usuário dá pan (já suportado). Assim os sprites ficam SEMPRE legíveis,
    // independente da largura/altura — antes o auto-fit reduzia p/ 2px e "sumia" a parede/montanha.
    const MIN_ZOOM = 0.14;
    let scale = Math.min(cv.width / W / TILE_PX, cv.height / H / TILE_PX, 1);
    scale = Math.max(MIN_ZOOM, scale);
    vpZoom = scale;
    vpX = Math.round((cv.width  - W * TILE_PX * scale) / 2);
    vpY = Math.round((cv.height - H * TILE_PX * scale) / 2);
  }

  // ---- opções dinâmicas por tipo ----
  const TYPE_OPTS = {
    dungeon: [['genCorrW','Largura corredor',2,1,8],['genCorrH','Altura corredor',2,1,8],['genRoomMin','Sala mín (tiles)',5,3,30],['genRoomMax','Sala máx (tiles)',14,4,60]],
    quest:   [['genCorrW','Largura corredor',3,1,8],['genCorrH','Altura corredor',3,1,8],['genRoomMin','Sala mín',6,3,30],['genRoomMax','Sala máx',16,4,60]],
    cave:    [['genCaveFill','Densidade chão (%)',45,10,80],['genCavePasses','Suavização',5,1,12],['genCaveOpen','Limiar abertura',5,3,8]],
    island:  [['genIslandLand','Terra (%)',40,5,85],['genIslandFreq','Freq ruído (×10)',10,3,30],['genIslandGrad','Gradiente borda',25,5,80]],
    openarea:[['genOACluster','Nº clusters',8,1,50],['genOARadius','Raio cluster',5,1,25],['genOADens','Densidade (%)',70,10,100]],
    maze:    [['genMazeCell','Tamanho célula',2,1,6],['genMazeWall','Espessura parede',1,1,4]],
    village: [['genVHouseMin','Casa mín',4,3,16],['genVHouseMax','Casa máx',9,4,30],['genVStreet','Largura rua',2,1,8]],
    city:    [['genCityWall','Espessura muralha',2,0,8],['genCityStreet','Largura rua',3,1,10],['genCityBlock','Tamanho quarteirão',12,6,40],['genCityPlaza','Praça central (%)',12,0,40]],
    fortress:[['genFortWall','Espessura muralha',3,1,8],['genFortTower','Tamanho torre',5,3,14],['genFortPatio','Pátio (%)',50,20,80]],
    forest:  [['genForDens','Densidade árvores (%)',60,5,95],['genForPath','Largura trilha',2,1,8],['genForClust','Raio cluster',6,2,20]],
    river:   [['genRivW','Largura rio',4,1,16],['genRivWander','Sinuosidade',3,0,10],['genRivObst','Obstáculos',20,0,80]],
  };

  // ---- monta os botões de tile ----
  function buildTileRows() {
    const cont = document.getElementById('genTileRows'); if (!cont) return;
    cont.innerHTML = '';
    const defs = [['floor','Chão (interior)'],['wall','Parede/Montanha'],['water','Água/Vazio (0=skip)'],['door','Porta (0=sem porta)']];
    defs.forEach(([key, label]) => {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;background:#0a0e1a;border:1px solid #1e2a3a;border-radius:4px';
      const lbl = document.createElement('span'); lbl.style.cssText = 'font-size:11px;color:var(--muted);min-width:100px'; lbl.textContent = label;
      const picker = _mkPickerBtn('', tileConfig[key].id, (id, item) => {
        tileConfig[key] = Object.assign(tileConfig[key]||{}, { id, lookid: item.lookid || id, name: item.name || '' });
        schedPreview();
      });
      picker.style.flex = '1';
      row.append(lbl, picker);
      // a linha "Parede/Montanha" ganha um seletor explícito de comportamento (auto-detect erra às vezes)
      if (key === 'wall') {
        const sel = document.createElement('select'); sel.style.cssText = 'font-size:10px;background:#0d1120;color:#ccc;border:1px solid #2a3145;border-radius:3px;flex-shrink:0';
        sel.title = 'como tratar o item escolhido: parede (auto-wall) · montanha (auto-borda de rocha) · sólido (só o ground)';
        [['auto','Auto'],['wall','Parede'],['mountain','Montanha'],['raw','Sólido']].forEach(([v,t])=>{ const o=document.createElement('option'); o.value=v; o.textContent=t; sel.appendChild(o); });
        sel.value = tileConfig.wallMode || 'auto';
        sel.onchange = () => { tileConfig.wallMode = sel.value; schedPreview(); };
        row.append(sel);
      }
      cont.appendChild(row);
    });
  }
  buildTileRows();
  buildTypeOptions();
  // presets de bioma (IDs extraídos do MAP.otbm real — ground+parede que combinam)
  { const PRESETS=[
      ['🌿 Grama',   101, 4820, 4608, 1234, 'mountain'],
      ['🪨 Caverna', 919, 873,  4608, 1234, 'mountain'],
      ['⛰ Montanha', 708, 4820, 4608, 1234, 'mountain'],
      ['🪵 Madeira',  458, 1274, 4608, 1234, 'wall'],
      ['🏝 Areia',   231, 4820, 4608, 1234, 'mountain'],
    ];
    const cont=document.getElementById('genBiomePresets');
    if(cont) PRESETS.forEach(([label,f,w,wa,d,mode])=>{ const b=document.createElement('button'); b.className='miniBtn'; b.style.cssText='font-size:10px;padding:2px 5px'; b.textContent=label;
      b.title=`chão ${f} · ${mode==='mountain'?'montanha':'parede'} ${w} · água ${wa}`;
      b.onclick=()=>{ tileConfig.floor={id:f,lookid:f,name:''}; tileConfig.wall={id:w,lookid:w,name:''}; tileConfig.water={id:wa,lookid:wa,name:''}; tileConfig.door={id:d,lookid:d,name:''}; tileConfig.wallMode=mode; buildTileRows(); buildBrushPickers(); schedPreview(); };
      cont.appendChild(b); });
  }

  // pickers de brush POR NOME do material RME → ids/modo corretos (borda/montanha garantida)
  function buildBrushPickers(){
    const c=document.getElementById('genBrushPickers'); if(!c) return; c.innerHTML='';
    if(!mapBrushData){ c.innerHTML='<span style="font-size:10px;color:#e6a23c">📦 carregue materiais RME p/ escolher brushes prontos</span>'; return; }
    const grounds=mapBrushData.brushes.filter(b=>b.optional==null);
    const mounts=mapBrushData.brushes.filter(b=>b.optional!=null);
    const mkSel=(label,opts,onpick)=>{ const row=document.createElement('div'); row.style.cssText='display:flex;align-items:center;gap:6px;margin-top:3px';
      const l=document.createElement('span'); l.style.cssText='font-size:11px;color:var(--muted);min-width:100px'; l.textContent=label;
      const s=document.createElement('select'); s.style.cssText='flex:1;font-size:10px;background:#0d1120;color:#ccc;border:1px solid #2a3145;border-radius:3px';
      const o0=document.createElement('option'); o0.value=''; o0.textContent='— usar id manual abaixo —'; s.appendChild(o0);
      opts.forEach(o=>{ const op=document.createElement('option'); op.value=o.v; op.textContent=o.t; s.appendChild(op); });
      s.onchange=()=>{ onpick(s.value); buildTileRows(); schedPreview(); };
      row.append(l,s); c.appendChild(row); };
    mkSel('🟫 Chão (brush)', grounds.map(b=>({v:b.name,t:b.name})), (nm)=>{ if(!nm)return; const b=mapBrushData.byName.get(nm); const id=(b.items&&b.items[0])||b.lookid; if(id) tileConfig.floor={id,lookid:id,name:nm}; });
    const wm=[...mapBrushData.walls.map(w=>({v:'w:'+w.name,t:'🧱 '+w.name})), ...mounts.map(b=>({v:'m:'+b.name,t:'⛰ '+b.name}))];
    mkSel('🧱 Parede/Montanha', wm, (val)=>{ if(!val)return; const kind=val[0], nm=val.slice(2);
      if(kind==='w'){ const w=mapBrushData.wallByName.get(nm); const id=((w.walls.pole||w.walls.horizontal||w.walls.vertical||Object.values(w.walls)[0])||[])[0]; if(id)tileConfig.wall={id,lookid:id,name:nm}; tileConfig.wallMode='wall'; }
      else { const b=mapBrushData.byName.get(nm); const id=(b.items&&b.items[0])||b.lookid; if(id)tileConfig.wall={id,lookid:id,name:nm}; tileConfig.wallMode='mountain'; } });
  }
  // multi-seleção de doodads p/ decoração (com filtro)
  function buildDecoList(){
    const c=document.getElementById('genDecoList'); if(!c) return; c.innerHTML='';
    if(!mapBrushData||!mapBrushData.doodads.length){ c.innerHTML='<span style="font-size:10px;color:#888">sem doodads — carregue materiais RME</span>'; return; }
    const search=document.createElement('input'); search.placeholder='filtrar (tree, rock, torch…)'; search.style.cssText='width:100%;font-size:10px;background:#0d1120;color:#ccc;border:1px solid #2a3145;border-radius:3px;margin-bottom:2px';
    const list=document.createElement('div'); list.style.cssText='max-height:84px;overflow:auto;display:flex;flex-direction:column;gap:1px';
    const render=(flt)=>{ list.innerHTML=''; const f=(flt||'').toLowerCase();
      mapBrushData.doodads.filter(d=>!f||d.name.toLowerCase().includes(f)).slice(0,300).forEach(d=>{ const lb=document.createElement('label'); lb.style.cssText='font-size:10px;display:flex;gap:4px;align-items:center;cursor:pointer';
        const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=genDecoSel.has(d.name);
        cb.onchange=()=>{ if(cb.checked)genDecoSel.add(d.name); else genDecoSel.delete(d.name); schedPreview(); };
        lb.append(cb, document.createTextNode(d.name)); list.appendChild(lb); }); };
    search.oninput=()=>render(search.value); render('');
    c.append(search, list);
  }
  buildBrushPickers();
  buildDecoList();

  document.getElementById('genType').onchange = () => { buildTypeOptions(); schedPreview(); };

  // ---- pincel ----
  {
    const bpCont = document.getElementById('genBrushPicker');
    const bp = _mkPickerBtn('— nenhum (pan) —', 0, (id, item) => {
      brushItem = id ? { id, lookid: item.lookid||id, name: item.name||'' } : null;
      document.getElementById('genPreview').style.cursor = brushItem ? 'crosshair' : 'grab';
    });
    bp.style.flex = '1';
    bpCont.appendChild(bp);
    document.getElementById('genBrushClear').onclick = () => {
      brushItem = null;
      bp._getId && (bp.querySelector('span') && (bp.querySelector('span').textContent = '— nenhum (pan) —'));
      bp.querySelector('canvas') && bp.querySelector('canvas').getContext('2d').clearRect(0,0,32,32);
      document.getElementById('genPreview').style.cursor = 'grab';
    };
  }

  function gv(id) { return +document.getElementById(id).value || 0; }
  function gs(id) { return document.getElementById(id).value; }

  // ---- PRNG ----
  function mkRng(seed) { let s = seed >>> 0; return () => { s += 0x6D2B79F5; let t = Math.imul(s ^ s >>> 15, 1 | s); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  // ---- ALGORITMOS ----

  function genDungeon(W, H, numRooms, rng) {
    const grid = new Uint8Array(W * H); const rooms = [];
    const corrW = Math.max(1, Math.min(8, gv('genCorrW') || 2));
    const corrH = Math.max(1, Math.min(8, gv('genCorrH') || 2));
    const minR = Math.max(3, gv('genRoomMin') || 5);
    const maxR = Math.max(minR + 2, gv('genRoomMax') || 14);
    const margin = corrW + 1;
    for (let a = 0; a < numRooms * 10 && rooms.length < numRooms; a++) {
      const rw = Math.floor(rng()*(maxR-minR)+minR), rh = Math.floor(rng()*(maxR-minR)+minR);
      const rx = Math.floor(rng()*(W-rw-margin*2))+margin, ry = Math.floor(rng()*(H-rh-margin*2))+margin;
      if (rx < 1 || ry < 1 || rx+rw >= W-1 || ry+rh >= H-1) continue;
      if (rooms.some((r) => rx<r.x+r.w+margin&&rx+rw+margin>r.x&&ry<r.y+r.h+margin&&ry+rh+margin>r.y)) continue;
      rooms.push({ x:rx, y:ry, w:rw, h:rh });
      for (let dy=0;dy<rh;dy++) for (let dx=0;dx<rw;dx++) grid[(ry+dy)*W+(rx+dx)]=1;
    }
    // carve corridors with configurable width
    const carve = (x1,y1,x2,y2) => {
      const sx=Math.sign(x2-x1)||0, sy=Math.sign(y2-y1)||0;
      let x=x1, y=y1;
      for (let step=0; step<W+H; step++) {
        for (let dy=0;dy<corrH;dy++) for (let dx=0;dx<corrW;dx++) { const nx=x+dx,ny=y+dy; if(nx>=0&&nx<W&&ny>=0&&ny<H) grid[ny*W+nx]=1; }
        if (x===x2&&y===y2) break;
        if (x!==x2) x+=sx; else y+=sy;
      }
    };
    for (let i=1;i<rooms.length;i++) {
      const a=rooms[i-1], b=rooms[i];
      const cx1=Math.floor(a.x+a.w/2), cy1=Math.floor(a.y+a.h/2), cx2=Math.floor(b.x+b.w/2), cy2=Math.floor(b.y+b.h/2);
      if (rng()>0.5) { carve(cx1,cy1,cx2,cy1); carve(cx2,cy1,cx2,cy2); }
      else            { carve(cx1,cy1,cx1,cy2); carve(cx1,cy2,cx2,cy2); }
    }
    if (tileConfig.door.id) {
      for (let i=1;i<rooms.length;i++) {
        const a=rooms[i-1], b=rooms[i];
        const mx=Math.floor((Math.floor(a.x+a.w/2)+Math.floor(b.x+b.w/2))/2), my=Math.floor((Math.floor(a.y+a.h/2)+Math.floor(b.y+b.h/2))/2);
        if (mx>=0&&mx<W&&my>=0&&my<H&&grid[my*W+mx]===1) grid[my*W+mx]=2;
      }
    }
    return { grid, rooms };
  }

  function buildTypeOptions() {
    const cont = document.getElementById('genTypeOpts'); if (!cont) return;
    const type = gs('genType'); cont.innerHTML = '';
    const opts = TYPE_OPTS[type] || [];
    if (!opts.length) return;
    opts.forEach(([id, label, def, min, max]) => {
      const existing = document.getElementById(id);
      const val = existing ? existing.value : def;
      const row = document.createElement('label'); row.className = 'opRow';
      row.innerHTML = `<span>${label}</span><input type="number" id="${id}" value="${val}" min="${min}" max="${max}" style="width:50px">`;
      row.querySelector('input').oninput = schedPreview;
      cont.appendChild(row);
    });
  }

  function gopt(id, def) { const el = document.getElementById(id); return el ? (+el.value || def) : def; }

  function genCave(W, H, rng) {
    const fill = gopt('genCaveFill',45)/100;
    const passes = Math.round(gopt('genCavePasses',5));
    const open = Math.round(gopt('genCaveOpen',5));
    let grid = new Uint8Array(W*H);
    for (let i=0;i<W*H;i++) grid[i]=rng()<fill?1:0;
    for (let pass=0;pass<passes;pass++) {
      const next=new Uint8Array(W*H);
      for (let y=0;y<H;y++) for (let x=0;x<W;x++) { let w=0; for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=W||ny>=H)w++;else if(!grid[ny*W+nx])w++;} next[y*W+x]=w>=open?0:1; }
      grid=next;
    }
    for (let x=0;x<W;x++){grid[x]=0;grid[(H-1)*W+x]=0;}
    for (let y=0;y<H;y++){grid[y*W]=0;grid[y*W+W-1]=0;}
    return { grid, rooms:[] };
  }

  function genIsland(W, H, rng) {
    const landRatio = gopt('genIslandLand',40)/100;
    const freqMult = gopt('genIslandFreq',10)/100;
    const grad = gopt('genIslandGrad',25)/10;
    const grid=new Uint8Array(W*H);
    const freqs=Array.from({length:6},()=>({fx:rng()*freqMult+0.02,fy:rng()*freqMult+0.02,px:rng()*6.28,py:rng()*6.28,a:rng()*0.5+0.3}));
    const cx=W/2, cy=H/2;
    const threshold = 0.6 - landRatio;
    for (let y=0;y<H;y++) for (let x=0;x<W;x++){
      let v=0; for (const f of freqs) v+=f.a*Math.sin(x*f.fx+f.px)*Math.cos(y*f.fy+f.py);
      v-=Math.sqrt((x-cx)**2+(y-cy)**2)/(Math.min(W,H)*0.45)*grad;
      grid[y*W+x]=v>threshold?1:0;
    }
    return { grid, rooms:[] };
  }

  function genOpenArea(W, H, rng) {
    const nc = Math.round(gopt('genOACluster',8));
    const maxR = Math.round(gopt('genOARadius',5));
    const dens = gopt('genOADens',70)/100;
    const grid=new Uint8Array(W*H).fill(1);
    for (let c=0;c<nc;c++){
      const cx=Math.floor(rng()*(W-4))+2,cy=Math.floor(rng()*(H-4))+2,r=Math.floor(rng()*maxR+2);
      for (let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++){
        if(dx*dx+dy*dy<=r*r*1.2&&rng()>dens){const nx=cx+dx,ny=cy+dy;if(nx>=0&&ny>=0&&nx<W&&ny<H)grid[ny*W+nx]=0;}
      }
    }
    return { grid, rooms:[] };
  }

  function genQuest(W, H, numRooms, rng) {
    const { grid, rooms } = genDungeon(W, H, numRooms, rng);
    const corrH = Math.max(1, gopt('genCorrH',3));
    const cy=Math.floor(H/2);
    for (let x=2;x<W-2;x++) for (let d=0;d<corrH;d++) if(cy+d<H) grid[(cy+d)*W+x]=1;
    return { grid, rooms };
  }

  function genMaze(W, H, rng) {
    const cell = Math.max(1, Math.round(gopt('genMazeCell',2)));
    const wall = Math.max(1, Math.round(gopt('genMazeWall',1)));
    const step = cell + wall;
    const mW=Math.max(1,Math.floor((W-wall)/step)), mH=Math.max(1,Math.floor((H-wall)/step));
    const grid=new Uint8Array(W*H);
    const visited=new Uint8Array(mW*mH);
    const stack=[[Math.floor(rng()*mW), Math.floor(rng()*mH)]];
    visited[stack[0][1]*mW+stack[0][0]]=1;
    const dirs=[[0,-1],[1,0],[0,1],[-1,0]];
    // carve cell at maze coords
    const carveCell=(mx,my)=>{ for(let dy=0;dy<cell;dy++) for(let dx=0;dx<cell;dx++){const gx=wall+mx*step+dx,gy=wall+my*step+dy;if(gx<W&&gy<H)grid[gy*W+gx]=1;} };
    // carve passage between two adj maze cells
    const carvePass=(mx,my,dx,dy)=>{ for(let s=0;s<wall;s++) for(let t=0;t<cell;t++){
      const gx=wall+mx*step+(dx===1?cell+s:t*(dx===0?1:0)),gy=wall+my*step+(dy===1?cell+s:t*(dy===0?1:0));
      if(gx<W&&gy<H)grid[gy*W+gx]=1;
    }};
    while (stack.length) {
      const [cx,cy]=stack[stack.length-1]; carveCell(cx,cy);
      const shuffled=dirs.slice().sort(()=>rng()-0.5);
      let moved=false;
      for (const [dx,dy] of shuffled){const nx=cx+dx,ny=cy+dy;if(nx>=0&&ny>=0&&nx<mW&&ny<mH&&!visited[ny*mW+nx]){carvePass(cx,cy,dx,dy);visited[ny*mW+nx]=1;stack.push([nx,ny]);moved=true;break;}}
      if (!moved) stack.pop();
    }
    return { grid, rooms:[] };
  }

  function genVillage(W, H, numRooms, rng) {
    const hMin=Math.round(gopt('genVHouseMin',4)), hMax=Math.round(gopt('genVHouseMax',9));
    const streetW=Math.round(gopt('genVStreet',2));
    const grid=new Uint8Array(W*H).fill(1);
    // ruas principais
    const cy=Math.floor(H/2); for(let sw=0;sw<streetW;sw++) for(let x=0;x<W;x++) if(cy+sw<H) grid[(cy+sw)*W+x]=1;
    const cx=Math.floor(W/2); for(let sw=0;sw<streetW;sw++) for(let y=0;y<H;y++) if(cx+sw<W) grid[y*W+(cx+sw)]=1;
    const houses=[]; const margin=streetW+1;
    for (let a=0;a<numRooms*8&&houses.length<numRooms;a++){
      const hw=Math.floor(rng()*(hMax-hMin)+hMin), hh=Math.floor(rng()*(hMax-hMin)+hMin);
      const hx=Math.floor(rng()*(W-hw-margin*2))+margin, hy=Math.floor(rng()*(H-hh-margin*2))+margin;
      if (houses.some((h)=>hx<h.x+h.w+margin&&hx+hw+margin>h.x&&hy<h.y+h.h+margin&&hy+hh+margin>h.y)) continue;
      houses.push({x:hx,y:hy,w:hw,h:hh});
      for (let dy=0;dy<hh;dy++) for (let dx=0;dx<hw;dx++){
        grid[(hy+dy)*W+(hx+dx)]=(dy===0||dy===hh-1||dx===0||dx===hw-1)?0:1;
      }
      grid[(hy+(rng()>0.5?hh-1:0))*W+(hx+Math.floor(hw/2))]=2;
    }
    for (let x=0;x<W;x++){grid[x]=0;grid[(H-1)*W+x]=0;}
    for (let y=0;y<H;y++){grid[y*W]=0;grid[y*W+W-1]=0;}
    return { grid, rooms:houses };
  }

  function genFortress(W, H, numRooms, rng) {
    const wallT=Math.round(gopt('genFortWall',3));
    const towerSz=Math.round(gopt('genFortTower',5));
    const patioP=gopt('genFortPatio',50)/100;
    const grid=new Uint8Array(W*H).fill(0);
    const pw=Math.floor(W*patioP), ph=Math.floor(H*patioP);
    const px=Math.floor((W-pw)/2), py=Math.floor((H-ph)/2);
    for (let dy=wallT;dy<ph-wallT;dy++) for (let dx=wallT;dx<pw-wallT;dx++) grid[(py+dy)*W+(px+dx)]=1;
    for (let t=0;t<wallT;t++){for(let x=t;x<W-t;x++){grid[t*W+x]=0;grid[(H-1-t)*W+x]=0;}for(let y=t;y<H-t;y++){grid[y*W+t]=0;grid[y*W+(W-1-t)]=0;}}
    const tower=(tx,ty)=>{for(let dy=0;dy<towerSz;dy++)for(let dx=0;dx<towerSz;dx++)grid[(ty+dy)*W+(tx+dx)]=0;for(let dy=1;dy<towerSz-1;dy++)for(let dx=1;dx<towerSz-1;dx++)grid[(ty+dy)*W+(tx+dx)]=1;};
    if(towerSz<W&&towerSz<H){tower(0,0);tower(W-towerSz,0);tower(0,H-towerSz);tower(W-towerSz,H-towerSz);}
    const mid=Math.floor(W/2); const gateW=Math.max(1,Math.floor(wallT/2));
    for(let i=-gateW;i<=gateW;i++){if(wallT<H-wallT){grid[wallT*W+(mid+i)]=2;grid[(H-wallT-1)*W+(mid+i)]=2;}}
    const midd=Math.floor(H/2);
    for(let i=-gateW;i<=gateW;i++){if(wallT<W-wallT){grid[(midd+i)*W+wallT]=2;grid[(midd+i)*W+(W-wallT-1)]=2;}}
    if(pw>4&&ph>4){const sub=genDungeon(pw-2,ph-2,numRooms,rng);for(let y=0;y<ph-2;y++)for(let x=0;x<pw-2;x++){if(sub.grid[y*(pw-2)+x])grid[(py+1+y)*W+(px+1+x)]=1;}}
    return { grid, rooms:[] };
  }

  // CIDADE: muralha externa + ruas em grid + quarteirões com prédios variados + praça central + 4 portões.
  function genCity(W, H, numRooms, rng) {
    const wallT  = Math.round(gopt('genCityWall', 2));
    const street = Math.max(1, Math.round(gopt('genCityStreet', 3)));
    const block  = Math.max(6, Math.round(gopt('genCityBlock', 12)));
    const plazaP = gopt('genCityPlaza', 12) / 100;
    const grid = new Uint8Array(W * H).fill(1); // tudo chão (ruas/praças)
    // muralha externa
    for (let t = 0; t < wallT; t++) {
      for (let x = 0; x < W; x++) { grid[t*W+x] = 0; grid[(H-1-t)*W+x] = 0; }
      for (let y = 0; y < H; y++) { grid[y*W+t] = 0; grid[y*W+(W-1-t)] = 0; }
    }
    // quarteirões (entre as ruas) → prédios; cada quarteirão pode ter 1-4 prédios
    const step = block + street, inner = wallT + street, houses = [];
    for (let by = inner; by + 5 < H - wallT; by += step) {
      for (let bx = inner; bx + 5 < W - wallT; bx += step) {
        const bw = Math.min(block, W - wallT - bx - 1), bh = Math.min(block, H - wallT - by - 1);
        if (bw < 4 || bh < 4) continue;
        const cols = (bw > 9 && rng() > 0.5) ? 2 : 1, rows = (bh > 9 && rng() > 0.5) ? 2 : 1;
        const cw = Math.floor(bw / cols), ch = Math.floor(bh / rows);
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const hw = cw - 1, hh = ch - 1;
          if (hw < 3 || hh < 3 || rng() < 0.12) continue; // alguns lotes vazios = variedade
          const hx = bx + c*cw, hy = by + r*ch;
          houses.push({ x: hx, y: hy, w: hw, h: hh });
          for (let dy = 0; dy < hh; dy++) for (let dx = 0; dx < hw; dx++)
            grid[(hy+dy)*W+(hx+dx)] = (dy===0||dy===hh-1||dx===0||dx===hw-1) ? 0 : 1; // borda=parede, interior=chão
          grid[(hy + (rng()>0.5?hh-1:0))*W + (hx + Math.floor(hw/2))] = 2; // porta
        }
      }
    }
    // praça central
    const cmx = Math.floor(W/2), cmy = Math.floor(H/2), pr = Math.floor(Math.min(W, H) * plazaP / 2);
    for (let dy = -pr; dy <= pr; dy++) for (let dx = -pr; dx <= pr; dx++) {
      const x = cmx+dx, y = cmy+dy;
      if (x > wallT && x < W-wallT-1 && y > wallT && y < H-wallT-1) grid[y*W+x] = 1;
    }
    // 4 portões na muralha
    if (wallT > 0) {
      const gh = Math.max(1, Math.floor(street/2));
      for (let i = -gh; i <= gh; i++) for (let t = 0; t < wallT; t++) {
        if (cmx+i>0 && cmx+i<W) { grid[t*W+(cmx+i)] = 2; grid[(H-1-t)*W+(cmx+i)] = 2; }
        if (cmy+i>0 && cmy+i<H) { grid[(cmy+i)*W+t] = 2; grid[(cmy+i)*W+(W-1-t)] = 2; }
      }
    }
    return { grid, rooms: houses };
  }

  function genForest(W, H, rng) {
    const dens=gopt('genForDens',60)/100;
    const pathW=Math.round(gopt('genForPath',2));
    const clustR=Math.round(gopt('genForClust',6));
    const grid=new Uint8Array(W*H).fill(1);
    const nc=Math.floor(W*H/(clustR*clustR*6))+4;
    for(let c=0;c<nc;c++){
      const cx=Math.floor(rng()*W),cy=Math.floor(rng()*H),r=Math.floor(rng()*clustR+2);
      for(let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++){
        if(dx*dx+dy*dy<r*r&&rng()<dens){const nx=cx+dx,ny=cy+dy;if(nx>=0&&ny>=0&&nx<W&&ny<H)grid[ny*W+nx]=0;}
      }
    }
    let tx=Math.floor(W/2);
    for(let y=0;y<H;y++){const jitter=Math.floor((rng()-0.5)*4);tx=Math.max(pathW,Math.min(W-pathW-1,tx+jitter));for(let d=-Math.floor(pathW/2);d<=Math.floor(pathW/2);d++)if(tx+d>=0&&tx+d<W)grid[y*W+(tx+d)]=1;}
    return { grid, rooms:[] };
  }

  function genRiver(W, H, rng) {
    const rivW=Math.round(gopt('genRivW',4));
    const wander=gopt('genRivWander',3);
    const obstacles=Math.round(gopt('genRivObst',20));
    const grid=new Uint8Array(W*H).fill(1);
    let ry=Math.floor(H/2);
    const half=Math.floor(rivW/2);
    for(let x=0;x<W;x++){const j=Math.floor((rng()-0.5)*wander*2);ry=Math.max(rivW,Math.min(H-rivW-1,ry+j));for(let d=-half;d<=half;d++)if(ry+d>=0&&ry+d<H)grid[(ry+d)*W+x]=0;}
    for(let i=0;i<obstacles;i++){const ox=Math.floor(rng()*W),oy2=Math.floor(rng()*H);if(grid[oy2*W+ox]===1&&rng()>0.5)grid[oy2*W+ox]=0;}
    return { grid, rooms:[] };
  }

  // ponto-em-polígono (ray casting). pts = [[nx,ny]] normalizados 0..1
  function pointInPoly(px, py, pts) { let inside=false;
    for (let i=0,j=pts.length-1; i<pts.length; j=i++) { const xi=pts[i][0],yi=pts[i][1],xj=pts[j][0],yj=pts[j][1];
      if (((yi>py)!==(yj>py)) && (px < (xj-xi)*(py-yi)/((yj-yi)||1e-9)+xi)) inside=!inside; }
    return inside; }
  // recorta a área gerada numa forma (igual seleção do RME). null = retângulo cheio (sem máscara)
  function computeShapeMask(W, H) {
    const shape = gs('genShape') || 'rect';
    if (shape === 'rect') return null;
    if (shape === 'polygon' && genPoly.length < 3) return null; // sem pontos suficientes → sem recorte
    const mask = new Uint8Array(W*H);
    const cx=(W-1)/2, cy=(H-1)/2, rx=(W)/2, ry=(H)/2;
    for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
      const ndx=(x-cx)/rx, ndy=(y-cy)/ry; let inside=true;
      if (shape==='circle')       inside = (ndx*ndx + ndy*ndy) <= 1;
      else if (shape==='diamond') inside = (Math.abs(ndx)+Math.abs(ndy)) <= 1;
      else if (shape==='cross')   { const t=0.34; inside = Math.abs(ndx)<=t || Math.abs(ndy)<=t; }
      else if (shape==='polygon') inside = pointInPoly((x+0.5)/W, (y+0.5)/H, genPoly);
      mask[y*W+x] = inside ? 1 : 0;
    }
    return mask;
  }

  function buildGrid(seedOverride) {
    const W=Math.max(10,Math.min(500,gv('genW'))), H=Math.max(10,Math.min(500,gv('genH')));
    const seed=(seedOverride!=null?seedOverride:(gv('genSeed')||1));
    const rng=mkRng(seed);
    const numRooms=Math.max(2,Math.min(80,gv('genRooms')));
    const type=gs('genType');
    let r;
    if (type==='cave')          r=genCave(W,H,rng);
    else if (type==='island')   r=genIsland(W,H,rng);
    else if (type==='quest')    r=genQuest(W,H,numRooms,rng);
    else if (type==='openarea') r=genOpenArea(W,H,rng);
    else if (type==='maze')     r=genMaze(W,H,rng);
    else if (type==='village')  r=genVillage(W,H,numRooms,rng);
    else if (type==='city')     r=genCity(W,H,numRooms,rng);
    else if (type==='fortress') r=genFortress(W,H,numRooms,rng);
    else if (type==='forest')   r=genForest(W,H,rng);
    else if (type==='river')    r=genRiver(W,H,rng);
    else                        r=genDungeon(W,H,numRooms,rng);
    return {W,H,...r, mask: computeShapeMask(W,H)};
  }

  // cache de sprites renderizados p/ preview
  const _sprCache = new Map();
  function getSprCanvas(id) {
    if (_sprCache.has(id)) return _sprCache.get(id);
    let c = null;
    if (dat && id > 0) {
      const cid = (otbMap && otbMap.get(id)) || id;
      const t = dat.item(cid);
      if (t) { c = document.createElement('canvas'); c.width=32; c.height=32; try { drawScaled(c, composeThing(t,0,0)); } catch(e){c=null;} }
    }
    _sprCache.set(id, c); return c;
  }

  let _genBuf = null;
  function drawPreview(result) {
    const { W, H, grid } = result; const mask = result.mask;
    const cv = document.getElementById('genPreview'); if (!cv) return;
    // double-buffer: desenha tudo num canvas offscreen e blita 1x → o canvas visível nunca pisca em branco
    if (!_genBuf || _genBuf.width !== cv.width || _genBuf.height !== cv.height) { _genBuf = document.createElement('canvas'); _genBuf.width = cv.width; _genBuf.height = cv.height; }
    const ctx = _genBuf.getContext('2d');
    ctx.imageSmoothingEnabled = false; // casa com o CSS pixelated → sprites nítidos ao escalar p/ baixo
    // Preence o buffer com a cor de fundo (#0d1120, mesmo do CSS do canvas) p/ ele ficar 100% opaco.
    // Assim o blit final SUBSTITUI todo o canvas visível — sem deixar o preview anterior "vazar"
    // pelas áreas sem tile (que ficavam transparentes e causavam o efeito de mapa sobreposto).
    ctx.fillStyle = '#0d1120';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const tilePx = TILE_PX * vpZoom;
    const floorId=tileConfig.floor.id, wallId=tileConfig.wall.id, waterId=tileConfig.water.id, doorId=tileConfig.door.id;
    const minTX = Math.max(0, Math.floor(-vpX / tilePx));
    const maxTX = Math.min(W-1, Math.ceil((cv.width - vpX) / tilePx));
    const minTY = Math.max(0, Math.floor(-vpY / tilePx));
    const maxTY = Math.min(H-1, Math.ceil((cv.height - vpY) / tilePx));
    // Sprites (montanhas/parede/borda/deco) ficam SEMPRE ligados quando há material .dat.
    // O único corte real é PERFORMANCE: viewport gigante (> ~50k tiles visíveis de uma vez) cai
    // no modo chapado (mapas 300×300+ com zoom-out total). Um piso de 1.5px evita downscale puro
    // ruído sem prejudicar nenhum tamanho normal — 100×100 (~4px), 150×150 (~2.6px), 200×200 (2px).
    const visTiles = (maxTX - minTX + 1) * (maxTY - minTY + 1);
    const useSpr = dat && tilePx >= 1.5 && visTiles < 50000;
    for (let ty=minTY; ty<=maxTY; ty++) for (let tx=minTX; tx<=maxTX; tx++) {
      if (mask && !mask[ty*W+tx]) continue; // fora da forma → não desenha (mostra o recorte)
      const v = grid[ty*W+tx];
      const sx = vpX + tx*tilePx, sy = vpY + ty*tilePx;
      ctx.fillStyle = v===0?'#1a120a': v===2?'#6b5010':'#4a6a3a';
      ctx.fillRect(sx, sy, tilePx+0.5, tilePx+0.5);
      if (!useSpr) continue;
      const fin = lastFinish ? lastFinish.get(tx+','+ty) : null;
      if (fin) { // preview fiel: ground (bioma) + tudo empilhado (paredes segmentadas, bordas, deco)
        if (fin.g) { const gs2=getSprCanvas(fin.g); if(gs2) ctx.drawImage(gs2,sx,sy,tilePx,tilePx); }
        for (const id of fin.items) { const s2=getSprCanvas(id); if(s2) ctx.drawImage(s2,sx,sy,tilePx,tilePx); }
      } else { // sem material RME: desenho básico do grid
        const id = v===0?wallId:floorId;
        const spr = getSprCanvas(id); if (spr) ctx.drawImage(spr, sx, sy, tilePx, tilePx);
        if (v===0 && waterId) { const ws=getSprCanvas(waterId); if(ws) ctx.drawImage(ws,sx,sy,tilePx,tilePx); }
        if (v===2 && doorId) { const ds=getSprCanvas(doorId); if(ds) ctx.drawImage(ds,sx,sy,tilePx,tilePx); }
      }
    }
    // paintMap: overrides de pincel (desenhados sobre o grid)
    paintMap.forEach((item, key) => {
      const [ex,ey] = key.split(',').map(Number);
      if (ex<minTX||ex>maxTX||ey<minTY||ey>maxTY) return;
      const sx=vpX+ex*tilePx, sy=vpY+ey*tilePx;
      const s = getSprCanvas(item.id);
      if (s) ctx.drawImage(s, sx, sy, tilePx, tilePx);
      else { ctx.fillStyle='rgba(80,160,255,0.7)'; ctx.fillRect(sx,sy,tilePx,tilePx); }
    });
    // extras (items adicionais por cima)
    extraItems.forEach((item, key) => {
      const [ex,ey] = key.split(',').map(Number);
      if (ex<minTX||ex>maxTX||ey<minTY||ey>maxTY) return;
      const sx=vpX+ex*tilePx, sy=vpY+ey*tilePx;
      const s = getSprCanvas(item.id);
      if (s) ctx.drawImage(s, sx, sy, tilePx, tilePx);
      else { ctx.fillStyle='rgba(255,200,0,0.6)'; ctx.fillRect(sx,sy,tilePx,tilePx); }
    });
    // contorno do polígono em edição (mostra os cantos marcados)
    if ((gs('genShape')||'rect')==='polygon' && genPoly.length) {
      ctx.save(); ctx.strokeStyle='#ffd166'; ctx.fillStyle='rgba(255,209,102,0.9)'; ctx.lineWidth=1.5;
      ctx.beginPath();
      genPoly.forEach((p,i)=>{ const sx=vpX+p[0]*W*tilePx, sy=vpY+p[1]*H*tilePx; if(i===0)ctx.moveTo(sx,sy); else ctx.lineTo(sx,sy); });
      if (genPoly.length>=3) ctx.closePath();
      ctx.stroke();
      genPoly.forEach(p=>{ const sx=vpX+p[0]*W*tilePx, sy=vpY+p[1]*H*tilePx; ctx.beginPath(); ctx.arc(sx,sy,3,0,6.28); ctx.fill(); });
      ctx.restore();
    }
    cv.getContext('2d').drawImage(_genBuf, 0, 0); // blit único do buffer → sem piscar
    const piEl = document.getElementById('genPrevInfo');
    if (piEl) piEl.innerHTML = `${W}×${H} tiles · ${Math.round(vpZoom*TILE_PX)}px` + (_finishMsg ? ' · ' + _finishMsg : '');
    updateExtrasList();
  }

  function updateExtrasList() {
    const el = document.getElementById('genExtrasList'); if (!el) return;
    el.innerHTML = '';
    extraItems.forEach((item, key) => {
      const tag = document.createElement('span'); tag.style.cssText='padding:2px 5px;background:#1e2a3a;border-radius:3px;cursor:pointer'; tag.title='Clique p/ remover';
      tag.textContent = `(${key}) #${item.id}`;
      tag.onclick = () => { extraItems.delete(key); if (lastGrid) drawPreview(lastGrid); };
      el.appendChild(tag);
    });
  }

  // ---- viewport pan / zoom / click ----
  const genCv = document.getElementById('genPreview');

  // wheel → zoom centrado no cursor
  genCv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = genCv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.18 : 1/1.18;
    const nz = Math.max(0.08, Math.min(4, vpZoom * factor));
    vpX = mx - (mx - vpX) * (nz / vpZoom);
    vpY = my - (my - vpY) * (nz / vpZoom);
    vpZoom = nz;
    if (lastGrid) drawPreview(lastGrid);
  }, { passive: false });

  // helper: converte coord do canvas → tile
  function cvToTile(e) {
    const rect = genCv.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    return { tx: Math.floor((mx - vpX) / (TILE_PX * vpZoom)), ty: Math.floor((my - vpY) / (TILE_PX * vpZoom)) };
  }
  function paintTile(e) {
    if (!brushItem || !lastGrid) return;
    const { tx, ty } = cvToTile(e);
    if (tx < 0 || ty < 0 || tx >= lastGrid.W || ty >= lastGrid.H) return;
    paintMap.set(tx+','+ty, brushItem);
    drawPreview(lastGrid);
  }

  let _vpDrag = null, _vpMoved = false, _painting = false;
  genCv.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if ((gs('genShape')||'rect')==='polygon' && !e.shiftKey && lastGrid) {
      // modo polígono: clique adiciona um canto (shift+arrasta = pan)
      const { tx, ty } = cvToTile(e);
      if (tx>=0 && ty>=0 && tx<lastGrid.W && ty<lastGrid.H) { genPoly.push([(tx+0.5)/lastGrid.W,(ty+0.5)/lastGrid.H]); lastGrid=buildGrid(); lastFinish=computeFinish(lastGrid); drawPreview(lastGrid); }
      return;
    }
    if (brushItem && !e.shiftKey) {
      // modo pintura
      _painting = true; paintTile(e);
    } else {
      // modo pan (sem pincel OU shift pressionado)
      _vpDrag = { ox: e.clientX - vpX, oy: e.clientY - vpY, cx: e.clientX, cy: e.clientY };
      _vpMoved = false;
    }
  });
  // botão direito no polígono: remove o último canto
  genCv.addEventListener('contextmenu', (e) => {
    if ((gs('genShape')||'rect')!=='polygon') return;
    e.preventDefault(); if (genPoly.length) { genPoly.pop(); if (lastGrid) { lastGrid=buildGrid(); lastFinish=computeFinish(lastGrid); drawPreview(lastGrid); } }
  });
  const _vpMove = (e) => {
    if (_painting) { paintTile(e); return; }
    if (!_vpDrag) return;
    if (Math.abs(e.clientX-_vpDrag.cx)>3||Math.abs(e.clientY-_vpDrag.cy)>3) _vpMoved = true;
    if (_vpMoved) { vpX = e.clientX - _vpDrag.ox; vpY = e.clientY - _vpDrag.oy; if (lastGrid) drawPreview(lastGrid); }
  };
  const _vpUp = (e) => {
    if (_painting) { _painting = false; lastFinish = computeFinish(lastGrid); drawPreview(lastGrid); return; }
    if (!_vpDrag) return;
    if (!_vpMoved && lastGrid && !brushItem) {
      // click sem pincel: abre paleta p/ extra item
      const { tx, ty } = cvToTile(e);
      if (tx >= 0 && ty >= 0 && tx < lastGrid.W && ty < lastGrid.H) {
        openMinPalette(genCv, (item) => { extraItems.set(tx+','+ty, item); drawPreview(lastGrid); });
      }
    }
    _vpDrag = null;
  };
  document.addEventListener('mousemove', _vpMove);
  document.addEventListener('mouseup', _vpUp);
  // limpa listeners ao fechar o modal
  cancelBtn.addEventListener('click', () => { document.removeEventListener('mousemove',_vpMove); document.removeEventListener('mouseup',_vpUp); }, { once:true });
  applyBtn.addEventListener('click', () => { document.removeEventListener('mousemove',_vpMove); document.removeEventListener('mouseup',_vpUp); }, { once:true });

  document.getElementById('genFitBtn').onclick = () => { if (lastGrid) { fitView(lastGrid.W, lastGrid.H); drawPreview(lastGrid); } };
  clearExtrasBtn.onclick = () => { extraItems.clear(); if (lastGrid) drawPreview(lastGrid); };

  prevBtn.onclick = () => { lastGrid = buildGrid(); drawPreview(lastGrid); };

  // ============ PÓS-PROCESSAMENTO DO GRID (pré-carimbar) ============
  // garante que todo chão esteja conectado: mantém a maior região, cava túnel das demais até ela (descarta micro)
  function gridConnect(grid, W, H, rng) {
    const comp = new Int32Array(W*H).fill(-1); const regions = [];
    for (let i=0;i<W*H;i++){ if(grid[i]===0||comp[i]>=0) continue;
      const id=regions.length; const cells=[]; const stack=[i]; comp[i]=id;
      while(stack.length){ const p=stack.pop(); cells.push(p); const x=p%W, y=(p/W)|0;
        for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){ const nx=x+dx,ny=y+dy; if(nx<0||ny<0||nx>=W||ny>=H)continue; const np=ny*W+nx; if(grid[np]!==0&&comp[np]<0){comp[np]=id;stack.push(np);} } }
      regions.push(cells);
    }
    if (regions.length<=1) return;
    regions.sort((a,b)=>b.length-a.length); const main=regions[0];
    for (let r=1;r<regions.length;r++){ const cells=regions[r];
      if (cells.length<4){ for(const p of cells) grid[p]=0; continue; } // micro-região → vira parede
      const a=cells[(rng()*cells.length)|0]; const ax=a%W, ay=(a/W)|0;
      let best=-1,bd=1e9; for(const p of main){ const px=p%W,py=(p/W)|0; const d=(px-ax)**2+(py-ay)**2; if(d<bd){bd=d;best=p;} }
      const bx=best%W, by=(best/W)|0; let x=ax,y=ay,guard=0;
      while((x!==bx||y!==by)&&guard++<W+H){ if(!grid[y*W+x])grid[y*W+x]=1; if(x!==bx)x+=Math.sign(bx-x); else y+=Math.sign(by-y); if(!grid[y*W+x])grid[y*W+x]=1; }
    }
  }
  // limpeza morfológica: remove parede solta (4 vizinhos chão) e chão isolado (4 vizinhos parede)
  function gridCleanup(grid, W, H) {
    const src=grid.slice();
    for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){ const i=y*W+x; let wn=0;
      for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]) if(src[(y+dy)*W+(x+dx)]===0) wn++;
      if(src[i]===0 && wn===0) grid[i]=1; else if(src[i]!==0 && wn===4) grid[i]=0;
    }
  }
  // value-noise 2D suave (sem libs): grade aleatória + smoothstep bilinear → terreno/bioma orgânico
  function mkValueNoise(rng){ const G=256, v=new Float32Array(G*G); for(let i=0;i<G*G;i++)v[i]=rng();
    const sm=t=>t*t*(3-2*t);
    return (x,y,scale)=>{ const fx=x/scale,fy=y/scale,x0=Math.floor(fx),y0=Math.floor(fy),tx=sm(fx-x0),ty=sm(fy-y0);
      const g=(ix,iy)=>v[((iy&255)*G+(ix&255))]; const a=g(x0,y0),b=g(x0+1,y0),c=g(x0,y0+1),d=g(x0+1,y0+1);
      return (a*(1-tx)+b*tx)*(1-ty)+(c*(1-tx)+d*tx)*ty; };
  }
  // ---- resolvem brushes do material RME a partir dos ids configurados ----
  function genWallBrushName(wallId){ if(!mapBrushData) return null;
    for(const w of mapBrushData.walls){ const ww=w.walls||{}; for(const k in ww) if((ww[k]||[]).includes(wallId)) return w.name; }
    return mapBrushData.walls[0] ? mapBrushData.walls[0].name : null; }
  // classifica o id de "parede". mode: auto|wall|mountain|raw (escolhido pelo usuário)
  function genWallKind(wallId, mode){ if(!mapBrushData) return {kind:'raw'};
    if(mode==='raw') return {kind:'raw'};
    if(mode==='mountain') return {kind:'mountain', name:mapBrushData.groundToBrush.get(wallId)||null};
    if(mode==='wall'){ const n=genWallBrushName(wallId); return n?{kind:'wall',name:n}:{kind:'raw'}; }
    // auto: detecta pelo material
    for(const w of mapBrushData.walls){ const ww=w.walls||{}; for(const k in ww) if((ww[k]||[]).includes(wallId)) return {kind:'wall',name:w.name}; }
    const gb=mapBrushData.groundToBrush.get(wallId);
    if(gb){ const b=mapBrushData.byName.get(gb); return {kind:(b&&b.optional!=null)?'mountain':'ground',name:gb}; }
    return mapBrushData.walls[0] ? {kind:'wall',name:mapBrushData.walls[0].name} : {kind:'raw'}; }
  function genGroundBrushName(id){ return mapBrushData ? mapBrushData.groundToBrush.get(id) : null; }
  function genBiomePalette(baseId){ if(!mapBrushData) return null;
    const pal=[]; const base=genGroundBrushName(baseId); if(base)pal.push(base);
    for(const b of mapBrushData.brushes){ if(pal.length>=4)break; if(b.optional==null && !pal.includes(b.name)) pal.push(b.name); }
    return pal.length>1?pal:null; }
  function genDecoDoodads(type){ if(!mapBrushData||!mapBrushData.doodads.length) return [];
    const kw={forest:['tree','bush','flower','plant','grass'],cave:['rock','stone','stalag','crystal'],dungeon:['bone','rubble','rock','torch','skull'],island:['palm','tree','rock','shell'],village:['flower','barrel','crate'],city:['lantern','flower','barrel'],river:['rock','reed','plant'],openarea:['flower','bush','rock']}[type]||[];
    let ds=mapBrushData.doodads.filter(d=>kw.some(k=>d.name.toLowerCase().includes(k)));
    if(!ds.length) ds=mapBrushData.doodads.slice(0,8);
    return ds.map(d=>d.name); }
  // escada/rampa real: tile config > doodad com nome de escada > marcador porta
  function genStairId(){ if(tileConfig.stair&&tileConfig.stair.id) return tileConfig.stair.id;
    if(mapBrushData){ for(const d of mapBrushData.doodads){ if(/stair|ladder|ramp|hole/i.test(d.name)){ const id=(d.singles&&d.singles[0])||(d.composites&&d.composites[0]&&d.composites[0][0]&&d.composites[0][0].id); if(id)return id; } } }
    return tileConfig.door.id; }
  // spawns nas salas: 1 bloco por sala, N monstros aleatórios do material, raio pela sala
  function genSpawns(rooms, ox, oy, fz, rng, per){
    if(!mapBrushData||!mapBrushData.creatures.length||!rooms||!rooms.length) return 0;
    if(typeof mapSpawnRaw==='undefined') return 0;
    if(!mapSpawnRaw){ if(!mapSpawnPath&&mapPath&&mapData.spawnFile)mapSpawnPath=path.join(path.dirname(mapPath),mapData.spawnFile); mapSpawnRaw='<?xml version="1.0"?>\n<spawns>\n</spawns>\n'; }
    const cres=mapBrushData.creatures; let added=''; const n=Math.max(1,per);
    for(const r of rooms){ const cx=ox+Math.floor(r.x+r.w/2), cy=oy+Math.floor(r.y+r.h/2); const rad=Math.max(1,Math.min(5,Math.floor(Math.min(r.w,r.h)/2)));
      let body=''; for(let i=0;i<n;i++){ const c=cres[(rng()*cres.length)|0]; const dx=((rng()*(rad*2+1))|0)-rad, dy=((rng()*(rad*2+1))|0)-rad; body+=`\t\t<monster name="${c.name}" x="${dx}" y="${dy}" z="${fz}" spawntime="60"/>\n`; }
      added+=`\t<spawn centerx="${cx}" centery="${cy}" centerz="${fz}" radius="${rad}">\n${body}\t</spawn>\n`; }
    const i=mapSpawnRaw.search(/<\/spawns>/i); if(i<0)return 0; mapSpawnRaw=mapSpawnRaw.slice(0,i)+added+mapSpawnRaw.slice(i); mapSpawnDirty=true; if(typeof parseMapSpawns==='function')parseMapSpawns();
    return rooms.length;
  }

  // ============ CARIMBA + ACABAMENTO de 1 andar (md = mapa alvo: real OU tmp do preview) ============
  function stampFloor(md, fz, g, rng, opts){
    const { W, H, grid }=g;
    const floorId=tileConfig.floor.id, wallId=tileConfig.wall.id, waterId=tileConfig.water.id, doorId=tileConfig.door.id;
    const ox=opts.ox, oy=opts.oy, stroke=opts.stroke;
    if (opts.connect) gridConnect(grid,W,H,rng);
    if (opts.clean)   gridCleanup(grid,W,H);
    // modo explícito (Parede/Montanha/Sólido) é SEMPRE respeitado; só 'auto' segue o checkbox "Paredes auto"
    const wm = tileConfig.wallMode || 'auto';
    let wk;
    if (wm==='mountain')   wk = genWallKind(wallId,'mountain');
    else if (wm==='wall')  wk = genWallKind(wallId,'wall');
    else if (wm==='raw')   wk = {kind:'raw'};
    else                   wk = opts.walls ? genWallKind(wallId,'auto') : {kind:'raw'};
    const useWallBrush = wk.kind==='wall', useMountain = (wk.kind==='mountain'||wk.kind==='ground');
    const wbObj = useWallBrush ? mapBrushData.wallByName.get(wk.name) : null;
    const wbPole = wbObj ? (wbObj.walls.pole||wbObj.walls.horizontal||wbObj.walls.vertical||Object.values(wbObj.walls)[0]) : null;
    const wbn = wk.name;
    const biome = opts.biome ? genBiomePalette(floorId) : null;      // multi-bioma
    const noise = biome ? mkValueNoise(rng) : null;
    const biomeGid = biome ? biome.map(nm=>{ const b=mapBrushData.byName.get(nm); return b?((b.items&&b.items[0])||b.lookid||floorId):floorId; }) : null;
    const mask=g.mask;
    const wallTiles=[], mountainTiles=[], floorTiles=[], doorTiles=[]; let placed=0;
    for (let y=0;y<H;y++) for (let x=0;x<W;x++){
      if (mask && !mask[y*W+x]) continue; // fora da forma (círculo/losango/polígono) → não coloca nada
      const v=grid[y*W+x]; const tx=ox+x, ty=oy+y; if(stroke)strokeTouch(tx+','+ty+','+fz);
      if (v===0){ // parede
        if (useWallBrush) { OTBM.setGround(md,tx,ty,fz,floorId); wallTiles.push([tx,ty]); }   // chão sob a parede + auto-wall
        else if (useMountain) { OTBM.setGround(md,tx,ty,fz,wallId); mountainTiles.push([tx,ty]); } // montanha c/ borda auto
        else if (wallId) OTBM.setGround(md,tx,ty,fz,wallId);
        else if (waterId) OTBM.setGround(md,tx,ty,fz,waterId);
        placed++; continue;
      }
      // chão (1 ou 2)
      let gid=floorId;
      if (biomeGid){ const nv=noise(tx,ty,opts.biomeScale||14); let bi=(nv*biomeGid.length)|0; if(bi>=biomeGid.length)bi=biomeGid.length-1; gid=biomeGid[bi]; }
      OTBM.setGround(md,tx,ty,fz,gid); floorTiles.push([tx,ty]); placed++;
      if (v===2) doorTiles.push([tx,ty]);
      if (opts.ground0){ const ex=extraItems.get(x+','+y); if(ex&&ex.id)OTBM.setTileItems(md,tx,ty,fz,[ex.id]); const pt=paintMap.get(x+','+y); if(pt&&pt.id)OTBM.setGround(md,tx,ty,fz,pt.id); }
    }
    // montanha SEMPRE precisa de borda (a borda de rocha é parte dela), mesmo com "Bordas auto" desligado
    const wantBorder = (opts.border || mountainTiles.length>0) && mapBrushData;
    // PAREDES auto (RME) — 1ª passada poste, 2ª re-segmenta pela vizinhança
    if (wbPole && wbPole[0] && wallTiles.length<=60000){
      for(const[tx,ty]of wallTiles){ const tl=OTBM.ensureTile(md,tx,ty,fz); tl.children.push({type:6,props:itemBuf2(wbPole[0]),children:[]}); }
      for(const[tx,ty]of wallTiles) RB.paintWall(mapBrushData,md,tx,ty,fz,wbn);
    }
    // PORTAS (item) nas aberturas
    if (doorId) for(const[tx,ty]of doorTiles) OTBM.setTileItems(md,tx,ty,fz,[doorId]);
    // BORDAS RME — PASSE ÚNICO (recomputa cada tile 1× em vez do borderize 3×3 = ~9× mais rápido).
    // Inclui o anel externo (tiles vazios recebem outer border). A borda de montanha cai no chão vizinho.
    if (wantBorder && (floorTiles.length+mountainTiles.length)<=90000){
      const coords = new Map();
      for(const list of [floorTiles,mountainTiles]) for(const[tx,ty]of list){
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){ const x=tx+dx,y=ty+dy,k=x+'_'+y; if(!coords.has(k))coords.set(k,[x,y]); } }
      for(const[,c]of coords){ if(stroke)strokeTouch(c[0]+','+c[1]+','+fz); OTBM.ensureTile(md,c[0],c[1],fz); } // strokeTouch p/ o undo pegar as bordas (anel externo incluso)
      for(const[,c]of coords) RB.recomputeTile(mapBrushData,md,c[0],c[1],fz); // 1 recompute por tile
      // limpa tiles do anel que ficaram totalmente vazios (sem ground e sem item)
      for(const[,c]of coords){ const key=c[0]+','+c[1]+','+fz; const t=md.map.get(key); if(t && !OTBM.getGround(t) && !t.children.some(ch=>ch.type===6)) OTBM.setTile(md,key,null); }
    }
    // tiles cobertos por borda de montanha (a montanha + seus vizinhos) → deco NÃO entra aqui (não fica sobre a borda)
    const noDeco = new Set();
    for(const[tx,ty]of mountainTiles){ for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) noDeco.add((tx+dx)+','+(ty+dy)); }
    // DECORAÇÃO — doodads escolhidos (ou auto por tipo), AGRUPADOS via ruído, com espaçamento mínimo
    if (opts.deco){ const dd=(opts.decoNames&&opts.decoNames.length)?opts.decoNames:genDecoDoodads(opts.type);
      if(dd.length){ const pct=Math.max(0,Math.min(0.8,(opts.decoPct||6)/100)); const gap=Math.max(0,opts.decoGap||0); const dn=mkValueNoise(rng); const used=new Set();
        for(const[tx,ty]of floorTiles){ if(noDeco.has(tx+','+ty)) continue; // não decora sobre a borda da montanha
          const nv=dn(tx,ty,7); if(rng() >= pct*(0.2+1.8*nv)) continue;
          if(gap>0){ let near=false; for(let dy=-gap;dy<=gap&&!near;dy++)for(let dx=-gap;dx<=gap;dx++){ if(used.has((tx+dx)+','+(ty+dy))){near=true;break;} } if(near)continue; } // espaçamento (não gruda)
          const nm=dd[(rng()*dd.length)|0]; // variedade: sorteia entre os escolhidos
          try{RB.paintDoodad(mapBrushData,md,tx,ty,fz,nm,(rng()*4)|0); used.add(tx+','+ty);}catch(e){} } } }
    // SPAWNS nas salas (só no mapa real)
    let spawns=0; if (opts.spawn && !opts.preview) spawns=genSpawns(g.rooms, ox, oy, fz, rng, opts.spawnPer||2);
    return { placed, W, H, floorTiles, spawns };
  }

  // lê os checkboxes/inputs de acabamento → opts
  function readFinishOpts(){ const chk=id=>{ const e=document.getElementById(id); return e?e.checked:false; };
    return { type:gs('genType'), border:chk('genFinBorder'), walls:chk('genFinWall'), connect:chk('genFinConnect'),
      clean:chk('genFinClean'), biome:chk('genFinBiome'), deco:chk('genFinDeco'), spawn:chk('genFinSpawn'),
      realStairs:chk('genFinStairs'), decoPct:gv('genDecoPct'), decoGap:gv('genDecoGap'), decoNames:[...genDecoSel],
      spawnPer:gv('genSpawnPer'), biomeScale:14 }; }

  applyBtn.onclick = () => {
    const ox=gv('genX'), oy=gv('genY'), oz=gv('genZ');
    const nFloors=Math.max(1,Math.min(8,gv('genFloors')||1));
    const baseSeed=gv('genSeed')||1;
    const opts={ ...readFinishOpts(), ox, oy, stroke:true };
    const stairId=genStairId();
    strokeBegin();
    let placed=0, gW=0, gH=0, totSpawns=0, prevSet=null;
    for (let f=0; f<nFloors; f++) {
      const fz=oz+f;
      const g=(f===0 && lastGrid) ? lastGrid : buildGrid(baseSeed + f*7919);
      const r=stampFloor(mapData, fz, g, mkRng(baseSeed + f*104729 + 1), { ...opts, ground0: f===0 });
      placed+=r.placed; gW=r.W; gH=r.H; totSpawns+=r.spawns;
      const curSet=new Set(r.floorTiles.map(c=>c[0]+','+c[1]));
      if (f>0 && prevSet && stairId && opts.realStairs){ let link=null; for(const k of curSet){ if(prevSet.has(k)){link=k;break;} }
        if(link){ const [lx,ly]=link.split(',').map(Number); OTBM.setTileItems(mapData,lx,ly,fz-1,[stairId]); OTBM.setTileItems(mapData,lx,ly,fz,[stairId]); } }
      prevSet=curSet;
    }
    strokeEnd(); mapData._dirty=true; _miniDirty=true;
    if (typeof mapSpawnDirty!=='undefined' && mapSpawnDirty && $('mapSave')) $('mapSave').style.display='';
    reqMap();
    $('mapStatus').textContent=`Gerado: ${gW}×${gH} · ${nFloors} andar(es) — ${placed} tiles${totSpawns?` · ${totSpawns} spawns`:''}.`;
    ov.remove();
    mapOX=ox+gW/2-20; mapOY=oy+gH/2-15; reqMap();
  };

  document.getElementById('genRandSeed').onclick = () => { document.getElementById('genSeed').value=Math.floor(Math.random()*99999); schedPreview(); };

  // ---- presets (salva tipo + opções + tiles + acabamento em localStorage) ----
  const PKEY='genPresets';
  function loadPresets(){ try{ return JSON.parse(localStorage.getItem(PKEY)||'{}'); }catch(e){ return {}; } }
  function refreshPresetList(sel){ const ps=loadPresets(); const el=document.getElementById('genPresetList'); if(!el)return; el.innerHTML='<option value="">— presets —</option>'; Object.keys(ps).sort().forEach(n=>{ const o=document.createElement('option'); o.value=n; o.textContent=n; el.appendChild(o); }); if(sel)el.value=sel; }
  function snapshotGen(){ const o={ tile:JSON.parse(JSON.stringify(tileConfig)), fields:{} };
    box.querySelectorAll('select[id^="gen"],input[id^="gen"]').forEach(el=>{ if(el.id==='genSeed')return; o.fields[el.id]=(el.type==='checkbox')?el.checked:el.value; }); return o; }
  function applyGen(o){ if(o.tile){ Object.assign(tileConfig,o.tile); buildTileRows(); }
    if(o.fields&&o.fields.genType!==undefined){ document.getElementById('genType').value=o.fields.genType; buildTypeOptions(); }
    for(const id in (o.fields||{})){ const el=document.getElementById(id); if(!el)continue; if(el.type==='checkbox')el.checked=!!o.fields[id]; else el.value=o.fields[id]; }
    schedPreview(); }
  { const sv=document.getElementById('genPresetSave'); if(sv) sv.onclick=()=>{ const n=prompt('Nome do preset:'); if(!n)return; const ps=loadPresets(); ps[n]=snapshotGen(); localStorage.setItem(PKEY,JSON.stringify(ps)); refreshPresetList(n); };
    const dl=document.getElementById('genPresetDel'); if(dl) dl.onclick=()=>{ const el=document.getElementById('genPresetList'); const n=el&&el.value; if(!n)return; const ps=loadPresets(); delete ps[n]; localStorage.setItem(PKEY,JSON.stringify(ps)); refreshPresetList(); };
    const ls=document.getElementById('genPresetList'); if(ls) ls.onchange=()=>{ const n=ls.value; if(!n)return; const ps=loadPresets(); if(ps[n])applyGen(ps[n]); };
    refreshPresetList(); }
  { const sh=document.getElementById('genShape'); if(sh) sh.onchange=()=>{ genPoly=[]; // troca de forma zera o polígono
      genCv.style.cursor = sh.value==='polygon' ? 'crosshair' : (brushItem?'crosshair':'grab');
      if(sh.value==='polygon' && $('mapStatus')) $('mapStatus').textContent='Polígono: clique no preview p/ marcar os cantos · botão direito remove o último';
      schedPreview(); }; }
  // ATUALIZAÇÃO EM TEMPO REAL: qualquer controle re-renderiza. Controles do GRID regeneram o mapa;
  // os de ACABAMENTO reusam o grid (só recalcula bordas/paredes/deco) → sem travar/piscar.
  const _GRID_IDS = new Set(['genType','genSeed','genW','genH','genRooms','genShape']);
  const _isGridCtrl = (t) => _GRID_IDS.has(t.id) || (t.closest && t.closest('#genTypeOpts'));
  const _liveOpts = (t) => ({ keepGrid: !_isGridCtrl(t), refit: (t.id==='genW'||t.id==='genH') });
  box.addEventListener('change', (e) => { const t=e.target; if (t && t.matches && t.matches('input,select,textarea')) schedPreview(_liveOpts(t)); });
  box.addEventListener('input',  (e) => { const t=e.target; if (t && t.matches && t.matches('input[type=number],input[type=text],input[type=range],input:not([type])')) schedPreview(_liveOpts(t)); });
  schedPreview();
}

function wireRmeMenu() {
  // proxies/stubs valem p/ os menus do Mapa (#mapMenu) E do Object (#objMenu)
  document.querySelectorAll('.rmeProxy').forEach((b) => { b.onclick = () => { const t = $(b.dataset.proxy); if (t) t.click(); }; });
  document.querySelectorAll('.rmeProxyChk').forEach((b) => { b.onchange = () => { const t = $(b.dataset.proxy); if (!t) return; if (t.type === 'checkbox') { t.checked = b.checked; t.dispatchEvent(new Event('change')); } else t.click(); }; });
  document.querySelectorAll('.rmeStub').forEach((b) => { b.onclick = () => alert('Recurso ainda não portado nesta versão:\n• ' + b.dataset.rme); });
  document.querySelectorAll('.rmeCatSel').forEach((b) => { b.onclick = () => { const t = document.querySelector('.objCat[data-cat="' + b.dataset.cat + '"]'); if (t) t.click(); }; }); // tabs do Object
  document.querySelectorAll('#mapMenu .rmeSelMode').forEach((b) => { b.onclick = () => { const s = $('mapSelFloor'); if (s) { s.value = b.dataset.mode; s.dispatchEvent(new Event('change')); } if ($('status')) $('status').textContent = 'Selection Mode: ' + b.dataset.mode; }; });
  document.querySelectorAll('#mapMenu .rmePalSel').forEach((b) => { b.onclick = () => { const s = $('palType'); if (s) { s.value = b.dataset.pal; s.dispatchEvent(new Event('change')); } if (typeof setMapTool === 'function') setMapTool('paint'); }; });
  const fm = $('rmeFloorMenu'); if (fm && !fm._done) { fm._done = true; for (let z = 0; z <= 15; z++) { const b = document.createElement('button'); b.textContent = 'Floor ' + z; b.onclick = () => { mapZ = z; reqMap(); }; fm.appendChild(b); } }
  if ($('mapZoomNormal')) $('mapZoomNormal').onclick = () => { mapZoom = 1; reqMap(); };
}
try { wireRmeMenu(); } catch (e) { console.error('wireRmeMenu', e); }
if ($('mapGenerate'))   $('mapGenerate').onclick   = openMapGenerator;
if ($('mapPngToOtbm')) $('mapPngToOtbm').onclick   = openPngToOtbm;
// expõe spr/mapData (live) p/ o __memstats mostrar contadores reais
window.__stats = () => ({ spr: typeof spr !== 'undefined' ? spr : null, mapData: typeof mapData !== 'undefined' ? mapData : null, composeCount: (typeof _sprCv !== 'undefined' ? _sprCv.size : 0) });

// navegador de sprites (painel direito do Object, estilo Object Builder)
if ($('sprBrowsePrev')) $('sprBrowsePrev').onclick = () => { sprBrowsePage--; renderSprPanel(); };
if ($('sprBrowseNext')) $('sprBrowseNext').onclick = () => { sprBrowsePage++; renderSprPanel(); };
if ($('objPrevZoomIn')) $('objPrevZoomIn').onclick = () => { _objPrevZoom = Math.min(8, _objPrevZoom + 0.5); applyObjPrevZoom(); };
if ($('objPrevZoomOut')) $('objPrevZoomOut').onclick = () => { _objPrevZoom = Math.max(0.5, _objPrevZoom - 0.5); applyObjPrevZoom(); };
if ($('objPrevZoomRst')) $('objPrevZoomRst').onclick = () => { _objPrevZoom = 1; applyObjPrevZoom(); };
if ($('sprBrowseFirst')) $('sprBrowseFirst').onclick = () => { sprBrowsePage = 0; renderSprPanel(); };
if ($('sprBrowseLast')) $('sprBrowseLast').onclick = () => { sprBrowsePage = 1e9; renderSprPanel(); };
if ($('sprBrowsePageInp')) $('sprBrowsePageInp').onchange = () => { const p = parseInt($('sprBrowsePageInp').value, 10); if (p > 0) { sprBrowsePage = p - 1; renderSprPanel(); } };
if ($('sprBrowseFind')) $('sprBrowseFind').onchange = () => { const v = parseInt($('sprBrowseFind').value, 10); if (v > 0) { sprBrowsePage = Math.floor((v - 1) / SPR_PER_PAGE); renderSprPanel(); } };

// ---- zoom slider (OB-style) ----
if ($('objPrevZoomSlider')) {
  $('objPrevZoomSlider').oninput = () => {
    _objPrevZoom = parseInt($('objPrevZoomSlider').value, 10) / 100;
    applyObjPrevZoom();
  };
}

// ---- Objects action bar (botões de ação do painel esquerdo) ----
if ($('obActNew'))        $('obActNew').onclick = $('objNew').onclick;
if ($('obActDup'))        $('obActDup').onclick = $('objDup').onclick;
if ($('obActImport'))     $('obActImport').onclick = doImport;
if ($('obActExport'))     $('obActExport').onclick = () => exportSelection('obd');
if ($('obActExportPng'))  $('obActExportPng').onclick = () => exportSelection('png');
if ($('obActRemove'))     $('obActRemove').onclick = removeThing;

// ---- Sprites action bar (botões de ação do painel direito) ----
if ($('sprActReplace')) $('sprActReplace').onclick = () => { if (!objSel || !dat) return alert('selecione um thing'); if (_selBrowseSpr < 1) return alert('selecione um sprite no painel de sprites'); replaceSprite(_selBrowseSpr); };
if ($('sprActImport'))  $('sprActImport').onclick = doImport;
if ($('sprActExport'))  $('sprActExport').onclick = () => { if (_selBrowseSpr > 0) exportSprite(_selBrowseSpr); else alert('selecione um sprite no painel direito'); };
if ($('sprActNew'))     $('sprActNew').onclick = () => {
  if (!spr) return alert('carregue o .spr');
  const id = spr.count + (++sprAddedCount);
  const blank = new Uint8ClampedArray(4096);
  sprEdits.set(id, blank);
  if (spr.cache) spr.cache.set(id, new Uint8ClampedArray(blank));
  _selBrowseSpr = id;
  renderSprPanel();
  $('status').textContent = `sprite em branco #${id} criado — selecione um slot no thing p/ aplicar`;
};
if ($('sprActRemove'))  $('sprActRemove').onclick = () => {
  if (!objSel || !dat) return alert('selecione um thing');
  const t = dat.category(objSel.cat).get(objSel.id); if (!t) return;
  const g = t._groups && t._groups[objGroup]; if (!g || !g.sprites || !g.sprites.length) return alert('nenhum sprite p/ remover');
  objSnapshot();
  g.sprites.pop();
  g.frames = Math.max(1, (g.frames || 1) - 1);
  if (g.durations && g.durations.length > 0) g.durations.pop();
  invalidateGfx(); datDirty = true; updateDatSaveBtn();
  selectObjThing(objSel.id);
  $('status').textContent = `removido último slot do grupo ${objGroup}`;
};

// ---- Outfit colorizer ----
function _updateColorizerVisibility() {
  const col = $('objColorizer');
  if (col) col.style.display = (objCat === 'outfits') ? '' : 'none';
}
_updateColorizerVisibility();

function _hexToRgb(hex) {
  const h = hex.replace('#', '');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

function composeOutfitColorized(t, gi, colors) {
  if (!t || !spr) return null;
  const g = t._groups && t._groups[gi]; if (!g) return composeG(t, gi, 2, 0);
  const layers = g.layers || 1; if (layers < 4) return composeG(t, gi, 2, 0);
  const W = g.width || 1, H = g.height || 1;
  const out = document.createElement('canvas'); out.width = W * 32; out.height = H * 32;
  const ctx = out.getContext('2d');
  // composita layer 0 (base) com colorização via layer 3 (mask)
  for (let h = 0; h < H; h++) for (let w = 0; w < W; w++) {
    const idxBase = ((((0 * g.pz + 0) * g.py + 0) * g.px + 2) * layers + 0) * H * W + h * W + w;
    const idxMask = ((((0 * g.pz + 0) * g.py + 0) * g.px + 2) * layers + 3) * H * W + h * W + w;
    const sidBase = (g.sprites[idxBase] > 0) ? g.sprites[idxBase] : 0;
    const sidMask = (g.sprites[idxMask] > 0) ? g.sprites[idxMask] : 0;
    const cvBase = sidBase ? spriteCanvas(sidBase) : null;
    const cvMask = sidMask ? spriteCanvas(sidMask) : null;
    const dx = (W - 1 - w) * 32, dy = (H - 1 - h) * 32;
    if (!cvBase && !cvMask) continue;
    // composita layers 1 e 2 normalmente
    for (let l = 1; l <= 2; l++) {
      const idxL = ((((0 * g.pz + 0) * g.py + 0) * g.px + 2) * layers + l) * H * W + h * W + w;
      const sL = g.sprites[idxL]; if (sL > 0) { const cL = spriteCanvas(sL); if (cL) ctx.drawImage(cL, dx, dy); }
    }
    if (!cvBase || !cvMask) { if (cvBase) ctx.drawImage(cvBase, dx, dy); continue; }
    // aplica máscara de cor ao base
    const offBase = document.createElement('canvas'); offBase.width = 32; offBase.height = 32;
    const bCtx = offBase.getContext('2d'); bCtx.drawImage(cvBase, 0, 0);
    const offMask = document.createElement('canvas'); offMask.width = 32; offMask.height = 32;
    const mCtx = offMask.getContext('2d'); mCtx.drawImage(cvMask, 0, 0);
    const bd = bCtx.getImageData(0, 0, 32, 32); const md = mCtx.getImageData(0, 0, 32, 32);
    for (let p = 0; p < 1024; p++) {
      const o = p * 4; if (md.data[o + 3] < 10) continue;
      const mr = md.data[o], mg = md.data[o + 1], mb = md.data[o + 2];
      let col = null;
      if (mr > 200 && mg > 200 && mb < 50)  col = colors.head; // yellow → head
      else if (mr > 200 && mg < 50 && mb < 50) col = colors.body; // red → body
      else if (mr < 50 && mg > 200 && mb < 50) col = colors.legs; // green → legs
      else if (mr < 50 && mg < 50 && mb > 200) col = colors.feet; // blue → feet
      if (col) {
        bd.data[o]     = (bd.data[o]     * col.r) >> 8;
        bd.data[o + 1] = (bd.data[o + 1] * col.g) >> 8;
        bd.data[o + 2] = (bd.data[o + 2] * col.b) >> 8;
      }
    }
    bCtx.putImageData(bd, 0, 0); ctx.drawImage(offBase, dx, dy);
  }
  return out;
}

function applyColorizer() {
  if (objCat !== 'outfits' || !objSel) return;
  const t = dat && dat.category('outfits').get(objSel.id); if (!t) return;
  const colors = {
    head: _hexToRgb($('colHead').value),
    body: _hexToRgb($('colBody').value),
    legs: _hexToRgb($('colLegs').value),
    feet: _hexToRgb($('colFeet').value),
  };
  const cv = $('objInfoPrev'); if (!cv) return;
  const result = composeOutfitColorized(t, objGroup, colors);
  if (result) { const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(result, 0, 0, cv.width, cv.height); }
}

['colHead', 'colBody', 'colLegs', 'colFeet'].forEach((id) => {
  const el = $(id); if (!el) return;
  el.oninput = () => {
    const numId = id + 'N';
    // sincronizar número (0-215, cor OT) — aproximação simples: índice 0
    applyColorizer();
  };
});


// Hide empty objects (OB)
if ($('objHideEmpty')) $('objHideEmpty').onclick = () => { objHideEmpty = !objHideEmpty; $('objHideEmpty').textContent = 'Hide empty objects: ' + (objHideEmpty ? 'ON' : 'OFF'); objPage = 0; renderObjGrid(); };

// Object Viewer (OB): thing em tamanho grande + direção + animação
function objViewer() {
  if (!dat || !objSel) return alert('selecione um thing primeiro');
  const t = dat.category(objSel.cat).get(objSel.id); if (!t) return;
  if (spr && spr.warm) spr.warm((t.sprites || []).filter((s) => s > 0));
  const ov = document.createElement('div'); ov.className = 'modal';
  const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '460px';
  box.innerHTML = `<h3>Object Viewer — #${objSel.id}</h3><div class="alabel" style="font-size:11px">w${t.width} h${t.height} · layers ${t.layers} · px ${t.px} py ${t.py} · frames ${t.frames}</div>`;
  const sc = 3; const cv = document.createElement('canvas'); cv.width = t.width * 32 * sc; cv.height = t.height * 32 * sc;
  cv.style.cssText = 'image-rendering:pixelated;display:block;margin:10px auto;background:#0b0d12;border:1px solid #2a3145'; box.appendChild(cv);
  let x = 0, a = 0, anim = null;
  const draw = () => { const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, cv.width, cv.height); const c = composeThing(t, x, a); if (c) ctx.drawImage(c, 0, 0, cv.width, cv.height); };
  draw(); if (spr && spr.warm) spr.warm((t.sprites || []).filter((s) => s > 0)).then(draw);
  const ctrls = document.createElement('div'); ctrls.style.cssText = 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap';
  const dirBtn = document.createElement('button'); dirBtn.className = 'miniBtn'; dirBtn.textContent = '↻ direção (' + t.px + ')'; dirBtn.onclick = () => { x = (x + 1) % Math.max(1, t.px); draw(); };
  const animBtn = document.createElement('button'); animBtn.className = 'miniBtn'; animBtn.textContent = '▶ animar'; animBtn.onclick = () => { if (anim) { clearInterval(anim); anim = null; animBtn.textContent = '▶ animar'; } else if (t.frames > 1) { anim = setInterval(() => { a = (a + 1) % t.frames; draw(); }, 200); animBtn.textContent = '⏸ pausar'; } };
  ctrls.append(dirBtn, animBtn); box.appendChild(ctrls);
  const foot = document.createElement('div'); foot.className = 'modalFoot'; const cl = document.createElement('button'); cl.className = 'miniBtn accent'; cl.textContent = 'Fechar'; cl.onclick = () => { if (anim) clearInterval(anim); ov.remove(); }; foot.appendChild(cl); box.appendChild(foot);
  ov.appendChild(box); document.body.appendChild(ov);
}
if ($('objViewerBtn')) $('objViewerBtn').onclick = objViewer;
if ($('objCompileAs')) $('objCompileAs').onclick = compileAs;
if ($('objBulkEdit')) $('objBulkEdit').onclick = () => bulkEditFlags();

// ===== Animation Editor (OB): durações por frame + modo/loop/start do grupo primário =====
function animEditor() {
  if (!dat || !objSel) return alert('selecione um thing');
  const t = dat.category(objSel.cat).get(objSel.id); if (!t) return;
  const g = t._groups[t._primary];
  if (!g || g.frames <= 1) return alert('esse thing não tem animação (frames = 1)');
  if (assetsMode) return alert('edição não disponível no formato 15.x (só visualização)');
  const ov = document.createElement('div'); ov.className = 'modal';
  const box = document.createElement('div'); box.className = 'modalBox'; box.style.maxWidth = '420px';
  box.innerHTML = `<h3>Animation Editor — #${objSel.id} (${g.frames} frames)</h3>`;
  const opt = document.createElement('div'); opt.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;font-size:12px';
  opt.innerHTML = `<label>modo <select id="aeMode"><option value="0">async</option><option value="1">sync</option></select></label>
    <label>loop <input id="aeLoop" type="number" value="${g.loopCount || 0}" style="width:60px"></label>
    <label>start <input id="aeStart" type="number" value="${g.startFrame || 0}" style="width:50px"></label>`;
  box.appendChild(opt);
  const durs = (g.durations || Array(g.frames).fill(0).map(() => ({ min: 100, max: 100 }))).map((d) => ({ min: d.min, max: d.max }));
  const grid = document.createElement('div'); grid.style.cssText = 'display:grid;grid-template-columns:auto 1fr 1fr;gap:4px;align-items:center;max-height:320px;overflow:auto';
  grid.innerHTML = '<b>frame</b><b>min(ms)</b><b>max(ms)</b>';
  const inMin = [], inMax = [];
  for (let i = 0; i < g.frames; i++) { const l = document.createElement('span'); l.textContent = i; const a = document.createElement('input'); a.type = 'number'; a.value = durs[i].min; const b = document.createElement('input'); b.type = 'number'; b.value = durs[i].max; inMin.push(a); inMax.push(b); grid.append(l, a, b); }
  box.appendChild(grid);
  opt.querySelector('#aeMode').value = String(g.animMode || 0);
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const ap = document.createElement('button'); ap.className = 'miniBtn accent'; ap.textContent = 'Aplicar';
  ap.onclick = () => {
    const nd = []; for (let i = 0; i < g.frames; i++) nd.push({ min: parseInt(inMin[i].value, 10) || 100, max: parseInt(inMax[i].value, 10) || 100 });
    objSnapshot(); dat.setAnimation(t, objSel.cat, { animMode: +opt.querySelector('#aeMode').value, loopCount: parseInt(opt.querySelector('#aeLoop').value, 10) || 0, startFrame: parseInt(opt.querySelector('#aeStart').value, 10) || 0, durations: nd }, t._primary);
    datDirty = true; updateDatSaveBtn(); selectObjThing(objSel.id); ov.remove(); $('status').textContent = 'animação aplicada — 💾 Salvar .dat';
  };
  const cl = document.createElement('button'); cl.className = 'miniBtn'; cl.textContent = 'fechar'; cl.onclick = () => ov.remove();
  foot.append(ap, cl); box.appendChild(foot); ov.appendChild(box); document.body.appendChild(ov);
}
if ($('objAnimEditor')) $('objAnimEditor').onclick = animEditor;

// ===== Frame Durations Optimizer (OB): duração uniforme em TODAS as animações =====
function fdOptimizer() {
  if (!dat) return alert('carregue .dat'); if (assetsMode) return alert('não disponível no 15.x');
  const ms = parseInt(prompt('Duração uniforme (ms) para TODAS as animações:', '100'), 10); if (!ms) return;
  let n = 0;
  for (const cat of ['items', 'outfits', 'effects', 'missiles']) for (const [id, t] of dat.category(cat)) {
    let any = false; const groups = t._groups.map((g, i) => { const ng = dat._normGroup(g, i); if (ng.frames > 1) { ng.durations = Array(ng.frames).fill(0).map(() => ({ min: ms, max: ms })); any = true; } return ng; });
    if (any) { const attrs = t._attrs.map((a) => ({ canon: a.canon, data: a.data })); Object.assign(t, dat._serializeFull(cat, attrs, groups, t._primary)); n++; }
  }
  datDirty = true; updateDatSaveBtn(); if (objSel) selectObjThing(objSel.id); $('status').textContent = `Frame Durations: ${n} things → ${ms}ms — 💾 Salvar .dat`;
}
if ($('objFdOpt')) $('objFdOpt').onclick = fdOptimizer;

// ===== Frame Groups Converter (OB): outfits idle+walk <-> grupo único =====
function fgConverter() {
  if (!dat) return alert('carregue .dat'); if (assetsMode) return alert('não disponível no 15.x');
  const add = confirm('OK = adicionar grupo Walk em TODOS os outfits (idle+walk).\nCancelar = mesclar p/ grupo ÚNICO.');
  let n = 0;
  for (const [id, t] of dat.outfits) {
    if (add && t._groups.length < 2) { dat.addFrameGroup(t, 'outfits'); n++; }
    else if (!add && t._groups.length > 1) { while (t._groups.length > 1) dat.removeFrameGroup(t, 'outfits', 1); n++; }
  }
  datDirty = true; updateDatSaveBtn(); if (objSel) selectObjThing(objSel.id); renderObjGrid(); $('status').textContent = `Frame Groups: ${n} outfits ${add ? '→ idle+walk' : '→ único'} — 💾 Salvar .dat`;
}
if ($('objFgConv')) $('objFgConv').onclick = fgConverter;

// ===== Sprites Optimizer (OB): remove sprites duplicados e reaponta p/ o canônico =====
async function spritesOptimizer() {
  if (!dat || !spr) return alert('carregue .dat/.spr'); if (assetsMode) return alert('não disponível no 15.x');
  const used = new Set();
  for (const cat of ['items', 'outfits', 'effects', 'missiles']) for (const t of dat.category(cat).values()) for (const g of t._groups) for (const s of (g.sprites || [])) if (s > 0) used.add(s);
  $('status').textContent = `Sprites Optimizer: aquecendo ${used.size} sprites…`;
  if (spr.warm) await spr.warm([...used]);
  const byHash = new Map(); const remap = new Map();
  const key = (px) => { if (!px) return 'E'; let h = 0; for (let i = 0; i < px.length; i += 17) h = (h * 31 + px[i]) >>> 0; return h + ':' + px.length; };
  for (const sid of [...used].sort((a, b) => a - b)) {
    const px = spr.sprite(sid); const k = key(px); const bucket = byHash.get(k);
    let canon = null;
    if (bucket) for (const c of bucket) { const cp = spr.sprite(c); if (sameArr(cp, px)) { canon = c; break; } }
    if (canon) remap.set(sid, canon); else { if (!bucket) byHash.set(k, [sid]); else bucket.push(sid); }
  }
  if (!remap.size) { $('status').textContent = 'Sprites Optimizer: nenhum duplicado.'; return; }
  if (!confirm(`${remap.size} sprites duplicados achados. Reapontar os things p/ os canônicos? (reduz .spr ao recompilar)`)) return;
  let n = 0;
  for (const cat of ['items', 'outfits', 'effects', 'missiles']) for (const t of dat.category(cat).values()) for (const g of t._groups) for (let i = 0; i < (g.sprites || []).length; i++) { const r = remap.get(g.sprites[i]); if (r) { dat.setSpriteId(t, i, r, g); n++; } }
  datDirty = true; updateDatSaveBtn(); if (objSel) selectObjThing(objSel.id); $('status').textContent = `Sprites Optimizer: ${remap.size} duplicados, ${n} slots reapontados — 💾 Salvar .dat`;
}
function sameArr(a, b) { if (!a || !b || a.length !== b.length) return a === b; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
if ($('objSprOpt')) $('objSprOpt').onclick = () => spritesOptimizer();

// ===== Slicer (OB): PNG grande → fatia em sprites 32x32 e adiciona ao .spr =====
async function slicer() {
  if (!spr) return alert('carregue o .spr'); if (assetsMode) return alert('não disponível no 15.x');
  const f = await ipcRenderer.invoke('pick-file', ['png']); if (!f) return;
  const img = await loadPngImage(f); if (!img) return;
  const cols = Math.floor(img.width / 32), rows = Math.floor(img.height / 32);
  if (!cols || !rows) return alert('PNG menor que 32x32');
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const cx = c.getContext('2d'); cx.imageSmoothingEnabled = false; cx.drawImage(img, 0, 0);
  let added = 0; const newIds = [];
  for (let ry = 0; ry < rows; ry++) for (let rx = 0; rx < cols; rx++) {
    const d = cx.getImageData(rx * 32, ry * 32, 32, 32).data; let empty = true; for (let i = 3; i < d.length; i += 4) if (d[i]) { empty = false; break; }
    if (empty) continue;
    const nid = spr.count + (++sprAddedCount); sprEdits.set(nid, new Uint8ClampedArray(d)); newIds.push(nid); added++;
  }
  invalidateSprites(); updateObjSaveBtn && updateObjSaveBtn(); renderSprPanel();
  $('status').textContent = `Slicer: ${added} sprites adicionados (ids ${newIds[0]}–${newIds[newIds.length - 1]}) — 💾 Salvar .spr`;
}
if ($('objSlicer')) $('objSlicer').onclick = () => slicer();

// toggles de formato -> reparseia
for (const id of ['optExtended', 'optTransparency', 'optFrameGroups', 'optFrameDurations'])
  $(id).addEventListener('change', reloadGraphics);

// seletor de versão (igual o RME): força a versão do cliente e aplica o formato dela
(function initVerSel() {
  const sel = $('datVerSel'); if (!sel) return;
  const VLIST = [710, 730, 740, 750, 755, 760, 780, 790, 792, 800, 810, 811, 820, 830, 840, 841, 842, 850, 854, 855, 860, 861, 862, 870, 871, 872, 900, 910, 920, 940, 944, 946, 952, 953, 954, 960, 961, 963, 970, 980, 981, 982, 983, 985, 986, 1010, 1020, 1021, 1030, 1031, 1035, 1041, 1050, 1051, 1052, 1053, 1055, 1056, 1057, 1058, 1059, 1060, 1062, 1063, 1064, 1070, 1077, 1098, 1100];
  const lbl = (v) => Math.floor(v / 100) + '.' + String(v % 100).padStart(2, '0');
  sel.innerHTML = '<option value="auto">auto (detectar)</option>' + VLIST.map((v) => `<option value="${v}">${lbl(v)}${v >= 1071 ? '+' : ''}</option>`).join('');
  sel.value = 'auto';
  sel.onchange = () => {
    if (sel.value === 'auto') { if (datPath) detectDatFormat(datPath); }
    else {
      datVersion = parseInt(sel.value, 10);
      const f = VERS.formatFor(datVersion);
      $('optExtended').checked = f.extended; $('optFrameGroups').checked = f.frameGroups;
      $('optFrameDurations').checked = f.frameDurations; $('optTransparency').checked = datVersion >= 1050;
      $('status').textContent = 'versão forçada: ' + lbl(datVersion) + ' (extended ' + f.extended + ', frame-groups ' + f.frameGroups + ', transparência ' + (datVersion >= 1050) + ')';
    }
    reloadGraphics();
  };
})();

// ============================ LIVE (colaboração em tempo real) ============================
// Sala na nuvem (relay no servidor de licença). Sincroniza Mapa (edição + cursores), Spell, e Object (sprites/flags),
// + presença/cursor/chat em TODOS os modos. Extensível: liveOp(modo,tipo,dados) emite; LIVE_HANDLERS[modo] aplica.
const LIVE = { ws: null, id: 0, room: '', name: '', color: '#3fcf7a', connected: false, applying: false, peers: new Map(), cursors: new Map(), reconnect: false };
const LIVE_URL = () => (lsGet('live.url') || 'wss://SEU-SERVIDOR.onrender.com') + '/live';
const LIVE_COLORS = ['#3fcf7a', '#5b8cff', '#ff6a8a', '#ffc24a', '#9b6bff', '#4cd9d9', '#ff8f4c', '#7ad14a'];
function liveColorFor(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return LIVE_COLORS[h % LIVE_COLORS.length]; }
function liveStatus(t) { if ($('status')) $('status').textContent = '👥 ' + t; const el = $('liveState'); if (el) el.textContent = t; }
function liveConnect(room, name) {
  liveDisconnect(true);
  LIVE.room = (room || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24) || 'LOBBY';
  LIVE.name = (name || lsGet('live.name') || 'user' + (1000 + Math.floor(Math.random() * 9000))).slice(0, 32);
  LIVE.color = liveColorFor(LIVE.name); lsSet('live.name', LIVE.name); lsSet('live.room', LIVE.room);
  let ws; try { ws = new WebSocket(LIVE_URL()); } catch (e) { return alert('Live: URL inválida'); }
  LIVE.ws = ws; LIVE.reconnect = true; liveStatus('conectando…');
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', room: LIVE.room, name: LIVE.name, color: LIVE.color }));
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } liveOnMessage(m); };
  ws.onclose = () => { LIVE.connected = false; LIVE.id = 0; LIVE.peers.clear(); LIVE.cursors.clear(); liveRenderPanel(); liveStatus('desconectado'); if (LIVE.reconnect) setTimeout(() => { if (LIVE.reconnect) liveConnect(LIVE.room, LIVE.name); }, 4000); };
  ws.onerror = () => liveStatus('erro de conexão (servidor dormindo? tenta de novo em ~30s)');
}
function liveDisconnect(silent) { LIVE.reconnect = false; if (LIVE.ws) { try { LIVE.ws.close(); } catch (e) {} LIVE.ws = null; } LIVE.connected = false; LIVE.peers.clear(); LIVE.cursors.clear(); if (!silent) { liveRenderPanel(); liveStatus('saiu da sala'); } }
function liveSend(o) { if (LIVE.ws && LIVE.connected && LIVE.ws.readyState === 1) { try { LIVE.ws.send(JSON.stringify(o)); } catch (e) {} } }
function liveOnMessage(m) {
  switch (m.t) {
    case 'welcome': LIVE.id = m.id; LIVE.connected = true; LIVE.peers.clear(); for (const p of m.peers) LIVE.peers.set(p.id, p); liveStatus(`na sala ${m.room} · ${m.peers.length + 1} online`); liveRenderPanel(); break;
    case 'peer-join': LIVE.peers.set(m.id, { id: m.id, name: m.name, color: m.color }); liveRenderPanel(); liveChatSys(`${m.name} entrou`); break;
    case 'peer-leave': { const p = LIVE.peers.get(m.id); LIVE.peers.delete(m.id); LIVE.cursors.delete(m.id); liveRenderPanel(); if (p) liveChatSys(`${p.name} saiu`); if (mode === 'map') reqMap(); break; }
    case 'cursor': { LIVE.cursors.set(m.from, m); const p = LIVE.peers.get(m.from); if (p) { p.mode = m.mode; p.at = m.at; } liveRenderPanel(); if (mode === 'map' && m.mode === 'map') reqMap(); break; }
    case 'chat': liveChatMsg(m.from, m.text); break;
    case 'op': liveApplyOp(m); break;
    case 'error': liveStatus(m.msg); alert('Live: ' + m.msg); break;
  }
}
// ---- barramento de operações ----
function liveOp(modo, tipo, dados) { if (!LIVE.connected || LIVE.applying) return; liveSend({ t: 'op', mode: modo, type: tipo, data: dados }); }
function liveApplyOp(m) { const h = LIVE_HANDLERS[m.mode]; if (!h) return; LIVE.applying = true; try { h(m.type, m.data, m); } catch (e) { console.error('live apply', m, e); } LIVE.applying = false; }
const LIVE_HANDLERS = {
  map: (type, d) => { if (type === 'edit' && mapData) { mapApplyAction(d); } },
  spell: (type, d) => { if (type === 'set' && d && d.spell) { spell = Object.assign(spellDefault(), d.spell); if (mode === 'spell') { renderSpellForm(); spellGenLua(); } } },
  obj: (type, d) => {
    if (!dat) return;
    if (type === 'setspr') { const t = dat.category(d.cat) && dat.category(d.cat).get(d.id); if (t) { const g = t._groups && t._groups[d.gi]; dat.setSpriteId(t, d.slot, d.sid, g || undefined); datDirty = true; updateDatSaveBtn(); if (mode === 'obj') { renderObjGrid(); if (objSel && objSel.id === d.id) selectObjThing(d.id); } } }
    else if (type === 'pixel') { sprEdits.set(d.sid, new Uint8ClampedArray(d.rgba)); if (spr && spr.cache) spr.cache.set(d.sid, new Uint8ClampedArray(d.rgba)); invalidateSprites(); updateObjSaveBtn(); if (mode === 'obj') { renderObjGrid(); renderSprPanel(); if (objSel) selectObjThing(objSel.id); } }
    else if (type === 'flag') { const t = dat.category(d.cat) && dat.category(d.cat).get(d.id); if (t) { const has = t._attrs.some((a) => a.canon === d.canon); if (d.on && !has) t._attrs.push({ op: VERS.inverseRemap(d.canon, datVersion), canon: d.canon, data: Buffer.from(d.data || []) }); else if (!d.on && has) t._attrs = t._attrs.filter((a) => a.canon !== d.canon); dat.applyAttrs(t); datDirty = true; updateDatSaveBtn(); if (mode === 'obj' && objSel && objSel.id === d.id) selectObjThing(d.id); } }
  },
  // transferência do arquivo base pela sala
  file: (type, d, m) => {
    if (type === 'req') { liveShareBase(m.from); return; } // alguém pediu → mando o que tenho
    if (type === 'begin') { _liveRecv[d.fid] = { name: d.name, kind: d.kind, size: d.size, total: d.total, chunks: new Array(d.total), got: 0 }; const p = LIVE.peers.get(m.from); liveChatSys(`${(p && p.name) || 'alguém'} está enviando ${d.name} (${(d.size / 1048576).toFixed(1)}MB)…`); }
    else if (type === 'chunk') { const r = _liveRecv[d.fid]; if (!r) return; if (r.chunks[d.i] === undefined) { r.chunks[d.i] = Uint8Array.from(atob(d.b64), (c) => c.charCodeAt(0)); r.got++; } liveProgress(`📥 recebendo ${r.name}`, r.got / r.total * 100); }
    else if (type === 'end') { const r = _liveRecv[d.fid]; if (!r) return; delete _liveRecv[d.fid]; liveFinishRecv(r); }
  },
};
let _liveRecv = {};
let _liveProgT = null;
function liveProgress(label, pct) { const p = $('liveProg'); if (!p) return; p.style.display = ''; const l = $('liveProgLbl'), b = $('liveProgBar'); if (l) l.textContent = label; if (b) b.style.width = Math.max(0, Math.min(100, pct)) + '%'; clearTimeout(_liveProgT); }
function liveProgressDone(label) { const p = $('liveProg'); if (!p) return; const l = $('liveProgLbl'), b = $('liveProgBar'); if (b) b.style.width = '100%'; if (l && label) l.textContent = label; clearTimeout(_liveProgT); _liveProgT = setTimeout(() => { p.style.display = 'none'; if (b) b.style.width = '0%'; }, 1500); }
async function liveFinishRecv(r) {
  let total = 0; for (const c of r.chunks) if (c) total += c.length;
  const buf = new Uint8Array(total); let off = 0; for (const c of r.chunks) { if (!c) continue; buf.set(c, off); off += c.length; }
  if (buf.length < r.size) { liveProgressDone(`⚠ ${r.name} incompleto`); return void liveStatus(`⚠ ${r.name} chegou incompleto (${buf.length}/${r.size})`); }
  liveProgressDone(`📥 ${r.name} recebido ✓`);
  let dir; try { dir = await window.__TAURI__.core.invoke('tmp_dir'); } catch (e) { return void alert('não consegui pasta temp p/ salvar o recebido'); }
  const out = (dir.replace(/[\\/]+$/, '')) + '\\' + r.name.replace(/[^\w.\- ]+/g, '_');
  try { fs.writeFileSync(out, buf); } catch (e) { return void alert('erro salvando recebido: ' + e); }
  liveChatSys(`✅ recebido ${r.name} — carregando…`);
  if (r.kind === 'map') { mapPath = out; lsSet('mapPath', out); loadMapFile(out); setMode('map'); }
  else if (r.kind === 'dat') { assetsMode = false; datPath = out; lsSet('datPath', out); detectDatFormat(out); reloadGraphics(); }
  else if (r.kind === 'spr') { assetsMode = false; sprPath = out; lsSet('sprPath', out); reloadGraphics(); }
  liveStatus(`${r.name} carregado (do parceiro)`);
}
// envia 1 arquivo (por caminho) em chunks; toId opcional = só p/ aquele peer, senão p/ sala toda
async function liveSendFile(p, kind, toId) {
  if (!LIVE.connected) return;
  let size; try { size = await window.__TAURI__.core.invoke('file_size', { path: p }); } catch (e) { return; }
  const name = p.split(/[\\/]/).pop();
  const fid = kind + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const CH = 120 * 1024; const total = Math.ceil(size / CH) || 1;
  liveSend({ t: 'op', mode: 'file', type: 'begin', to: toId, data: { fid, name, kind, size, total } });
  for (let i = 0; i < total; i++) {
    let bytes; try { const ab = await window.__TAURI__.core.invoke('read_file_chunk', { path: p, offset: i * CH, len: CH }); bytes = new Uint8Array(ab); } catch (e) { liveStatus('erro lendo ' + name); return; }
    let bin = ''; for (let k = 0; k < bytes.length; k++) bin += String.fromCharCode(bytes[k]); const b64 = btoa(bin);
    liveSend({ t: 'op', mode: 'file', type: 'chunk', to: toId, data: { fid, i, b64 } });
    if (i % 6 === 5) await new Promise((r) => setTimeout(r, 12)); // pacing (não floodar o socket)
    liveProgress(`📤 enviando ${name}`, (i + 1) / total * 100);
  }
  liveSend({ t: 'op', mode: 'file', type: 'end', to: toId, data: { fid } });
  liveProgressDone(`📤 ${name} enviado ✓`);
}
// envia TODOS os arquivos base carregados (map/.dat/.spr) — abre seletor com tamanhos
function liveShareBase(toId) {
  if (!LIVE.connected) return alert('entre numa sala primeiro');
  const avail = [];
  if (mapPath) avail.push({ kind: 'map', path: mapPath, label: 'Mapa (.otbm)' });
  if (datPath && !assetsMode) avail.push({ kind: 'dat', path: datPath, label: 'Tibia.dat' });
  if (sprPath && !assetsMode) avail.push({ kind: 'spr', path: sprPath, label: 'Tibia.spr' });
  if (!avail.length) return alert('nada carregado pra enviar (abra o mapa / .dat / .spr antes)');
  if (toId) { for (const a of avail) liveSendFile(a.path, a.kind, toId); return; } // resposta a um pedido = manda tudo direto
  document.querySelectorAll('.liveShareModal').forEach((m) => m.remove());
  const ov = document.createElement('div'); ov.className = 'modal liveShareModal'; const b = document.createElement('div'); b.className = 'modalBox'; b.style.maxWidth = '420px';
  b.innerHTML = '<h3>📤 Enviar arquivo base pra sala</h3><div class="alabel" style="font-size:11px;margin-bottom:8px">Marque o que enviar. Os outros recebem e carregam automaticamente. (.spr é grande — pode demorar)</div>';
  const boxes = [];
  for (const a of avail) { const row = document.createElement('label'); row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0'; const c = document.createElement('input'); c.type = 'checkbox'; c.checked = a.kind !== 'spr'; const sz = document.createElement('span'); sz.className = 'alabel'; sz.textContent = '…'; window.__TAURI__.core.invoke('file_size', { path: a.path }).then((s) => sz.textContent = (s / 1048576).toFixed(1) + ' MB').catch(() => {}); row.append(c, document.createTextNode(a.label + ' '), sz); b.appendChild(row); boxes.push({ c, a }); }
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const go = document.createElement('button'); go.className = 'miniBtn accent'; go.textContent = 'Enviar'; go.onclick = () => { const sel = boxes.filter((x) => x.c.checked); if (!sel.length) return; ov.remove(); (async () => { for (const x of sel) await liveSendFile(x.a.path, x.a.kind); })(); };
  const cl = document.createElement('button'); cl.className = 'miniBtn'; cl.textContent = 'Cancelar'; cl.onclick = () => ov.remove();
  foot.append(go, cl); b.appendChild(foot); ov.appendChild(b); document.body.appendChild(ov);
}
// pede pros outros me enviarem a base
function liveRequestBase() { if (!LIVE.connected) return alert('entre numa sala primeiro'); liveSend({ t: 'op', mode: 'file', type: 'req', data: {} }); liveStatus('pedindo arquivo base pros parceiros…'); }
// ---- cursores no mapa ----
function liveDrawCursors(ctx, ts) {
  if (!LIVE.connected || !LIVE.cursors.size) return;
  for (const [id, c] of LIVE.cursors) { if (c.mode !== 'map' || c.z !== mapZ) continue; const p = LIVE.peers.get(id); const col = (p && p.color) || '#fff'; const sx = (c.x - mapOX) * ts, sy = (c.y - mapOY) * ts; if (sx < -ts || sy < -ts || sx > ctx.canvas.width || sy > ctx.canvas.height) continue;
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.strokeRect(sx + 1, sy + 1, ts - 2, ts - 2);
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + 11, sy + 4); ctx.lineTo(sx + 4, sy + 11); ctx.closePath(); ctx.fill();
    const nm = (p && p.name) || ('#' + id); ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left'; const w = ctx.measureText(nm).width + 8; ctx.fillStyle = col; ctx.fillRect(sx + 12, sy - 6, w, 14); ctx.fillStyle = '#06121a'; ctx.fillText(nm, sx + 16, sy + 4); ctx.restore(); }
}
let _liveCursorT = 0;
function liveCursorMap(x, y, z) { if (!LIVE.connected) return; const n = Date.now(); if (n - _liveCursorT < 60) return; _liveCursorT = n; liveSend({ t: 'cursor', mode: 'map', x, y, z }); }
function liveCursorMode() { if (!LIVE.connected) return; liveSend({ t: 'cursor', mode, at: (mode === 'mon' && current) ? current.name : (mode === 'obj' && objSel) ? (objCat + ' #' + objSel.id) : (mode === 'spell' && spell) ? spell.name : '' }); }
// ---- UI: painel flutuante ----
function liveRenderPanel() {
  const p = $('livePanel'); if (!p) return;
  const dot = (c) => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${c};margin-right:6px;vertical-align:middle"></span>`;
  const meRow = LIVE.connected ? `<div class="liveRow">${dot(LIVE.color)}<b>${LIVE.name}</b> <span class="alabel">(você)</span></div>` : '';
  let peers = ''; for (const [id, pr] of LIVE.peers) peers += `<div class="liveRow">${dot(pr.color)}<b>${pr.name}</b> <span class="alabel">${pr.mode ? '· ' + pr.mode + (pr.at ? ' ' + pr.at : '') : ''}</span></div>`;
  $('liveUsers').innerHTML = LIVE.connected ? (meRow + peers || meRow) : '<div class="alabel">desconectado</div>';
  $('liveConnBtn').textContent = LIVE.connected ? '⏹ Sair da sala' : '▶ Entrar/Criar sala';
  $('liveState').textContent = LIVE.connected ? `sala ${LIVE.room} · ${LIVE.peers.size + 1} online` : 'fora de uma sala';
}
function liveChatPush(html) { const l = $('liveChat'); if (!l) return; const d = document.createElement('div'); d.className = 'liveMsg'; d.innerHTML = html; l.appendChild(d); l.scrollTop = l.scrollHeight; while (l.children.length > 200) l.removeChild(l.firstChild); }
function liveChatSys(t) { liveChatPush(`<span class="alabel">• ${liveEsc(t)}</span>`); }
function liveChatMsg(fromId, text) { const p = LIVE.peers.get(fromId); const nm = p ? p.name : ('#' + fromId); const col = p ? p.color : '#9fb'; liveChatPush(`<b style="color:${col}">${liveEsc(nm)}:</b> ${liveEsc(text)}`); }
function liveEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function liveInit() {
  if ($('livePanel')) return;
  const btn = document.createElement('button'); btn.id = 'liveToggle'; btn.title = 'Live — editar junto (colaboração em tempo real)'; btn.textContent = '👥 Live';
  btn.style.cssText = 'position:fixed;bottom:8px;right:12px;z-index:9000;background:#16203a;color:#bcd3ff;border:1px solid #34508a;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4)';
  const pan = document.createElement('div'); pan.id = 'livePanel';
  pan.style.cssText = 'position:fixed;bottom:44px;right:12px;width:280px;z-index:9000;background:#0e1422;border:1px solid #2a3550;border-radius:8px;padding:10px;display:none;box-shadow:0 8px 24px rgba(0,0,0,.5);font-size:12px';
  pan.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><b>👥 Live — editar junto</b><span><button id="liveHelp" title="como funciona" style="background:none;border:none;color:#7fd0ff;cursor:pointer;font-size:13px">❔ Como funciona</button><button id="liveClose" style="background:none;border:none;color:#9fb;cursor:pointer;font-size:14px">✕</button></span></div>
    <div style="display:flex;gap:4px;margin-bottom:6px"><input id="liveName" placeholder="seu nome" style="flex:1;min-width:0"/></div>
    <div style="display:flex;gap:4px;margin-bottom:6px"><input id="liveRoom" placeholder="código da sala (ex: MEUMAPA)" style="flex:1;min-width:0;text-transform:uppercase"/><button id="liveCopy" title="copiar código">⧉</button></div>
    <button id="liveConnBtn" class="primary" style="width:100%;margin-bottom:6px">▶ Entrar/Criar sala</button>
    <div style="display:flex;gap:4px;margin-bottom:6px"><button id="liveShareBtn" style="flex:1" title="enviar o mapa/.dat/.spr carregado pros outros">📤 Enviar base</button><button id="liveReqBtn" style="flex:1" title="pedir o arquivo base pros outros da sala">📥 Pedir base</button></div>
    <div id="liveState" class="alabel" style="margin-bottom:4px">fora de uma sala</div>
    <div id="liveProg" style="display:none;margin-bottom:6px"><div id="liveProgLbl" class="alabel" style="font-size:11px;margin-bottom:2px"></div><div style="height:8px;background:#0a0f1a;border:1px solid #243049;border-radius:5px;overflow:hidden"><div id="liveProgBar" style="height:100%;width:0%;background:linear-gradient(90deg,#3fcf7a,#5b8cff);transition:width .12s"></div></div></div>
    <div id="liveUsers" style="max-height:120px;overflow:auto;border-top:1px solid #243049;border-bottom:1px solid #243049;padding:4px 0;margin-bottom:6px"></div>
    <div id="liveChat" style="height:130px;overflow:auto;background:#0a0f1a;border-radius:5px;padding:5px;margin-bottom:5px"></div>
    <div style="display:flex;gap:4px"><input id="liveMsgInp" placeholder="mensagem…" style="flex:1;min-width:0"/><button id="liveSendBtn">➤</button></div>`;
  document.body.append(btn, pan);
  btn.onclick = () => { pan.style.display = pan.style.display === 'none' ? '' : 'none'; if (pan.style.display === '') { $('liveName').value = LIVE.name || lsGet('live.name') || ''; $('liveRoom').value = LIVE.room || lsGet('live.room') || ''; liveRenderPanel(); } };
  $('liveClose').onclick = () => pan.style.display = 'none';
  $('liveHelp').onclick = liveShowHelp;
  $('liveConnBtn').onclick = () => { if (LIVE.connected) { liveDisconnect(); } else { const nm = $('liveName').value.trim(); const rm = $('liveRoom').value.trim(); if (!rm) return alert('digite um código de sala (combine o mesmo código com seus amigos)'); liveConnect(rm, nm); } };
  $('liveCopy').onclick = () => { const r = $('liveRoom').value.trim(); if (r) { try { navigator.clipboard.writeText(r); } catch (e) {} liveStatus('código copiado: ' + r); } };
  $('liveShareBtn').onclick = () => liveShareBase();
  $('liveReqBtn').onclick = () => liveRequestBase();
  const sendChat = () => { const i = $('liveMsgInp'); const t = i.value.trim(); if (!t || !LIVE.connected) return; liveSend({ t: 'chat', text: t.slice(0, 500) }); liveChatPush(`<b style="color:${LIVE.color}">${liveEsc(LIVE.name)}:</b> ${liveEsc(t)}`); i.value = ''; };
  $('liveSendBtn').onclick = sendChat; $('liveMsgInp').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
  // cursor no mapa + emitir presença ao trocar de modo/seleção
  const mc = $('mapCanvas'); if (mc) mc.addEventListener('mousemove', (e) => { if (!LIVE.connected || mode !== 'map' || !mapData) return; const t = tileAt(e); if (t.inside) liveCursorMap(t.x, t.y, t.z); });
}
// emite presença (modo atual) — chamado pontualmente
function liveTouchPresence() { liveCursorMode(); }
// ---- modal de instruções "Como funciona" ----
function liveShowHelp() {
  document.querySelectorAll('.liveHelpModal').forEach((m) => m.remove());
  const ov = document.createElement('div'); ov.className = 'modal liveHelpModal';
  const b = document.createElement('div'); b.className = 'modalBox'; b.style.cssText = 'max-width:620px;max-height:84vh;overflow:auto';
  b.innerHTML = `
    <h3>👥 Live — editar junto (tempo real)</h3>
    <p class="alabel" style="font-size:12px;margin:0 0 10px">Vários editores trabalham no mesmo projeto ao mesmo tempo — estilo "Live" do RME, mas no programa inteiro.</p>

    <div class="liveHelpSec"><b>1. Entrar numa sala</b><ul>
      <li>Abra <b>👥 Live</b> (canto superior direito).</li>
      <li>Digite seu <b>nome</b> e um <b>código de sala</b> (ex: <code>MEUMAPA</code>). Inventa qualquer um.</li>
      <li>Clique <b>Entrar/Criar sala</b>. Quem digitar o <b>mesmo código</b> cai na mesma sessão.</li>
      <li>Use <b>⧉</b> pra copiar o código e mandar pros amigos (Discord, etc).</li>
    </ul></div>

    <div class="liveHelpSec"><b>2. O que sincroniza ao vivo</b><ul>
      <li>🗺 <b>Mapa</b>: pintura, borracha e bordas — e você vê o <b>cursor dos outros</b> (com nome/cor) andando no mapa.</li>
      <li>🪄 <b>Spell</b>: qualquer alteração na spell aparece pra todos na hora.</li>
      <li>🧩 <b>Object</b>: reapontar sprite de um slot, editar pixel e ligar/desligar flags.</li>
      <li>💬 <b>Presença + chat</b> em TODOS os modos: você vê quem está online e em que está mexendo (ex: "Fulano · mon Dragon").</li>
    </ul></div>

    <div class="liveHelpSec"><b>3. Enviar o arquivo base pela sala</b><ul>
      <li>Todos precisam ter o <b>mesmo arquivo base</b> (mapa .otbm / .dat / .spr). Agora dá pra mandar pela própria sala:</li>
      <li><b>📤 Enviar base</b> — manda o que você tem carregado pros outros (eles recebem e carregam sozinhos).</li>
      <li><b>📥 Pedir base</b> — pede pros parceiros te enviarem (quem tiver, manda automático).</li>
      <li>O <b>.spr é grande</b> (centenas de MB) → demora; mande de preferência só o <b>mapa</b> e o <b>.dat</b>, e combinem o .spr por fora se for pesado.</li>
      <li>Depois disso, o Live só transmite as <b>edições</b> (leve e rápido). Cada um <b>salva no próprio PC</b> (💾).</li>
    </ul></div>

    <div class="liveHelpSec"><b>4. Como funciona por dentro</b><ul>
      <li>Tudo passa por um <b>servidor de sala na nuvem</b> (o mesmo da licença). Ninguém precisa liberar porta no roteador.</li>
      <li>É <b>online</b>: funciona pela internet, não só na mesma rede.</li>
      <li>O servidor grátis "dorme" depois de 15min parado → a <b>1ª conexão</b> pode levar ~30-50s. Depois fica rápido. Se der "erro de conexão", espere e tente de novo.</li>
      <li>Máximo de <b>16 pessoas</b> por sala. Se cair, ele <b>reconecta sozinho</b>.</li>
    </ul></div>

    <div class="liveHelpSec"><b>Dicas</b><ul>
      <li>Combine quem mexe em quê pra não pintar um por cima do outro.</li>
      <li>Use o <b>chat</b> do painel pra se comunicar.</li>
      <li>Código de sala é só um texto combinado — não precisa cadastrar nada.</li>
    </ul></div>`;
  const foot = document.createElement('div'); foot.className = 'modalFoot';
  const c = document.createElement('button'); c.className = 'miniBtn accent'; c.textContent = 'Entendi'; c.onclick = () => ov.remove();
  foot.appendChild(c); b.appendChild(foot); ov.appendChild(b); document.body.appendChild(ov);
}

// start
autoLoad();
liveInit();

