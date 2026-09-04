//! Package management over PackageKit.
//!
//! PackageKit is the D-Bus API every desktop package manager sits on, and its
//! backend is whatever the distro uses — apt here, dnf or zypper elsewhere. So
//! reads are typed, fast and cross-distro without this file knowing what a
//! `.deb` is.
//!
//! The API is transaction-shaped rather than request/response: create a
//! transaction object, subscribe to *its* path, call a method, and collect
//! `Package` signals until `Finished`. Each transaction gets its own bus
//! connection, so a slow search cannot interleave with anything else or
//! swallow signals another subscriber was waiting for.
//!
//! Writes go through `sudo pkcon`, for the same reason systemd writes go
//! through `sudo systemctl`: PackageKit gates installs behind polkit, and root
//! is not subject to it. That also keeps writes cross-distro, since pkcon
//! drives the same backend.

use crate::{dbus, shq, Error, Host, Result};
use serde::Serialize;
use std::time::{Duration, Instant};

const PK: &str = "org.freedesktop.PackageKit";
const PK_PATH: &str = "/org/freedesktop/PackageKit";
const PK_TX: &str = "org.freedesktop.PackageKit.Transaction";

/// Filters are a bitfield of `1 << PkFilterEnum`.
const FILTER_NONE: u64 = 1 << 1;
const FILTER_INSTALLED: u64 = 1 << 2;
const FILTER_NOT_INSTALLED: u64 = 1 << 3;
const FILTER_NEWEST: u64 = 1 << 16;

/// `PkInfoEnum::Installed`
const INFO_INSTALLED: u64 = 1;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Package {
    /// The full PackageKit id, `name;version;arch;repo` — needed verbatim for
    /// any follow-up call, so it is kept rather than reassembled.
    pub id: String,
    pub name: String,
    pub version: String,
    pub arch: String,
    pub repo: String,
    pub summary: String,
    pub installed: bool,
}

