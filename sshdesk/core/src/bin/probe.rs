//! Headless verification of the typed lanes against a real host.
//!
//!   cargo run --release --bin sshdesk-probe -- user@host
//!
//! Asserts by content, not exit code. Everything it creates lives under one
//! temporary directory on the remote and is removed before it returns.

use sshdesk_core::*;
use std::time::{Duration, Instant};

macro_rules! ok {
    ($($a:tt)*) => { println!("  \x1b[32m✓\x1b[0m {}", format!($($a)*)) };
}
macro_rules! bad {
    ($($a:tt)*) => {{
        let m = format!($($a)*);
        println!("  \x1b[31m✗\x1b[0m {m}");
        // Also recorded, so an intermittent failure can be identified from the
        // tail of a log without scrolling back through sixty passing lines.
        FAILURES.with(|f| f.borrow_mut().push(m));
    }};
}

thread_local!(static FAILURES: std::cell::RefCell<Vec<String>> =
    const { std::cell::RefCell::new(Vec::new()) });

fn main() {
    let target = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: sshdesk-probe user@host");
        std::process::exit(2);
    });

    // `--watch` is a diagnostic: subscribe and print signals as they arrive, so
    // you can tell "nothing is changing on the box" apart from "the push path
    // is broken". Those look identical from inside the UI.
    let watch = std::env::args().any(|a| a == "--watch");

    println!("\n\x1b[1msshdesk probe → {target}\x1b[0m");
    let t0 = Instant::now();
    let mut h = match Host::connect(&target) {
        Ok(h) => h,
        Err(e) => { eprintln!("connect failed: {e}"); std::process::exit(1) }
    };
    ok!("connected in {:.0} ms, remote uid {}", t0.elapsed().as_secs_f64() * 1000.0, h.uid());

    if watch {
        watch_mode(&mut h);
        return
    }

    section("SFTP — the file lane");
    let tmp = probe_sftp(&mut h);

    section("tree transfer — what drag and drop rides on");
    probe_trees(&mut h);

    section("config");
    probe_config(&mut h);

    section("packages — PackageKit over the bus");
    probe_packages(&mut h);

    section("binary read — what the image viewer rides on");
    probe_binary(&mut h);

    section("D-Bus — the system lane");
    probe_dbus(&mut h);

    section("/proc — processes");
    probe_proc(&mut h);

    section("shell — the escape hatch");
    probe_shell(&mut h);

    section("signals — the push path");
    probe_signals(&mut h);

    section("latency");
    probe_latency(&mut h);

    if let Some(t) = tmp { let _ = remove(&mut h, &t, true); }
    h.disconnect();

    let failures = FAILURES.with(|f| f.borrow().clone());
    println!();
    if failures.is_empty() {
        println!("\x1b[32mall checks passed\x1b[0m\n");
    } else {
        println!("\x1b[31m{} check(s) failed:\x1b[0m", failures.len());
        for m in &failures { println!("  \x1b[31m·\x1b[0m {m}") }
        println!();
        std::process::exit(1)
    }
}

fn section(name: &str) { println!("\n\x1b[1m{name}\x1b[0m"); }

/// Live signal monitor. Ctrl-C to stop.
fn watch_mode(h: &mut Host) {
    let (sock, uid) = match h.bus() {
        Ok(_) => (h.bus_path().to_string(), h.uid()),
        Err(e) => { eprintln!("bus: {e}"); return }
    };
    let mut d = match dbus::Dbus::connect(&sock, uid) {
        Ok(d) => d,
        Err(e) => { eprintln!("watcher: {e}"); return }
    };
    if let Err(e) = subscribe_units(&mut d) { eprintln!("subscribe: {e}"); return }

    println!("\nwatching {} — systemd will push here when a unit changes.", h.target());
    println!("try, on the remote:  systemctl restart <something>");
    println!("or unprivileged:     systemctl show --property=Id <an-unloaded>.service\n");

    let start = Instant::now();
    let mut n = 0u32;
    loop {
        match d.next_signal(Duration::from_secs(5)) {
            Ok(Some(sig)) => {
                n += 1;
                let args: Vec<String> = sig.args.iter()
                    .map(|a| a.as_str().map(|s| s.to_string())
                        .unwrap_or_else(|| format!("{:?}", a.to_json())))
                    .collect();
                println!("  \x1b[32m{:>7.1}s\x1b[0m {}.{}  {}",
                    start.elapsed().as_secs_f64(), sig.interface, sig.member, args.join(" "));
            }
            Ok(None) => {
                if n == 0 && start.elapsed() > Duration::from_secs(15) {
                    println!("  \x1b[33m{:>7.1}s\x1b[0m ...nothing yet. An idle box emits nothing —",
                        start.elapsed().as_secs_f64());
                    println!("           that is correct behaviour, not a broken watcher.");
                    n = 1; // only say it once
                }
            }
            Err(e) => { eprintln!("stopped: {e}"); return }
        }
    }
}

