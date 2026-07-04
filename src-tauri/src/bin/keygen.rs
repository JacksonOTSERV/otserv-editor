// keygen — ferramenta do VENDEDOR pra gerar licenças do OTServ Editor.
// NÃO distribua este binário nem a chave PRIVADA. Só você (vendedor) usa.
//
// Uso:
//   keygen genkey                                  -> gera um par de chaves (faça UMA vez)
//   keygen sign <HWID> <YYYY-MM-DD> <PRIVATE_HEX>  -> gera a LICENSE KEY p/ o cliente
//
// Fluxo:
//   1) Roda `keygen genkey` 1x. Guarda a PRIVATE em segredo. Cola a PUBLIC no lib.rs (LICENSE_PUBKEY).
//   2) Cliente paga, te manda o HWID dele (a tela de ativação mostra).
//   3) Roda `keygen sign <HWID_DO_CLIENTE> <DATA_EXPIRACAO> <SUA_PRIVATE>` (ex: data = hoje + 30 dias).
//   4) Manda a LICENSE KEY pro cliente colar na ativação.

use ed25519_dalek::{Signer, SigningKey};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("genkey") => {
            let sk = SigningKey::generate(&mut rand::rngs::OsRng);
            println!("== GUARDE EM SEGREDO (chave privada, só sua) ==");
            println!("PRIVATE = {}", hex::encode(sk.to_bytes()));
            println!();
            println!("== COLE no lib.rs em LICENSE_PUBKEY (chave pública) ==");
            println!("PUBLIC  = {}", hex::encode(sk.verifying_key().to_bytes()));
        }
        Some("sign") => {
            let (hwid, expiry, priv_hex) = match (args.get(2), args.get(3), args.get(4)) {
                (Some(a), Some(b), Some(c)) => (a, b, c),
                _ => {
                    eprintln!("uso: keygen sign <HWID> <YYYY-MM-DD> <PRIVATE_HEX>");
                    std::process::exit(1);
                }
            };
            // data -> unix secs (fim do dia, 23:59:59 UTC)
            let exp_secs = match parse_date(expiry) {
                Some(s) => s,
                None => {
                    eprintln!("data inválida (use YYYY-MM-DD)");
                    std::process::exit(1);
                }
            };
            let pk_bytes: [u8; 32] = hex::decode(priv_hex)
                .ok()
                .and_then(|v| v.try_into().ok())
                .expect("PRIVATE_HEX inválido");
            let sk = SigningKey::from_bytes(&pk_bytes);
            let payload = format!("{}|{}", hwid.to_lowercase(), exp_secs);
            let sig = sk.sign(payload.as_bytes());
            let token = format!("{}|{}", payload, hex::encode(sig.to_bytes()));
            use base64::Engine;
            let key = base64::engine::general_purpose::STANDARD.encode(token);
            println!("== LICENSE KEY (manda pro cliente) ==");
            println!("{}", key);
            println!("(expira em {} = {})", expiry, exp_secs);
        }
        _ => {
            println!("OTServ Editor — keygen");
            println!("  keygen genkey                                  -> gera par de chaves (1x)");
            println!("  keygen sign <HWID> <YYYY-MM-DD> <PRIVATE_HEX>  -> gera a license key");
        }
    }
}

// YYYY-MM-DD -> unix secs (23:59:59 UTC do dia)
fn parse_date(s: &str) -> Option<i64> {
    use chrono::{NaiveDate, NaiveTime};
    let d = NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()?;
    let dt = d.and_time(NaiveTime::from_hms_opt(23, 59, 59)?);
    Some(dt.and_utc().timestamp())
}
