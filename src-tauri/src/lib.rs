// Backend nativo do OTServ Editor (Tauri v2).
// Comandos expostos ao frontend via `invoke(...)`:
//  - read_file / write_file / path_exists / list_dir  (FS)
//  - spr_open / spr_sprite / spr_compressed           (.spr nativo, leitura lazy + decode RLE em Rust)
//  - claude_cli                                        (spawn do Claude Code CLI, igual no Electron)
// Diálogos (abrir/salvar/pasta) usam o plugin-dialog direto no JS.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::process::Command;
use std::sync::Mutex;
use tauri::Manager;

use serde::Serialize;

mod security; // proteção anti-tamper (anti-debug / anti-injeção / anti-RE)

// ---------- FS ----------
#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}

// Retorno binário EFICIENTE (chega como ArrayBuffer no JS, sem serializar array de números).
#[tauri::command]
fn read_file_raw(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())
}

// Lê um pedaço do arquivo (offset/len) como bytes crus — p/ carregar .spr grande em chunks.
#[tauri::command]
fn read_file_chunk(path: String, offset: u64, len: u64) -> Result<tauri::ipc::Response, String> {
    let mut f = File::open(&path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len as usize];
    let n = f.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);
    Ok(tauri::ipc::Response::new(buf))
}

#[tauri::command]
fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
fn rm_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else if p.exists() {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_path(from: String, to: String) -> Result<(), String> {
    std::fs::copy(&from, &to).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn make_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

// pasta temporária do SO (usada pelo Live p/ salvar arquivos recebidos da sala)
#[tauri::command]
fn tmp_dir() -> Result<String, String> {
    let mut p = std::env::temp_dir();
    p.push("otserv-editor-live");
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().to_string())
}

// abre uma URL no navegador padrão do sistema (window.open não funciona no WebView)
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:")) {
        return Err("url invalida".into());
    }
    Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let win = path.replace('/', "\\");
    Command::new("explorer")
        .args(["/select,", &win])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// abre um programa externo (.exe) — usado p/ integrar ferramentas nativas (ex: Assets Editor WPF).
// roda no diretório do próprio exe (apps WPF precisam dos resources ao lado).
#[tauri::command]
fn launch_app(path: String) -> Result<(), String> {
    let win = path.replace('/', "\\");
    let p = std::path::Path::new(&win);
    if !p.exists() {
        return Err(format!("não encontrado: {}", win));
    }
    let mut cmd = Command::new(&win);
    if let Some(dir) = p.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
fn list_dir(path: String, recursive: Option<bool>, ext: Option<String>) -> Result<Vec<DirEntry>, String> {
    let mut out = Vec::new();
    let rec = recursive.unwrap_or(false);
    fn walk(dir: &std::path::Path, rec: bool, ext: &Option<String>, out: &mut Vec<DirEntry>, depth: u32) {
        if depth > 8 {
            return;
        }
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                let is_dir = p.is_dir();
                if is_dir && rec {
                    walk(&p, rec, ext, out, depth + 1);
                }
                let name = e.file_name().to_string_lossy().to_string();
                let keep = match ext {
                    Some(x) => is_dir || name.to_lowercase().ends_with(&x.to_lowercase()),
                    None => true,
                };
                if keep {
                    out.push(DirEntry {
                        name,
                        path: p.to_string_lossy().to_string(),
                        is_dir,
                    });
                }
            }
        }
    }
    walk(std::path::Path::new(&path), rec, &ext, &mut out, 0);
    Ok(out)
}

// ---------- .spr nativo ----------
struct SprFile {
    file: File,
    table: Vec<u32>,
    count: u32,
    transparency: bool,
}

#[derive(Default)]
struct SprState(Mutex<Option<SprFile>>);