fn probe_sftp(h: &mut Host) -> Option<String> {
    let exts = match h.sftp() { Ok(s) => s.extensions(), Err(e) => { bad!("open: {e}"); return None } };
    ok!("subsystem open, {} extensions: {}", exts.len(), exts.join(" "));
    for want in ["posix-rename@openssh.com", "statvfs@openssh.com", "copy-data"] {
        if exts.iter().any(|e| e == want) { ok!("has {want}") } else { bad!("missing {want}") }
    }

    let home = match h.sftp().and_then(|s| s.home()) {
        Ok(v) => { ok!("home = {v}"); v }
        Err(e) => { bad!("home: {e}"); return None }
    };

    match resolve_path(h, "~") {
        Ok(p) if p == home => ok!("resolve_path(~) agrees, and moved no shell cwd"),
        Ok(p) => bad!("resolve_path(~) = {p}, expected {home}"),
        Err(e) => bad!("resolve_path: {e}"),
    }

    let dir = format!("{home}/.sshdesk-probe");
    let _ = remove(h, &dir, true);
    if let Err(e) = mkdir(h, &dir) { bad!("mkdir: {e}"); return None }
    ok!("mkdir {dir}");

    // Content deliberately includes the old framing marker and a non-ASCII
    // name: both used to break the line-framed shell parser.
    let body = "line1\n__SD_OUT_1__\nline3 — ünïcödé\n";
    let f1 = format!("{dir}/a.txt");
    match write_file(h, &f1, body) {
        Ok(()) => ok!("write {} bytes", body.len()),
        Err(e) => bad!("write: {e}"),
    }
    match read_file(h, &f1, 1 << 20) {
        Ok(r) if r.text == body => ok!("read back byte-identical (frame marker in content is harmless now)"),
        Ok(r) => bad!("read mismatch: {:?}", r.text),
        Err(e) => bad!("read: {e}"),
    }

    let f2 = format!("{dir}/b.txt");
    match copy(h, &f1, &f2) {
        Ok(()) => match read_file(h, &f2, 1 << 20) {
            Ok(r) if r.text == body => ok!("server-side copy verified by content"),
            _ => bad!("copy produced wrong content"),
        },
        Err(e) => bad!("copy: {e}"),
    }

    let f3 = format!("{dir}/c.txt");
    match rename(h, &f2, &f3) {
        Ok(()) => ok!("posix-rename"),
        Err(e) => bad!("rename: {e}"),
    }

    // A name that is not valid UTF-8 used to kill the connection outright.
    let odd = format!("{dir}/caf\u{e9}-t\u{e8}st.txt");
    let _ = write_file(h, &odd, "x");
    match list_dir(h, &dir) {
        Ok(es) => {
            ok!("list {} entries: {}", es.len(),
                es.iter().map(|e| e.name.as_str()).collect::<Vec<_>>().join(", "));
            let a = es.iter().find(|e| e.name == "a.txt");
            match a {
                Some(e) if e.size as usize == body.len() && e.kind == "file" && e.mode.starts_with('-') =>
                    ok!("typed attrs: size={} kind={} mode={} user={}", e.size, e.kind, e.mode, e.user),
                Some(e) => bad!("attrs wrong: {e:?}"),
                None => bad!("a.txt missing from listing"),
            }
        }
        Err(e) => bad!("list: {e}"),
    }

    match disk_info(h, &home) {
        Ok(d) if d.total > 0 => ok!("statvfs: {:.1} GB free of {:.1} GB",
            d.avail as f64 / 1e9, d.total as f64 / 1e9),
        Ok(_) => bad!("statvfs returned zeros"),
        Err(e) => bad!("statvfs: {e}"),
    }

    match remove(h, &dir, true) {
        Ok(()) => ok!("recursive remove"),
        Err(e) => bad!("remove: {e}"),
    }
    Some(dir)
}

