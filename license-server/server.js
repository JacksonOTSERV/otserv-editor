// Servidor de licenças do OTServ Editor (online, com auto-renovação por Mercado Pago/PIX).
// Stack: Node puro (sem dependências) + arquivo JSON como banco. Para baixo/médio volume é perfeito.
// Deploy grátis: Render.com, Railway, Fly.io, Replit, ou um VPS. Configure as variáveis de ambiente abaixo.
//
// Variáveis de ambiente:
//   PORT                 -> porta (default 8787). Os hosts setam sozinho.
//   ADMIN_TOKEN          -> senha do admin (crie uma forte). Usada pra criar/revogar licenças manualmente.
//   MP_ACCESS_TOKEN      -> Access Token do Mercado Pago (para o webhook consultar o pagamento).
//   PRICE_DAYS           -> dias adicionados por pagamento aprovado (default 30).
//   DB_FILE              -> caminho do arquivo de banco (default ./licenses.json).
//
// Endpoints:
//   GET  /                       -> health
//   POST /verify   {key,hwid}    -> valida a licença e prende o HWID na 1ª vez. -> {valid,expiry,daysLeft,reason}
//   POST /admin/create {token,email,days}  -> cria/estende uma licença manual. -> {key,expiry}
//   POST /admin/revoke {token,key}         -> revoga uma licença.
//   POST /admin/list   {token}             -> lista as licenças.
//   POST /webhook/mp             -> webhook do Mercado Pago (pagamento aprovado -> +PRICE_DAYS).

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 8787;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'troque-este-admin-token';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const ASAAS_API_KEY = process.env.ASAAS_API_KEY || '';
const ASAAS_API_URL = process.env.ASAAS_API_URL || 'https://api.asaas.com/v3'; // sandbox: https://sandbox.asaas.com/api/v3
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || ''; // opcional: token que você define no painel do Asaas
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || ''; // "whsec_..." (Stripe ▸ Webhooks ▸ Signing secret)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || ''; // "sk_live_..." — se setado, o Stripe vira a FONTE DA VERDADE (não depende de banco)
const PRICE_DAYS = parseInt(process.env.PRICE_DAYS || '30', 10);
const DB_FILE = process.env.DB_FILE || './licenses.json';

// ---- "banco" JSON ----
let db = { licenses: {}, banned: {} }; // licenses: key->{...}; banned: hwid->{reason,at}
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
if (!db.banned) db.banned = {};
const isBanned = (hwid) => !!(hwid && db.banned[String(hwid)]);
function banHwid(hwid, reason) { hwid = String(hwid || '').trim(); if (!hwid) return; db.banned[hwid] = { reason: String(reason || 'tamper').slice(0, 80), at: now() }; save(); console.log('BAN HWID', hwid, '-', reason); }
let _saveT = null;
function save() { clearTimeout(_saveT); _saveT = setTimeout(() => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('save', e); } }, 50); }
const now = () => Math.floor(Date.now() / 1000);
const newKey = () => 'OTE-' + crypto.randomBytes(12).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');

// cria ou estende uma licença por EMAIL (1 licença por email). Retorna o registro.
function upsertByEmail(email, days) {
  email = String(email || '').toLowerCase().trim();
  let lic = Object.values(db.licenses).find((l) => l.email === email);
  if (!lic) { lic = { key: newKey(), email, hwid: '', expiry: now(), active: true, created: now(), lastSeen: 0 }; db.licenses[lic.key] = lic; }
  const base = Math.max(lic.expiry, now()); // se já venceu, conta a partir de hoje
  lic.expiry = base + days * 86400; lic.active = true;
  save(); return lic;
}

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); }
function body(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); }); }
function rawBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); }); }

// verifica a assinatura do webhook do Stripe (HMAC-SHA256 com o signing secret)
function stripeVerify(raw, sigHeader, secret) {
  if (!secret) return true; // sem secret = não verifica (configure em produção!)
  try {
    const parts = Object.fromEntries((sigHeader || '').split(',').map((p) => p.split('=')));
    if (!parts.t || !parts.v1) return false;
    const expected = crypto.createHmac('sha256', secret).update(parts.t + '.' + raw).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected));
  } catch (e) { return false; }
}

