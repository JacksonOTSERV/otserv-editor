# Live — edição colaborativa em tempo real

Vários usuários editam **juntos** (estilo "Live" do RME), agora no **programa inteiro**.

## Como usar
1. Clica no botão **👥 Live** (canto superior direito).
2. Põe seu **nome** e um **código de sala** (ex: `MEUMAPA`). Combine o MESMO código com seus amigos.
3. **Entrar/Criar sala** → todos com o mesmo código entram na mesma sessão.
4. Editem juntos. Tem **chat** e lista de quem está online + em que modo cada um está.

## O que sincroniza
- **Mapa** 🗺 — pintura, borracha, bordas (auto-border), e os **cursores** dos outros (com nome/cor) em tempo real.
- **Spell** 🪄 — qualquer mudança na spell aparece pra todos.
- **Object** 🧩 — reapontar sprite de slot, editar pixel e ligar/desligar flags.
- **Presença/Chat** — em TODOS os modos: você vê quem está online e onde (ex: "Fulano · mon Dragon").

## Enviar o arquivo base pela sala
Todos precisam do mesmo arquivo base. Agora dá pra mandar pela própria sala:
- **📤 Enviar base** — manda o mapa/.dat/.spr carregado pros outros (recebem e carregam sozinhos, na pasta temp).
- **📥 Pedir base** — pede pros parceiros te enviarem (quem tiver, manda automático).
- O **.spr é grande** → demora; mande de preferência só o **mapa** e o **.dat**.
- Depois disso o Live só transmite as **edições** (leve). Cada um salva no próprio PC (💾).

## Botão "❔ Como funciona"
Dentro do painel Live tem o **❔ Como funciona** → abre um guia explicando tudo pro usuário.

## Servidor (já incluso)
- O relay roda **no mesmo servidor de licença** (Render), via WebSocket em `/live`. Sem custo extra.
- Render free "dorme" após 15min parado → a 1ª conexão pode levar ~30-50s. Depois fica rápido enquanto a sessão está ativa.

## Publicar a atualização do servidor
O `server.js` ganhou o relay Live. Pra valer em produção:
1. GitHub → repo `otserv-license` → **Upload files** → sobe o `server.js` novo → Commit.
2. Render re-deploya sozinho (~2min). Pronto.

## Trocar o servidor do Live (opcional)
No app, F12 console: `localStorage.setItem('live.url','wss://SEU-SERVIDOR')` (sem `/live` no fim).