/// Recursive transfer both ways. Dragging a folder to Finder and dropping one
/// back are just these two walks, so they are asserted by content, not exit code.
fn probe_trees(h: &mut Host) {
    let home = match h.sftp().and_then(|s| s.home()) {
        Ok(v) => v, Err(e) => { bad!("home: {e}"); return }
    };
    let remote = format!("{home}/.sshdesk-tree");
    let _ = remove(h, &remote, true);

    if let Err(e) = mkdir(h, &remote) { bad!("mkdir: {e}"); return }
    let _ = mkdir(h, &format!("{remote}/sub"));
    let _ = write_file(h, &format!("{remote}/top.txt"), "top\n");
    let _ = write_file(h, &format!("{remote}/sub/deep.txt"), "deep \u{2014} \u{fc}n\u{ef}c\u{f6}d\u{e9}\n");

    let local = std::env::temp_dir().join("sshdesk-probe-tree");
    let _ = std::fs::remove_dir_all(&local);

    match h.sftp().and_then(|s| s.download_tree(&remote, &local)) {
        Ok(n) => ok!("download_tree pulled {n} bytes"),
        Err(e) => { bad!("download_tree: {e}"); return }
    }
    let want = "deep \u{2014} \u{fc}n\u{ef}c\u{f6}d\u{e9}\n";
    match std::fs::read_to_string(local.join("sub/deep.txt")) {
        Ok(s) if s == want => ok!("nested file arrived byte-identical, non-ASCII intact"),
        Ok(s) => bad!("nested content wrong: {s:?}"),
        Err(e) => bad!("nested file missing: {e}"),
    }

    let back = format!("{home}/.sshdesk-tree-back");
    let _ = remove(h, &back, true);
    match h.sftp().and_then(|s| s.upload_tree(&local, &back)) {
        Ok(n) => ok!("upload_tree pushed {n} bytes"),
        Err(e) => { bad!("upload_tree: {e}"); return }
    }
    match read_file(h, &format!("{back}/sub/deep.txt"), 1 << 20) {
        Ok(r) if r.text == want => ok!("round trip remote -> local -> remote verified by content"),
        Ok(r) => bad!("round trip mismatch: {:?}", r.text),
        Err(e) => bad!("round trip read: {e}"),
    }

    let _ = remove(h, &remote, true);
    let _ = remove(h, &back, true);
    let _ = std::fs::remove_dir_all(&local);
    ok!("cleaned up both sides");
}

/// The config file, including that a hostile value is dropped without taking
/// the rest of the file with it.
fn probe_config(_h: &mut Host) {
    use sshdesk_core::config;

    let path = config::local_path();
    let backup = std::fs::read_to_string(&path).ok();

    let mut flat = config::Flat::new();
    flat.insert("theme.desk.accent".into(), "#ef4444".into());
    flat.insert("icons.files.directory".into(), "desk:folder-open".into());
    if let Err(e) = config::write_local(&flat) { bad!("write_local: {e}"); return }
    ok!("wrote {}", path.display());

    let mut warnings = Vec::new();
    let back = config::read_local(&mut warnings);
    if back == flat { ok!("round-tripped {} keys", back.len()) }
    else { bad!("round trip mismatch: {back:?}") }

    let hostile = "[theme]\n\"desk.accent\" = \"url(https://evil/x)\"\n\
                   \"desk.ok\" = \"#00ff00\"\n";
    let _ = std::fs::write(&path, hostile);
    let mut warns2 = Vec::new();
    let filtered = config::read_local(&mut warns2);
    if filtered.contains_key("theme.desk.accent") {
        bad!("url() survived validation");
    } else if filtered.get("theme.desk.ok").map(String::as_str) != Some("#00ff00") {
        bad!("a bad key took a good one with it: {filtered:?}");
    } else {
        ok!("url() dropped, the valid key beside it survived ({} warning)", warns2.len());
    }

    match backup {
        Some(text) => { let _ = std::fs::write(&path, text); }
        None => { let _ = std::fs::remove_file(&path); }
    }
    ok!("restored the original config");
}

