#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod term;

use serde::Serialize;
use sshdesk_core::{
    copy, dir_summary, list_dir, list_ports, list_processes, list_services, mkdir,
    read_file, remove, rename, resolve_path, server_time, write_file, Entry, Host, Port,
    Process, Service,
};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
struct Hosts(Mutex<HashMap<String, Host>>);

/// Active local forwards, keyed by "target:remote_port" -> local_port.
#[derive(Default)]
struct Forwards(Mutex<HashMap<String, u16>>);

/// Ask the OS for a free local port by binding :0 and immediately releasing it.
fn free_port(preferred: u16) -> u16 {
    use std::net::TcpListener;
    if preferred >= 1024 && TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(0)
}

#[derive(Serialize)]
struct Snapshot {
    services: Vec<Service>,
    processes: Vec<Process>,
    ports: Vec<Port>,
    elapsed_ms: f64,
}

fn with_host<T>(
    hosts: &State<Hosts>,
    target: &str,
    f: impl FnOnce(&mut Host) -> Result<T, sshdesk_core::Error>,
) -> Result<T, String> {
    let mut map = hosts.0.lock().map_err(|e| e.to_string())?;
    let h = map.get_mut(target).ok_or("not connected")?;
    f(h).map_err(|e| e.to_string())
}

#[tauri::command]
fn connect(hosts: State<Hosts>, target: String, password: Option<String>) -> Result<String, String> {
    let mut map = hosts.0.lock().map_err(|e| e.to_string())?;
    if map.contains_key(&target) {
        return Ok(format!("already connected to {target}"));
    }
    let h = Host::connect_with(&target, password.as_deref()).map_err(|e| e.to_string())?;
    map.insert(target.clone(), h);
    Ok(format!("connected to {target}"))
}

#[tauri::command]
fn clock(hosts: State<Hosts>, target: String) -> Result<sshdesk_core::ServerTime, String> {
    with_host(&hosts, &target, server_time)
}

#[tauri::command]
fn disconnect(hosts: State<Hosts>, target: String) -> Result<(), String> {
    let mut map = hosts.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut h) = map.remove(&target) {
        h.disconnect();
    }
    Ok(())
}

/// One round trip returns everything the UI needs — batching beats three calls.
#[tauri::command]
fn snapshot(hosts: State<Hosts>, target: String) -> Result<Snapshot, String> {
    let t0 = std::time::Instant::now();
    with_host(&hosts, &target, |h| {
        Ok(Snapshot {
            services: list_services(h)?,
            processes: list_processes(h)?,
            ports: list_ports(h)?,
            elapsed_ms: 0.0,
        })
    })
    .map(|mut s| {
        s.elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
        s
    })
}

#[tauri::command]
fn service_action(
    hosts: State<Hosts>,
    target: String,
    unit: String,
    action: String,
    password: String,
) -> Result<String, String> {
    if !matches!(action.as_str(), "start" | "stop" | "restart" | "enable" | "disable") {
        return Err(format!("refusing unknown action: {action}"));
    }
    // Unit names come from the remote, but never trust them back as shell input.
    if !unit.chars().all(|c| c.is_alphanumeric() || "-_.@:\\".contains(c)) {
        return Err(format!("refusing suspicious unit name: {unit}"));
    }
    with_host(&hosts, &target, |h| {
        let o = h.sudo(&format!("systemctl {action} {unit}"), &password)?;
        if o.code == 0 {
            Ok(format!("{action} {unit}: ok"))
        } else {
            Err(sshdesk_core::Error::Remote { code: o.code, stderr: o.stderr })
        }
    })
}

#[tauri::command]
fn kill_process(
    hosts: State<Hosts>,
    target: String,
    pid: u32,
    password: String,
) -> Result<String, String> {
    with_host(&hosts, &target, |h| {
        let o = if password.is_empty() {
            h.run(&format!("kill {pid}"))?
        } else {
            h.sudo(&format!("kill {pid}"), &password)?
        };
        if o.code == 0 { Ok(format!("killed {pid}")) }
        else { Err(sshdesk_core::Error::Remote { code: o.code, stderr: o.stderr }) }
    })
}

#[derive(Serialize)]
struct DirListing {
    path: String,
    entries: Vec<Entry>,
    disk: String,
    elapsed_ms: f64,
}

