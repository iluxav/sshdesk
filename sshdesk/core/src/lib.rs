//! Persistent-shell SSH transport.
//!
//! Deliberately shells out to the real `ssh` binary rather than reimplementing
//! the protocol. That inherits ControlMaster multiplexing, ~/.ssh/config,
//! ssh-agent, ProxyJump, known_hosts and host-key verification for free — and
//! keeps every line of crypto out of this codebase.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

pub mod config;
pub mod icons;
pub mod dbus;
pub mod sftp;

pub use sftp::{DiskInfo, Entry};

#[derive(Debug)]
pub enum Error {
    Spawn(String),
    Io(String),
    Closed,
    Remote { code: i32, stderr: String },
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Spawn(m) => write!(f, "spawn failed: {m}"),
            Error::Io(m) => write!(f, "io error: {m}"),
            Error::Closed => write!(f, "remote shell closed"),
            Error::Remote { code, stderr } => write!(f, "exit {code}: {stderr}"),
        }
    }
}
impl std::error::Error for Error {}

type Result<T> = std::result::Result<T, Error>;

pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
    pub elapsed: Duration,
}

/// One live connection: a ControlMaster plus a single long-lived `bash` whose
/// stdin we feed commands into. Avoids per-command channel setup (~40ms -> ~19ms).
pub struct Host {
    target: String,
    ctl: String,
    shell: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    seq: u64,
    /// Remote uid. Needed for D-Bus EXTERNAL auth, which verifies the claimed
    /// identity against the peer credentials of sshd — not of us.
    uid: u32,
    /// Typed lanes, opened on first use. Both multiplex over `ctl`, so neither
    /// costs an authentication or a TCP connection.
    sftp: Option<sftp::Sftp>,
    bus: Option<dbus::Dbus>,
    bus_sock: String,
    passwd: Option<HashMap<u32, String>>,
}

impl Host {
    pub fn connect(target: &str) -> Result<Host> {
        Host::connect_with(target, None)
    }

