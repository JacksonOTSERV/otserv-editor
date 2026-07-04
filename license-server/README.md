# Servidor de Licenças — OTServ Editor

Backend simples (Node puro, sem dependências) que valida licenças online e renova
automaticamente via **Mercado Pago / PIX**. Banco = arquivo JSON (`licenses.json`).

## 1) Subir grátis (escolha um)

### Render.com (recomendado, grátis)
1. Crie conta em render.com → **New ▸ Web Service**.
2. Conecte um repositório com esta pasta (ou suba via "Public Git").
3. Build Command: *(vazio)* · Start Command: `node server.js`.
4. Em **Environment**, adicione as variáveis (seção 2).
5. Deploy. A URL fica tipo `https://otserv-editor-xxxx.onrender.com`.
   > Free tier "dorme" após inatividade (1ª requisição demora ~30s). Pra produção, use o plano pago barato ou Railway/Fly.

### Railway / Fly.io / VPS
- Railway: New Project ▸ Deploy from repo ▸ start `node server.js` ▸ set env vars.
- VPS: `node server.js` atrás de um nginx com HTTPS (ou use `caddy` que faz HTTPS sozinho).

## 2) Variáveis de ambiente
| Var | O que é |
|---|---|
| `ADMIN_TOKEN` | Senha de admin (crie uma forte). Usada nos endpoints `/admin/*`. |
| `MP_ACCESS_TOKEN` | Access Token do Mercado Pago (Painel ▸ Suas integrações ▸ Credenciais). |
| `PRICE_DAYS` | Dias por pagamento aprovado (padrão `30`). |
| `PORT` | Porta (o host costuma setar sozinho). |

## 3) Ligar no app
No arquivo `src/full/shim.js`, troque a constante:
```js
const LICENSE_SERVER = 'https://SUA-URL.onrender.com';
```
Recompile o app (`EXECUTAR.bat`). Pronto: o app valida online (com tolerância offline de 3 dias).

## 4) Mercado Pago (auto-renovação)
1. Crie um **link de pagamento** (ou uma **assinatura/preapproval** mensal) no painel do Mercado Pago, com valor R$ 30.
2. Configure o **Webhook/IPN** apontando para: `https://SUA-URL/webhook/mp`.
3. Quando o cliente paga, o MP chama o webhook → o servidor acha o **email do pagador** e dá **+30 dias** na licença daquele email.
4. O cliente recebe/usa a **key** ligada ao email dele.

> Dica: no checkout, peça o **email** do cliente (o MP manda no `payer.email`). É por ele que a licença é amarrada.

## 5) Criar/gerenciar licença manual (sem pagamento)
```bash
# criar/estender (retorna a KEY pro cliente)
curl -X POST https://SUA-URL/admin/create -H "Content-Type: application/json" \
  -d '{"token":"SEU_ADMIN_TOKEN","email":"cliente@email.com","days":30}'

# revogar
curl -X POST https://SUA-URL/admin/revoke -H "Content-Type: application/json" \
  -d '{"token":"SEU_ADMIN_TOKEN","key":"OTE-XXXX-XXXX-XXXX"}'

# listar
curl -X POST https://SUA-URL/admin/list -H "Content-Type: application/json" \
  -d '{"token":"SEU_ADMIN_TOKEN"}'
```

## Como funciona a trava
- A **key** é amarrada ao **HWID** da máquina na 1ª ativação (não roda em outro PC).
- A **validade** fica no servidor; o app checa no boot. Sem internet, tolera **3 dias** (cache).
- Renovou o pagamento → o servidor estende → o app volta a validar sozinho.

## Sem servidor (modo offline)
Se `LICENSE_SERVER` ficar no placeholder, o app valida pela **key assinada offline**
(`GERAR-KEY.bat` + chave privada Ed25519). Útil pra começar antes de subir o servidor.
