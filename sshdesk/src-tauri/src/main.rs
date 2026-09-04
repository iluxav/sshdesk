#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod term;

use serde::Serialize;
use sshdesk_core::{
    copy, list_dir, list_ports, list_processes, list_services, mkdir,
    read_file, remove, rename, resolve_path, server_time, write_file, Entry, Host, Port,
    Process, Service,
};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, State};

#[derive(Default)]
struct Hosts(Mutex<HashMap<String, Host>>);

/// Hosts with a live signal watcher thread. Keyed by target so reconnecting a
/// window does not stack one thread per open window.
#[derive(Default)]
struct Watchers(Mutex<std::collections::HashSet<String>>);

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
    with_host(&hosts, &target, |h| {
        sshdesk_core::service_action(h, &unit, &action, &password)?;
        Ok(format!("{action} {unit}: ok"))
    })
}

/// Start pushing unit changes to the UI.
///
/// The watcher opens its *own* connection to the already-forwarded bus socket.
/// That matters: it blocks on read indefinitely, and sharing the Host's
/// connection would mean holding the hosts lock forever, freezing every other
/// command in the app.
#[tauri::command]
fn watch_units(
    app: tauri::AppHandle,
    hosts: State<Hosts>,
    watchers: State<Watchers>,
    target: String,
) -> Result<bool, String> {
    {
        let mut w = watchers.0.lock().map_err(|e| e.to_string())?;
        if !w.insert(target.clone()) { return Ok(false) }  // already watching
    }
    // Ensure the forward exists, then hand the path to the thread.
    let (sock, uid) = match with_host(&hosts, &target, |h| {
        h.bus()?;
        Ok((h.bus_path().to_string(), h.uid()))
    }) {
        Ok(v) => v,
        Err(e) => {
            watchers.0.lock().ok().map(|mut w| w.remove(&target));
            return Err(e)
        }
    };

    let t2 = target.clone();
    std::thread::spawn(move || {
        let run = || -> Result<(), sshdesk_core::Error> {
            let mut d = sshdesk_core::dbus::Dbus::connect(&sock, uid)?;
            sshdesk_core::subscribe_units(&mut d)?;
            let _ = app.emit("units:watching", &t2);
            loop {
                match d.next_signal(std::time::Duration::from_secs(60)) {
                    // A timeout is not an error — an idle box simply has
                    // nothing to say. Keep waiting.
                    Ok(None) => continue,
                    Ok(Some(sig)) => {
                        let _ = app.emit("units:changed", UnitSignal {
                            target: t2.clone(),
                            member: sig.member,
                            args: sig.args.iter().map(|v| v.to_json()).collect(),
                        });
                    }
                    Err(e) => return Err(e),
                }
            }
        };
        let _ = run();
        // Connection died: drop the registration so a reconnect can re-arm.
        use tauri::Manager;
        if let Some(w) = app.try_state::<Watchers>() {
            w.0.lock().ok().map(|mut s| s.remove(&t2));
        }
        let _ = app.emit("units:stopped", &t2);
    });
    Ok(true)
}

#[derive(Clone, Serialize)]
struct UnitSignal {
    target: String,
    member: String,
    args: Vec<serde_json::Value>,
}

/// Read a systemd manager property straight off the bus.
#[tauri::command]
fn systemd_property(hosts: State<Hosts>, target: String, prop: String)
    -> Result<serde_json::Value, String> {
    with_host(&hosts, &target, |h| sshdesk_core::systemd_property(h, &prop))
}