    pub fn connect_with(target: &str, password: Option<&str>) -> Result<Host> {
        let ctl = control_path(target);
        ensure_master(target, &ctl, password)?;

        let mut shell = Command::new("ssh")
            .args(["-S", &ctl, target, "bash", "--noprofile", "--norc"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| Error::Spawn(e.to_string()))?;

        let stdin = shell.stdin.take().ok_or(Error::Closed)?;
        let stdout = BufReader::new(shell.stdout.take().ok_or(Error::Closed)?);

        let mut h = Host {
            target: target.into(), ctl, shell, stdin, stdout, seq: 0,
            uid: 0, sftp: None, bus: None, bus_sock: String::new(), passwd: None,
        };
        // Quiet the shell and make parsing predictable.
        h.run("export LC_ALL=C; unset PROMPT_COMMAND; set +o history")?;
        // One call, cached for the connection's life.
        h.uid = h.run("id -u")?.stdout.trim().parse().unwrap_or(0);
        Ok(h)
    }

    /// Run one command. stdout and stderr are captured separately by routing
    /// stderr to a temp file the same round trip reads back.
    pub fn run(&mut self, cmd: &str) -> Result<Output> {
        self.seq += 1;
        let m_out = format!("__SD_OUT_{}__", self.seq);
        let m_err = format!("__SD_ERR_{}__", self.seq);
        let m_end = format!("__SD_END_{}__", self.seq);

        // stderr is buffered to a var so we can frame it distinctly from stdout.
        let script = format!(
            "{{ __sd_err=$( {{ {cmd} ; }} 2>&1 1>&3 3>&- ); }} 3>&1\n\
             __sd_rc=$?\n\
             echo '{m_err}'\n\
             printf '%s\\n' \"$__sd_err\"\n\
             echo '{m_end}'\n\
             echo \"$__sd_rc\"\n\
             echo '{m_out}'\n"
        );

        let t0 = Instant::now();
        self.stdin.write_all(script.as_bytes()).map_err(|e| Error::Io(e.to_string()))?;
        self.stdin.flush().map_err(|e| Error::Io(e.to_string()))?;

        let mut stdout_buf = String::new();
        let mut stderr_buf = String::new();
        let mut code_buf = String::new();
        let mut phase = 0; // 0=stdout 1=stderr 2=code
        let mut line = String::new();

        loop {
            line.clear();
            let n = self.stdout.read_line(&mut line).map_err(|e| Error::Io(e.to_string()))?;
            if n == 0 {
                return Err(Error::Closed);
            }
            let t = line.trim_end_matches('\n');
            if t == m_err { phase = 1; continue; }
            if t == m_end { phase = 2; continue; }
            if t == m_out { break; }
            match phase {
                0 => { stdout_buf.push_str(&line); }
                1 => { stderr_buf.push_str(&line); }
                _ => { code_buf.push_str(t); }
            }
        }

        Ok(Output {
            stdout: stdout_buf,
            stderr: stderr_buf.trim_end().to_string(),
            code: code_buf.trim().parse().unwrap_or(-1),
            elapsed: t0.elapsed(),
        })
    }

    /// Run an argv vector. Each element is shell-quoted separately, so a value
    /// can never widen into extra arguments or a second command — the property
    /// the extension API depends on when it passes user input through.
    pub fn run_argv(&mut self, argv: &[String], password: Option<&str>) -> Result<Output> {
        if argv.is_empty() {
            return Err(Error::Io("empty argv".into()));
        }
        let line = argv.iter().map(|a| shq(a)).collect::<Vec<_>>().join(" ");
        match password {
            Some(pw) => self.sudo(&line, pw),
            None => self.run(&line),
        }
    }

    /// Run a command under sudo, feeding the password on stdin.
    /// `-S` is supported by both classic sudo and sudo-rs; `--askpass` is not.
    pub fn sudo(&mut self, cmd: &str, password: &str) -> Result<Output> {
        let quoted = password.replace('\'', "'\\''");
        self.run(&format!("printf '%s\\n' '{quoted}' | sudo -S -p '' {cmd}"))
    }

    pub fn target(&self) -> &str { &self.target }

    /// Path to this host's ControlMaster socket. A terminal session opens its
    /// own ssh process against it, so it costs no extra authentication.
    pub fn control_path(&self) -> &str { &self.ctl }

    /// Add a local port forward to the *live* connection — no reconnect.
    /// `ssh -O forward` is the primitive the whole project started from.
    pub fn forward(&self, local: u16, remote: u16) -> Result<()> {
        self.mux(&["-O", "forward", "-L", &format!("{local}:localhost:{remote}")])
    }

    pub fn cancel_forward(&self, local: u16, remote: u16) -> Result<()> {
        self.mux(&["-O", "cancel", "-L", &format!("{local}:localhost:{remote}")])
    }

    fn mux(&self, args: &[&str]) -> Result<()> {
        let out = Command::new("ssh")
            .arg("-S").arg(&self.ctl)
            .args(args)
            .arg(&self.target)
            .output()
            .map_err(|e| Error::Spawn(e.to_string()))?;
        if out.status.success() { return Ok(()) }
        Err(Error::Remote {
            code: out.status.code().unwrap_or(-1),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        })
    }

    /// Copy a remote file to the local machine over SFTP.
    ///
    /// Was a `scp` subprocess. Same connection either way, but this needs no
    /// process spawn and reports errors as protocol status codes rather than
    /// scraped stderr.
    pub fn download(&mut self, remote: &str, local: &str) -> Result<u64> {
        self.sftp()?.download(remote, local)
    }

    /// Copy a local file up to the remote over SFTP.
    pub fn upload(&mut self, local: &str, remote: &str) -> Result<u64> {
        self.sftp()?.upload(local, remote)
    }

    pub fn uid(&self) -> u32 { self.uid }

    /// Local endpoint of the forwarded bus. Empty until `bus()` has run.
    /// A signal watcher opens its *own* connection to this path so a blocking
    /// read never holds the lock that every other command needs.
    pub fn bus_path(&self) -> &str { &self.bus_sock }

    /// SFTP subsystem, opened on first use. This is the file lane: typed
    /// attributes, byte-safe names, server-side copy.
    pub fn sftp(&mut self) -> Result<&mut sftp::Sftp> {
        if self.sftp.is_none() {
            self.sftp = Some(sftp::Sftp::open(&self.target, &self.ctl)?);
        }
        Ok(self.sftp.as_mut().expect("just set"))
    }

    /// Remote system bus, opened on first use.
    ///
    /// Forwards /run/dbus/system_bus_socket onto a local unix socket with
    /// `-O forward` on the live connection — the same primitive as port
    /// forwarding, and still nothing installed on the remote.
    pub fn bus(&mut self) -> Result<&mut dbus::Dbus> {
        if self.bus.is_none() {
            let sock = bus_socket_path(&self.target);
            // StreamLocalBindUnlink defaults to `no`, so a socket left behind
            // by a previous run silently blocks the forward.
            let _ = std::fs::remove_file(&sock);
            self.mux(&["-O", "forward", "-L",
                       &format!("{sock}:/run/dbus/system_bus_socket")])?;
            let d = dbus::Dbus::connect(&sock, self.uid)?;
            self.bus_sock = sock;
            self.bus = Some(d);
        }
        Ok(self.bus.as_mut().expect("just set"))
    }

    /// uid -> name, read once over SFTP and cached. /proc only ever gives us
    /// numbers, and shelling out per process would cost more than the listing.
    fn passwd_map(&mut self) -> HashMap<u32, String> {
        if let Some(m) = &self.passwd { return m.clone() }
        let mut m = HashMap::new();
        if let Ok(s) = self.sftp() {
            if let Ok((bytes, _)) = s.read("/etc/passwd", 1 << 20) {
                for line in String::from_utf8_lossy(&bytes).lines() {
                    let f: Vec<&str> = line.split(':').collect();
                    if f.len() > 2 {
                        if let Ok(uid) = f[2].parse::<u32>() {
                            m.insert(uid, f[0].to_string());
                        }
                    }
                }
            }
        }
        self.passwd = Some(m.clone());
        m
    }

    pub fn disconnect(&mut self) {
        self.sftp = None;
        self.bus = None;
        if !self.bus_sock.is_empty() {
            let _ = self.mux(&["-O", "cancel", "-L",
                               &format!("{}:/run/dbus/system_bus_socket", self.bus_sock)]);
            let _ = std::fs::remove_file(&self.bus_sock);
        }
        let _ = self.stdin.write_all(b"exit\n");
        let _ = self.shell.wait();
        let _ = Command::new("ssh").args(["-S", &self.ctl, "-O", "exit", &self.target]).output();
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.shell.kill();
    }
}

fn control_path(target: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let safe: String = target.chars().map(|c| if c.is_alphanumeric() { c } else { '_' }).collect();
    // Keep well under the ~104 byte unix socket path limit.
    format!("{home}/.sshdesk-{safe}.sock")
}

/// Local endpoint for the forwarded system bus. Same length discipline as
/// `control_path` — unix socket paths are capped near 104 bytes.
fn bus_socket_path(target: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let safe: String = target.chars().map(|c| if c.is_alphanumeric() { c } else { '_' }).collect();
    format!("{home}/.sshdesk-bus-{safe}.sock")
}

fn ensure_master(target: &str, ctl: &str, password: Option<&str>) -> Result<()> {
    let alive = Command::new("ssh")
        .args(["-S", ctl, "-O", "check", target])
        .stdout(Stdio::null()).stderr(Stdio::null())
        .status().map(|s| s.success()).unwrap_or(false);
    if alive { return Ok(()); }

    let _ = std::fs::remove_file(ctl);

    let mut cmd = Command::new("ssh");
    cmd.args([
        "-M", "-S", ctl,
        "-o", "ControlPersist=10m",
        "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=15",
        "-o", "StrictHostKeyChecking=accept-new",
        "-f", "-N", target,
    ]);

    // Keep the askpass files alive until ssh has exited.
    let _guard = match password {
        None => {
            cmd.arg("-o").arg("BatchMode=yes");
            None
        }
        Some(pw) => {
            // ssh will not read a password from a pipe by design. The supported
            // route is SSH_ASKPASS, and since OpenSSH 8.4 `REQUIRE=force` makes
            // it used even when a tty is present. The secret goes in a 0600 file
            // rather than argv or the environment, both of which other local
            // processes can read via `ps`.
            let g = AskPass::new(pw)?;
            cmd.env("SSH_ASKPASS", &g.script)
                .env("SSH_ASKPASS_REQUIRE", "force")
                .env("DISPLAY", ":0")
                .args(["-o", "BatchMode=no", "-o", "NumberOfPasswordPrompts=1"]);
            Some(g)
        }
    };

    let out = cmd.output().map_err(|e| Error::Spawn(e.to_string()))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = err.lines()
            .find(|l| !l.trim().is_empty() && !l.contains("Warning: Permanently added"))
            .unwrap_or("connection failed")
            .trim()
            .to_string();
        Err(Error::Spawn(msg))
    }
}

