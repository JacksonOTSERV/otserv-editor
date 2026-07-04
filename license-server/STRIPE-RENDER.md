# Deploy: Stripe (pagamento) + Render (servidor) — passo a passo

O servidor usa o **Stripe como fonte da verdade** (quem tem assinatura ativa = liberado).
Por isso **não precisa de banco** e funciona no **Render grátis** (o HWID fica salvo nos
metadados do cliente no próprio Stripe).

---

## PARTE A — Stripe (criar produto + pegar as chaves)

1. Cria conta em **stripe.com** (ative o Brasil; suporta **PIX + cartão** em BRL).
2. **Products** ▸ **Add product**:
   - Nome: `OTServ Editor` · Preço: **R$ 30,00 BRL** · **Recurring / Monthly**.
   - Salva → isso cria um **Price** (id `price_...`).
3. **Payment Links** ▸ **New** ▸ escolhe esse price ▸ **Create link**.
   - Esse **link** é a sua "loja" → coloca no botão da `loja-modelo.html`.
4. Pega as chaves (vai usar no Render):
   - **Developers ▸ API keys** → copia a **Secret key** (`sk_live_...` ou `sk_test_...` p/ teste).
5. **Webhook** (faz depois que o Render estiver no ar — Parte C).

---

## PARTE B — Render (subir o servidor)

### B.1 — Botar o código no GitHub (sem git, pelo navegador)
1. No GitHub, **New repository** → nome `otserv-license` → **Private** → Create.
2. **Add file ▸ Upload files** → arrasta **2 arquivos** da pasta `license-server\`:
   - `server.js`
   - `package.json`
3. **Commit changes**.

### B.2 — Criar o Web Service no Render
1. Em **render.com** → **New +** ▸ **Web Service**.
2. **Connect a repository** → conecta o GitHub → seleciona `otserv-license`.
3. Configurações:
   - **Name:** `otserv-license`
   - **Region:** qualquer
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** *(deixa vazio)*
   - **Start Command:** `node server.js`
   - **Instance Type:** **Free**
4. **Environment Variables** (Add):
   | Key | Value |
   |---|---|
   | `ADMIN_TOKEN` | uma senha forte sua |
   | `STRIPE_SECRET_KEY` | a `sk_live_...` (ou `sk_test_...`) |
   | `STRIPE_WEBHOOK_SECRET` | (preenche na Parte C) |
   | `PRICE_DAYS` | `35` (um pouco a mais que 30, folga) |
5. **Create Web Service** → espera o deploy (~2min).
6. Vai te dar a URL: `https://SEU-SERVIDOR.onrender.com`.
7. Testa: abre essa URL no navegador → deve aparecer `{"ok":true,...}`.

> ⚠️ Render Free "dorme" após 15min parado → o 1º acesso demora ~30-50s. O app tolera
> 3 dias offline (cache), então tá ok. Pra produção sem dormir, o plano pago é ~US$7/mês.

---

## PARTE C — Ligar o Webhook do Stripe
1. **Stripe ▸ Developers ▸ Webhooks ▸ Add endpoint**.
2. **Endpoint URL:** `https://SEU-SERVIDOR.onrender.com/webhook/stripe`
3. **Events:** seleciona `invoice.paid`, `invoice.payment_succeeded`, `checkout.session.completed`.
4. **Add endpoint** → copia o **Signing secret** (`whsec_...`).
5. Volta no Render → Environment → preenche **`STRIPE_WEBHOOK_SECRET`** com esse `whsec_...` → salva (re-deploy).

---

## PARTE D — Ligar no app
1. No `src\full\shim.js`, troca:
   ```js
   const LICENSE_SERVER = 'https://SEU-SERVIDOR.onrender.com';
   ```
2. Recompila o app (`EXECUTAR.bat`).
3. Pronto: o cliente paga no link do Stripe → abre o app → digita o **email da compra** → **Ativar**.

---

## Fluxo final
```
Cliente clica no Payment Link do Stripe → paga R$30 (PIX/cartão) →
webhook avisa o servidor → app valida o email no Stripe → libera →
renova sozinho todo mês (Stripe cobra) → app continua liberado
```

## Teste antes de produção
- Use as chaves **TEST** do Stripe (`sk_test_`, link de teste, cartão `4242 4242 4242 4242`).
- Confirma que ativa no app. Depois troca pra `sk_live_` e o link real.