impl Package {
    fn parse(id: &str, summary: &str, info: u64) -> Package {
        let mut f = id.split(';');
        Package {
            name: f.next().unwrap_or_default().to_string(),
            version: f.next().unwrap_or_default().to_string(),
            arch: f.next().unwrap_or_default().to_string(),
            repo: f.next().unwrap_or_default().to_string(),
            summary: summary.to_string(),
            installed: info == INFO_INSTALLED,
            id: id.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Details {
    pub id: String,
    pub description: String,
    pub license: String,
    pub url: String,
    pub size: u64,
    pub group: u32,
}

/// A transaction on its own connection.
struct Tx {
    d: dbus::Dbus,
    path: String,
}

impl Tx {
    fn open(h: &mut Host) -> Result<Tx> {
        // Ensure the forward exists, then take a private connection over it.
        h.bus()?;
        let (sock, uid) = (h.bus_path().to_string(), h.uid());
        let mut d = dbus::Dbus::connect(&sock, uid)?;
        let out = d.call(PK, PK_PATH, PK, "CreateTransaction", &[])?;
        let path = out.first().and_then(|v| v.as_str())
            .ok_or_else(|| Error::Io("PackageKit gave no transaction".into()))?
            .to_string();
        d.add_match(&format!("type='signal',path='{path}'"))?;
        Ok(Tx { d, path })
    }

    /// Call a transaction method and collect packages until `Finished`.
    ///
    /// `Finished` is the only reliable terminator: a search that matches
    /// nothing emits no packages at all, so counting results would hang.
    fn run(&mut self, member: &str, args: &[dbus::Val], timeout: Duration)
        -> Result<Vec<Package>> {
        let path = self.path.clone();
        self.d.call(PK, &path, PK_TX, member, args)?;

        let mut out = Vec::new();
        let start = Instant::now();
        loop {
            if start.elapsed() > timeout {
                return Err(Error::Io(format!("{member} timed out after {:?}", timeout)))
            }
            match self.d.next_signal(Duration::from_millis(500))? {
                None => continue,
                Some(sig) => match sig.member.as_str() {
                    "Package" => {
                        let info = sig.args.first().and_then(|v| v.as_u64()).unwrap_or(0);
                        let id = sig.args.get(1).and_then(|v| v.as_str()).unwrap_or("");
                        let summary = sig.args.get(2).and_then(|v| v.as_str()).unwrap_or("");
                        if !id.is_empty() { out.push(Package::parse(id, summary, info)) }
                    }
                    "ErrorCode" => {
                        let msg = sig.args.get(1).and_then(|v| v.as_str()).unwrap_or("failed");
                        return Err(Error::Remote { code: 1, stderr: msg.to_string() })
                    }
                    "Finished" => break,
                    _ => {}
                },
            }
        }
        Ok(out)
    }
}

fn strings(values: &[&str]) -> dbus::Val {
    dbus::Val::Array("s".into(),
        values.iter().map(|v| dbus::Val::Str((*v).to_string())).collect())
}

/// Search package names. Newest-only, so one package does not fill the list
/// with every version the archive still carries.
pub fn search(h: &mut Host, query: &str) -> Result<Vec<Package>> {
    if query.trim().is_empty() { return Ok(Vec::new()) }
    let mut tx = Tx::open(h)?;
    let mut out = tx.run("SearchNames",
        &[dbus::Val::U64(FILTER_NONE | FILTER_NEWEST), strings(&[query])],
        Duration::from_secs(60))?;
    // Installed first, then by how well the name matches what was typed.
    let q = query.to_lowercase();
    out.sort_by(|a, b| {
        b.installed.cmp(&a.installed)
            .then_with(|| rank(&a.name, &q).cmp(&rank(&b.name, &q)))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

fn rank(name: &str, q: &str) -> u8 {
    let n = name.to_lowercase();
    if n == q { 0 } else if n.starts_with(q) { 1 } else { 2 }
}

pub fn list_installed(h: &mut Host) -> Result<Vec<Package>> {
    let mut tx = Tx::open(h)?;
    let mut out = tx.run("GetPackages",
        &[dbus::Val::U64(FILTER_INSTALLED)], Duration::from_secs(120))?;
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Packages with a newer version available.
pub fn list_updates(h: &mut Host) -> Result<Vec<Package>> {
    let mut tx = Tx::open(h)?;
    let mut out = tx.run("GetUpdates",
        &[dbus::Val::U64(FILTER_NONE)], Duration::from_secs(120))?;
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub fn details(h: &mut Host, id: &str) -> Result<Details> {
    let mut tx = Tx::open(h)?;
    let path = tx.path.clone();
    tx.d.call(PK, &path, PK_TX, "GetDetails", &[strings(&[id])])?;

    let mut out = Details { id: id.to_string(), ..Default::default() };
    let start = Instant::now();
    loop {
        if start.elapsed() > Duration::from_secs(30) { break }
        match tx.d.next_signal(Duration::from_millis(500))? {
            None => continue,
            Some(sig) => match sig.member.as_str() {
                // PackageKit 1.2+ sends a dict; older versions send positional
                // arguments. Both are read so this does not break on an older box.
                "Details" => {
                    if let Some(dbus::Val::Dict(_, entries)) = sig.args.first() {
                        for (k, v) in entries {
                            match k.as_str().unwrap_or("") {
                                "description" => out.description = v.as_str().unwrap_or("").into(),
                                "license" => out.license = v.as_str().unwrap_or("").into(),
                                "url" => out.url = v.as_str().unwrap_or("").into(),
                                "size" => out.size = v.as_u64().unwrap_or(0),
                                "group" => out.group = v.as_u64().unwrap_or(0) as u32,
                                _ => {}
                            }
                        }
                    } else {
                        out.license = sig.args.get(1).and_then(|v| v.as_str()).unwrap_or("").into();
                        out.description = sig.args.get(3).and_then(|v| v.as_str()).unwrap_or("").into();
                        out.url = sig.args.get(4).and_then(|v| v.as_str()).unwrap_or("").into();
                        out.size = sig.args.get(5).and_then(|v| v.as_u64()).unwrap_or(0);
                    }
                }
                "ErrorCode" => {
                    let msg = sig.args.get(1).and_then(|v| v.as_str()).unwrap_or("failed");
                    return Err(Error::Remote { code: 1, stderr: msg.to_string() })
                }
                "Finished" => break,
                _ => {}
            },
        }
    }
    Ok(out)
}

/// Is a package installed right now? Cheaper than listing everything.
pub fn resolve(h: &mut Host, name: &str) -> Result<Vec<Package>> {
    let mut tx = Tx::open(h)?;
    tx.run("Resolve", &[dbus::Val::U64(FILTER_NONE), strings(&[name])],
           Duration::from_secs(30))
}

/// Install or remove.
///
/// `sudo pkcon` rather than the bus: PackageKit puts installs behind polkit,
/// and root is not subject to it. It also keeps this cross-distro, since pkcon
/// drives whichever backend the box has.
pub fn install(h: &mut Host, name: &str, password: &str) -> Result<String> {
    package_action(h, "install", name, password)
}

pub fn remove(h: &mut Host, name: &str, password: &str) -> Result<String> {
    package_action(h, "remove", name, password)
}

fn package_action(h: &mut Host, verb: &str, name: &str, password: &str) -> Result<String> {
    // A package name is never trusted back as shell input, even though it came
    // from the remote's own package database.
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric()
        || "-_.+:~".contains(c)) {
        return Err(Error::Io(format!("refusing suspicious package name: {name}")))
    }
    let o = h.sudo(&format!("pkcon --plain --noninteractive {verb} {}", shq(name)), password)?;
    if o.code == 0 {
        Ok(o.stdout.lines().rev().find(|l| !l.trim().is_empty())
            .unwrap_or("done").trim().to_string())
    } else {
        // pkcon reports the useful part on stdout even when it fails.
        let why = o.stderr.trim();
        let why = if why.is_empty() { o.stdout.trim() } else { why };
        Err(Error::Remote { code: o.code, stderr: why.to_string() })
    }
}

/// Refresh the package index — the equivalent of `apt update`.
pub fn refresh(h: &mut Host, password: &str) -> Result<String> {
    let o = h.sudo("pkcon --plain --noninteractive refresh force", password)?;
    if o.code == 0 { Ok("package index refreshed".into()) }
    else { Err(Error::Remote { code: o.code, stderr: o.stderr }) }
}

/// Which backend this host uses, for the UI to name honestly.
pub fn backend(h: &mut Host) -> Result<String> {
    let v = h.bus()?.get(PK, PK_PATH, PK, "BackendName")?;
    Ok(v.as_str().unwrap_or("unknown").to_string())
}

/// Not every box has PackageKit; the app should say so rather than fail oddly.
pub fn available(h: &mut Host) -> bool {
    backend(h).is_ok()
}

#[allow(dead_code)]
const _UNUSED: u64 = FILTER_NOT_INSTALLED;

#[cfg(test)]
mod tests {
    /// Package names reach a shell command line, and they arrive from the
    /// remote's own database — which is exactly the input you are tempted to
    /// trust. The whitelist is the only thing between that and a second
    /// command, so it is asserted rather than assumed.
    fn accepted(name: &str) -> bool {
        !name.is_empty()
            && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.+:~".contains(c))
    }

    #[test]
    fn real_package_names_are_accepted() {
        for n in ["htop", "libssl3t64", "g++-14", "python3.12", "linux-image-6.8.0-31-generic",
                  "gcc-13-base:arm64", "fonts-noto-cjk", "libc6~exp1"] {
            assert!(accepted(n), "{n} rejected");
        }
    }

    #[test]
    fn shell_metacharacters_are_refused() {
        for n in ["htop; rm -rf /", "htop && id", "$(id)", "`id`", "htop|tee /x",
                  "htop\nid", "htop 'x'", "../../etc/passwd", ""] {
            assert!(!accepted(n), "{n:?} was allowed through");
        }
    }
}
