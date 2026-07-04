// build-frontend.js — gera ./dist a partir de ./src e OFUSCA o JS próprio.
// O Tauri embute ./dist no .exe (frontendDist). vendor/ (CodeMirror etc.) NÃO é ofuscado.
//
//   node build-frontend.js        → copia + ofusca (produção / o que vai pro cliente)
//   node build-frontend.js --dev  → só copia (rápido, debugável — não ofusca)
//
// SEGURANÇA: se a ofuscação falhar num arquivo, o ORIGINAL (já copiado) é mantido.
// Ou seja, ofuscação nunca quebra o build — pior caso, 1 arquivo fica legível mas FUNCIONA.

const fs = require('fs');
const path = require('path');
const obfuscator = require('javascript-obfuscator');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const DEV = process.argv.includes('--dev');

// Config CONSERVADORA — embaralha nomes locais e esconde strings (base64), mas:
//  - renameGlobals:false   → preserva window.*, funções globais, comandos invoke('hwid'...)
//  - renameProperties:false→ preserva nomes de métodos/propriedades e ids do DOM
//  - controlFlowFlattening/deadCode/selfDefending OFF → sem bugs/lentidão/falso-positivo
//  - import/export de módulo (boot, TFS...) ficam intactos
const OBF = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,          // NUNCA ligar (trava com 'debugger' = falso positivo)
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: false,
  renameGlobals: false,            // CRÍTICO: preserva globais (shim ↔ renderer)
  renameProperties: false,         // CRÍTICO: preserva propriedades/ids
  selfDefending: false,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayEncoding: ['base64'], // strings somem do texto plano (Ghidra/strings.exe)
  stringArrayThreshold: 1,         // esconde 100% das strings (threshold não causa bug)
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

// pastas/arquivos que NÃO devem ser ofuscados (libs de terceiros / workers sensíveis)
const SKIP = (rel) => {
  const r = rel.replace(/\\/g, '/').toLowerCase();
  return r.includes('/vendor/') || r.startsWith('vendor/');
};

function listFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else out.push(p);
  }
  return out;
}

// 1) limpa e recria dist (cópia 1:1 de src)
fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(SRC, DIST, { recursive: true });
console.log('[build-frontend] copiado src → dist');

if (DEV) {
  console.log('[build-frontend] modo --dev: SEM ofuscar (debugável)');
  process.exit(0);
}

// 2) ofusca cada .js próprio
let ok = 0, kept = 0;
for (const file of listFiles(DIST)) {
  if (!file.toLowerCase().endsWith('.js')) continue;
  const rel = path.relative(DIST, file);
  if (SKIP(rel)) continue;
  try {
    const code = fs.readFileSync(file, 'utf8');
    const out = obfuscator.obfuscate(code, OBF).getObfuscatedCode();
    fs.writeFileSync(file, out, 'utf8');
    ok++;
  } catch (e) {
    // mantém o original (já copiado) — build nunca quebra por ofuscação
    kept++;
    console.warn('  [aviso] não ofuscou (mantido original):', rel, '—', e.message);
  }
}
console.log(`[build-frontend] ofuscados: ${ok} | mantidos originais: ${kept}`);
