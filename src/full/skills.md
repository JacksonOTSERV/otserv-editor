# skills.md — Integração de IA (gerar scripts pro servidor)

Guia/spec pra plugar **todas as APIs de IA do mercado** no OTServ Editor. O usuário cola a **key** da IA que ele tiver e usa pra **gerar/explicar/corrigir scripts** do servidor (Lua TFS, XML de monstro, spells, NPC, etc).

---

## 1. Objetivo
- Painel **🤖 IA** no editor.
- Usuário escolhe **provedor** + **modelo** + cola a **API key** (fica salva local).
- Caixa de prompt + **contexto automático** (arquivo aberto, monstro/item selecionado).
- Saída da IA → **inserir no editor** / copiar / criar arquivo.
- Casos de uso: gerar monster.xml, spell.lua, action/movement/talkaction/creaturescript, NPC, loot, balancear, explicar erro, converter código.

---

## 2. Provedores suportados (todas as APIs do mercado)
Todos usam HTTP(S) + JSON. `fetch` global já existe no Electron (Node 18+).

| Provedor | Endpoint | Auth header | Formato |
|---|---|---|---|
| **OpenAI** | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer KEY` | OpenAI |
| **Anthropic (Claude)** | `https://api.anthropic.com/v1/messages` | `x-api-key: KEY` + `anthropic-version: 2023-06-01` | Anthropic |
| **Google Gemini** | `https://generativelanguage.googleapis.com/v1beta/models/MODEL:generateContent?key=KEY` | query `?key=` | Gemini |
| **DeepSeek** | `https://api.deepseek.com/chat/completions` | `Bearer KEY` | OpenAI |
| **Groq** | `https://api.groq.com/openai/v1/chat/completions` | `Bearer KEY` | OpenAI |
| **Mistral** | `https://api.mistral.ai/v1/chat/completions` | `Bearer KEY` | OpenAI |
| **xAI (Grok)** | `https://api.x.ai/v1/chat/completions` | `Bearer KEY` | OpenAI |
| **OpenRouter** ⭐ | `https://openrouter.ai/api/v1/chat/completions` | `Bearer KEY` | OpenAI |
| **Ollama (local/grátis)** | `http://localhost:11434/api/chat` | — | Ollama |

> ⭐ **OpenRouter** é o atalho pra "todas do mercado": 1 key só dá acesso a centenas de modelos (GPT, Claude, Gemini, Llama, etc). Recomendado como default.
> Formato **OpenAI** é o padrão de fato — 6 dos 9 provedores usam ele igual. Só Anthropic, Gemini e Ollama precisam de adaptador próprio.

---

## 3. Arquitetura (arquivos a criar)

```
lib/ai.js            ← camada de provedores (1 função chat() unificada)
  PROVIDERS = { openai, anthropic, gemini, deepseek, groq, mistral, xai, openrouter, ollama }
  async function chat(provider, key, model, messages, opts) → string (resposta)
  async function chatStream(...) → async iterator (streaming opcional)
  listModels(provider, key) → [modelos]  (quando a API expõe)

renderer.js          ← painel IA + wiring
index.html           ← <div id="aiPanel"> + botão de modo 🤖 IA
styles.css           ← estilos do painel
```

### `lib/ai.js` — esqueleto

```js
const PROVIDERS = {
  openai:     { url: 'https://api.openai.com/v1/chat/completions', fmt: 'openai', hdr: k => ({ Authorization: `Bearer ${k}` }) },
  deepseek:   { url: 'https://api.deepseek.com/chat/completions',  fmt: 'openai', hdr: k => ({ Authorization: `Bearer ${k}` }) },
  groq:       { url: 'https://api.groq.com/openai/v1/chat/completions', fmt: 'openai', hdr: k => ({ Authorization: `Bearer ${k}` }) },
  mistral:    { url: 'https://api.mistral.ai/v1/chat/completions', fmt: 'openai', hdr: k => ({ Authorization: `Bearer ${k}` }) },
  xai:        { url: 'https://api.x.ai/v1/chat/completions',       fmt: 'openai', hdr: k => ({ Authorization: `Bearer ${k}` }) },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', fmt: 'openai', hdr: k => ({ Authorization: `Bearer ${k}`, 'HTTP-Referer': 'otserv-editor', 'X-Title': 'OTServ Editor' }) },
  anthropic:  { url: 'https://api.anthropic.com/v1/messages', fmt: 'anthropic', hdr: k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }) },
  gemini:     { fmt: 'gemini' }, // url monta com model+key
  ollama:     { url: 'http://localhost:11434/api/chat', fmt: 'ollama', hdr: () => ({}) },
};

async function chat(provider, key, model, messages, { temperature = 0.3, maxTokens = 4096, system } = {}) {
  const p = PROVIDERS[provider];
  if (p.fmt === 'openai') {
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const r = await fetch(p.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...p.hdr(key) },
      body: JSON.stringify({ model, messages: msgs, temperature, max_tokens: maxTokens }) });
    const j = await r.json(); if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.choices[0].message.content;
  }
  if (p.fmt === 'anthropic') {
    const r = await fetch(p.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...p.hdr(key) },
      body: JSON.stringify({ model, system, max_tokens: maxTokens, temperature, messages }) });
    const j = await r.json(); if (j.error) throw new Error(j.error.message);
    return j.content.map(b => b.text || '').join('');
  }
  if (p.fmt === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const body = { contents, generationConfig: { temperature, maxOutputTokens: maxTokens } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json(); if (j.error) throw new Error(j.error.message);
    return j.candidates[0].content.parts.map(p => p.text).join('');
  }
  if (p.fmt === 'ollama') {
    const r = await fetch(p.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: system ? [{ role: 'system', content: system }, ...messages] : messages, stream: false }) });
    const j = await r.json(); return j.message.content;
  }
}
module.exports = { PROVIDERS, chat };
```