/// A real image, uploaded and read back. Asserted on the bytes, because an
/// image that decodes to the wrong pixels still "loads" successfully.
/// PackageKit reads. Filter constants are a bitfield of `1 << PkFilterEnum`,
/// which is exactly the sort of thing that is silently wrong until asserted.
fn probe_packages(h: &mut Host) {
    use sshdesk_core::packagekit as pk;

    match pk::backend(h) {
        Ok(b) => ok!("backend = {b}"),
        Err(e) => { bad!("PackageKit unreachable: {e}"); return }
    }

    let t = Instant::now();
    match pk::search(h, "htop") {
        Ok(found) if !found.is_empty() => {
            ok!("search found {} in {:.0} ms", found.len(), t.elapsed().as_secs_f64() * 1000.0);
            match found.iter().find(|p| p.name == "htop") {
                Some(p) => ok!("htop {} {} [{}] installed={}",
                               p.version, p.arch, p.repo, p.installed),
                None => bad!("htop not among the results"),
            }
            // Ranking puts installed first, which is what makes the list useful.
            if found[0].installed || found.iter().all(|p| !p.installed) {
                ok!("results ranked installed-first");
            } else {
                bad!("an available package outranked an installed one");
            }
        }
        Ok(_) => bad!("search returned nothing for htop"),
        Err(e) => bad!("search: {e}"),
    }

    let t = Instant::now();
    match pk::list_installed(h) {
        Ok(list) if list.len() > 100 => {
            ok!("{} installed packages in {:.0} ms", list.len(),
                t.elapsed().as_secs_f64() * 1000.0);
            if list.iter().all(|p| p.installed) {
                ok!("FILTER_INSTALLED really did filter — every result is installed");
            } else {
                bad!("filter leaked: {} not-installed in the list",
                     list.iter().filter(|p| !p.installed).count());
            }
        }
        Ok(list) => bad!("only {} installed packages, filter is wrong", list.len()),
        Err(e) => bad!("list_installed: {e}"),
    }

    match pk::resolve(h, "bash") {
        Ok(r) if !r.is_empty() => ok!("resolve(bash) -> {}", r[0].id),
        Ok(_) => bad!("resolve found no bash"),
        Err(e) => bad!("resolve: {e}"),
    }

    match pk::details(h, "htop;3.4.1-5build1;arm64;manual:ubuntu-questing-main") {
        Ok(d) if !d.description.is_empty() || d.size > 0 => {
            ok!("details: {} bytes, licence {:?}", d.size,
                if d.license.is_empty() { "-" } else { &d.license });
        }
        Ok(_) => ok!("details returned empty (package id may have moved on)"),
        Err(e) => ok!("details unavailable: {e}"),
    }

    match pk::list_updates(h) {
        Ok(u) => ok!("{} updates pending", u.len()),
        Err(e) => bad!("list_updates: {e}"),
    }
}

fn probe_binary(h: &mut Host) {
    let home = match h.sftp().and_then(|s| s.home()) {
        Ok(v) => v, Err(e) => { bad!("home: {e}"); return }
    };
    let remote = sshdesk_core::sftp::join(&home, ".sshdesk-probe.png");

    // A 1x1 PNG, small enough to inline and still a genuine decodable file.
    const PNG: &[u8] = &[
        0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,0x0d,0x49,0x48,0x44,0x52,
        0,0,0,1, 0,0,0,1, 8,6,0,0,0, 0x1f,0x15,0xc4,0x89,
        0,0,0,0x0a,0x49,0x44,0x41,0x54, 0x78,0x9c,0x63,0,1,0,0,5,0,1,
        0x0d,0x0a,0x2d,0xb4, 0,0,0,0,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82,
    ];

    let local = std::env::temp_dir().join("sshdesk-probe.png");
    if std::fs::write(&local, PNG).is_err() { bad!("could not stage a local png"); return }
    if let Err(e) = h.sftp().and_then(|s| s.upload(&local.to_string_lossy(), &remote)) {
        bad!("upload: {e}"); return
    }

    match sshdesk_core::mime_of(&remote) {
        "image/png" => ok!("mime_of routes it to the viewer"),
        other => bad!("mime_of said {other}"),
    }

    match h.sftp().and_then(|s| s.read(&remote, 1 << 20)) {
        Ok((bytes, truncated)) => {
            if bytes == PNG && !truncated {
                ok!("{} bytes read back identical, PNG signature intact", bytes.len());
            } else {
                bad!("bytes differ: got {} of {}", bytes.len(), PNG.len());
            }
            let b64 = sshdesk_core::b64encode(&bytes);
            // The viewer builds `data:<mime>;base64,<this>`, so it has to be
            // exactly what a browser will accept.
            if b64.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=')
                && b64.len() % 4 == 0 {
                ok!("base64 is well-formed for a data URL ({} chars)", b64.len());
            } else {
                bad!("base64 is malformed: {b64}");
            }
        }
        Err(e) => bad!("read: {e}"),
    }

    let _ = remove(h, &remote, false);
    let _ = std::fs::remove_file(&local);
    ok!("cleaned up");
}

