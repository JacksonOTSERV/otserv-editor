# Mercado Pago — Assinatura mensal R$ 30 (passo a passo)

Objetivo: cliente paga R$ 30/mês → o servidor renova a licença sozinho → o cliente
ativa o app com o **email da compra**.

## 1) Conta e credenciais
1. Crie/entre na conta vendedora em **mercadopago.com.br**.
2. Vá em **Seu negócio ▸ Configurações ▸ Credenciais de produção**.
3. Copie o **Access Token** (começa com `APP_USR-...`).
4. No seu servidor (Render/Railway), coloque na variável **`MP_ACCESS_TOKEN`**.

## 2) Criar a assinatura mensal (sem código)
1. Painel do Mercado Pago ▸ **Assinaturas** ▸ **Criar assinatura**.
2. Tipo: **com plano associado** (cobrança recorrente).
3. Valor: **R$ 30,00** · Frequência: **Mensal** · Cobranças: **ilimitadas**.
4. Em "Após o pagamento", pode deixar redirecionar pro seu site/discord.
5. Salve → o MP gera um **link de assinatura** (ex: `https://www.mercadopago.com.br/subscriptions/checkout?preapproval_plan_id=XXXX`).
6. **Esse link é a sua "loja"** — divulgue ele. O cliente assina e paga todo mês automático.

> Alternativa mais simples (sem recorrência automática): **Link de pagamento** avulso de R$ 30.
> O cliente paga manual todo mês; o webhook dá +30 dias a cada pagamento.

## 3) Configurar o Webhook (renovação automática)
1. Painel ▸ **Suas integrações ▸ (sua aplicação) ▸ Webhooks** (ou **Notificações ▸ Webhooks**).
2. URL de produção: **`https://SUA-URL/webhook/mp`**
3. Eventos: marque **Pagamentos** (e **Assinaturas**, se aparecer).
4. Salvar. Faça um pagamento de teste pra confirmar que chega.

Quando um pagamento é **aprovado**, o MP chama o webhook → o servidor pega o
**email do pagador** (`payer.email`) e dá **+30 dias** na licença daquele email.

## 4) Fluxo do cliente (o que ele faz)
1. Clica no seu **link de assinatura** → paga R$ 30 com o email dele.
2. Abre o app → tela de **Ativação** → digita o **mesmo email** da compra → **Ativar**.
3. Pronto. Mês que vem o MP cobra de novo → renova sozinho → o app continua liberado.

## 5) Você (admin) controla tudo
- Ver quem está ativo: `POST /admin/list` (com seu `ADMIN_TOKEN`).
- Dar acesso grátis/manual: `POST /admin/create {email, days}`.
- Cortar alguém: `POST /admin/revoke {key}` (ou desligue no banco).

## Observações
- O app amarra o **email à máquina (HWID)** na 1ª ativação → não roda em 2 PCs com o mesmo email.
- Sem internet, o app tolera **3 dias** com o último estado válido (cache).
- Teste com as **credenciais de TESTE** do MP antes de ir pra produção (cartões de teste no painel).
