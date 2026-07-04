// Lê experienceStages + rates do config.lua do servidor.
const fs = require('fs');

function loadConfig(file) {
  const raw = fs.readFileSync(file, 'latin1');
  const stages = [];
  const re = /minlevel\s*=\s*(\d+)\s*,\s*maxlevel\s*=\s*(\d+)\s*,\s*multiplier\s*=\s*([\d.]+)/gi;
  let m;
  while ((m = re.exec(raw)) !== null)
    stages.push({ min: +m[1], max: +m[2], mult: parseFloat(m[3]) });
  const num = (k, d) => { const mm = raw.match(new RegExp(k + '\\s*=\\s*([\\d.]+)')); return mm ? parseFloat(mm[1]) : d; };
  return {
    stages,
    rateExperience: num('rateExperience', 1),
    rateLoot: num('rateLoot', 1),
    rateSkill: num('rateSkill', 1),
    rateMagic: num('rateMagic', 1),
  };
}

// multiplicador de exp no level dado (stages sobrescrevem rateExperience no TFS)
function stageMult(cfg, level) {
  if (!cfg || !cfg.stages.length) return cfg ? cfg.rateExperience : 1;
  for (const s of cfg.stages) if (level >= s.min && level <= s.max) return s.mult;
  return cfg.stages[cfg.stages.length - 1].mult;
}

module.exports = { loadConfig, stageMult };