/// Materialise remote files locally so the OS can drag them.
///
/// A native drag needs real paths: macOS hands Finder a file, not a promise we
/// could fill in later, so the bytes have to exist before the gesture starts.
/// That is the tradeoff of this approach — instant for a config file, and a
/// visible wait for something large.
///
/// Each drag gets its own staging directory, so two drags of the same filename
/// cannot collide, and previous stagings are swept on the way in.
#[tauri::command]
fn stage_for_drag(
    hosts: State<Hosts>,
    target: String,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let root = std::env::temp_dir().join("sshdesk-drag");
    sweep_old_stagings(&root);
    let dir = root.join(format!("{}-{}", std::process::id(), now_millis()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    with_host(&hosts, &target, |h| {
        let mut out = Vec::new();
        for p in &paths {
            let name = p.rsplit('/').next().unwrap_or("file");
            // A remote name is never trusted as a local path component.
            let safe: String = name.chars()
                .map(|c| if c == '/' || c == '\\' || c == ':' { '_' } else { c })
                .collect();
            let local = dir.join(if safe.is_empty() { "file" } else { &safe });
            h.sftp()?.download_tree(p, &local)?;
            out.push(local.to_string_lossy().to_string());
        }
        Ok(out)
    })
}

/// Drop staging directories older than an hour. They are copies; the originals
/// are still on the remote, so this is safe to be aggressive about.
fn sweep_old_stagings(root: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
    for e in entries.flatten() {
        if e.metadata().and_then(|m| m.modified()).map(|t| t < cutoff).unwrap_or(false) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Upload files dropped from Finder into a remote directory.
#[tauri::command]
fn upload_files(
    hosts: State<Hosts>,
    target: String,
    locals: Vec<String>,
    remote_dir: String,
) -> Result<String, String> {
    with_host(&hosts, &target, |h| {
        let mut bytes = 0u64;
        let mut n = 0;
        for l in &locals {
            let path = std::path::Path::new(l);
            let name = path.file_name().map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".into());
            let dest = sshdesk_core::sftp::join(&remote_dir, &name);
            bytes += h.sftp()?.upload_tree(path, &dest)?;
            n += 1;
        }
        Ok(format!("uploaded {n} item{} ({bytes} bytes)", if n == 1 { "" } else { "s" }))
    })
}

// ---- configuration ------------------------------------------------------

/// The config file. Defaults are not included: they are declared by app
/// manifests in the frontend, and duplicating that registry here would buy
/// nothing.
#[tauri::command]
fn config_load() -> sshdesk_core::config::Settings {
    sshdesk_core::config::load()
}

/// Write one key, or remove it when no value is given.
///
/// Validation lives here rather than in the UI so a hand-edited file and the
/// Settings app get identical treatment.
#[tauri::command]
fn config_set(key: String, value: Option<String>) -> Result<(), String> {
    if let Some(v) = &value {
        sshdesk_core::config::validate(&key, v)?;
    }
    let mut warnings = Vec::new();
    let mut flat = sshdesk_core::config::read_local(&mut warnings);
    match value { Some(v) => flat.insert(key, v), None => flat.remove(&key) };
    sshdesk_core::config::write_local(&flat).map_err(|e| e.to_string())
}

/// Where the file lives, so the UI can offer to open it in the Editor.
#[tauri::command]
fn config_path() -> String {
    sshdesk_core::config::local_path().to_string_lossy().to_string()
}

/// Every installed icon pack, sanitised and ready to inject as a sprite.
#[tauri::command]
fn icon_packs() -> Vec<sshdesk_core::icons::Pack> {
    sshdesk_core::icons::load()
}

/// Arbitrary D-Bus call — the platform primitive plugins build on.
///
/// `signature` describes the argument types exactly as `busctl call` requires;
/// JSON supplies the data. Without it there is no way to know whether `2` is a
/// byte, a uint32 or a double. The reply comes back as JSON with variants
/// unwrapped and dicts flattened to objects.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn dbus_call(
    hosts: State<Hosts>,
    target: String,
    dest: String,
    path: String,
    interface: String,
    member: String,
    signature: Option<String>,
    args: Option<Vec<serde_json::Value>>,
) -> Result<serde_json::Value, String> {
    with_host(&hosts, &target, |h| {
        let sig = signature.unwrap_or_default();
        let vals = args.unwrap_or_default();
        let mut built = Vec::new();
        for (s, v) in sshdesk_core::dbus::split_sig(&sig).iter().zip(vals.iter()) {
            built.push(sshdesk_core::dbus::from_json(s, v)?);
        }
        let out = h.bus()?.call(&dest, &path, &interface, &member, &built)?;
        Ok(serde_json::Value::Array(out.iter().map(|v| v.to_json()).collect()))
    })
}

/// Read one property off the bus, typed.
#[tauri::command]
fn dbus_get(
    hosts: State<Hosts>,
    target: String,
    dest: String,
    path: String,
    interface: String,
    property: String,
) -> Result<serde_json::Value, String> {
    with_host(&hosts, &target, |h| {
        Ok(h.bus()?.get(&dest, &path, &interface, &property)?.to_json())
    })
}

/// Typed free-space numbers, replacing the parsed `df -h` string.
#[tauri::command]
fn disk_info(hosts: State<Hosts>, target: String, path: String)
    -> Result<sshdesk_core::DiskInfo, String> {
    with_host(&hosts, &target, |h| sshdesk_core::disk_info(h, &path))
}

/// Which SFTP extensions this server offers. The UI can light up server-side
/// copy and typed statvfs only where they actually exist.
#[tauri::command]
fn sftp_extensions(hosts: State<Hosts>, target: String) -> Result<Vec<String>, String> {
    with_host(&hosts, &target, |h| Ok(h.sftp()?.extensions()))
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
    /// Typed numbers from statvfs, not a parsed `df -h` string. The UI decides
    /// how to render them, which is where that decision belongs.
    disk: sshdesk_core::DiskInfo,
    /// Whether this server can copy files without shipping bytes over the wire.
    server_side_copy: bool,
    elapsed_ms: f64,
}

#[tauri::command]
fn list_directory(hosts: State<Hosts>, target: String, path: String) -> Result<DirListing, String> {
    let t0 = std::time::Instant::now();
    with_host(&hosts, &target, |h| {
        let abs = resolve_path(h, &path)?;
        let entries = list_dir(h, &abs)?;
        let disk = sshdesk_core::disk_info(h, &abs).unwrap_or_default();
        let server_side_copy = h.sftp()?.has("copy-data");
        Ok(DirListing { path: abs, entries, disk, server_side_copy, elapsed_ms: 0.0 })
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
    with_host(&hosts, &target, |h| {
        // download_tree, not download: a folder is a legitimate thing to want,
        // and SFTP has no bulk primitive so somebody has to do the walk.
        let n = h.sftp()?.download_tree(&path, std::path::Path::new(&dest))?;
        Ok(format!("saved {safe} ({n} bytes) to ~/Downloads"))
    })
}

/// Raw bytes, base64'd for the IPC hop.
///
/// Separate from `read_text` because that one classifies and returns a string;
/// an image needs the bytes intact. The cap is generous but real — a webview
/// holding a 200 MB data URL helps nobody.
#[derive(Serialize)]
struct BinaryRead {
    b64: String,
    size: u64,
    truncated: bool,
    /// Guessed from the extension, for the data URL the viewer builds.
    mime: String,
}

#[tauri::command]
fn read_binary(
    hosts: State<Hosts>,
    target: String,
    path: String,
    max_bytes: Option<usize>,
) -> Result<BinaryRead, String> {
    let max = max_bytes.unwrap_or(32 * 1024 * 1024).min(64 * 1024 * 1024);
    let mime = sshdesk_core::mime_of(&path).to_string();
    with_host(&hosts, &target, |h| {
        let size = h.sftp()?.stat(&path)?.size;
        let (bytes, truncated) = h.sftp()?.read(&path, max)?;
        Ok(BinaryRead { b64: sshdesk_core::b64encode(&bytes), size, truncated, mime })
    })
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
fn upload_file(hosts: State<Hosts>, target: String, local: String, remote: String)
    -> Result<String, String> {
    with_host(&hosts, &target, |h| {
        let n = h.upload(&local, &remote)?;
        Ok(format!("uploaded {n} bytes"))
    })
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
        .plugin(tauri_plugin_drag::init())
        // Log OS drag-drop at the Rust boundary. If files land here but nothing
        // happens in the UI, the problem is the frontend hit test; if nothing
        // reaches here at all, it is the window config or the OS. Without this
        // the two are indistinguishable.
        .on_window_event(|_w, event| {
            if let tauri::WindowEvent::DragDrop(e) = event {
                match e {
                    tauri::DragDropEvent::Enter { paths, position } =>
                        eprintln!("drag enter: {} path(s) at {:?}", paths.len(), position),
                    tauri::DragDropEvent::Drop { paths, position } =>
                        eprintln!("drag drop: {paths:?} at {position:?}"),
                    tauri::DragDropEvent::Leave => eprintln!("drag leave"),
                    _ => {}
                }
            }
        })
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
        .manage(Watchers::default())
        .invoke_handler(tauri::generate_handler![
            connect, clock, disconnect, snapshot, service_action, kill_process,
            systemd_property, disk_info, sftp_extensions, dbus_call, dbus_get,
            watch_units, stage_for_drag, upload_files,
            config_load, config_set, config_path, icon_packs, read_binary,
            list_directory, read_text, download_file,
            write_text, make_dir, rename_path, copy_path, remove_path, upload_file,
            term_open, term_write, term_resize, term_close, exec, list_plugins,
            forward_port, cancel_forward, list_forwards, open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
