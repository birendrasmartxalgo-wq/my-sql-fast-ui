// Desktop shell for mysql-fast-ui.
//
// The app's real backend is the existing Bun server, compiled to a single executable
// and shipped as a Tauri "sidecar". On launch we:
//   1. resolve a per-user writable data dir + the bundled resource dir (assets, tools),
//   2. mint a random per-launch session token,
//   3. spawn the sidecar bound to 127.0.0.1 with those paths/token in its env,
//   4. wait until it accepts connections, then open a window at http://127.0.0.1:<port>
//      with the token in the URL hash (the frontend adopts it — no password screen),
//   5. kill the sidecar when the app exits.
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use uuid::Uuid;

const PORT: u16 = 47626;

// Holds the live sidecar child so we can kill it on exit.
struct Sidecar(Mutex<Option<CommandChild>>);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            // --- writable per-user data dir (install dir is read-only when packaged)
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir).ok();

            // --- bundled resources: frontend assets + (optional) MySQL client / ssh tools
            let resource_dir = app.path().resource_dir()?;
            // In `tauri dev`, bundle.resources aren't staged next to the binary, so read
            // assets straight from the source tree; in a packaged build use the resource dir.
            let assets_dir = if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public")
            } else {
                resource_dir.join("public")
            };
            let mysql_bin_dir = resource_dir.join("tools").join("mysql");
            let ssh_bin = resource_dir
                .join("tools")
                .join(if cfg!(windows) { "ssh.exe" } else { "ssh" });

            // --- per-launch session token, shared between server and webview
            let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());

            // --- spawn the Bun sidecar, loopback-only, paths + token via env
            let mut cmd = app
                .shell()
                .sidecar("mysql-fast-server")
                .expect("mysql-fast-server sidecar is missing")
                .env("APP_DATA_DIR", data_dir.to_string_lossy().to_string())
                .env("ASSETS_DIR", assets_dir.to_string_lossy().to_string())
                .env("HOST", "127.0.0.1")
                .env("PORT", PORT.to_string())
                .env("DESKTOP_TOKEN", token.clone());
            // Default "Local" connection (id 0): point at a local MySQL as root with no
            // password — the common dev convention — so the app shows local databases out
            // of the box. Users can edit/add connections in the UI; honour any MYSQL_*
            // already present in the environment.
            for (k, v) in [
                ("MYSQL_HOST", "127.0.0.1".to_string()),
                ("MYSQL_PORT", "3306".to_string()),
                ("MYSQL_USER", "root".to_string()),
                ("MYSQL_MAINT_DB", "mysql".to_string()),
            ] {
                if std::env::var(k).is_err() {
                    cmd = cmd.env(k, v);
                }
            }
            // Only point at bundled tools when they were actually shipped; otherwise the
            // server falls back to PATH (dev machines have mysqldump/ssh installed).
            if mysql_bin_dir.is_dir() {
                cmd = cmd.env("MYSQL_BIN_DIR", mysql_bin_dir.to_string_lossy().to_string());
            }
            if ssh_bin.is_file() {
                cmd = cmd.env("SSH_BIN", ssh_bin.to_string_lossy().to_string());
            }

            let (mut rx, child) = cmd.spawn().expect("failed to spawn sidecar");
            *app.state::<Sidecar>().0.lock().unwrap() = Some(child);

            // surface sidecar logs in the Rust console (helpful while developing)
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                            eprint!("[sidecar] {}", String::from_utf8_lossy(&b));
                        }
                        _ => {}
                    }
                }
            });

            // poll until the server accepts connections, then open the window
            std::thread::spawn(move || {
                let addr = format!("127.0.0.1:{}", PORT);
                let mut ready = false;
                for _ in 0..200 {
                    if TcpStream::connect_timeout(
                        &addr.parse().unwrap(),
                        Duration::from_millis(200),
                    )
                    .is_ok()
                    {
                        ready = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                if !ready {
                    eprintln!("sidecar did not become ready on {addr}");
                    return;
                }
                let url = format!("http://127.0.0.1:{}/#token={}", PORT, token);
                let open = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    let _ = tauri::WebviewWindowBuilder::new(
                        &open,
                        "main",
                        tauri::WebviewUrl::External(url.parse().unwrap()),
                    )
                    .title("mysql-fast-ui")
                    .inner_size(1320.0, 860.0)
                    .min_inner_size(900.0, 600.0)
                    .build();
                });
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(child) = app_handle.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
