// Previne o console extra no Windows em release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    otserv_editor_lib::run()
}
