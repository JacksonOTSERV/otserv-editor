# Proteção anti-tamper (anti-debug / anti-injeção / anti-RE)

## O que foi implementado
**No app (Rust, `src-tauri/src/security.rs`)** — um watchdog roda a cada ~2,5s. Há **2 níveis** (pra evitar banir gente à toa):

**🔴 HARD — adulteração DIRETA do nosso processo → BAN de HWID + fecha:**
- **Anti-debug**: `IsDebuggerPresent` + `CheckRemoteDebuggerPresent` (debugger anexado AO nosso processo).
- **Anti-injeção / Frida**: DLL injetada DENTRO do nosso processo (`frida`, `gum`, `gadget`, `cheatengine`, `dbk64`, `speedhack`, `winject`, `xenos`, `blackbone`, `scylla`…).

**🟡 SOFT — ferramenta de RE só ABERTA / DevTools → AVISA e fecha, SEM ban:**
- **Processos**: IDA, x64dbg/x32dbg, OllyDbg, dnSpy, WinDbg, Cheat Engine, Frida-server, Binary Ninja, Hopper, Relyze, Immunity…
- **Janelas**: títulos de janela (pega **Ghidra** mesmo em Java, IDA, x64dbg, Cheat Engine, dnSpy…).
- **DevTools do WebView** (F12 / inspecionar): detectado no front (truque do `debugger` + getter no console).
- O app mostra "⚠️ feche a ferramenta" e fecha em ~5s. **Não bane** — dev legítimo com x64dbg/DevTools aberto não perde acesso; é só fechar e reabrir.

> 💪 **Proteção máxima do DevTools**: remova `"devtools"` das features do `tauri` no `Cargo.toml`
> (linha `tauri = { version = "2", features = ["devtools"] }` → `features = []`).
> Aí o build **release** não tem DevTools de jeito nenhum (e o debug ainda tem, p/ você desenvolver).

**Ban (HWID)**:
- Local: registro `HKCU\Software\OTServEditorSec` (sobrevive a apagar a key / `license_reset`).
- Servidor: o app reporta o HWID pro `/ban` → o `/verify` passa a recusar aquele HWID **em qualquer máquina/reinstalação** (camada forte).
- Tela de **"Acesso banido"** no app.

**Reembolso/chargeback = ban permanente**:
- Webhook do Stripe trata `charge.refunded`, `refund.created`, `charge.dispute.created`, `charge.dispute.funds_withdrawn` → pega o HWID do cliente (metadata) → **bane**.

## ⚠️ Você precisa fazer
1. **Stripe ▸ Webhooks** ▸ seu endpoint ▸ **adicionar eventos**: `charge.refunded`, `refund.created`, `charge.dispute.created`, `charge.dispute.funds_withdrawn` (além dos `invoice.paid` etc. que já tem).
2. **Subir o `server.js` novo** no GitHub → Render redeploya (ativa `/ban` + checagem de ban + refund→ban).
3. **Rebuild do app** (`EXECUTAR.bat`).
4. **(Recomendado) Packar o .exe final** com um protector (ex.: VMProtect/Themida/Enigma) — veja abaixo.

## Limites honestos (importante)
- **Não dá pra impedir 100% abrir o .exe no Ghidra/IDA** — é um arquivo estático; quem tem o arquivo pode copiar os bytes e analisar offline. O que fazemos é **detectar análise dinâmica** (debug/injeção) e **detectar as ferramentas rodando** na máquina, e aí banir.
- Para dificultar a análise **estática**, **pack/ofusque o `-setup.exe`/`.exe`** com VMProtect, Themida ou Enigma Protector depois do build. Isso é o que realmente atrapalha o Ghidra.
- **Falsos positivos**: já suavizado — ferramenta só **aberta** = aviso + fecha (**sem ban**). Ban permanente só quando algo **debuga/injeta direto no nosso processo** (intenção clara de crackear). As listas estão em `security.rs` (`BAD`) — dá pra ajustar.

## Admin (desbanir um engano)
`POST /admin/unban { token: ADMIN_TOKEN, hwid }` → remove o ban.
`POST /admin/bans { token }` → lista os banidos.
(No app, p/ limpar o ban LOCAL de teste: `regedit` → apague `HKCU\Software\OTServEditorSec`.)
