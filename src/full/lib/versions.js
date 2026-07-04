// Detecta a versao do cliente pela assinatura do .dat (base no versions.xml do RME/OTC)
// e deriva o formato (extended, frame-durations, frame-groups, remap de atributos).
const fs = require('fs');

// dat signature (hex maiusc) -> { v: version, s: string }
const DAT = {
  '3DFF4B2A': { v: 710, s: '7.10' }, '411A6233': { v: 730, s: '7.30' }, '41BF619C': { v: 740, s: '7.40' },
  '42F81973': { v: 750, s: '7.50' }, '437B2B8F': { v: 755, s: '7.55' }, '439D5A33': { v: 760, s: '7.60/7.70' },
  '44CE4743': { v: 780, s: '7.80' }, '457D854E': { v: 790, s: '7.90' }, '459E7B73': { v: 792, s: '7.92' },
  '467FD7E6': { v: 800, s: '8.00' }, '475D3747': { v: 810, s: '8.10' }, '47F60E37': { v: 811, s: '8.11' },
  '486905AA': { v: 820, s: '8.20' }, '48DA1FB6': { v: 830, s: '8.30' }, '493D607A': { v: 840, s: '8.40' },
  '49B7CC19': { v: 841, s: '8.41' }, '49C233C9': { v: 842, s: '8.42' }, '4A49C5EB': { v: 850, s: '8.50 v1' },
  '4A4CC0DC': { v: 850, s: '8.50 v2' }, '4AE97492': { v: 850, s: '8.50 v3' }, '4B1E2CAA': { v: 854, s: '8.54 v1' },
  '4B0D46A9': { v: 854, s: '8.54 v2' }, '4B28B89E': { v: 854, s: '8.54 v3' }, '4B98FF53': { v: 855, s: '8.55' },
  '4C28B721': { v: 860, s: '8.60 v1' }, '4C2C7993': { v: 860, s: '8.60 v2' }, '4C6A4CBC': { v: 861, s: '8.61' },
  '4C973450': { v: 862, s: '8.62' }, '4CFE22C5': { v: 870, s: '8.70' }, '4D41979E': { v: 871, s: '8.71' },
  '4DAD1A1A': { v: 872, s: '8.72' }, '4DBAA20B': { v: 900, s: '9.00' }, '4E12DAFF': { v: 910, s: '9.10' },
  '4E807C08': { v: 920, s: '9.20' }, '4EE71DE5': { v: 940, s: '9.40' }, '4F0EEFBB': { v: 944, s: '9.44 v0' },
  '4F105168': { v: 944, s: '9.44 v1' }, '4F16C0D7': { v: 944, s: '9.44 v2' }, '4F3131CF': { v: 944, s: '9.44 v3' },
  '4F75B7AB': { v: 946, s: '9.46/9.50' }, '4F857F6C': { v: 952, s: '9.52' }, '4FA11252': { v: 953, s: '9.53' },
  '4FD5956B': { v: 954, s: '9.54' }, '4FFA74CC': { v: 960, s: '9.60' }, '50226F9D': { v: 961, s: '9.61' },
  '503CB933': { v: 963, s: '9.63' }, '5072A490': { v: 970, s: '9.70' }, '50C70674': { v: 980, s: '9.80' },
  '50D1C5B6': { v: 981, s: '9.81' }, '512CAD09': { v: 982, s: '9.82' }, '51407B67': { v: 983, s: '9.83' },
  '51641A1B': { v: 985, s: '9.85' }, '5170E904': { v: 986, s: '9.86' }, '51E3F8C3': { v: 1010, s: '10.10' },
  '5236F129': { v: 1020, s: '10.20' }, '526A5068': { v: 1021, s: '10.21' }, '52A59036': { v: 1030, s: '10.30' },
  '52AED581': { v: 1031, s: '10.31' }, '52FDFC2C': { v: 1035, s: '10.35' }, '53B6460E': { v: 1050, s: '10.50' },
  '53C8CC17': { v: 1051, s: '10.51' }, '53E898BD': { v: 1052, s: '10.52' }, '53FAD76E': { v: 1053, s: '10.53' },
  '54128727': { v: 1055, s: '10.55' }, '542143B0': { v: 1056, s: '10.56' }, '542535F9': { v: 1057, s: '10.57' },
  '542D12E7': { v: 1058, s: '10.58' }, '5434084B': { v: 1059, s: '10.59' }, '5448D9C7': { v: 1060, s: '10.60/10.61' },
  '54622638': { v: 1062, s: '10.62' }, '546B502A': { v: 1063, s: '10.63' }, '547F05BE': { v: 1064, s: '10.64' },
  '5481BB97': { v: 1070, s: '10.70' },
};

function peekSignature(file) {
  // lê a assinatura (4 primeiros bytes) via readFileSync — no Tauri o fs é cache (sem openSync).
  const b = fs.readFileSync(file);
  return b.readUInt32LE(0).toString(16).toUpperCase().padStart(8, '0');
}

function detect(file) {
  try {
    const sig = peekSignature(file);
    return { sig, ...(DAT[sig] || { v: 0, s: 'desconhecida' }) };
  } catch (e) { return { sig: '?', v: 0, s: 'erro' }; }
}

// formato derivado da versao (otfi pode sobrescrever no renderer)
function formatFor(v) {
  return {
    extended: v >= 960,
    frameDurations: v >= 1050,
    frameGroups: v >= 1057,
  };
}

// remap do opcode de atributo do .dat conforme a versao (porta do RME RemapFlag)
// retorna o valor "canonico" (8.60) que o parser entende.
function remapFlag(flag, v) {
  if (v >= 1010) {
    if (flag === 16) return 253;      // NoMoveAnimation (sem dados)
    if (flag > 16) return flag - 1;
    return flag;
  }
  if (v >= 860) return flag;          // 8.6 - 10.09: sem mudanca
  if (v >= 780) {
    if (flag === 8) return 254;       // Chargeable (sem dados)
    if (flag > 8) return flag - 1;
    return flag;
  }
  if (v >= 755) {
    if (flag === 23) return 252;      // FloorChange
    return flag;
  }
  if (v >= 740) {
    if (flag > 0 && flag <= 15) return flag + 1;
    switch (flag) {
      case 16: return 21;   // Light
      case 17: return 252;  // FloorChange
      case 18: return 30;   // FullGround
      case 19: return 25;   // Elevation
      case 20: return 24;   // Displacement
      case 22: return 28;   // MinimapColor
      case 23: return 20;   // Rotateable
      case 24: return 26;   // LyingCorpse
      case 25: return 17;   // Hangable
      case 26: return 18;   // HookSouth
      case 27: return 19;   // HookEast
      case 28: return 27;   // AnimateAlways
      default: return flag;
    }
  }
  return flag;
}

// inverso do remap: dado o flag canonico, qual opcode escrever no arquivo dessa versao
function inverseRemap(canon, v) {
  if (v >= 860 && v < 1010) return canon;                 // 8.6-10.09: identidade
  if (v >= 1010) { if (canon === 253) return 16; if (canon >= 16 && canon < 252) return canon + 1; return canon; }
  if (v >= 780) { if (canon === 254) return 8; if (canon >= 8 && canon < 252) return canon + 1; return canon; }
  return canon; // 7.x: melhor esforco
}

// versao -> assinatura u32 (primeira correspondente na tabela)
function sigForVersion(v) {
  for (const [hex, info] of Object.entries(DAT)) if (info.v === v) return parseInt(hex, 16) >>> 0;
  return null;
}

module.exports = { DAT, peekSignature, detect, formatFor, remapFlag, inverseRemap, sigForVersion };