#[tauri::command]
fn spr_open(
    path: String,
    extended: Option<bool>,
    transparency: Option<bool>,
    state: tauri::State<'_, SprState>,
) -> Result<u32, String> {
    let ext = extended.unwrap_or(true);
    let tr = transparency.unwrap_or(true);
    let mut f = File::open(&path).map_err(|e| e.to_string())?;
    let mut head = [0u8; 8];
    f.read_exact(&mut head).map_err(|e| e.to_string())?;
    let count = if ext {
        u32::from_le_bytes([head[4], head[5], head[6], head[7]])
    } else {
        u16::from_le_bytes([head[4], head[5]]) as u32
    };
    let off_base = if ext { 8u64 } else { 6u64 };
    f.seek(SeekFrom::Start(off_base)).map_err(|e| e.to_string())?;
    let mut tbl = vec![0u8; (count as usize) * 4];
    f.read_exact(&mut tbl).map_err(|e| e.to_string())?;
    let table: Vec<u32> = (0..count as usize)
        .map(|i| u32::from_le_bytes([tbl[i * 4], tbl[i * 4 + 1], tbl[i * 4 + 2], tbl[i * 4 + 3]]))
        .collect();
    *state.0.lock().unwrap() = Some(SprFile { file: f, table, count, transparency: tr });
    Ok(count)
}

