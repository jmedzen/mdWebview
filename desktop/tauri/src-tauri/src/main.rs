// mdWebview — Tauri v2 desktop shell
//
// mdWebview is a Node.js HTTP server that serves its own single-page reader.
// Rather than reimplementing it, this shell launches the *unmodified* server as
// a Tauri sidecar (an official Node.js binary), waits for it to report the port
// it bound, and then opens a native window pointed at that local address.
//
// Why a Node sidecar instead of Node's SEA:
//   * The server spawns `worker_threads` from files on disk
//     (render-worker.js / index-worker.js) and resolves static assets relative
//     to `process.cwd()`. A real Node process keeps both behaviours identical to
//     the server/Docker deployment, with zero changes to the app.
//   * SEA is still Stability 1.1, requires a postject + re-signing dance on
//     macOS, and reports macOS x64 as untested in CI. A sidecar avoids all of it.
//
// The sidecar binary is produced by the build workflow, which downloads the
// official Node.js release for the target and renames it to the
// `-$TARGET_TRIPLE` form Tauri expects for `externalBin`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Name of the sidecar as declared in `tauri.conf.json` (`externalBin`).
const SIDECAR: &str = "mdwebview-server";

/// Marker printed by server.js on stdout once it is listening.
const READY_MARKER: &str = "MDWEBVIEW_READY port=";

/// Holds the running server so it can be terminated when the app exits.
#[derive(Default)]
struct ServerState(Mutex<Option<CommandChild>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServerState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = start_server(handle).await {
                    eprintln!("[mdWebview] 伺服器啟動失敗: {err}");
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("建立 mdWebview 應用程式失敗")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                shutdown_server(app_handle);
            }
        });
}

/// Locate the bundled application payload (server.js, lib/, index.html, ...).
///
/// Tauri places `bundle.resources` inside the resource directory, but the exact
/// nesting differs per platform and bundler version, so probe the plausible
/// locations and take the first that actually contains the server entry point.
fn find_payload(resource_dir: &Path) -> Option<PathBuf> {
    let candidates = [
        resource_dir.join("app"),
        resource_dir.join("payload"),
        resource_dir.join("resources").join("app"),
        resource_dir.join("resources").join("payload"),
        resource_dir.to_path_buf(),
    ];
    candidates
        .into_iter()
        .find(|dir| dir.join("server.js").is_file())
}

/// Terminate the child server process, allowing it to flush index caches.
fn shutdown_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ServerState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.take() {
                // server.js installs SIGTERM/SIGINT handlers for a graceful stop.
                let _ = child.kill();
            }
        }
    }
}

async fn start_server(app: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;
    let payload = find_payload(&resource_dir).ok_or_else(|| {
        format!(
            "在 {} 找不到 server.js，應用程式封裝不完整。",
            resource_dir.display()
        )
    })?;
    let server_entry = payload.join("server.js");

    // Everything writable lives in the per-user data directory so that the
    // application bundle stays read-only and survives updates untouched.
    let user_data = app.path().app_data_dir()?;
    let logs_dir = user_data.join("logs");
    let vault_dir = user_data.join("md");
    let dict_dir = user_data.join("dicts");
    for dir in [&user_data, &logs_dir, &vault_dir, &dict_dir] {
        std::fs::create_dir_all(dir)?;
    }

    let command = app
        .shell()
        .sidecar(SIDECAR)?
        .arg(server_entry.to_string_lossy().to_string())
        // server.js resolves assets and worker scripts from the working dir.
        .current_dir(payload.clone())
        .env("HOST", "127.0.0.1")
        // Ask the OS for a free port; the chosen one is reported on stdout.
        .env("PORT", "0")
        .env("MDW_USER_DATA", user_data.to_string_lossy().to_string())
        .env(
            "CONFIG_PATH",
            user_data.join("config.json").to_string_lossy().to_string(),
        )
        .env("LOG_DIR", logs_dir.to_string_lossy().to_string())
        .env("MD_ROOT", vault_dir.to_string_lossy().to_string())
        .env("DICTIONARY_PATH", dict_dir.to_string_lossy().to_string())
        .env("NODE_ENV", "production")
        // A large vault builds a ~700MB bigram index; match the Docker headroom.
        .env("NODE_OPTIONS", "--max-old-space-size=4096");

    let (mut rx, child) = command.spawn()?;

    // Keep the handle so the process can be stopped on exit.
    {
        let state = app.state::<ServerState>();
        let mut guard = state.0.lock().unwrap();
        *guard = Some(child);
    }

    // Drain output for the lifetime of the process. This is not just for
    // parsing: an unread stdout pipe eventually fills and blocks the server.
    let mut buffer = String::new();
    let mut opened = false;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                if !opened {
                    buffer.push_str(&text);
                    if let Some(port) = parse_port(&buffer) {
                        opened = true;
                        if let Err(err) = open_window(&app, port) {
                            eprintln!("[mdWebview] 無法開啟視窗: {err}");
                            app.exit(1);
                            break;
                        }
                    }
                } else {
                    // Keep the stream drained without retaining it.
                    let _ = text.len();
                }
            }
            CommandEvent::Terminated(payload) => {
                eprintln!("[mdWebview] 伺服器已結束: {:?}", payload.code);
                break;
            }
            _ => {}
        }
    }

    // The server is gone: there is nothing left to show.
    shutdown_server(&app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.close();
    }
    app.exit(0);
    Ok(())
}

/// Extract the port from the accumulated stdout buffer.
fn parse_port(buffer: &str) -> Option<u16> {
    let start = buffer.find(READY_MARKER)? + READY_MARKER.len();
    let rest = &buffer[start..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u16>().ok()
}

fn open_window(app: &tauri::AppHandle, port: u16) -> Result<(), Box<dyn std::error::Error>> {
    let url = tauri::Url::parse(&format!("http://127.0.0.1:{port}/"))?;

    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("mdWebview (Tauri)")
        .inner_size(1440.0, 960.0)
        .min_inner_size(480.0, 480.0)
        .build()?;

    Ok(())
}
