// i18n PT<->EN por frases. Traduz o DOM INTEIRO e observa mudanças (MutationObserver) p/ traduzir
// QUALQUER conteúdo criado dinamicamente (painéis de módulo, listas, diálogos) — sem precisar re-chamar.
// Guarda o original PT de cada text-node/atributo (WeakMap) → alternar BR/EN é sempre a partir do original.
const PHRASES = [
  // ---- top toolbar / modos ----
  ['Editar arquivo', 'Edit file'], ['Salvar tudo', 'Save all'], ['Carregar materiais RME', 'Load RME materials'],
  ['Servidor', 'Server'], ['Validar', 'Validate'], ['Formato', 'Format'], ['Versão', 'Version'], ['cliente', 'client'],
  ['Logs de erro', 'Error logs'], ['Logs', 'Logs'], ['Health Check', 'Health Check'], ['Backup', 'Backup'], ['Quests', 'Quests'],
  ['Outfits/Mounts', 'Outfits/Mounts'], ['Dashboard', 'Dashboard'], ['Carregar assets', 'Load assets'], ['Assets', 'Assets'],
  ['Mobs', 'Mobs'], ['NPCs', 'NPCs'], ['Vocs', 'Vocs'], ['Spawns', 'Spawns'], ['Arquivos', 'Files'], ['Object', 'Object'],
  ['Economia', 'Economy'], ['Mapa', 'Map'], ['Spell', 'Spell'], ['Scripts', 'Scripts'], ['IA', 'AI'],
  // ---- mob editor ----
  ['Atributos completos do mob', 'Full mob attributes'], ['aplicar exp', 'apply exp'], ['escalar dano', 'scale damage'],
  ['Gold sugerido', 'Suggested gold'], ['Comparar mobs', 'Compare mobs'], ['Simular loot', 'Simulate loot'], ['Salvar XML', 'Save XML'],
  ['XML cru', 'Raw XML'], ['Experience', 'Experience'], ['Level alvo', 'Target level'], ['Novo mob', 'New mob'], ['Voc ref', 'Voc ref'],
  ['ataque / spell', 'attack / spell'], ['vida', 'health'], ['velocidade', 'speed'], ['chance', 'chance'], ['mana', 'mana'],
  // ---- genéricos ----
  ['Propriedades', 'Properties'], ['Estatísticas', 'Statistics'], ['Substituir', 'Replace'], ['Remover', 'Remove'], ['Adicionar', 'Add'],
  ['Importar', 'Import'], ['Exportar', 'Export'], ['Duplicar', 'Duplicate'], ['Copiar', 'Copy'], ['Colar', 'Paste'], ['Deletar', 'Delete'],
  ['Salvar como', 'Save as'], ['Salvar', 'Save'], ['Abrir', 'Open'], ['Novo', 'New'], ['Nova', 'New'], ['Cancelar', 'Cancel'], ['Fechar', 'Close'],
  ['Confirmar', 'Confirm'], ['Aplicar', 'Apply'], ['Desfazer', 'Undo'], ['Refazer', 'Redo'], ['Limpar', 'Clear'], ['Recarregar', 'Reload'],
  ['filtrar', 'filter'], ['buscar', 'search'], ['Buscar', 'Search'], ['Ferramentas', 'Tools'], ['Pasta', 'Folder'], ['Arquivo', 'File'],
  ['nome do monstro', 'monster name'], ['nome', 'name'], ['monstro', 'monster'], ['respawn', 'respawn'], ['posições', 'positions'], ['posição', 'position'],
  ['carregue', 'load'], ['carregando', 'loading'], ['carregado', 'loaded'], ['selecionado', 'selected'], ['nenhum', 'none'],
  // ---- mapa: menu Ver ----
  ['Importar/Mesclar', 'Import/Merge'], ['Espelhar horizontal', 'Flip horizontal'], ['Espelhar vertical', 'Flip vertical'], ['Rotacionar', 'Rotate'],
  ['stack completo', 'full stack'], ['overlays (zonas/spawns/towns)', 'overlays (zones/spawns/towns)'], ['andar de baixo translúcido', 'lower floor translucent'],
  ['animar itens', 'animate items'], ['minimap', 'minimap'], ['grade (grid)', 'grid'], ['casas (house tiles)', 'houses (house tiles)'], ['criaturas/spawns', 'creatures/spawns'],
  ['ghost andar de cima', 'ghost upper floor'], ['ver todos os andares acima', 'show all floors above'], ['ver todos abaixo', 'show all below'],
  ['tooltips (nome do item ao passar o mouse)', 'tooltips (item name on hover)'], ['modo in-game (sem grid/overlays)', 'in-game mode (no grid/overlays)'],
  ['render GPU (WebGL)', 'GPU render (WebGL)'], ['efeito 3D', '3D effect'], ['Borderize seleção', 'Borderize selection'], ['Borderize mapa inteiro', 'Borderize whole map'],
  ['Randomize seleção', 'Randomize selection'], ['Randomize mapa', 'Randomize map'], ['Limpar (inválidos/dups/vazios)', 'Cleanup (invalid/dups/empty)'],
  ['Achar item', 'Find item'], ['Substituir item', 'Replace item'], ['Remover item (seleção/mapa)', 'Remove item (selection/map)'],
  ['Preencher seleção com brush', 'Fill selection with brush'], ['Achar itens similares (visual)', 'Find similar items (visual)'],
  ['Exportar minimap PNG', 'Export minimap PNG'], ['Exportar mapa completo PNG (andar)', 'Export full map PNG (floor)'], ['Voltar posição', 'Back to position'],
  ['Propriedades / Towns', 'Properties / Towns'], ['Tamanho livre', 'Free size'], ['andar atual', 'current floor'], ['retângulo', 'rectangle'],
  // ---- mapa: toolbar / tool options ----
  ['navegar', 'pan'], ['selecionar', 'select'], ['pincel', 'brush'], ['balde', 'bucket fill'], ['borracha', 'eraser'], ['zona', 'zone'], ['waypoint', 'waypoint'],
  ['subir andar', 'floor up'], ['descer andar', 'floor down'], ['conta-gotas', 'eyedropper'], ['tamanho do brush', 'brush size'], ['forma do brush', 'brush shape'],
  ['iluminação', 'lighting'], ['intensidade', 'intensity'], ['ambiente', 'ambient'], ['simular caminhada', 'walk simulation'], ['borda', 'border'],
  ['Tile Properties', 'Tile Properties'], ['Map Flags', 'Map Flags'], ['Spawn / Criatura', 'Spawn / Creature'], ['só ground', 'ground only'],
  ['Zonas (flag brush)', 'Zones (flag brush)'], ['Porta (door brush)', 'Door (door brush)'], ['Forma', 'Shape'], ['girar', 'rotate'],
  ['quadrado', 'square'], ['círculo', 'circle'], ['Normal', 'Normal'], ['Trancada', 'Locked'], ['Mágica', 'Magic'], ['Janela', 'Window'],
  ['Preview Border', 'Preview Border'], ['Lock Doors', 'Lock Doors'], ['Tamanho', 'Size'],
  // ---- palette ----
  ['Terrain Palette', 'Terrain Palette'], ['Doodad Palette', 'Doodad Palette'], ['Item Palette', 'Item Palette'], ['Wall Palette', 'Wall Palette'],
  ['Door Palette', 'Door Palette'], ['Carpet Palette', 'Carpet Palette'], ['Table Palette', 'Table Palette'], ['Creature Palette', 'Creature Palette'], ['House Palette', 'House Palette'],
  ['Todos os itens', 'All items'], ['Tileset', 'Tileset'], ['Palette', 'Palette'], ['Natureza', 'Nature'],
  // ---- object ----
  ['Itens', 'Items'], ['Items', 'Items'], ['Outfits', 'Outfits'], ['Effects', 'Effects'], ['Missiles', 'Missiles'], ['Montar brush', 'Build brush'],
  ['primeira página', 'first page'], ['página anterior', 'previous page'], ['próxima página', 'next page'], ['última página', 'last page'],
  ['Salvar .spr', 'Save .spr'], ['Salvar .dat', 'Save .dat'], ['Selecionar', 'Select'], ['Deselecionar', 'Deselect'], ['Tudo', 'All'],
  ['Sprite & Animação', 'Sprite & Animation'], ['geometria', 'geometry'], ['largura', 'width'], ['altura', 'height'], ['camadas', 'layers'],
  ['Aplicar geometria', 'Apply geometry'], ['total sprites', 'total sprites'], ['slots de sprite', 'sprite slots'], ['flags / propriedades', 'flags / properties'],
  ['frames (anim)', 'frames (anim)'], ['novo total de sprites', 'new sprite total'], ['editar pixel', 'edit pixel'],
  // ---- spell / scripts ----
  ['descreva o script', 'describe the script'], ['gerar', 'generate'], ['preview', 'preview'], ['tipo de script', 'script type'],
  ['tipo', 'type'], ['nível', 'level'], ['cooldown', 'cooldown'], ['alcance', 'range'], ['área', 'area'], ['dano', 'damage'], ['cura', 'heal'],
  // ---- ai ----
  ['provedor de IA', 'AI provider'], ['modelo', 'model'], ['usar arquivo/seleção atual', 'use current file/selection'], ['Enviar', 'Send'],
  ['Peça um script, monstro, spell', 'Ask for a script, monster, spell'],
  // ---- comuns soltos ----
  ['descrição', 'description'], ['dimensões', 'dimensions'], ['tiles', 'tiles'], ['itens', 'items'], ['flags do tile', 'tile flags'],
  ['ir', 'go'], ['raio', 'radius'], ['qtd spawns', 'spawn count'], ['ações', 'actions'], ['idioma', 'language'], ['tema claro/escuro', 'light/dark theme'],
  ['atalhos do teclado', 'keyboard shortcuts'], ['salva automaticamente', 'auto saves'], ['pronto', 'ready'], ['erro', 'error'], ['aviso', 'warning'],
];