// bytes RLE crus de um sprite (pra reescrever sem recomprimir)
#[tauri::command]
fn spr_compressed(id: u32, state: tauri::State<'_, SprState>) -> Result<Vec<u8>, String> {
    let mut guard = state.0.lock().unwrap();
    let spr = guard.as_mut().ok_or("spr nao aberto")?;
    if id == 0 || id > spr.count {
        return Ok(vec![]);
    }
    let addr = spr.table[(id - 1) as usize];
    if addr == 0 {
        return Ok(vec![]);
    }
    spr.file.seek(SeekFrom::Start(addr as u64 + 3)).map_err(|e| e.to_string())?; // pula 3 bytes color-key
    let mut sz = [0u8; 2];
    spr.file.read_exact(&mut sz).map_err(|e| e.to_string())?;
    let size = u16::from_le_bytes(sz) as usize;
    let mut buf = vec![0u8; size];
    spr.file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

// decodifica 1 sprite (id) direto num slice RGBA de 4096 bytes (zera = transparente).
fn decode_into(spr: &mut SprFile, id: u32, out: &mut [u8]) -> Result<(), String> {
    for b in out.iter_mut() {
        *b = 0;
    }
    if id == 0 || id > spr.count {
        return Ok(());
    }
    let addr = spr.table[(id - 1) as usize];
    if addr == 0 {
        return Ok(());
    }
    let transparency = spr.transparency;
    spr.file.seek(SeekFrom::Start(addr as u64 + 3)).map_err(|e| e.to_string())?;
    let mut sz = [0u8; 2];
    spr.file.read_exact(&mut sz).map_err(|e| e.to_string())?;
    let size = u16::from_le_bytes(sz) as usize;
    if size == 0 {
        return Ok(());
    }
    let mut comp = vec![0u8; size];
    spr.file.read_exact(&mut comp).map_err(|e| e.to_string())?;
    let bpp = if transparency { 4 } else { 3 };
    let (mut read, mut write) = (0usize, 0usize);
    while read + 4 <= size && write < 1024 {
        let transparent = (comp[read] as usize) | ((comp[read + 1] as usize) << 8);
        read += 2;
        write += transparent;
        let colored = (comp[read] as usize) | ((comp[read + 1] as usize) << 8);
        read += 2;
        let mut i = 0;
        while i < colored && write < 1024 {
            if read + bpp > size {
                break;
            }
            let o = write * 4;
            out[o] = comp[read];
            out[o + 1] = comp[read + 1];
            out[o + 2] = comp[read + 2];
            out[o + 3] = if transparency { comp[read + 3] } else { 255 };
            read += bpp;
            write += 1;
            i += 1;
        }
    }
    Ok(())
}

// RGBA 32x32 (4096 bytes) decodificado de 1 sprite
#[tauri::command]
fn spr_sprite(id: u32, state: tauri::State<'_, SprState>) -> Result<Vec<u8>, String> {
    let mut guard = state.0.lock().unwrap();
    let spr = guard.as_mut().ok_or("spr nao aberto")?;
    let mut px = vec![0u8; 32 * 32 * 4];
    decode_into(spr, id, &mut px)?;
    Ok(px)
}

// LOTE: decodifica N sprites numa só chamada (1 IPC). Retorna 4096*N bytes (ArrayBuffer no JS).
#[tauri::command]
fn spr_sprites(ids: Vec<u32>, state: tauri::State<'_, SprState>) -> Result<tauri::ipc::Response, String> {
    let mut guard = state.0.lock().unwrap();
    let spr = guard.as_mut().ok_or("spr nao aberto")?;
    let mut out = vec![0u8; ids.len() * 32 * 32 * 4];
    for (i, &id) in ids.iter().enumerate() {
        let base = i * 4096;
        decode_into(spr, id, &mut out[base..base + 4096])?;
    }
    Ok(tauri::ipc::Response::new(out))
}

// ---------- Sprite sheet 12+/15.x (.bmp.lzma) ----------
// header CIP (skip nulls + magic 70 0A FA 80 24 + 7-bit size + props + dict(4) + skip 8) → LZMA1 cru (end marker)
// → BMP (BITMAPV4HEADER) 384x384 32-bit BGRA bottom-up → RGBA top-down + magenta(FF00FF)→transparente.
// Retorna [w u32 LE][h u32 LE][rgba...].
#[tauri::command]
fn sheet_rgba(path: String) -> Result<tauri::ipc::Response, String> {
    use std::io::Cursor;
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let n = data.len();
    let mut i = 0usize;
    while i < n && data[i] == 0 {
        i += 1;
    }
    i += 1; // 0x70
    i += 4; // 0A FA 80 24
    while i < n && (data[i] & 0x80) != 0 {
        i += 1;
    }
    i += 1; // último byte do 7-bit size
    if i + 13 > n {
        return Err("header lzma curto".into());
    }
    let lclppb = data[i];
    i += 1;
    let dict = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    i += 4;
    i += 8; // CIP compressed size
    let raw = &data[i..];
    let mut inp = Vec::with_capacity(13 + raw.len());
    inp.push(lclppb);
    inp.extend_from_slice(&dict);
    inp.extend_from_slice(&u64::MAX.to_le_bytes()); // tamanho desconhecido → usa end marker
    inp.extend_from_slice(raw);
    let mut bmp = Vec::new();
    lzma_rs::lzma_decompress(&mut Cursor::new(&inp), &mut bmp).map_err(|e| format!("lzma: {:?}", e))?;
    if bmp.len() < 54 || bmp[0] != 0x42 || bmp[1] != 0x4D {
        return Err("saida nao e BMP".into());
    }
    let px_off = u32::from_le_bytes([bmp[10], bmp[11], bmp[12], bmp[13]]) as usize;
    let w = i32::from_le_bytes([bmp[18], bmp[19], bmp[20], bmp[21]]);
    let h_raw = i32::from_le_bytes([bmp[22], bmp[23], bmp[24], bmp[25]]);
    let bpp = u16::from_le_bytes([bmp[28], bmp[29]]) as usize;
    let width = w.unsigned_abs() as usize;
    let height = h_raw.unsigned_abs() as usize;
    let top_down = h_raw < 0;
    let bytespp = (bpp / 8).max(1);
    let mut out = vec![0u8; width * height * 4];
    for row in 0..height {
        let src_row = if top_down { row } else { height - 1 - row };
        let src = px_off + src_row * width * bytespp;
        for col in 0..width {
            let s = src + col * bytespp;
            if s + bytespp > bmp.len() {
                continue;
            }
            let (b, g, r) = (bmp[s], bmp[s + 1], bmp[s + 2]);
            let a = if bytespp >= 4 { bmp[s + 3] } else { 255 };
            let d = (row * width + col) * 4;
            if r == 255 && g == 0 && b == 255 {
                // magenta → transparente
            } else {
                out[d] = r;
                out[d + 1] = g;
                out[d + 2] = b;
                out[d + 3] = a;
            }
        }
    }
    let mut resp = Vec::with_capacity(8 + out.len());
    resp.extend_from_slice(&(width as u32).to_le_bytes());
    resp.extend_from_slice(&(height as u32).to_le_bytes());
    resp.extend_from_slice(&out);
    Ok(tauri::ipc::Response::new(resp))
}

// ---------- spr_save: salva .spr inteiro em Rust (não bloqueia a UI) ----------
// edits_ids / edits_rgba: sprites editados (RGBA 4096 bytes cada)
// new_count: total de sprites no novo arquivo (>= count original p/ sprites adicionados)
#[tauri::command]
// Retorna novo count após salvar + reabrir o arquivo final
fn spr_save(
    out_path: String,
    edits_ids: Vec<u32>,
    edits_rgba: Vec<Vec<u8>>,
    new_count: u32,
    state: tauri::State<'_, SprState>,
) -> Result<u32, String> {
    fn encode_sprite(rgba: &[u8], transparency: bool) -> Vec<u8> {
        let n = 32 * 32usize;
        let mut out = Vec::with_capacity(256);
        let mut i = 0usize;
        while i < n {
            let mut transparent = 0u16;
            let mut j = i;
            while j < n && rgba[j * 4 + 3] == 0 { transparent += 1; j += 1; }
            let mut colored = 0u16;
            let mut k = j;
            while k < n && rgba[k * 4 + 3] != 0 { colored += 1; k += 1; }
            out.extend_from_slice(&transparent.to_le_bytes());
            out.extend_from_slice(&colored.to_le_bytes());
            for c in 0..colored as usize {
                let o = (i as usize + transparent as usize + c) * 4;
                out.push(rgba[o]); out.push(rgba[o + 1]); out.push(rgba[o + 2]);
                if transparency { out.push(rgba[o + 3]); }
            }
            i += transparent as usize + colored as usize;
            if transparent == 0 && colored == 0 { break; }
        }
        out
    }

    let mut guard = state.0.lock().unwrap();

    // extrai tudo do SprFile em bloco → libera o borrow antes de reatribuir guard
    let (transparency, orig_count, sig_bytes, orig_body, orig_table) = {
        let spr = guard.as_mut().ok_or("spr nao aberto")?;
        let tr = spr.transparency;
        let oc = spr.count;
        let orig_head_size = if oc > 0xFFFF { 8u64 } else { 6u64 };
        // lê assinatura
        spr.file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let mut sig = [0u8; 4];
        spr.file.read_exact(&mut sig).map_err(|e| e.to_string())?;
        // lê body inteiro de uma vez (1 syscall, sem 360k seeks individuais)
        let body_start = orig_head_size + oc as u64 * 4;
        spr.file.seek(SeekFrom::Start(body_start)).map_err(|e| e.to_string())?;
        let mut body = Vec::new();
        spr.file.read_to_end(&mut body).map_err(|e| e.to_string())?;
        let tbl = spr.table.clone();
        (tr, oc, sig, body, tbl)
    }; // spr dropped aqui — guard livre para reatribuição

    let count = new_count.max(orig_count);
    let ext = count > 0xFFFF;
    let head_size = if ext { 8u32 } else { 6u32 };
    let orig_head_size = if orig_count > 0xFFFF { 8u64 } else { 6u64 };
    let body_start = orig_head_size + orig_count as u64 * 4;

    let edits: std::collections::HashMap<u32, &Vec<u8>> =
        edits_ids.iter().copied().zip(edits_rgba.iter()).collect();

    let get_comp = |addr: u32| -> Option<&[u8]> {
        if addr == 0 { return None; }
        let rel = (addr as usize).checked_sub(body_start as usize)?;
        if rel + 5 > orig_body.len() { return None; }
        let size = u16::from_le_bytes([orig_body[rel + 3], orig_body[rel + 4]]) as usize;
        if size == 0 { return None; }
        let ds = rel + 5;
        if ds + size > orig_body.len() { return None; }
        Some(&orig_body[ds..ds + size])
    };

    let mut new_table = vec![0u32; count as usize];
    let mut bodies: Vec<Option<Vec<u8>>> = Vec::with_capacity(count as usize);
    let mut offset = head_size + count * 4;

    for id in 1..=count {
        let comp: Option<Vec<u8>> = if let Some(rgba) = edits.get(&id) {
            let c = encode_sprite(rgba, transparency);
            if c.is_empty() { None } else { Some(c) }
        } else if id <= orig_count {
            let addr = orig_table[(id - 1) as usize];
            get_comp(addr).map(|s| s.to_vec())
        } else { None };

        if let Some(c) = comp {
            new_table[(id - 1) as usize] = offset;
            offset += 5 + c.len() as u32;
            bodies.push(Some(c));
        } else {
            bodies.push(None);
        }
    }

    use std::io::BufWriter;
    let mut f = BufWriter::new(File::create(&out_path).map_err(|e| e.to_string())?);
    f.write_all(&sig_bytes).map_err(|e| e.to_string())?;
    if ext {
        f.write_all(&count.to_le_bytes()).map_err(|e| e.to_string())?;
    } else {
        f.write_all(&(count as u16).to_le_bytes()).map_err(|e| e.to_string())?;
    }
    for &off in &new_table {
        f.write_all(&off.to_le_bytes()).map_err(|e| e.to_string())?;
    }
    let color_key = [0xFFu8, 0x00, 0xFF];
    for body in &bodies {
        if let Some(c) = body {
            f.write_all(&color_key).map_err(|e| e.to_string())?;
            f.write_all(&(c.len() as u16).to_le_bytes()).map_err(|e| e.to_string())?;
            f.write_all(c).map_err(|e| e.to_string())?;
        }
    }
    f.flush().map_err(|e| e.to_string())?;
    drop(f);
    // fecha o handle do original (Windows não permite rename sobre arquivo aberto)
    *guard = None;
    Ok(count)
}

// ---------- Claude Code CLI (igual o provider do Electron) ----------
#[tauri::command]
fn claude_cli(prompt: String) -> Result<String, String> {
    let out = Command::new("claude")
        .args(["-p", "--output-format", "text"])
        .arg(&prompt)
        .output()
        .map_err(|e| format!("claude CLI: {} (o comando `claude` esta no PATH?)", e))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

// ================= LICENÇA (HWID + key Ed25519 + validade) =================
// Chave pública ofuscada em compilação (obfstr) — NÃO aparece com strings.exe / Ghidra.
// É o "marcador" que um RE procuraria no binário pra localizar a função de verificação.
fn license_pubkey() -> String {
    obfstr::obfstr!("c0abf92329cd3160329afcc3280a981412dfdd0011d20124ee8405c7df881b79").to_string()
}

fn machine_hwid() -> String {
    use sha2::{Digest, Sha256};
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let guid: String = hklm
        .open_subkey("SOFTWARE\\Microsoft\\Cryptography")
        .and_then(|k| k.get_value("MachineGuid"))
        .unwrap_or_default();
    let cpu: String = hklm
        .open_subkey("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0")
        .and_then(|k| k.get_value("ProcessorNameString"))
        .unwrap_or_default();
    let mut h = Sha256::new();
    h.update(guid.as_bytes());
    h.update(b"|");
    h.update(cpu.trim().as_bytes());
    hex::encode(&h.finalize()[..8]) // 16 hex chars
}

// ---------- LZMA compress/decompress (para OBD export/import) ----------
#[tauri::command]
fn lzma_compress(data: Vec<u8>) -> Result<Vec<u8>, String> {
    use std::io::Cursor;
    let mut out = Vec::new();
    lzma_rs::lzma_compress(&mut Cursor::new(&data), &mut out).map_err(|e| format!("lzma compress: {:?}", e))?;
    Ok(out)
}
#[tauri::command]
fn lzma_decompress(data: Vec<u8>) -> Result<Vec<u8>, String> {
    use std::io::Cursor;
    let mut out = Vec::new();
    lzma_rs::lzma_decompress(&mut Cursor::new(&data), &mut out).map_err(|e| format!("lzma decompress: {:?}", e))?;
    Ok(out)
}

#[tauri::command]
fn hwid() -> String {
    machine_hwid()
}

#[derive(Serialize)]
struct LicenseStatus {
    valid: bool,
    reason: String,
    expiry: i64,
    days_left: i64,
    hwid: String,
}

#[tauri::command]
fn license_verify(key: String) -> LicenseStatus {
    use base64::Engine;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let hwid_now = machine_hwid();
    let bad = |r: &str| LicenseStatus {
        valid: false,
        reason: r.to_string(),
        expiry: 0,
        days_left: 0,
        hwid: hwid_now.clone(),
    };
    let raw = match base64::engine::general_purpose::STANDARD.decode(key.trim()) {
        Ok(t) => t,
        Err(_) => return bad("key invalida (base64)"),
    };
    let token = match String::from_utf8(raw) {
        Ok(s) => s,
        Err(_) => return bad("key invalida"),
    };
    let parts: Vec<&str> = token.split('|').collect();
    if parts.len() != 3 {
        return bad("formato invalido");
    }
    let payload = format!("{}|{}", parts[0], parts[1]);
    let pk: [u8; 32] = match hex::decode(license_pubkey()).ok().and_then(|v| v.try_into().ok()) {
        Some(b) => b,
        None => return bad("pubkey"),
    };
    let vk = match VerifyingKey::from_bytes(&pk) {
        Ok(v) => v,
        Err(_) => return bad("pubkey"),
    };
    let sig: [u8; 64] = match hex::decode(parts[2]).ok().and_then(|v| v.try_into().ok()) {
        Some(b) => b,
        None => return bad("assinatura"),
    };
    if vk.verify(payload.as_bytes(), &Signature::from_bytes(&sig)).is_err() {
        return bad(obfstr::obfstr!("assinatura invalida (key falsa/alterada)"));
    }
    // HWID "*" ou "*<dias>" = key de TESTE curinga: vale em QUALQUER máquina. O sufixo numérico (ex
    // "*5") dá um trial de N dias POR MÁQUINA a partir da 1ª ativação (gravado no registro: sobrevive
    // a apagar a key/reinstalar). "*" sozinho = sem trial local (só a data assinada na key).
    let test_trial_days: i64 = if let Some(rest) = parts[0].strip_prefix('*') {
        rest.parse().unwrap_or(0)
    } else if parts[0].to_lowercase() != hwid_now.to_lowercase() {
        return bad(obfstr::obfstr!("key e de outra maquina (HWID nao bate)"));
    } else {
        -1
    };
    let exp: i64 = parts[1].parse().unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    // anti-rollback: se o relógio do PC voltou (vs o maior já visto), bloqueia (evita renovar mudando a data)
    let seen = read_last_seen();
    if seen > 0 && now < seen - 86400 {
        return LicenseStatus {
            valid: false,
            reason: "relogio do sistema alterado (data invalida)".into(),
            expiry: exp,
            days_left: 0,
            hwid: hwid_now,
        };
    }
    write_last_seen(now.max(seen));
    // trial de teste POR MÁQUINA (key curinga "*<dias>"): bloqueia N dias após a 1ª ativação AQUI.
    // Grava a data da 1ª ativação no registro (HKCU) → apagar a key/reinstalar NÃO renova o teste.
    if test_trial_days > 0 {
        let started = read_test_trial();
        let s = if started == 0 { write_test_trial(now); now } else { started };
        let left = test_trial_days * 86400 - (now - s);
        if left <= 0 {
            return LicenseStatus {
                valid: false,
                reason: format!("o teste de {} dias ja expirou nesta maquina", test_trial_days),
                expiry: exp,
                days_left: 0,
                hwid: hwid_now,
            };
        }
        // a validade efetiva é o MENOR entre a data da key e o fim do trial desta máquina
        let trial_exp = s + test_trial_days * 86400;
        if trial_exp < exp || exp == 0 {
            return LicenseStatus {
                valid: true,
                reason: "teste".into(),
                expiry: trial_exp,
                days_left: (left / 86400).max(0),
                hwid: hwid_now,
            };
        }
    }
    if now > exp {
        return LicenseStatus {
            valid: false,
            reason: "licenca expirada".into(),
            expiry: exp,
            days_left: 0,
            hwid: hwid_now,
        };
    }
    LicenseStatus {
        valid: true,
        reason: "ok".into(),
        expiry: exp,
        days_left: (exp - now) / 86400,
        hwid: hwid_now,
    }
}

fn license_file() -> std::path::PathBuf {
    let base = std::env::var("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let dir = base.join("OTServEditor");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("license.key")
}

// maior timestamp já visto (anti-rollback) — no registro HKCU (sobrevive a apagar o license.key)
fn read_last_seen() -> i64 {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let v: String = hkcu
        .open_subkey("Software\\OTServEditor")
        .and_then(|k| k.get_value("ls"))
        .unwrap_or_default();
    i64::from_str_radix(&v, 16).unwrap_or(0)
}
fn write_last_seen(t: i64) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok((k, _)) = hkcu.create_subkey("Software\\OTServEditor") {
        let _ = k.set_value("ls", &format!("{:x}", t));
    }
}

// data da 1ª ativação de uma key de TESTE curinga NESTA máquina. Fica em OTServEditorSec (NÃO é
// apagado pelo "Trocar chave"/license_reset) → o tester não reseta o trial reinstalando.
fn read_test_trial() -> i64 {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let v: String = hkcu
        .open_subkey("Software\\OTServEditorSec")
        .and_then(|k| k.get_value("tt"))
        .unwrap_or_default();
    i64::from_str_radix(&v, 16).unwrap_or(0)
}
fn write_test_trial(t: i64) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok((k, _)) = hkcu.create_subkey("Software\\OTServEditorSec") {
        let _ = k.set_value("tt", &format!("{:x}", t));
    }
}

#[tauri::command]
fn license_load() -> String {
    std::fs::read_to_string(license_file()).unwrap_or_default()
}

#[tauri::command]
fn license_save(key: String) -> Result<(), String> {
    std::fs::write(license_file(), key.trim()).map_err(|e| e.to_string())
}

// ---- BAN local (anti-tamper). HKCU sobrevive a apagar a key/reinstalar; o servidor banar por HWID é a camada forte. ----
fn write_ban(reason: &str) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok((k, _)) = hkcu.create_subkey("Software\\OTServEditorSec") {
        let _ = k.set_value("bn", &machine_hwid());
        let _ = k.set_value("bnr", &reason.to_string());
        let _ = k.set_value("bnp", &"1".to_string()); // pendente p/ reportar ao servidor
    }
}
fn read_ban() -> Option<(String, bool)> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let k = hkcu.open_subkey("Software\\OTServEditorSec").ok()?;
    let bn: String = k.get_value("bn").ok()?;
    if bn.is_empty() {
        return None;
    }
    let reason: String = k.get_value("bnr").unwrap_or_default();
    let pending: String = k.get_value("bnp").unwrap_or_default();
    Some((reason, pending == "1"))
}

