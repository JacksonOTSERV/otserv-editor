#![allow(unused)]

#[cfg(windows)]
pub fn start<F: Fn(&str, bool) + Send + 'static>(on_tamper: F) {
    std::thread::spawn(move || {
        loop {
            if let Some((reason, hard)) = win::detect() {
                on_tamper(&reason, hard);
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(2500));
        }
    });
}
#[cfg(not(windows))]
pub fn start<F: Fn(&str, bool) + Send + 'static>(_on: F) {}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, INVALID_HANDLE_VALUE, TRUE};
    use windows_sys::Win32::System::Diagnostics::Debug::{CheckRemoteDebuggerPresent, IsDebuggerPresent};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Module32FirstW, Module32NextW,
        MODULEENTRY32W, TH32CS_SNAPMODULE,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId};

    fn wstr(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end]).to_lowercase()
    }

    pub fn detect() -> Option<(String, bool)> {
        if debugger() {
            return Some(("debugger".into(), true));
        }
        if let Some(m) = injected_module() {
            return Some((format!("inject:{m}"), true));
        }
        None
    }

    fn debugger() -> bool {
        unsafe {
            if IsDebuggerPresent() == TRUE { return true; }
            let mut present: BOOL = 0;
            if CheckRemoteDebuggerPresent(GetCurrentProcess(), &mut present) == TRUE && present == TRUE {
                return true;
            }
        }
        false
    }

    fn injected_module() -> Option<String> {
        // SÓ nomes de DLL que de fato são INJETADAS no nosso processo (não processos externos).
        // Substrings específicas o bastante p/ não baterem em DLL legítima do Windows → sem falso positivo.
        const BAD: &[&str] = &[
            "frida", "gum", "gadget", "cheatengine", "dbk64", "speedhack",
            "winject", "xenos", "blackbone", "scylla", "reclass", "megadumper",
            "extremedumper", "easyhook", "minhook", "detours", "deviare",
            "vehdebug", "titanhide", "sharpod", "scyllahide", "x64dbg", "x32dbg",
        ];
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
            if snap == INVALID_HANDLE_VALUE { return None; }
            let mut me: MODULEENTRY32W = std::mem::zeroed();
            me.dwSize = std::mem::size_of::<MODULEENTRY32W>() as u32;
            let mut ok = Module32FirstW(snap, &mut me);
            let mut hit = None;
            while ok == TRUE {
                let name = wstr(&me.szModule);
                if BAD.iter().any(|b| name.contains(b)) { hit = Some(name); break; }
                ok = Module32NextW(snap, &mut me);
            }
            CloseHandle(snap);
            hit
        }
    }
}