// ---- Stripe como FONTE DA VERDADE (sem banco): assinatura ativa + HWID nos metadados do cliente ----
function stripeReq(method, path, formBody) {
  return new Promise((resolve) => {
    if (!STRIPE_SECRET_KEY) return resolve(null);
    const data = formBody || '';
    const r = https.request({ host: 'api.stripe.com', path: '/v1' + path, method, headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    r.on('error', () => resolve(null)); r.write(data); r.end();
  });
}
// retorna {valid, reason, expiry, daysLeft} consultando o Stripe pelo email + amarrando o HWID nos metadados
async function stripeCheck(email, hwid) {
  email = String(email || '').toLowerCase().trim(); hwid = String(hwid || '');
  const cust = await stripeReq('GET', '/customers?email=' + encodeURIComponent(email) + '&limit=1');
  const c = cust && cust.data && cust.data[0];
  if (!c) return { valid: false, reason: 'email nao encontrado no Stripe (pagou? use o mesmo email)' };
  const subs = await stripeReq('GET', '/subscriptions?customer=' + c.id + '&status=active&limit=1');
  const s = subs && subs.data && subs.data[0];
  if (!s) return { valid: false, reason: 'assinatura nao esta ativa' };
  const bound = c.metadata && c.metadata.hwid;
  if (bound && bound !== hwid) return { valid: false, reason: 'email ja ativado em outra maquina' };
  if (!bound) await stripeReq('POST', '/customers/' + c.id, 'metadata[hwid]=' + encodeURIComponent(hwid)); // amarra o HWID (persiste no Stripe)
  // periodo: API nova (dahlia) poe current_period_end no item; versoes antigas na raiz da sub.
  const item = s.items && s.items.data && s.items.data[0];
  const periodEnd = s.current_period_end || (item && item.current_period_end) || 0;
  // ja filtramos status=active, entao a sub vale; se nao tiver data legivel, libera com folga (PRICE_DAYS).
  if (!periodEnd) { const fb = now() + (Number(process.env.PRICE_DAYS || 35) * 86400); return { valid: true, reason: 'ok', expiry: fb, daysLeft: Number(process.env.PRICE_DAYS || 35) }; }
  const left = periodEnd - now();
  return { valid: left > 0, reason: left > 0 ? 'ok' : 'assinatura expirada', expiry: periodEnd, daysLeft: Math.max(0, Math.floor(left / 86400)) };
}

// consulta o email do cliente no Asaas (a partir do customer id do pagamento)
function asaasCustomerEmail(customerId) {
  return new Promise((resolve) => {
    if (!ASAAS_API_KEY || !customerId) return resolve(null);
    const u = new URL(ASAAS_API_URL + '/customers/' + customerId);
    https.get({ host: u.host, path: u.pathname + u.search, headers: { access_token: ASAAS_API_KEY } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { resolve((JSON.parse(d) || {}).email); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

// consulta um pagamento no Mercado Pago (precisa do MP_ACCESS_TOKEN)
function mpGetPayment(id) {
  return new Promise((resolve) => {
    if (!MP_ACCESS_TOKEN) return resolve(null);
    https.get({ host: 'api.mercadopago.com', path: '/v1/payments/' + id, headers: { Authorization: 'Bearer ' + MP_ACCESS_TOKEN } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); return res.end(); }
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/') return json(res, 200, { ok: true, service: 'otserv-editor-license', licenses: Object.keys(db.licenses).length });

  // ---- VERIFY (o app chama no boot) ----
  if (req.method === 'POST' && url === '/verify') {
    const { key, hwid } = await body(req);
    const id = String(key || '').trim();
    if (isBanned(hwid)) return json(res, 200, { valid: false, reason: 'banido (violação dos termos: tamper/reembolso)' });
    // Stripe é a fonte da verdade: se configurado e o input for um email → consulta direto (sem depender de banco)
    if (STRIPE_SECRET_KEY && id.includes('@')) {
      const st = await stripeCheck(id, hwid);
      return json(res, 200, st);
    }
    // senão: banco local (key OTE-... ou email criado via admin/webhook)
    const lic = db.licenses[id] || Object.values(db.licenses).find((l) => l.email === id.toLowerCase());
    if (!lic) return json(res, 200, { valid: false, reason: 'licenca/email nao encontrado (pagou? use o MESMO email da compra)' });
    if (!lic.active) return json(res, 200, { valid: false, reason: 'licenca revogada' });
    if (!lic.hwid) { lic.hwid = String(hwid || ''); save(); } // prende o HWID na 1ª ativação
    else if (lic.hwid !== String(hwid || '')) return json(res, 200, { valid: false, reason: 'licenca ja ativada em outra maquina' });
    lic.lastSeen = now(); save();
    const left = lic.expiry - now();
    if (left <= 0) return json(res, 200, { valid: false, reason: 'licenca expirada', expiry: lic.expiry, daysLeft: 0 });
    return json(res, 200, { valid: true, reason: 'ok', expiry: lic.expiry, daysLeft: Math.floor(left / 86400) });
  }

  // ---- BAN (o app reporta tamper detectado; bane o HWID permanentemente) ----
  if (req.method === 'POST' && url === '/ban') {
    const { hwid, reason } = await body(req);
    if (hwid) banHwid(hwid, reason || 'tamper');
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url === '/admin/unban') {
    const { token, hwid } = await body(req);
    if (token !== ADMIN_TOKEN) return json(res, 403, { error: 'forbidden' });
    const had = !!db.banned[String(hwid || '')]; delete db.banned[String(hwid || '')]; save();
    return json(res, 200, { ok: had });
  }
  if (req.method === 'POST' && url === '/admin/bans') {
    const { token } = await body(req);
    if (token !== ADMIN_TOKEN) return json(res, 403, { error: 'forbidden' });
    return json(res, 200, { banned: db.banned });
  }

  // ---- ADMIN ----
  if (req.method === 'POST' && url === '/admin/create') {
    const { token, email, days } = await body(req);
    if (token !== ADMIN_TOKEN) return json(res, 403, { error: 'forbidden' });
    const lic = upsertByEmail(email, parseInt(days, 10) || PRICE_DAYS);
    return json(res, 200, { key: lic.key, email: lic.email, expiry: lic.expiry });
  }
  if (req.method === 'POST' && url === '/admin/revoke') {
    const { token, key } = await body(req);
    if (token !== ADMIN_TOKEN) return json(res, 403, { error: 'forbidden' });
    const lic = db.licenses[String(key || '').trim()]; if (lic) { lic.active = false; save(); }
    return json(res, 200, { ok: !!lic });
  }
  if (req.method === 'POST' && url === '/admin/list') {
    const { token } = await body(req);
    if (token !== ADMIN_TOKEN) return json(res, 403, { error: 'forbidden' });
    return json(res, 200, { licenses: Object.values(db.licenses) });
  }

  // ---- WEBHOOK Stripe (assinatura paga/renovada -> +PRICE_DAYS no email do cliente) ----
  if (req.method === 'POST' && url === '/webhook/stripe') {
    const raw = await rawBody(req);
    if (!stripeVerify(raw, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)) return json(res, 400, { error: 'assinatura invalida' });
    let data; try { data = JSON.parse(raw); } catch (e) { return json(res, 400, { error: 'json' }); }
    const obj = (data.data && data.data.object) || {};
    // invoice.paid = renovação mensal · checkout.session.completed = 1ª compra
    if (data.type === 'invoice.paid' || data.type === 'invoice.payment_succeeded' || data.type === 'checkout.session.completed') {
      const email = obj.customer_email || (obj.customer_details && obj.customer_details.email);
      if (email) { const lic = upsertByEmail(email, PRICE_DAYS); console.log('Stripe pago:', email, '-> key', lic.key, 'expira', new Date(lic.expiry * 1000).toISOString()); }
    }
    // REEMBOLSO / CHARGEBACK / DISPUTA = ban permanente do HWID (termos: doação não-reembolsável)
    else if (data.type === 'charge.refunded' || data.type === 'refund.created' || data.type === 'charge.dispute.created' || data.type === 'charge.dispute.funds_withdrawn') {
      try {
        let custId = obj.customer; // charge.refunded já traz customer
        if (!custId && obj.charge) { const ch = await stripeReq('GET', '/charges/' + obj.charge); custId = ch && ch.customer; } // disputa traz só o charge
        if (custId) { const c = await stripeReq('GET', '/customers/' + custId); const hwid = c && c.metadata && c.metadata.hwid; if (hwid) banHwid(hwid, data.type.includes('dispute') ? 'chargeback' : 'reembolso'); else console.log('refund/dispute sem hwid no customer', custId); }
      } catch (e) { console.error('ban refund', e); }
    }
    return json(res, 200, { received: true });
  }

  // ---- WEBHOOK Asaas (pagamento recebido/confirmado -> +PRICE_DAYS no email do cliente) ----
  if (req.method === 'POST' && url === '/webhook/asaas') {
    if (ASAAS_WEBHOOK_TOKEN && req.headers['asaas-access-token'] !== ASAAS_WEBHOOK_TOKEN) return json(res, 401, { error: 'token invalido' });
    const data = await body(req);
    const ev = data && data.event;
    const pay = data && data.payment;
    if (pay && (ev === 'PAYMENT_RECEIVED' || ev === 'PAYMENT_CONFIRMED')) {
      let email = pay.email; // se não vier no payload, busca pelo customer
      if (!email && pay.customer) email = await asaasCustomerEmail(pay.customer);
      if (email) { const lic = upsertByEmail(email, PRICE_DAYS); console.log('Asaas pago:', email, '-> key', lic.key, 'expira', new Date(lic.expiry * 1000).toISOString()); }
    }
    return json(res, 200, { ok: true });
  }

  // ---- WEBHOOK Mercado Pago (pagamento aprovado -> +PRICE_DAYS no email do pagador) ----
  if (req.method === 'POST' && url === '/webhook/mp') {
    const data = await body(req);
    const payId = (data && data.data && data.data.id) || data.id;
    if (payId) {
      const pay = await mpGetPayment(payId);
      if (pay && pay.status === 'approved') {
        const email = (pay.payer && pay.payer.email) || pay.external_reference;
        if (email) { const lic = upsertByEmail(email, PRICE_DAYS); console.log('pagamento aprovado:', email, '-> key', lic.key, 'expira', new Date(lic.expiry * 1000).toISOString()); }
      }
    }
    return json(res, 200, { ok: true }); // o MP só quer 200
  }

  json(res, 404, { error: 'not found' });
});
// ====================== LIVE (colaboração em tempo real) — WebSocket em Node PURO ======================
// Relay de SALAS por CÓDIGO: o que um cliente manda é repassado aos outros da mesma sala (mesh via servidor).
// Protocolo app = JSON. Tipos: join/welcome/peer-join/peer-leave/op/cursor/chat/state. Msg com {to:id} = privada.
// Sem dependências (handshake + frames implementados na mão). Render free mantém a conexão WS viva durante a sessão.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const rooms = new Map(); // code -> Map(id -> client)
let _wsId = 0;
const wsAccept = (key) => crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
function wsSend(sock, obj) { // frame de texto servidor→cliente (sem máscara)
  let data; try { data = Buffer.from(JSON.stringify(obj)); } catch (e) { return; }
  const len = data.length; let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len >>> 0, 6); }
  try { sock.write(Buffer.concat([header, data])); } catch (e) {}
}
const roomPeers = (code, except) => { const r = rooms.get(code), out = []; if (r) for (const [id, c] of r) if (id !== except) out.push({ id, name: c.name, color: c.color }); return out; };
const wsBroadcast = (code, obj, except) => { const r = rooms.get(code); if (r) for (const [id, c] of r) if (id !== except) wsSend(c.sock, obj); };
function wsLeave(client) { const r = rooms.get(client.room); if (!r) return; r.delete(client.id); wsBroadcast(client.room, { t: 'peer-leave', id: client.id }); if (!r.size) rooms.delete(client.room); }
server.on('upgrade', (req, sock) => {
  if ((req.url || '').split('?')[0] !== '/live') return void sock.destroy();
  const key = req.headers['sec-websocket-key']; if (!key) return void sock.destroy();
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
  const client = { id: ++_wsId, sock, room: null, name: 'anon', color: '#3fcf7a' };
  let buf = Buffer.alloc(0);
  const onMsg = (txt) => {
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (m.t === 'join') {
      if (client.room) wsLeave(client);
      const code = (String(m.room || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 24)) || 'LOBBY';
      client.room = code; client.name = String(m.name || 'anon').slice(0, 32); client.color = String(m.color || '#3fcf7a').slice(0, 9);
      let r = rooms.get(code); if (!r) { r = new Map(); rooms.set(code, r); }
      if (r.size >= 16) return void wsSend(sock, { t: 'error', msg: 'sala cheia (máx 16)' });
      r.set(client.id, client);
      wsSend(sock, { t: 'welcome', id: client.id, room: code, peers: roomPeers(code, client.id) });
      wsBroadcast(code, { t: 'peer-join', id: client.id, name: client.name, color: client.color }, client.id);
      return;
    }
    if (!client.room) return;
    m.from = client.id;
    if (m.to) { const r = rooms.get(client.room), c = r && r.get(m.to); if (c) wsSend(c.sock, m); }
    else wsBroadcast(client.room, m, client.id);
  };
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0; let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 4 * 1024 * 1024) return void sock.destroy(); // cap 4MB/frame
      const need = off + (masked ? 4 : 0) + len; if (buf.length < need) break;
      let payload;
      if (masked) { const mk = buf.slice(off, off + 4); payload = Buffer.alloc(len); for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mk[i & 3]; off += 4; }
      else payload = buf.slice(off, off + len);
      buf = buf.slice(need);
      if (op === 0x8) { wsLeave(client); try { sock.end(); } catch (e) {} return; }
      else if (op === 0x9) { try { sock.write(Buffer.from([0x8a, 0])); } catch (e) {} }
      else if (op === 0x1) onMsg(payload.toString('utf8'));
    }
  });
  const bye = () => wsLeave(client);
  sock.on('close', bye); sock.on('error', bye); sock.on('end', bye);
});

server.listen(PORT, () => console.log('license-server on :' + PORT));
