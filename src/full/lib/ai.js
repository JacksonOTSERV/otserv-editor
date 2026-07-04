// Camada unificada de IA: 1 função chat() pra todas as APIs do mercado.
// Usa fetch global (Electron/Node 18+). Sem dependências.

const PROVIDERS = {
  openrouter: { label: 'OpenRouter (todos modelos)', url: 'https://openrouter.ai/api/v1/chat/completions', fmt: 'openai', hdr: (k) => ({ Authorization: `Bearer ${k}`, 'HTTP-Referer': 'otserv-editor', 'X-Title': 'OTServ Editor' }), models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o-mini', 'openai/gpt-4o', 'google/gemini-flash-1.5', 'deepseek/deepseek-chat', 'meta-llama/llama-3.3-70b-instruct'] },
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', fmt: 'openai', hdr: (k) => ({ Authorization: `Bearer ${k}` }), models: ['gpt-4o-mini', 'gpt-4o', 'o4-mini'] },
  anthropic: { label: 'Anthropic (Claude)', url: 'https://api.anthropic.com/v1/messages', fmt: 'anthropic', hdr: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }), models: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'] },
  gemini: { label: 'Google Gemini', fmt: 'gemini', models: ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'] },
  deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', fmt: 'openai', hdr: (k) => ({ Authorization: `Bearer ${k}` }), models: ['deepseek-chat', 'deepseek-reasoner'] },
  groq: { label: 'Groq (rápido)', url: 'https://api.groq.com/openai/v1/chat/completions', fmt: 'openai', hdr: (k) => ({ Authorization: `Bearer ${k}` }), models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
  mistral: { label: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', fmt: 'openai', hdr: (k) => ({ Authorization: `Bearer ${k}` }), models: ['mistral-large-latest', 'codestral-latest'] },
  xai: { label: 'xAI (Grok)', url: 'https://api.x.ai/v1/chat/completions', fmt: 'openai', hdr: (k) => ({ Authorization: `Bearer ${k}` }), models: ['grok-2-latest', 'grok-beta'] },
  claudecode: { label: '⭐ Claude Code CLI (grátis — usa seu login)', fmt: 'cli', hdr: () => ({}), models: ['(modelo do seu Claude Code)'], nokey: true, bin: 'claude' },
  ollama: { label: 'Ollama (local, grátis, sem key)', url: 'http://localhost:11434/api/chat', fmt: 'ollama', hdr: () => ({}), models: ['qwen2.5-coder', 'llama3.1', 'deepseek-coder-v2'], local: true, nokey: true, tags: 'http://localhost:11434/api/tags' },
  lmstudio: { label: 'LM Studio (local, sem key)', url: 'http://localhost:1234/v1/chat/completions', fmt: 'openai', hdr: () => ({}), models: ['local-model'], local: true, tags: 'http://localhost:1234/v1/models' },
  custom: { label: 'Custom (OpenAI-compat / self-host)', fmt: 'openai', hdr: (k) => (k ? { Authorization: `Bearer ${k}` } : {}), models: ['model'], local: true, custom: true },
};

// lista os modelos REALMENTE instalados num runtime local (Ollama /api/tags ou OpenAI-compat /v1/models)
async function listModels(provider, baseUrl) {
  const p = PROVIDERS[provider];
  try {
    if (provider === 'ollama') {
      const r = await fetch(p.tags); const j = await r.json();
      return (j.models || []).map((m) => m.name);
    }
    // lmstudio / custom: GET /v1/models
    const url = provider === 'custom' ? (baseUrl || '').replace(/\/chat\/completions$/, '').replace(/\/$/, '') + '/models' : p.tags;
    const r = await fetch(url); const j = await r.json();
    return (j.data || []).map((m) => m.id);
  } catch (e) { return []; }
}

// messages: [{role:'user'|'assistant', content}]. opts: {temperature, maxTokens, system}
async function chat(provider, key, model, messages, opts = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error('provedor desconhecido: ' + provider);
  const { temperature = 0.3, maxTokens = 4096, system, baseUrl } = opts;

  if (p.fmt === 'openai') {
    const url = p.url || baseUrl; // custom usa baseUrl
    if (!url) throw new Error('defina a URL do servidor (custom)');
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...p.hdr(key) }, body: JSON.stringify({ model, messages: msgs, temperature, max_tokens: maxTokens }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    if (!j.choices || !j.choices[0]) throw new Error('resposta vazia: ' + JSON.stringify(j).slice(0, 200));
    return j.choices[0].message.content;
  }
  if (p.fmt === 'anthropic') {
    const r = await fetch(p.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...p.hdr(key) }, body: JSON.stringify({ model, system, max_tokens: maxTokens, temperature, messages }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return (j.content || []).map((b) => b.text || '').join('');
  }
  if (p.fmt === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const contents = messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const body = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return (j.candidates[0].content.parts || []).map((x) => x.text).join('');
  }
  if (p.fmt === 'ollama') {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const r = await fetch(p.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: msgs, stream: false }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.message.content;
  }
  if (p.fmt === 'cli') {
    // shell out pro CLI do Claude Code (usa o login/assinatura local — sem API key)
    const { spawn } = require('child_process');
    const sys = system ? system + '\n\n' : '';
    const conv = messages.map((m) => (m.role === 'assistant' ? 'Assistant: ' : 'User: ') + m.content).join('\n\n');
    const prompt = sys + conv + '\n\nAssistant:';
    const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE; // senão o Electron roda o filho como node puro
    return await new Promise((resolve, reject) => {
      let out = '', err = '';
      const ps = spawn(p.bin || 'claude', ['-p', '--output-format', 'text'], { shell: true, env, windowsHide: true });
      ps.stdout.on('data', (d) => { out += d; });
      ps.stderr.on('data', (d) => { err += d; });
      ps.on('error', (e) => reject(new Error('Claude Code CLI: ' + e.message + ' (o comando `claude` está no PATH?)')));
      ps.on('close', (code) => code === 0 ? resolve(out.trim() || '(resposta vazia)') : reject(new Error('claude CLI saiu ' + code + ': ' + (err || out).slice(0, 300))));
      ps.stdin.write(prompt); ps.stdin.end();
    });
  }
  throw new Error('formato não suportado: ' + p.fmt);
}

const SYSTEM_PROMPT = `Você é um assistente especialista em OpenTibia: servidor TFS 1.x (Lua 5.x, revscriptsys e XML) e cliente OTCv8 (Lua + OTUI). Gere código pronto pra colar, idiomático do TFS. Quando gerar script, diga em qual pasta vai (data/scripts, data/monster, data/npc, etc). Responda em português. Seja conciso. Só blocos de código quando fizer sentido.`;

// ---- streaming (token a token via onToken) ----
async function readSSE(r, pick, emit) {
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '', full = '';
  while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) { const t = line.trim(); if (!t.startsWith('data:')) continue; const data = t.slice(5).trim(); if (data === '[DONE]' || !data) continue; try { const d = pick(JSON.parse(data)); if (d) { full += d; emit(d); } } catch (e) {} } }
  return full;
}
async function readNDJSON(r, pick, emit) {
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '', full = '';
  while (true) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) { const t = line.trim(); if (!t) continue; try { const d = pick(JSON.parse(t)); if (d) { full += d; emit(d); } } catch (e) {} } }
  if (buf.trim()) { try { const d = pick(JSON.parse(buf)); if (d) { full += d; emit(d); } } catch (e) {} }
  return full;
}
async function chatStream(provider, key, model, messages, opts = {}, onToken) {
  const p = PROVIDERS[provider]; if (!p) throw new Error('provedor desconhecido: ' + provider);
  const { temperature = 0.3, maxTokens = 4096, system, baseUrl } = opts; const emit = (s) => { if (s && onToken) onToken(s); };
  if (p.fmt === 'cli' || p.fmt === 'gemini') { const full = await chat(provider, key, model, messages, opts); emit(full); return full; }
  if (p.fmt === 'openai') {
    const url = p.url || baseUrl; const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...p.hdr(key) }, body: JSON.stringify({ model, messages: msgs, temperature, max_tokens: maxTokens, stream: true }) });
    if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw new Error((j.error && j.error.message) || ('HTTP ' + r.status)); }
    return readSSE(r, (o) => o.choices && o.choices[0] && o.choices[0].delta && o.choices[0].delta.content || '', emit);
  }
  if (p.fmt === 'anthropic') {
    const r = await fetch(p.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...p.hdr(key) }, body: JSON.stringify({ model, system, max_tokens: maxTokens, temperature, messages, stream: true }) });
    if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw new Error((j.error && j.error.message) || ('HTTP ' + r.status)); }
    return readSSE(r, (o) => (o.type === 'content_block_delta' && o.delta && o.delta.text) || '', emit);
  }
  if (p.fmt === 'ollama') {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const r = await fetch(p.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: msgs, stream: true }) });
    if (!r.body) { const full = await chat(provider, key, model, messages, opts); emit(full); return full; }
    return readNDJSON(r, (o) => o.message && o.message.content || '', emit);
  }
  const full = await chat(provider, key, model, messages, opts); emit(full); return full;
}
module.exports = { PROVIDERS, chat, chatStream, SYSTEM_PROMPT, listModels };
