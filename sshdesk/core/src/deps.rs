//! Remote dependencies declared by apps.
//!
//! An app says what it needs on the machine — a command, a package, or an
//! archive that no repository carries — and this resolves it. Same shape as
//! tokens and content types: declared, not hardcoded in whatever launches the
//! app.
//!
//! Three kinds, because one is not enough:
//!
//!   * `command`  probe only. Missing means a clear message, not an install.
//!   * `package`  through PackageKit, named per backend. PackageKit's apt
//!                backend cannot map a *missing* file to a package (that needs
//!                apt-file), so the names have to be declared. Verified, not
//!                assumed: `what-provides /usr/bin/docker` returns nothing.
//!   * `archive`  a tarball, unpacked under ~/.sshdesk/opt.
//!
//! The archive kind is preferred wherever it fits, and not only because some
//! software is not packaged: it installs into the user's own directory, so it
//! needs no root, no polkit and no password, and removing it is one `rm -rf`
//! rather than a package manager transaction that cannot be cleanly reversed.

use crate::{shq, Error, Host, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Everything sshdesk installs lives here, so it is all visible and removable
/// in one place and never mixed in with what the machine's owner installed.
pub const OPT_DIR: &str = ".sshdesk/opt";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Requirement {
    Command {
        command: String,
        #[serde(default)]
        hint: String,
    },
    Package {
        command: String,
        /// backend name (`apt`, `dnf`, …) -> package name
        packages: BTreeMap<String, String>,
    },
    Archive {
        command: String,
        /// `${arch}` is replaced with the remote's uname -m.
        url: String,
        /// arch -> sha256 of the download. Required: this fetches a binary and
        /// then runs it.
        sha256: BTreeMap<String, String>,
        /// Directory name under ~/.sshdesk/opt.
        into: String,
        /// Path to the executable inside the unpacked tree.
        bin: String,
        #[serde(default = "one")]
        strip_components: u32,
        /// `uname -m` -> whatever the publisher calls that architecture.
        /// Projects rarely agree: aarch64 ships as "arm64", x86_64 as "x64".
        /// The checksums stay keyed by `uname -m`, which is the only name the
        /// remote actually reports.
        #[serde(default)]
        arch_map: BTreeMap<String, String>,
    },
}

fn one() -> u32 { 1 }

impl Requirement {
    pub fn command(&self) -> &str {
        match self {
            Requirement::Command { command, .. }
            | Requirement::Package { command, .. }
            | Requirement::Archive { command, .. } => command,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub command: String,
    pub present: bool,
    /// Where it was found, if it was.
    pub path: String,
    /// "command" | "package" | "archive"
    pub kind: String,
    /// What installing it would mean, in words the user can act on.
    pub detail: String,
    /// False when nothing can be done automatically.
    pub installable: bool,
}

/// A command name that is safe to interpolate and plausible as a program.
fn sane_command(c: &str) -> bool {
    !c.is_empty() && c.len() < 64
        && c.chars().all(|ch| ch.is_ascii_alphanumeric() || "-_.+".contains(ch))
}

/// A directory name under OPT_DIR. No separators: this must not escape.
fn sane_dirname(d: &str) -> bool {
    !d.is_empty() && d.len() < 64 && d != "." && d != ".."
        && d.chars().all(|ch| ch.is_ascii_alphanumeric() || "-_.".contains(ch))
}

fn sane_url(u: &str) -> bool {
    u.starts_with("https://") && u.len() < 2048
        && !u.contains(|c: char| c.is_whitespace() || c.is_control())
        && !u.contains('\'') && !u.contains('`') && !u.contains('$')
}

fn sane_sha(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// `uname -m` on the remote.
pub fn arch(h: &mut Host) -> Result<String> {
    Ok(h.run("uname -m")?.stdout.trim().to_string())
}

/// Where an archive requirement's executable would live.
pub fn archive_bin(home: &str, into: &str, bin: &str) -> String {
    format!("{home}/{OPT_DIR}/{into}/{bin}")
}

/// Probe every requirement in one round trip.
///
/// Batched deliberately: a launch that checked four dependencies one at a time
/// would cost four round trips before the window even appeared.
pub fn probe(h: &mut Host, reqs: &[Requirement]) -> Result<Vec<Status>> {
    if reqs.is_empty() { return Ok(Vec::new()) }
    let home = h.sftp()?.home()?;
    let backend = crate::packagekit::backend(h).unwrap_or_default();
    let arch = arch(h)?;

    // One script: for each requirement, print where its command is, looking
    // inside our own opt directory as well as $PATH.
    let mut script = String::new();
    for r in reqs {
        let c = r.command();
        if !sane_command(c) {
            script.push_str("echo ''\n");
            continue
        }
        match r {
            Requirement::Archive { into, bin, .. } if sane_dirname(into) => {
                let p = archive_bin(&home, into, bin);
                script.push_str(&format!(
                    "if [ -x {p} ]; then echo {p}; else command -v {c} 2>/dev/null || echo ''; fi\n",
                    p = shq(&p), c = shq(c)));
            }
            _ => script.push_str(&format!("command -v {} 2>/dev/null || echo ''\n", shq(c))),
        }
    }

    let out = h.run(&script)?;
    let mut lines = out.stdout.lines();

    Ok(reqs.iter().map(|r| {
        let path = lines.next().unwrap_or("").trim().to_string();
        let present = !path.is_empty();
        let (kind, detail, installable) = match r {
            Requirement::Command { hint, .. } => (
                "command",
                if hint.is_empty() { "not available on this machine".to_string() }
                else { hint.clone() },
                false,
            ),
            Requirement::Package { packages, .. } => {
                match packages.get(&backend).or_else(|| packages.get("default")) {
                    Some(p) => ("package", format!("install the {p} package ({backend})"), true),
                    None => ("package",
                             format!("no package name declared for this backend ({backend})"),
                             false),
                }
            }
            Requirement::Archive { url, sha256, into, .. } => {
                let ok = sha256.contains_key(&arch) && sane_url(url) && sane_dirname(into);
                if ok {
                    ("archive",
                     format!("download into ~/{OPT_DIR}/{into} — no root needed"),
                     true)
                } else if !sha256.contains_key(&arch) {
                    ("archive", format!("no build published for {arch}"), false)
                } else {
                    ("archive", "the app declared an unusable download".into(), false)
                }
            }
        };
        Status {
            command: r.command().to_string(),
            present,
            path,
            kind: kind.into(),
            detail,
            installable: installable && !present,
        }
    }).collect())
}

/// Install one requirement. Archives need no password; packages do.
pub fn install(h: &mut Host, req: &Requirement, password: &str) -> Result<String> {
    match req {
        Requirement::Command { command, .. } =>
            Err(Error::Io(format!("{command} cannot be installed automatically"))),
        Requirement::Package { packages, .. } => {
            let backend = crate::packagekit::backend(h)?;
            let name = packages.get(&backend).or_else(|| packages.get("default"))
                .ok_or_else(|| Error::Io(format!("no package declared for {backend}")))?;
            crate::packagekit::install(h, name, password)
        }
        Requirement::Archive { url, sha256, into, bin, strip_components, arch_map, .. } =>
            install_archive(h, url, sha256, into, bin, *strip_components, arch_map),
    }
}

/// Download, verify, unpack — in that order, on the remote.
///
/// The checksum is not optional and is checked *before* anything is unpacked.
/// This fetches a binary that will then be executed on the user's machine, so
/// "the download succeeded" is not the same as "the download is what the app
/// said it would be".
fn install_archive(
    h: &mut Host,
    url: &str,
    sha256: &BTreeMap<String, String>,
    into: &str,
    bin: &str,
    strip: u32,
    arch_map: &BTreeMap<String, String>,
) -> Result<String> {
    if !sane_dirname(into) { return Err(Error::Io(format!("unsafe install directory: {into}"))) }
    let arch = arch(h)?;
    let url_arch = arch_map.get(&arch).cloned().unwrap_or_else(|| arch.clone());
    let url = url.replace("${arch}", &url_arch);
    if !sane_url(&url) { return Err(Error::Io(format!("refusing to fetch: {url}"))) }
    let want = sha256.get(&arch)
        .ok_or_else(|| Error::Io(format!("no checksum published for {arch}")))?;
    if !sane_sha(want) { return Err(Error::Io("declared checksum is not a sha256".into())) }

    let home = h.sftp()?.home()?;
    let dir = format!("{home}/{OPT_DIR}/{into}");
    let tmp = format!("{home}/{OPT_DIR}/.{into}.download");

    // Fetch on the remote rather than through us: it is usually the better
    // link, and the bytes never touch this machine.
    let fetch = format!(
        "set -e\n\
         mkdir -p {optdir}\n\
         if command -v curl >/dev/null; then curl -fL --retry 2 -o {tmp} {url}\n\
         elif command -v wget >/dev/null; then wget -q -O {tmp} {url}\n\
         else echo 'neither curl nor wget on this machine' >&2; false; fi\n\
         sha256sum {tmp} | cut -d' ' -f1",
        optdir = shq(&format!("{home}/{OPT_DIR}")),
        tmp = shq(&tmp), url = shq(&url));

    let out = h.run(&fetch)?;
    if out.code != 0 {
        let _ = h.run(&format!("rm -f {}", shq(&tmp)));
        return Err(Error::Remote { code: out.code, stderr: out.stderr })
    }
    let got = out.stdout.trim().to_string();
    if got != *want {
        let _ = h.run(&format!("rm -f {}", shq(&tmp)));
        return Err(Error::Remote {
            code: 1,
            stderr: format!("checksum mismatch for {arch}: expected {want}, got {got}"),
        })
    }

    // Only now unpack. A fresh directory each time, so a failed upgrade cannot
    // leave a half-replaced tree behind.
    let unpack = format!(
        "set -e\n\
         rm -rf {dir}.new {dir}.old\n\
         mkdir -p {dir}.new\n\
         tar -xzf {tmp} -C {dir}.new --strip-components={strip} --no-same-owner\n\
         if [ -d {dir} ]; then mv {dir} {dir}.old; fi\n\
         mv {dir}.new {dir}\n\
         rm -rf {dir}.old {tmp}\n\
         test -x {binpath}",
        dir = shq(&dir), tmp = shq(&tmp), strip = strip,
        binpath = shq(&format!("{dir}/{bin}")));

    let out = h.run(&unpack)?;
    if out.code != 0 {
        return Err(Error::Remote {
            code: out.code,
            stderr: if out.stderr.trim().is_empty() {
                format!("unpacked, but {bin} is not there or not executable")
            } else { out.stderr },
        })
    }
    Ok(format!("installed to ~/{OPT_DIR}/{into}"))
}

/// Remove something sshdesk installed. Only ever inside OPT_DIR.
pub fn remove_archive(h: &mut Host, into: &str) -> Result<String> {
    if !sane_dirname(into) { return Err(Error::Io(format!("unsafe directory: {into}"))) }
    let home = h.sftp()?.home()?;
    let dir = format!("{home}/{OPT_DIR}/{into}");
    let o = h.run(&format!("rm -rf {}", shq(&dir)))?;
    if o.code == 0 { Ok(format!("removed ~/{OPT_DIR}/{into}")) }
    else { Err(Error::Remote { code: o.code, stderr: o.stderr }) }
}

/// What sshdesk has installed here, for a Settings panel to list and remove.
#[derive(Debug, Clone, Serialize)]
pub struct Installed { pub name: String, pub size: u64 }

pub fn list_installed(h: &mut Host) -> Result<Vec<Installed>> {
    let home = h.sftp()?.home()?;
    let root = format!("{home}/{OPT_DIR}");
    let o = h.run(&format!(
        "if [ -d {root} ]; then du -sk {root}/*/ 2>/dev/null || true; fi", root = shq(&root)))?;
    Ok(o.stdout.lines().filter_map(|l| {
        let (kb, path) = l.split_once('\t')?;
        let name = path.trim_end_matches('/').rsplit('/').next()?.to_string();
        Some(Installed { name, size: kb.trim().parse::<u64>().ok()? * 1024 })
    }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_directories_cannot_escape_opt() {
        for bad in ["../x", "a/b", "/etc", "..", ".", "", "a b", "a;b", "$x"] {
            assert!(!sane_dirname(bad), "{bad:?} was allowed");
        }
        for good in ["openvscode-server", "node_v22", "code-server.1"] {
            assert!(sane_dirname(good), "{good} rejected");
        }
    }

    #[test]
    fn only_plain_https_urls_are_fetched() {
        assert!(sane_url("https://github.com/a/b/releases/download/v1/x-aarch64.tar.gz"));
        for bad in ["http://x/y", "file:///etc/passwd", "https://x/`id`",
                    "https://x/$(id)", "https://x/'a'", "https://x/a b"] {
            assert!(!sane_url(bad), "{bad} was allowed");
        }
    }

    #[test]
    fn a_checksum_must_be_a_checksum() {
        assert!(sane_sha(&"a".repeat(64)));
        for bad in ["", "abc", &"z".repeat(64), &"a".repeat(63)] {
            assert!(!sane_sha(bad), "{bad:?} accepted");
        }
    }

    #[test]
    fn command_names_cannot_carry_a_second_command() {
        for bad in ["a;b", "a b", "$(id)", "`id`", "a|b", "", "a/b"] {
            assert!(!sane_command(bad), "{bad:?} allowed");
        }
        assert!(sane_command("openvscode-server"));
        assert!(sane_command("g++"));
    }
}
