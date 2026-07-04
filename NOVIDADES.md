# OTServ Editor — Novidades

Tudo o que foi implementado e adicionado desde a migração para Tauri. App nativo (.exe)
com frontend embutido e backend em Rust.

---

## Plataforma / Base
- Migração completa de Electron para Tauri (WebView2 + Rust): binário único, mais leve e rápido.
- Backend nativo em Rust: comandos de filesystem, decode de .spr nativo (sob demanda), leitura de sheets 15.x (lzma+bmp), licença e segurança.
- Ponte JS/Rust transparente, mantendo compatibilidade com a base do código antigo.
- Decode de .spr sob demanda em Rust (cache LRU): só o sprite visível é processado, em lote.
- Auto-detecção de formato de cliente ao abrir .dat/.spr: identifica extended, frame-durations, frame-groups e transparência sozinho (suporta de 7.x a 10.x, incluindo dats custom OTCv8).
- Pré-aquecimento do viewport ao abrir o mapa.

## Object Builder (editor de itens / sprites)
- Paridade com o Object Builder original, com 3 painéis (Objects / Inspector / Sprites).
- Drag-and-drop de PNG.
- Abas Sprite, Propriedades e Flags separadas.
- Compile As (exportar em versão de cliente diferente).
- Editor de pixel, frame groups, otimizadores (.fd / .fg / sprites), slicer e viewer.
- Edição de flags em massa.
- Suporte a assets 12+/15.x (catalog + sprites .bmp.lzma) além do .dat/.spr/.otb clássico, lendo appearances.dat (protobuf) sem precisar do items.otb.

## Editor de Mapa (RME)
- Layout e barra de menus equivalentes ao RME full.
- Pintura, borracha, bordas automáticas (Automagic) e palettes.
- Borracha mágica (Shift+Ctrl+arrastar) apaga o mesmo item na área.
- Casas, spawns e towns.
- Render GPU (WebGL) opcional para zoom out fluido (toggle).
- Data Editor (Montar brush): monta 7 tipos e salva no materials — borda, piso, parede, montanha, doodad, carpete e mesa.
- Scan da seleção: seleciona exemplos já pintados no mapa e o editor reconhece e cria os brushes automaticamente.
  - Identifica o tipo lendo os materiais (ground, borda+piso, montanha, parede, carpete, mesa, doodad).
  - Lê orientação, edge e align exatos dos materiais (paredes, carpetes, mesas).
  - Vários exemplos numa seleção só (separados por tiles vazios), criando uma palette inteira de uma vez.
  - Lista de revisão com preview visual de cada brush antes de salvar.
- Novo mapa vazio, redimensionar, limpar house tiles inválidos e remover corpses.

## Spell Editor
- Formulário completo: vocações, cooldown nativo TFS, needlearn / premium / soul, blockarmor / dispel, entre outros.
- Preview animado (player centralizado, monstro como offset arrastável).
- Geração de Lua + XML prontos.
- Base de conhecimento por IA (Base IA): gera o skills.md do servidor do usuário (OTX / Canary / custom) via IA paga ou local, ou usa a padrão TFS.
- Script Studio com a mesma base de IA.

## Monster / NPC / Vocações / Economia
- Editor de monstros com escalonamento de vida, além de dano e exp.
- Editores de NPC, vocações e economia integrados.

## Configuração de Servidor
- Botão Servidor para apontar os caminhos: config.lua, monster, npc, vocations, spells, dat, spr, otb, mapa, spawn e materiais RME.
- Auto-load: recarrega tudo no boot (mapa em carga preguiçosa). Os caminhos de cada usuário ficam salvos entre sessões.

## Live (colaboração em tempo real)
- Sala na nuvem via relay WebSocket próprio.
- Sincroniza mapa (edição e cursores), spell e object, com presença e chat.
- Enviar e pedir arquivo base em chunks, com barra de progresso.
- Guia "Como funciona".

## Tradução
- PT/EN em todos os módulos pela bandeira (traduz inclusive DOM dinâmico).

## Licença
- Online: ativação por e-mail via Stripe (servidor no Render), assinatura mensal.
- Offline: chave Ed25519 master (sempre entra), com cache offline.
- Vínculo por HWID + CPU e registro anti-rollback.

## Proteção (anti-tamper)
- Watchdog em background: anti-debug, anti-injeção (Frida/DLL) e anti-RE (Ghidra/IDA/x64dbg).
- Servidor com endpoints de ban; reembolso e chargeback no Stripe geram ban automático.

## Auto-update
- Verificação de atualização no boot, download de instalador assinado (minisign) e reinício.
- Hospedagem no Cloudflare R2, com script de publicação.

## Loja / Pagamento
- Página-modelo de loja com termos.
- Stripe com servidor DB-less (Stripe como fonte da verdade; HWID no metadata do cliente).

---

Build e execução: EXECUTAR.bat. Documentação técnica: HANDOFF.md, LIVE.md, PROTECAO.md, AUTO-UPDATE.md.