#[tauri::command]
fn list_directory(hosts: State<Hosts>, target: String, path: String) -> Result<DirListing, String> {
    let t0 = std::time::Instant::now();
    with_host(&hosts, &target, |h| {
        let abs = resolve_path(h, &path)?;
        let entries = list_dir(h, &abs)?;
        let disk = dir_summary(h, &abs).unwrap_or_default();
        Ok(DirListing { path: abs, entries, disk, elapsed_ms: 0.0 })
    })
    .map(|mut d| { d.elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0; d })
}

#[tauri::command]
fn read_text(hosts: State<Hosts>, target: String, path: String) -> Result<sshdesk_core::FileRead, String> {
    // 2 MB cap: comfortably covers source files without letting the editor
    // choke on a log someone left running.
    with_host(&hosts, &target, |h| read_file(h, &path, 2 * 1024 * 1024))
}

#[tauri::command]
fn download_file(
    hosts: State<Hosts>,
    target: String,
    path: String,
    name: String,
) -> Result<String, String> {
    // Land downloads in ~/Downloads, and never let the remote name escape it.
    let base = std::env::var("HOME").map_err(|e| e.to_string())? + "/Downloads";
    let safe: String = name
        .chars()
        .map(|c| if c == '/' || c == '\\' { '_' } else { c })
        .collect();
    let dest = format!("{base}/{safe}");
    let map = hosts.0.lock().map_err(|e| e.to_string())?;
    let h = map.get(&target).ok_or("not connected")?;
    let n = h.download(&path, &dest).map_err(|e| e.to_string())?;
    Ok(format!("saved {} ({} bytes) to ~/Downloads", safe, n))
}

#[tauri::command]
fn write_text(hosts: State<Hosts>, target: String, path: String, content: String) -> Result<(), String> {
    with_host(&hosts, &target, |h| write_file(h, &path, &content))
}

#[tauri::command]
fn make_dir(hosts: State<Hosts>, target: String, path: String) -> Result<(), String> {
    with_host(&hosts, &target, |h| mkdir(h, &path))
}

#[tauri::command]
fn rename_path(hosts: State<Hosts>, target: String, from: String, to: String) -> Result<(), String> {
    with_host(&hosts, &target, |h| rename(h, &from, &to))
}

#[tauri::command]
fn copy_path(hosts: State<Hosts>, target: String, from: String, to: String) -> Result<(), String> {
    with_host(&hosts, &target, |h| copy(h, &from, &to))
}

#[tauri::command]
fn remove_path(hosts: State<Hosts>, target: String, path: String, recursive: bool) -> Result<(), String> {
    with_host(&hosts, &target, |h| remove(h, &path, recursive))
}

#[tauri::command]
fn upload_file(hosts: State<Hosts>, target: String, local: String, remote: String) -> Result<String, String> {
    let map = hosts.0.lock().map_err(|e| e.to_string())?;
    let h = map.get(&target).ok_or("not connected")?;
    let n = h.upload(&local, &remote).map_err(|e| e.to_string())?;
    Ok(format!("uploaded {n} bytes"))
}

#[tauri::command]
fn term_open(
    app: tauri::AppHandle,
    hosts: State<Hosts>,
    terms: State<term::Terminals>,
    id: String,
    target: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let ctl = {
        let map = hosts.0.lock().map_err(|e| e.to_string())?;
        map.get(&target).ok_or("not connected")?.control_path().to_string()
    };
    term::open(&app, &terms, id, &target, &ctl, cols, rows)
}

#[tauri::command]
fn term_write(terms: State<term::Terminals>, id: String, data: String) -> Result<(), String> {
    term::write(&terms, &id, &data)
}

#[tauri::command]
fn term_resize(terms: State<term::Terminals>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    term::resize(&terms, &id, cols, rows)
}

#[tauri::command]
fn term_close(terms: State<term::Terminals>, id: String) -> Result<(), String> {
    term::close(&terms, &id)
}

#[derive(Serialize)]
struct ExecOut { stdout: String, stderr: String, code: i32, elapsed_ms: f64 }

/// Generic command runner for extensions. Takes argv, never a command string,
/// so nothing an extension passes through can become a second command.
#[tauri::command]
fn exec(
    hosts: State<Hosts>,
    target: String,
    argv: Vec<String>,
    password: Option<String>,
) -> Result<ExecOut, String> {
    let t0 = std::time::Instant::now();
    with_host(&hosts, &target, |h| {
        let o = h.run_argv(&argv, password.as_deref())?;
        Ok(ExecOut {
            stdout: o.stdout,
            stderr: o.stderr,
            code: o.code,
            elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0,
        })
    })
}

