// Parser + writer do items.otb (árvore binária TFS).
// Nó: 0xFE início, 0xFF fim, 0xFD escape. Item: flags(u32) + atributos {u8 attr, u16 len, data}.
// SERVERID=0x10, CLIENTID=0x11. parseFull/serializeOtb fazem round-trip byte-idêntico.
const fs = require('fs');

const NODE_START = 0xFE, NODE_END = 0xFF, ESCAPE = 0xFD;
const ATTR_SERVERID = 0x10, ATTR_CLIENTID = 0x11, ATTR_ROTATETO = 0x1E;

// --- parse simples (compat): Map<serverId, clientId> ---
function readNode(buf, pos) {
  const type = buf[pos++];
  const props = [];
  const children = [];
  while (pos < buf.length) {
    const b = buf[pos];
    if (b === ESCAPE) { props.push(buf[pos + 1]); pos += 2; continue; }
    if (b === NODE_START) { pos++; const r = readNode(buf, pos); children.push(r.node); pos = r.pos; continue; }
    if (b === NODE_END) { pos++; return { node: { type, props, children }, pos }; }
    props.push(b); pos++;
  }
  return { node: { type, props, children }, pos };
}

function loadOtb(file) {
  const buf = fs.readFileSync(file);
  let pos = 4;
  if (buf[pos] !== NODE_START) { if (buf[0] === NODE_START) pos = 0; else throw new Error('items.otb invalido (sem no raiz)'); }
  pos++;
  const { node: root } = readNode(buf, pos);
  const map = new Map();
  const rotateTo = new Map(); // serverId -> rotateTo serverId (igual RME doRotate)
  for (const child of root.children) {
    const p = child.props;
    if (p.length < 4) continue;
    let i = 4, serverId = null, clientId = null, rot = 0;
    while (i + 3 <= p.length) {
      const attr = p[i]; const len = p[i + 1] | (p[i + 2] << 8); i += 3;
      if (i + len > p.length) break;
      if (attr === ATTR_SERVERID && len === 2) serverId = p[i] | (p[i + 1] << 8);
      else if (attr === ATTR_CLIENTID && len === 2) clientId = p[i] | (p[i + 1] << 8);
      else if (attr === ATTR_ROTATETO && len === 2) rot = p[i] | (p[i + 1] << 8);
      i += len;
    }
    if (serverId != null && clientId != null) map.set(serverId, clientId);
    if (serverId != null && rot) rotateTo.set(serverId, rot);
  }
  map.rotateTo = rotateTo; // anexa no Map (callers de .get() seguem funcionando)
  return map;
}

// --- parse completo: árvore com props crus (já des-escapados) p/ editar e reescrever ---
function readNodeFull(buf, pos) {
  const type = buf[pos++];
  const props = [];
  const children = [];
  while (pos < buf.length) {
    const b = buf[pos];
    if (b === ESCAPE) { props.push(buf[pos + 1]); pos += 2; continue; }
    if (b === NODE_START) { pos++; const r = readNodeFull(buf, pos); children.push(r.node); pos = r.pos; continue; }
    if (b === NODE_END) { pos++; return { node: { type, props: Buffer.from(props), children }, pos }; }
    props.push(b); pos++;
  }
  return { node: { type, props: Buffer.from(props), children }, pos };
}

function parseFull(file) {
  const buf = fs.readFileSync(file);
  const headerFlags = buf.readUInt32LE(0);
  let pos = 4;
  if (buf[pos] !== NODE_START) throw new Error('items.otb invalido (sem no raiz)');
  pos++;
  const { node: root } = readNodeFull(buf, pos);
  return { headerFlags, root };
}

// escapa 0xFD/0xFE/0xFF nos bytes de props
function escapeBuf(buf) {
  const out = [];
  for (const b of buf) { if (b === NODE_START || b === NODE_END || b === ESCAPE) out.push(ESCAPE); out.push(b); }
  return out;
}
function writeNode(node, out) {
  out.push(NODE_START, node.type & 0xFF);
  for (const b of escapeBuf(node.props)) out.push(b);
  for (const ch of node.children) writeNode(ch, out);
  out.push(NODE_END);
}
function serializeOtb(model) {
  const out = [];
  const h = Buffer.alloc(4); h.writeUInt32LE(model.headerFlags >>> 0, 0);
  out.push(h[0], h[1], h[2], h[3]);
  writeNode(model.root, out);
  return Buffer.from(out);
}
function saveOtb(model, file) { fs.writeFileSync(file, serializeOtb(model)); }

// item node props -> { flags:u32, attrs:[{type, data:Buffer}] }
function parseItemProps(props) {
  if (props.length < 4) return { flags: 0, attrs: [] };
  const flags = props.readUInt32LE(0);
  const attrs = []; let i = 4;
  while (i + 3 <= props.length) {
    const type = props[i]; const len = props[i + 1] | (props[i + 2] << 8); i += 3;
    if (i + len > props.length) break;
    attrs.push({ type, data: Buffer.from(props.subarray(i, i + len)) }); i += len;
  }
  return { flags, attrs };
}
function buildItemProps(flags, attrs) {
  const parts = [Buffer.alloc(4)]; parts[0].writeUInt32LE(flags >>> 0, 0);
  for (const a of attrs) { const h = Buffer.alloc(3); h[0] = a.type; h.writeUInt16LE(a.data.length, 1); parts.push(h, a.data); }
  return Buffer.concat(parts);
}
function getAttr(item, type) { const a = item.attrs.find((x) => x.type === type); return a ? a.data : null; }
function setU16Attr(item, type, val) {
  let a = item.attrs.find((x) => x.type === type);
  if (!a) { a = { type, data: Buffer.alloc(2) }; item.attrs.push(a); }
  if (a.data.length < 2) a.data = Buffer.alloc(2);
  a.data.writeUInt16LE(val & 0xFFFF, 0);
}
function setBytesAttr(item, type, buf) {
  let a = item.attrs.find((x) => x.type === type);
  if (!a) { a = { type, data: Buffer.from(buf) }; item.attrs.push(a); }
  else a.data = Buffer.from(buf);
}

module.exports = { loadOtb, parseFull, serializeOtb, saveOtb, parseItemProps, buildItemProps, getAttr, setU16Attr, setBytesAttr, ATTR_SERVERID, ATTR_CLIENTID, ATTR_SPRITEHASH: 0x20 };