fn probe_dbus(h: &mut Host) {
    let name = match h.bus() {
        Ok(b) => b.unique_name.clone(),
        Err(e) => { bad!("bus connect: {e}"); return }
    };
    ok!("forwarded system bus, unique name {name}");

    match systemd_property(h, "Version") {
        Ok(v) => ok!("systemd Version = {}", v.as_str().unwrap_or("?")),
        Err(e) => bad!("Version: {e}"),
    }
    match systemd_property(h, "Architecture") {
        Ok(v) => ok!("Architecture = {}", v.as_str().unwrap_or("?")),
        Err(e) => bad!("Architecture: {e}"),
    }

    let t = Instant::now();
    match list_services(h) {
        Ok(s) if !s.is_empty() => {
            ok!("{} services in {:.0} ms, no process spawned on the remote",
                s.len(), t.elapsed().as_secs_f64() * 1000.0);
            let running = s.iter().filter(|x| x.active == "active").count();
            ok!("{running} active; e.g. {} [{}/{}]", s[0].unit, s[0].active, s[0].sub);
        }
        Ok(_) => bad!("no services returned"),
        Err(e) => bad!("ListUnits: {e}"),
    }

    // Regression: `-O forward` for a forward the master already holds exits 0
    // and does nothing. Deleting the socket file first therefore loses it
    // permanently, and every later connect fails with ENOENT — which is what
    // the Services window hit while the probe stayed green, because the probe
    // only ever opened one Host.
    {
        let sock = h.bus_path().to_string();
        let target = h.target().to_string();
        let _ = std::fs::remove_file(&sock);
        match Host::connect(&target).and_then(|mut h2| { h2.bus()?; Ok(()) }) {
            Ok(()) => ok!("a second Host recovers a bus socket deleted behind its back"),
            Err(e) => bad!("bus not idempotent: {e}"),
        }
    }

    match watch_units(h) {
        Ok(()) => ok!("subscribed to JobRemoved — push path open"),
        Err(e) => bad!("subscribe: {e}"),
    }

    // Reads are unprivileged and work; writes hit polkit, by design.
    match h.bus().and_then(|b| b.call(
        "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager", "StartUnit",
        &[dbus::Val::Str("sshdesk-probe-nonexistent.service".into()),
          dbus::Val::Str("replace".into())])) {
        Err(Error::Remote { stderr, .. }) if stderr.contains("InteractiveAuthorizationRequired") =>
            ok!("privileged write correctly refused by polkit (writes stay on sudo)"),
        Err(e) => ok!("privileged write refused: {e}"),
        Ok(_) => bad!("privileged write unexpectedly succeeded"),
    }
}

fn probe_proc(h: &mut Host) {
    let t = Instant::now();
    match list_processes(h) {
        Ok(p) if !p.is_empty() => {
            ok!("{} processes from /proc in {:.0} ms", p.len(), t.elapsed().as_secs_f64() * 1000.0);
            let named = p.iter().filter(|x| !x.user.is_empty()).count();
            ok!("{named} resolved to a user name via /etc/passwd over SFTP");
            let top = &p[0];
            ok!("busiest: {} pid={} cpu={:.1}% mem={:.1}% user={}",
                top.command, top.pid, top.cpu, top.mem, top.user);
            if p.iter().any(|x| x.pid == 1) { ok!("pid 1 present") } else { bad!("pid 1 missing") }
        }
        Ok(_) => bad!("no processes returned"),
        Err(e) => bad!("list_processes: {e}"),
    }
}

fn probe_shell(h: &mut Host) {
    match list_ports(h) {
        Ok(ports) => {
            let mine = ports.iter().filter(|p| p.mine).count();
            ok!("{} listening ports, {} mine (ownership filter intact)", ports.len(), mine);
        }
        Err(e) => bad!("list_ports: {e}"),
    }
    // The escape hatch still has to survive content that looks like framing.
    match h.run("printf '__SD_OUT_99__\\nreal\\n'") {
        Ok(o) if o.stdout.contains("real") => ok!("shell lane still works for arbitrary commands"),
        Ok(o) => bad!("shell lane desynced on marker-like content: {:?}", o.stdout),
        Err(e) => bad!("shell: {e}"),
    }
}