#[derive(Serialize)]
struct Plugin { name: String, dir: String, source: String, style: Option<String> }

/// Where plugins live. Convention: <root>/<name>/index.js
///
/// Hardcoded to the repo's ./plugins during development so edits are picked up
/// on reload; falls back to ~/.sshdesk/plugins, which is the shipping location.
fn plugins_root() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("SSHDESK_PLUGINS") {
        return std::path::PathBuf::from(p);
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("plugins"));
    match dev {
        Some(d) if d.is_dir() => d,
        _ => std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
            .join(".sshdesk/plugins"),
    }
}

#[tauri::command]
fn list_plugins() -> Result<Vec<Plugin>, String> {
    let root = plugins_root();
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Ok(out),          // no plugins dir is not an error
    };
    for e in entries.flatten() {
        let dir = e.path();
        if !dir.is_dir() { continue; }
        let index = dir.join("index.js");
        if !index.is_file() { continue; }
        match std::fs::read_to_string(&index) {
            Ok(source) => out.push(Plugin {
                name: dir.file_name().unwrap_or_default().to_string_lossy().to_string(),
                dir: dir.to_string_lossy().to_string(),
                source,
                style: std::fs::read_to_string(dir.join("style.css")).ok(),
            }),
            Err(err) => eprintln!("sshdesk: cannot read {}: {err}", index.display()),
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Add a local forward for `remote_port`.
///
/// `local_port` is a preference, not a demand: reusing the port a host had last
/// session keeps bookmarked URLs working, but if it is taken we fall back
/// rather than fail.
#[tauri::command]
fn forward_port(
    hosts: State<Hosts>,
    fwds: State<Forwards>,
    target: String,
    remote_port: u16,
    local_port: Option<u16>,
) -> Result<u16, String> {
    let key = format!("{target}:{remote_port}");
    if let Some(p) = fwds.0.lock().map_err(|e| e.to_string())?.get(&key) {
        return Ok(*p);
    }
    // Prefer last session's port, then the remote's own number, then ephemeral.
    let local = free_port(local_port.unwrap_or(remote_port));
    if local == 0 { return Err("no free local port".into()) }
    let map = hosts.0.lock().map_err(|e| e.to_string())?;
    let h = map.get(&target).ok_or("not connected")?;
    h.forward(local, remote_port).map_err(|e| e.to_string())?;
    fwds.0.lock().map_err(|e| e.to_string())?.insert(key, local);
    Ok(local)
}

#[tauri::command]
fn cancel_forward(
    hosts: State<Hosts>,
    fwds: State<Forwards>,
    target: String,
    remote_port: u16,
) -> Result<(), String> {
    let key = format!("{target}:{remote_port}");
    let local = match fwds.0.lock().map_err(|e| e.to_string())?.remove(&key) {
        Some(p) => p,
        None => return Ok(()),
    };
    let map = hosts.0.lock().map_err(|e| e.to_string())?;
    if let Some(h) = map.get(&target) {
        h.cancel_forward(local, remote_port).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn list_forwards(fwds: State<Forwards>, target: String) -> Result<HashMap<u16, u16>, String> {
    let map = fwds.0.lock().map_err(|e| e.to_string())?;
    Ok(map.iter()
        .filter_map(|(k, v)| {
            k.strip_prefix(&format!("{target}:"))
                .and_then(|p| p.parse::<u16>().ok())
                .map(|rp| (rp, *v))
        })
        .collect())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Only ever a local forward we created.
    if !url.starts_with("http://localhost:") && !url.starts_with("http://127.0.0.1:") {
        return Err("refusing to open a non-local URL".into());
    }
    std::process::Command::new("open").arg(url).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|_app| {
            // Devtools in debug builds only: `make dev` opens them automatically.
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(w) = _app.get_webview_window("main") {
                    w.open_devtools();
                }
            }
            Ok(())
        })
        .manage(Hosts::default())
        .manage(term::Terminals::default())
        .manage(Forwards::default())
        .invoke_handler(tauri::generate_handler![
            connect, clock, disconnect, snapshot, service_action, kill_process,
            list_directory, read_text, download_file,
            write_text, make_dir, rename_path, copy_path, remove_path, upload_file,
            term_open, term_write, term_resize, term_close, exec, list_plugins,
            forward_port, cancel_forward, list_forwards, open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
