// Validacao: varre mobs/NPCs e aponta erros (refs quebradas, dano positivo, etc.).
function lget(attrs, k) {
  const m = attrs.match(new RegExp('\\b' + k + '\\s*=\\s*"([^"]*)"'));
  return m ? m[1] : null;
}

// ctx: { creatureExists(lt), itemServerExists(id), indexNameFor(file) }
function validateMob(m, ctx) {
  const out = [];
  const add = (msg, sev) => out.push({ entity: m, kind: 'mob', name: m.name, msg, sev: sev || 'err' });

  if ((m.exp || 0) <= 0) add('experience zero/negativa', 'warn');
  if ((m.health || 0) <= 0) add('vida (max) zero');
  if (m.looktype > 0 && ctx.creatureExists && !ctx.creatureExists(m.looktype))
    add(`looktype ${m.looktype} nao existe no .dat`);

  for (const a of (m.loot || [])) {
    const idTxt = lget(a, 'id');
    const id = parseInt(idTxt || '0', 10);
    if (id > 0 && ctx.itemServerExists && !ctx.itemServerExists(id))
      add(`loot id ${id} fora do items.otb`);
    const chTxt = lget(a, 'chance');
    const ch = parseInt(chTxt || '0', 10);
    if (chTxt != null && (ch <= 0 || ch > 100000)) add(`loot id ${id || '?'}: chance invalida (${chTxt})`, 'warn');
  }

  for (const a of (m.attacks || [])) {
    const nm = lget(a.attrs, 'name') || 'attack';
    const mn = parseInt(lget(a.attrs, 'min') || '0', 10);
    const mx = parseInt(lget(a.attrs, 'max') || '0', 10);
    if (mn > 0 || mx > 0) add(`ataque "${nm}" com dano POSITIVO (vira cura)`);
  }

  if (ctx.indexNameFor) {
    const reg = ctx.indexNameFor(m.file);
    if (reg === null) add('nao registrado no monsters.xml', 'warn');
    else if (reg !== undefined && reg !== m.name) add(`name "${m.name}" != monsters.xml ("${reg}")`, 'warn');
  }
  return out;
}

function validateNpc(n, ctx) {
  const out = [];
  const add = (msg, sev) => out.push({ entity: n, kind: 'npc', name: n.name, msg, sev: sev || 'err' });
  for (const it of (n.items || [])) {
    if (it.id > 0 && ctx.itemServerExists && !ctx.itemServerExists(it.id))
      add(`item "${it.name}" (${it.id}) fora do items.otb`);
    if ((it.price || 0) <= 0) add(`item "${it.name}": preco zero`, 'warn');
  }
  return out;
}

function validateAll(monsters, npcs, ctx) {
  let out = [];
  for (const m of (monsters || [])) out = out.concat(validateMob(m, ctx));
  for (const n of (npcs || [])) out = out.concat(validateNpc(n, ctx));
  return out;
}

module.exports = { validateMob, validateNpc, validateAll };