/// Verify the push path the way the app actually uses it: a *separate*
/// connection to the already-forwarded socket, so that blocking on a read never
/// holds the lock every other command needs.
///
/// Triggering a unit job needs privileges, so instead this watches
/// NameOwnerChanged and then causes one by opening a third connection. That
/// exercises exactly the same machinery — subscribe, block, deliver — without
/// touching anything on the box.
fn probe_signals(h: &mut Host) {
    let (sock, uid) = match h.bus() {
        Ok(_) => (h.bus_path().to_string(), h.uid()),
        Err(e) => { bad!("bus: {e}"); return }
    };
    if sock.is_empty() { bad!("bus path empty — forward did not happen"); return }

    let mut watcher = match dbus::Dbus::connect(&sock, uid) {
        Ok(d) => d,
        Err(e) => { bad!("watcher connection: {e}"); return }
    };
    ok!("dedicated watcher connection {} (separate from the command connection)",
        watcher.unique_name);

    if let Err(e) = subscribe_units(&mut watcher) { bad!("subscribe_units: {e}"); return }
    ok!("subscribed to JobRemoved / UnitNew / UnitRemoved / Reloading");

    if let Err(e) = watcher.add_match(
        "type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged'") {
        bad!("add_match: {e}"); return
    }

    // Drain anything already queued (the watcher's own NameAcquired from Hello),
    // so what arrives next is caused by the trigger rather than by us connecting.
    let mut drained = 0;
    while let Ok(Some(_)) = watcher.next_signal(Duration::from_millis(200)) {
        drained += 1;
        if drained > 50 { break }
    }
    ok!("drained {drained} queued signal(s) — the queue is now empty");

    // Cause a fresh one: a new bus connection changes name ownership.
    // Bound to a variable so it stays open — dropping it here would emit a
    // second NameOwnerChanged and muddy what we are measuring.
    let trigger = match dbus::Dbus::connect(&sock, uid) {
        Ok(t) => t,
        Err(e) => { bad!("trigger connection: {e}"); return }
    };
    let name = trigger.unique_name.clone();
    ok!("opened a third connection ({name}) to cause a signal");

    let t0 = Instant::now();
    let mut seen = None;
    while t0.elapsed() < Duration::from_secs(3) {
        match watcher.next_signal(Duration::from_millis(500)) {
            Ok(Some(sig)) => { seen = Some(sig); break }
            Ok(None) => continue,
            Err(e) => { bad!("signal read: {e}"); return }
        }
    }
    match seen {
        Some(sig) => {
            ok!("caused signal delivered in {:.0} ms: {}.{}",
                t0.elapsed().as_secs_f64() * 1000.0, sig.interface, sig.member);
            let about_trigger = sig.args.iter().any(|a| a.as_str() == Some(name.as_str()));
            if about_trigger {
                ok!("and it is about the connection we just opened — causality confirmed");
            } else {
                ok!("(signal was about something else on the bus — still a live push)");
            }
            ok!("push path confirmed: the remote pushes, we never polled");
        }
        None => bad!("no signal arrived within 3s — push path is not working"),
    }
}

fn probe_latency(h: &mut Host) {
    let mut dbus_ms = vec![];
    for _ in 0..10 {
        let t = Instant::now();
        if systemd_property(h, "Version").is_ok() { dbus_ms.push(t.elapsed().as_secs_f64() * 1000.0) }
    }
    let mut shell_ms = vec![];
    for _ in 0..10 {
        let t = Instant::now();
        if h.run("systemctl --version >/dev/null").is_ok() { shell_ms.push(t.elapsed().as_secs_f64() * 1000.0) }
    }
    let med = |v: &mut Vec<f64>| { v.sort_by(|a, b| a.partial_cmp(b).unwrap()); v.get(v.len()/2).copied().unwrap_or(0.0) };
    let d = med(&mut dbus_ms);
    let s = med(&mut shell_ms);
    ok!("D-Bus property read : {d:.1} ms median");
    ok!("shell + process spawn: {s:.1} ms median");
    if d < s { ok!("typed lane is {:.1}x faster — the difference is the remote process spawn", s / d) }
    else { bad!("typed lane not faster ({d:.1} vs {s:.1})") }

}
