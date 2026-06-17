// Prevents a console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mysql_fast_ui_lib::run()
}