#[derive(Serialize)]
struct BanInfo {
    banned: bool,
    reason: String,
    hwid: String,
    pending: bool,
}

#[tauri::command]
fn ban_status() -> BanInfo {
    let hwid = machine_hwid();
    match read_ban() {
        Some((reason, pending)) => BanInfo { banned: true, reason, hwid, pending },
        None => BanInfo { banned: false, reason: String::new(), hwid, pending: false },
    }
}

// o JS pode banir (ex.: detectou DevTools/adulteração no front)
#[tauri::command]
fn ban_self(reason: String) {
    write_ban(&reason);
}

// JS chama após reportar o ban ao servidor (limpa só o "pendente"; o ban continua)
#[tauri::command]
fn ban_mark_reported() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok((k, _)) = hkcu.create_subkey("Software\\OTServEditorSec") {
        let _ = k.set_value("bnp", &"0".to_string());
    }
}

// splash agora é overlay na própria janela main (não há janela separada) — no-op mantido por compat
#[tauri::command]
fn splash_done(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
    }
}

// apaga a licença salva + o anti-rollback (pra re-ativar/testar). NÃO mexe no servidor.
#[tauri::command]
fn license_reset() {
    let _ = std::fs::remove_file(license_file());
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all("Software\\OTServEditor");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(SprState::default())
        .setup(|app| {

            let handle = app.handle().clone();
            security::start(move |reason, hard| {
                if hard {
                    write_ban(reason);
                    std::process::exit(1);
                } else {
                    use tauri::Emitter;
                    let _ = handle.emit("tamper-soft", reason.to_string());
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    std::process::exit(1);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            read_file_raw,
            file_size,
            read_file_chunk,
            write_file,
            path_exists,
            list_dir,
            rm_path,
            rename_path,
            copy_path,
            make_dir,
            tmp_dir,
            reveal_path,
            open_url,
            launch_app,
            spr_open,
            spr_sprite,
            spr_sprites,
            spr_compressed,
            spr_save,
            sheet_rgba,
            lzma_compress,
            lzma_decompress,
            hwid,
            license_verify,
            license_load,
            license_save,
            license_reset,
            ban_status,
            ban_self,
            ban_mark_reported,
            claude_cli,
            splash_done
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o OTServ Editor");
}