function translate(s, toEn) {
  if (!s) return s;
  for (const [pt, en] of PHRASES) { const a = toEn ? pt : en, b = toEn ? en : pt; if (a) s = s.split(a).join(b); }
  return s;
}

// ---- aplicação ao DOM (original guardado por nó) ----
const TEXT_ORIG = new WeakMap();   // text node -> string original PT
const ATTR_ORIG = new WeakMap();   // element  -> { title, ph }
let _lang = 'pt';
let _obs = null;
const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, CANVAS: 1, SVG: 1 };

function _isSkippable(el) {
  let n = el;
  while (n && n.nodeType === 1) { if (SKIP_TAGS[n.tagName] || (n.classList && n.classList.contains('CodeMirror'))) return true; n = n.parentNode; }
  return false;
}
function _setText(node, toEn) {
  if (!TEXT_ORIG.has(node)) TEXT_ORIG.set(node, node.nodeValue);
  const orig = TEXT_ORIG.get(node);
  const v = toEn ? translate(orig, true) : orig;
  if (node.nodeValue !== v) node.nodeValue = v;
}
function _setAttrs(el, toEn) {
  if (!el.getAttribute) return;
  if (el.hasAttribute('title') || el.hasAttribute('placeholder')) {
    if (!ATTR_ORIG.has(el)) ATTR_ORIG.set(el, { title: el.getAttribute('title'), ph: el.getAttribute('placeholder') });
    const a = ATTR_ORIG.get(el);
    if (a.title != null) el.setAttribute('title', toEn ? translate(a.title, true) : a.title);
    if (a.ph != null) el.setAttribute('placeholder', toEn ? translate(a.ph, true) : a.ph);
  }
}
function translateSubtree(root, toEn) {
  if (!root) return;
  if (root.nodeType === 3) { if (root.nodeValue && root.nodeValue.trim() && !_isSkippable(root.parentNode)) _setText(root, toEn); return; }
  if (root.nodeType !== 1 || _isSkippable(root)) return;
  _setAttrs(root, toEn);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) { return (n.nodeValue && n.nodeValue.trim() && !SKIP_TAGS[n.parentNode && n.parentNode.tagName] && !(n.parentNode && n.parentNode.classList && n.parentNode.classList.contains('CodeMirror'))) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
  });
  let n; while ((n = walker.nextNode())) _setText(n, toEn);
  if (root.querySelectorAll) root.querySelectorAll('[title],[placeholder]').forEach((el) => { if (!_isSkippable(el)) _setAttrs(el, toEn); });
}
function apply(doc, lang) {
  _lang = lang === 'en' ? 'en' : 'pt';
  const toEn = _lang === 'en';
  const body = (doc && doc.body) || document.body;
  translateSubtree(body, toEn);
  if (!_obs) {
    _obs = new MutationObserver((muts) => {
      const toEn2 = _lang === 'en';
      if (!toEn2) return; // em PT, conteúdo novo já nasce em PT (nada a fazer)
      for (const m of muts) for (const node of m.addedNodes) { try { translateSubtree(node, true); } catch (e) {} }
    });
    _obs.observe(body, { childList: true, subtree: true });
  }
}
module.exports = { apply, translate, PHRASES };
