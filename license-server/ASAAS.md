# Asaas — Assinatura mensal R$ 30 (passo a passo)

Conta **grátis** (sem mensalidade). Você paga só a taxa por pagamento recebido
(PIX ~R$ 1,99 · cartão ~2,99% + R$0,49). Cliente paga → o servidor renova a licença
automático pelo **email** dele.

## 1) Conta e API Key
1. Crie conta em **asaas.com** (use o **Sandbox** primeiro pra testar: sandbox.asaas.com).
2. Painel ▸ **Configurações** ▸ **Integrações** ▸ **API Key** → copie a chave.
3. No seu servidor (Render/Railway), coloque nas variáveis:
   - `ASAAS_API_KEY` = a chave de API.
   - `ASAAS_API_URL` = `https://api.asaas.com/v3` (produção) **ou** `https://sandbox.asaas.com/api/v3` (teste).
   - `ASAAS_WEBHOOK_TOKEN` = um token que você inventa (qualquer senha) — usado pra proteger o webhook.

## 2) Criar a assinatura mensal (recorrente)
1. Painel ▸ **Cobranças** ▸ **Nova assinatura** (ou **Link de pagamento** com recorrência).
2. Valor **R$ 30,00** · Cobrança **Mensal** · Forma: PIX/Cartão/Boleto (deixe os que quiser).
3. Salve → o Asaas gera um **link de pagamento da assinatura**.
4. **Esse link é a sua "loja"** — coloca no botão da `loja-modelo.html` e divulga.
   - No `loja-modelo.html`, troca o `href` do botão "Assinar" por esse link do Asaas.

## 3) Configurar o Webhook (renovação automática)
1. Painel ▸ **Configurações** ▸ **Integrações** ▸ **Webhooks** ▸ **Adicionar**.
2. URL: **`https://SUA-URL/webhook/asaas`**
3. Token de autenticação: o **mesmo** que você pôs em `ASAAS_WEBHOOK_TOKEN`.
4. Eventos: marque **PAYMENT_RECEIVED** e **PAYMENT_CONFIRMED** (pagamento recebido/confirmado).
5. Salvar. Faça um pagamento de teste (sandbox) pra confirmar que chega.

Quando o cliente paga, o Asaas chama o webhook → o servidor pega o **email** do cliente
(via API do Asaas) e dá **+30 dias** na licença daquele email.

## 4) Fluxo do cliente
1. Clica no seu **link de assinatura Asaas** → paga R$ 30 com o email dele.
2. Abre o app → tela de **Ativação** → digita o **mesmo email** da compra → **Ativar**.
3. Mês que vem o Asaas cobra de novo → renova sozinho → app continua liberado.

## 5) Você controla (admin)
- Ver ativos: `POST /admin/list` (com `ADMIN_TOKEN`).
- Acesso grátis/manual: `POST /admin/create {email, days}`.
- Cortar: `POST /admin/revoke {key}`.

## Dica
- Teste tudo no **Sandbox** do Asaas (cartões/PIX de teste) antes de ir pra produção.
- Só troque `ASAAS_API_URL` pra produção quando estiver tudo ok.