/// Temporary 0600 password file plus the 0700 helper ssh runs to read it.
/// Both are removed when this value drops.
struct AskPass { dir: std::path::PathBuf, script: std::path::PathBuf }

impl AskPass {
    fn new(password: &str) -> Result<AskPass> {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("sshdesk-{}-{}", std::process::id(), now_nanos()));
        std::fs::create_dir_all(&base).map_err(|e| Error::Io(e.to_string()))?;
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| Error::Io(e.to_string()))?;

        let pw = base.join("pw");
        std::fs::write(&pw, password).map_err(|e| Error::Io(e.to_string()))?;
        std::fs::set_permissions(&pw, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| Error::Io(e.to_string()))?;

        let script = base.join("askpass");
        std::fs::write(&script, format!("#!/bin/sh\nexec cat {}\n", pw.display()))
            .map_err(|e| Error::Io(e.to_string()))?;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| Error::Io(e.to_string()))?;

        Ok(AskPass { dir: base, script })
    }
}

impl Drop for AskPass {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); }
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

// ---- domain types -------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Service {
    pub unit: String,
    #[serde(default)]
    pub load: String,
    #[serde(default)]
    pub active: String,
    #[serde(default)]
    pub sub: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct Process {
    pub pid: u32,
    pub user: String,
    pub cpu: f32,
    pub mem: f32,
    pub command: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct Port {
    pub port: u16,
    pub bind: String,
    pub process: String,
    pub mine: bool,
}

/// Units, straight off the bus.
///
/// `systemctl` is itself a D-Bus client, so the old shell path was asking a CLI
/// to marshal a typed API into text for us to parse back. This is the same call
/// `systemctl` makes, minus the round trip through human formatting — and it
/// spawns no process on the remote, which is where the old ~15ms went.
pub fn list_services(h: &mut Host) -> Result<Vec<Service>> {
    let out = h.bus()?.call(
        "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager", "ListUnits", &[])?;
    let mut v = Vec::new();
    if let Some(dbus::Val::Array(_, items)) = out.into_iter().next() {
        for it in items {
            if let dbus::Val::Struct(f) = it {
                let s = |i: usize| f.get(i).and_then(|x| x.as_str()).unwrap_or("").to_string();
                let unit = s(0);
                if !unit.ends_with(".service") { continue }
                v.push(Service {
                    unit,
                    description: s(1),
                    load: s(2),
                    active: s(3),
                    sub: s(4),
                });
            }
        }
    }
    v.sort_by(|a, b| a.unit.cmp(&b.unit));
    Ok(v)
}

/// Subscribe a connection to unit lifecycle signals.
///
/// `Subscribe` is what makes systemd emit these at all — without it the manager
/// stays quiet for efficiency. After this the remote pushes; there are no
/// further round trips and no polling, which is the thing the shell lane could
/// never do at any price.
pub fn subscribe_units(d: &mut dbus::Dbus) -> Result<()> {
    const M: &str = "org.freedesktop.systemd1.Manager";
    for member in ["JobRemoved", "UnitNew", "UnitRemoved", "Reloading"] {
        d.add_match(&format!(
            "type='signal',sender='org.freedesktop.systemd1',interface='{M}',member='{member}'"))?;
    }
    d.call("org.freedesktop.systemd1", "/org/freedesktop/systemd1", M, "Subscribe", &[])?;
    Ok(())
}

/// Subscribe on the host's own connection (used by the probe).
pub fn watch_units(h: &mut Host) -> Result<()> {
    let d = h.bus()?;
    subscribe_units(d)
}

/// Read any systemd manager property (Version, Architecture, NNames, ...).
pub fn systemd_property(h: &mut Host, prop: &str) -> Result<serde_json::Value> {
    let v = h.bus()?.get("org.freedesktop.systemd1", "/org/freedesktop/systemd1",
                         "org.freedesktop.systemd1.Manager", prop)?;
    Ok(v.to_json())
}

/// Processes from /proc rather than `ps`.
///
/// There is no typed API for this — no D-Bus service owns the process table —
/// so this stays in the shell lane. What changes is the *source*: /proc/[pid]/stat
/// is a kernel ABI documented in proc(5) and stable for decades, whereas `ps`
/// output formatting varies with procps version, locale and column widths.
///
/// `grep -H ''` prefixes each line with its filename, which turns a whole
/// directory of files into one parseable stream in a single round trip.
/// Process names containing spaces or parens are handled exactly, because the
/// comm field is delimited by the *last* ')' — something `ps` cannot express.
pub fn list_processes(h: &mut Host) -> Result<Vec<Process>> {
    let users = h.passwd_map();
    let o = h.run(
        "echo __MEM__; head -n1 /proc/meminfo; \
         echo __UP__; cat /proc/uptime; \
         echo __STAT__; grep -H '' /proc/[0-9]*/stat 2>/dev/null; \
         echo __UID__; grep -H '^Uid:' /proc/[0-9]*/status 2>/dev/null")?;

    let mut mem_total_kb = 0f32;
    let mut uptime = 0f32;
    let mut uid_of: HashMap<u32, u32> = HashMap::new();
    let mut section = "";
    let mut out = Vec::new();
    const HZ: f32 = 100.0; // USER_HZ is 100 on every Linux port that matters

    for line in o.stdout.lines() {
        match line.trim() {
            "__MEM__" | "__UP__" | "__STAT__" | "__UID__" => { section = line.trim(); continue }
            _ => {}
        }
        match section {
            "__MEM__" => {
                mem_total_kb = line.split_whitespace().nth(1)
                    .and_then(|v| v.parse().ok()).unwrap_or(0.0);
            }
            "__UP__" => {
                uptime = line.split_whitespace().next()
                    .and_then(|v| v.parse().ok()).unwrap_or(0.0);
            }
            "__UID__" => {
                if let Some((path, rest)) = line.split_once(':') {
                    let pid: u32 = path.trim_start_matches("/proc/")
                        .trim_end_matches("/status").parse().unwrap_or(0);
                    if let Some(u) = rest.split_whitespace().nth(1).and_then(|v| v.parse().ok()) {
                        uid_of.insert(pid, u);
                    }
                }
            }
            "__STAT__" => {
                let Some((path, rest)) = line.split_once(':') else { continue };
                let pid: u32 = match path.trim_start_matches("/proc/")
                    .trim_end_matches("/stat").parse() { Ok(v) => v, Err(_) => continue };
                // comm is parenthesised and may itself contain ')' — split on the last one.
                let Some(open) = rest.find('(') else { continue };
                let Some(close) = rest.rfind(')') else { continue };
                let comm = rest[open + 1..close].to_string();
                let f: Vec<&str> = rest[close + 1..].split_whitespace().collect();
                // Fields after comm are shifted by 2 relative to proc(5) numbering.
                let utime: f32 = f.get(11).and_then(|v| v.parse().ok()).unwrap_or(0.0);
                let stime: f32 = f.get(12).and_then(|v| v.parse().ok()).unwrap_or(0.0);
                let starttime: f32 = f.get(19).and_then(|v| v.parse().ok()).unwrap_or(0.0);
                let rss_pages: f32 = f.get(21).and_then(|v| v.parse().ok()).unwrap_or(0.0);

                // Lifetime-average CPU, the same quantity `ps pcpu` reports.
                let alive = (uptime - starttime / HZ).max(0.01);
                let cpu = ((utime + stime) / HZ / alive) * 100.0;
                let mem = if mem_total_kb > 0.0 {
                    (rss_pages * 4.0) / mem_total_kb * 100.0
                } else { 0.0 };

                out.push(Process { pid, user: String::new(), cpu, mem, command: comm });
            }
            _ => {}
        }
    }

    for p in &mut out {
        let uid = uid_of.get(&p.pid).copied().unwrap_or(u32::MAX);
        p.user = users.get(&uid).cloned()
            .unwrap_or_else(|| if uid == u32::MAX { String::new() } else { uid.to_string() });
    }
    out.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

pub fn list_ports(h: &mut Host) -> Result<Vec<Port>> {
    let o = h.run("ss -ltnpH")?;
    Ok(o.stdout.lines().filter_map(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 4 { return None; }
        let addr = f[3];
        let (bind, port) = addr.rsplit_once(':')?;
        // Non-root `ss -p` only fills users:(...) for processes we own — a free
        // ownership filter, so other tenants' ports are never actionable.
        let mine = l.contains("users:(");
        let process = l.split("users:((\"").nth(1)
            .and_then(|s| s.split('"').next()).unwrap_or("").to_string();
        Some(Port { port: port.parse().ok()?, bind: bind.into(), process, mine })
    }).collect())
}

// ---- file lane: SFTP, not shell -----------------------------------------
//
// Every function below used to build a shell command and parse its output.
// They now delegate to the SFTP subsystem, which removes three parsers
// (`find -printf`, `df | awk`, `cd && pwd`), two `scp` subprocess spawns, and
// the class of bug where an exotic filename desynced the line-framed shell.

/// Single-quote a value for safe interpolation into a shell command.
/// Still needed by the escape hatch (`run_argv`, `sudo`) — nothing in the file
/// lane goes near a shell any more.
fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[derive(Debug, Serialize, Clone)]
pub struct FileRead {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
    pub size: u64,
}

pub fn list_dir(h: &mut Host, path: &str) -> Result<Vec<Entry>> {
    h.sftp()?.list(path)
}

/// Absolute path, with `~` and `..` expanded.
///
/// The shell version ran `cd <path> && pwd -P`, which permanently moved the
/// persistent shell's working directory as a side effect. This has no such
/// hazard because there is no shell involved.
pub fn resolve_path(h: &mut Host, path: &str) -> Result<String> {
    let s = h.sftp()?;
    if path.is_empty() || path == "~" { return s.home() }
    if let Some(rest) = path.strip_prefix("~/") {
        let home = s.home()?;
        return s.realpath(&sftp::join(&home, rest));
    }
    s.realpath(path)
}

/// Read a file, capped so the UI never renders a huge blob.
///
/// No base64 round trip: SFTP carries bytes natively, so classification is
/// just a look at what came back.
pub fn read_file(h: &mut Host, path: &str, max_bytes: usize) -> Result<FileRead> {
    let size = h.sftp()?.stat(path)?.size;
    let (bytes, truncated) = h.sftp()?.read(path, max_bytes)?;

    // A NUL byte in the first chunk is the heuristic `grep` and `file` use;
    // invalid UTF-8 is the other giveaway.
    let has_nul = bytes.iter().take(8192).any(|&b| b == 0);
    match (has_nul, String::from_utf8(bytes)) {
        (false, Ok(text)) => Ok(FileRead { text, truncated, binary: false, size }),
        _ => Ok(FileRead { text: String::new(), truncated, binary: true, size }),
    }
}

pub fn write_file(h: &mut Host, path: &str, content: &str) -> Result<()> {
    h.sftp()?.write(path, content.as_bytes())
}

pub fn mkdir(h: &mut Host, path: &str) -> Result<()> {
    h.sftp()?.mkdir(path)
}

pub fn rename(h: &mut Host, from: &str, to: &str) -> Result<()> {
    h.sftp()?.rename(from, to)
}

pub fn remove(h: &mut Host, path: &str, recursive: bool) -> Result<()> {
    h.sftp()?.remove(path, recursive)
}

/// Server-side copy where the server supports `copy-data` — the bytes never
/// cross the network, which `cp -a` over a shell could not achieve either
/// without the same extension.
pub fn copy(h: &mut Host, from: &str, to: &str) -> Result<()> {
    h.sftp()?.copy(from, to)
}

/// Free space, as numbers rather than a parsed `df -h` string.
pub fn disk_info(h: &mut Host, path: &str) -> Result<DiskInfo> {
    h.sftp()?.disk(path)
}

/// Kept for the status line the UI already renders.
pub fn dir_summary(h: &mut Host, path: &str) -> Result<String> {
    let d = h.sftp()?.disk(path)?;
    if d.total == 0 { return Ok(String::new()) }
    Ok(format!("{} free of {}", human(d.avail), human(d.total)))
}

fn human(n: u64) -> String {
    const U: [&str; 6] = ["B", "K", "M", "G", "T", "P"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 { v /= 1024.0; i += 1 }
    if i == 0 { format!("{n}B") } else { format!("{v:.1}{}", U[i]) }
}

fn check(o: Output) -> Result<()> {
    if o.code == 0 { Ok(()) } else { Err(Error::Remote { code: o.code, stderr: o.stderr }) }
}

/// Privileged unit action.
///
/// Writes deliberately stay on `sudo systemctl` rather than moving to D-Bus.
/// The bus equivalent is blocked by polkit unless a `pkttyagent` is registered
/// for the ssh session *and* the call sets ALLOW_INTERACTIVE_AUTHORIZATION —
/// a long-lived pty per host and re-registration on every reconnect, to
/// replace one line that already works. See the notes in dbus.rs.
///
/// The unit name is shell-quoted as well as whitelisted. It came from the
/// remote, so it is not trusted back as shell input.
pub fn service_action(h: &mut Host, unit: &str, action: &str, password: &str) -> Result<()> {
    if !matches!(action, "start" | "stop" | "restart" | "reload" | "enable" | "disable") {
        return Err(Error::Io(format!("refusing unknown action: {action}")))
    }
    if unit.is_empty() || !unit.chars().all(|c| c.is_alphanumeric() || "-_.@:".contains(c)) {
        return Err(Error::Io(format!("refusing suspicious unit name: {unit}")))
    }
    check(h.sudo(&format!("systemctl {action} {}", shq(unit)), password)?)
}


pub fn b64encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if c.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}


#[derive(Debug, Serialize, Clone)]
pub struct ServerTime {
    /// Remote wall clock as unix seconds.
    pub epoch: i64,
    /// Offset from UTC in minutes, so the UI can render the server's local time.
    pub offset_minutes: i32,
    pub zone: String,
}

/// Read the remote clock once. The UI ticks locally from this and re-syncs
/// occasionally, rather than making a round trip every second.
pub fn server_time(h: &mut Host) -> Result<ServerTime> {
    let o = h.run("date +'%s %z %Z'")?;
    let parts: Vec<&str> = o.stdout.split_whitespace().collect();
    if parts.len() < 3 {
        return Err(Error::Io(format!("unexpected date output: {:?}", o.stdout)));
    }
    let epoch: i64 = parts[0].parse().unwrap_or(0);
    // %z is like +0300 / -0800
    let z = parts[1];
    let sign = if z.starts_with('-') { -1 } else { 1 };
    let hh: i32 = z[1..3].parse().unwrap_or(0);
    let mm: i32 = z[3..5].parse().unwrap_or(0);
    Ok(ServerTime { epoch, offset_minutes: sign * (hh * 60 + mm), zone: parts[2].to_string() })
}