> ⚠️ CORS: chamadas do **renderer** com `nodeIntegration` rodam como Node (sem CORS). Se um dia ligar `contextIsolation`, mover o `fetch` pro **main** via IPC (`ipcMain.handle('ai-chat', ...)`).

---

## 4. Gerência de keys (segurança)
- Salvar por provedor em `localStorage` (`ai.key.<provider>`) — fica **só na máquina do usuário**.
- Opção "lembrar key" (default on). Botão "limpar keys".
- Aviso honesto na UI: *"sua key fica salva local e as mensagens vão direto pro provedor escolhido"*.
- Nunca logar a key. Nunca commitar key no projeto.
- (Opcional) ofuscar levemente no localStorage — mas é client-side, não é criptografia real.

---

## 5. Contexto automático (o que torna útil pro OTServ)
Injeta no prompt conforme o modo aberto:
- **Files**: conteúdo do arquivo da aba ativa (ou seleção) — pra explicar/corrigir/continuar.
- **Mobs**: XML do monstro selecionado — "balanceie", "adicione spell X".
- **Object Edit**: nome/flags do item — "gera um action script pra esse item".
- **Spawns/Econ**: dados relevantes.

```js
function aiContext() {
  if (mode === 'files' && activeTab) return `Arquivo ${activeTab.name}:\n\`\`\`\n${activeTab.doc.getValue()}\n\`\`\``;
  if (mode === 'mon' && current) return `Monstro XML:\n${M.serialize(current)}`;
  if (mode === 'obj' && objSel) return `Item #${objSel.id} ${itemNameOf(objSel.id)} flags=${objSel.t._attrs.map(a=>a.canon)}`;
  return '';
}
```

---

## 6. System prompt (especializa pra TFS/OTC)
```
Você é um assistente especialista em OpenTibia: servidor TFS 1.x (Lua 5.x, revscriptsys e XML)
e cliente OTCv8 (Lua + OTUI). Gere código pronto pra colar, idiomático do TFS.
Quando gerar script, diga em qual pasta vai (data/scripts, data/monster, data/npc, etc).
Responda em português. Seja conciso. Só código quando pedirem código.
```

### Templates rápidos (botões no painel)
- "Gerar monstro" → pede nome/level → XML completo em `data/monster/`.
- "Gerar spell" → instant/conjure/rune → `data/scripts/spells/`.
- "Action de item" → usa o item selecionado → `data/scripts/actions/`.
- "Movement" / "Talkaction" / "Creaturescript" / "Globalevent".
- "Explicar este código" / "Achar o bug" / "Otimizar" (usa o arquivo aberto).
- "Converter 0.4 → 1.x" (revscripts).

---

## 7. UI (painel 🤖 IA)
```
[ provedor ▾ ][ modelo ▾ ][ 🔑 key ........ ][salvar]
[ templates: Monstro | Spell | Action | NPC | Explicar | Bug ]
[ contexto: ☑ usar arquivo/seleção atual ]
[ prompt textarea.......................... ]              [ ▶ Enviar ]
[ resposta (markdown + blocos de código com botão 📋 / ⤵ inserir) ]
```
- Botão **⤵ inserir** cola o bloco de código no editor (aba ativa) ou cria arquivo novo na pasta sugerida.
- Histórico curto da conversa (multi-turn) por sessão.
- Streaming opcional (mostra resposta saindo aos poucos).

---

## 8. Modelos default sugeridos (por provedor)
- openrouter: `anthropic/claude-3.5-sonnet` ou `openai/gpt-4o-mini` (barato)
- openai: `gpt-4o-mini` / `gpt-4o`
- anthropic: `claude-3-5-sonnet-latest` / `claude-3-5-haiku-latest`
- gemini: `gemini-1.5-flash` / `gemini-1.5-pro`
- deepseek: `deepseek-chat`
- groq: `llama-3.3-70b-versatile` (rápido/grátis-ish)
- ollama: `qwen2.5-coder` / `llama3.1` (local, sem key)

> Deixar lista editável (o usuário digita o modelo se quiser um novo).

---

## 9. Passos de implementação
1. `lib/ai.js` com `chat()` (seção 3) + lista de modelos default.
2. `index.html`: botão de modo `🤖 IA` + `<div id="aiPanel">`.
3. `renderer.js`: estado (`aiProvider`, `aiModel`, keys em localStorage), `aiContext()`, render do painel, envio, parse de blocos ```code``` na resposta, inserir no editor.
4. `styles.css`: painel + bolhas de chat + blocos de código.
5. Tratar erros (key inválida, rate limit, offline) com mensagem clara.
6. Teste: 1 provedor OpenAI-fmt (ex: Groq grátis) + Ollama local.

---

## 10. Riscos / notas
- **Custo**: chamadas gastam créditos da key do usuário — mostrar aviso e deixar `max_tokens` configurável.
- **Privacidade**: o conteúdo enviado vai pro provedor — avisar antes de mandar arquivo inteiro.
- **Qualidade**: IA pode gerar Lua que não roda — sempre revisar; oferecer "testar/validar" antes de salvar.
- **Offline**: Ollama cobre uso local sem key nem internet.
- **Rate limit**: retry com backoff simples.
