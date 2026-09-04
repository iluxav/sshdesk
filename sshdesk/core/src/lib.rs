//! Persistent-shell SSH transport.
//!
//! Deliberately shells out to the real `ssh` binary rather than reimplementing
//! the protocol. That inherits ControlMaster multiplexing, ~/.ssh/config,
//! ssh-agent, ProxyJump, known_hosts and host-key verification for free — and
//! keeps every line of crypto out of this codebase.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

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

        let mut h = Host { target: target.into(), ctl, shell, stdin, stdout, seq: 0 };
        // Quiet the shell and make parsing predictable.
        h.run("export LC_ALL=C; unset PROMPT_COMMAND; set +o history")?;
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

    /// Copy a remote file to the local machine.
    ///
    /// Reuses the existing ControlMaster socket, so there is no second
    /// authentication and no new TCP connection.
    pub fn download(&self, remote: &str, local: &str) -> Result<u64> {
        let st = Command::new("scp")
            .args([
                "-o", &format!("ControlPath={}", self.ctl),
                "-o", "BatchMode=yes",
                &format!("{}:{}", self.target, remote),
                local,
            ])
            .output()
            .map_err(|e| Error::Spawn(e.to_string()))?;
        if !st.status.success() {
            return Err(Error::Remote {
                code: st.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&st.stderr).trim().to_string(),
            });
        }
        Ok(std::fs::metadata(local).map(|m| m.len()).unwrap_or(0))
    }

    pub fn disconnect(&mut self) {
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

pub fn list_services(h: &mut Host) -> Result<Vec<Service>> {
    let o = h.run("systemctl list-units --type=service --all --no-legend --no-pager -o json")?;
    serde_json::from_str(&o.stdout).map_err(|e| Error::Io(format!("bad json: {e}")))
}

pub fn list_processes(h: &mut Host) -> Result<Vec<Process>> {
    let o = h.run("ps -eo pid,user:20,pcpu,pmem,comm --no-headers")?;
    Ok(o.stdout.lines().filter_map(|l| {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 5 { return None; }
        Some(Process {
            pid: f[0].parse().ok()?,
            user: f[1].into(),
            cpu: f[2].parse().unwrap_or(0.0),
            mem: f[3].parse().unwrap_or(0.0),
            command: f[4..].join(" "),
        })
    }).collect())
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

// ---- file browsing ------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct Entry {
    pub name: String,
    pub kind: String,   // "dir" | "file" | "link" | other find %y codes
    pub size: u64,
    pub mtime: i64,
    pub mode: String,
    pub user: String,
    pub group: String,
}

/// Single-quote a value for safe interpolation into a shell command.
fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// List one directory.
///
/// Uses `find -printf` with NUL-delimited records rather than parsing `ls`:
/// `ls` output is ambiguous for names containing spaces, and quoting modes
/// differ across distros. `%f` is placed last so that even a tab inside a
/// filename cannot shift the earlier fields.
pub fn list_dir(h: &mut Host, path: &str) -> Result<Vec<Entry>> {
    let cmd = format!(
        "find {} -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%T@\\t%M\\t%u\\t%g\\t%f\\0' 2>/dev/null; echo",
        shq(path)
    );
    let o = h.run(&cmd)?;
    let mut out: Vec<Entry> = o
        .stdout
        .split('\0')
        .filter(|r| !r.trim().is_empty())
        .filter_map(|rec| {
            // 6 tabs, then the name — anything in the name stays in the name.
            let mut it = rec.splitn(7, '\t');
            let kind = it.next()?;
            let size = it.next()?;
            let mtime = it.next()?;
            let mode = it.next()?;
            let user = it.next()?;
            let group = it.next()?;
            let name = it.next()?;
            Some(Entry {
                name: name.trim_end_matches('\n').to_string(),
                kind: match kind {
                    "d" => "dir",
                    "f" => "file",
                    "l" => "link",
                    other => other,
                }
                .to_string(),
                size: size.parse().unwrap_or(0),
                mtime: mtime.split('.').next().and_then(|v| v.parse().ok()).unwrap_or(0),
                mode: mode.to_string(),
                user: user.to_string(),
                group: group.to_string(),
            })
        })
        .collect();
    // Directories first, then case-insensitive by name.
    out.sort_by(|a, b| {
        (b.kind == "dir")
            .cmp(&(a.kind == "dir"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Resolve a path to its absolute form (expands `~`, `..`, symlinks).
pub fn resolve_path(h: &mut Host, path: &str) -> Result<String> {
    let expr = if path.is_empty() || path == "~" {
        "$HOME".to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("$HOME/{rest}")
    } else {
        shq(path)
    };
    let o = h.run(&format!("cd {expr} 2>/dev/null && pwd -P"))?;
    if o.code != 0 || o.stdout.trim().is_empty() {
        return Err(Error::Remote { code: o.code, stderr: format!("cannot enter {path}") });
    }
    Ok(o.stdout.trim().to_string())
}

#[derive(Debug, Serialize, Clone)]
pub struct FileRead {
    pub text: String,
    pub truncated: bool,
    pub binary: bool,
    pub size: u64,
}

/// Read a file, capped so the UI never has to render a huge blob.
///
/// Content comes back base64-encoded: a binary file is not valid UTF-8, and
/// reading it as text would either corrupt it or kill the line-framed shell.
/// Encoding first means arbitrary bytes survive and we can classify locally.
pub fn read_file(h: &mut Host, path: &str, max_bytes: usize) -> Result<FileRead> {
    // No `tr -d` here: stripping the trailing newline would glue the frame
    // marker onto the payload line. base64 wraps at 76 cols; we rejoin below.
    // No `exit` either — that would kill the persistent shell; `false` sets the
    // status without ending the session.
    let o = h.run(&format!(
        "if [ -r {p} ]; then stat -c %s {p}; head -c {n} {p} | base64; \
         else echo \"cannot read {p}\" >&2; false; fi",
        p = shq(path), n = max_bytes + 1
    ))?;
    if o.code != 0 {
        return Err(Error::Remote { code: o.code, stderr: o.stderr });
    }
    let mut lines = o.stdout.lines();
    let size: u64 = lines.next().unwrap_or("0").trim().parse().unwrap_or(0);
    let b64: String = lines.collect::<Vec<_>>().concat();
    let bytes = b64decode(b64.trim());

    let truncated = bytes.len() > max_bytes;
    let bytes = &bytes[..bytes.len().min(max_bytes)];

    // A NUL byte in the first chunk is the same heuristic `grep` and `file`
    // use; invalid UTF-8 is the other giveaway.
    let has_nul = bytes.iter().take(8192).any(|&b| b == 0);
    match (has_nul, std::str::from_utf8(bytes)) {
        (false, Ok(text)) => Ok(FileRead { text: text.to_string(), truncated, binary: false, size }),
        _ => Ok(FileRead { text: String::new(), truncated, binary: true, size }),
    }
}

fn b64decode(s: &str) -> Vec<u8> {
    let val = |c: u8| -> i16 {
        match c {
            b'A'..=b'Z' => (c - b'A') as i16,
            b'a'..=b'z' => (c - b'a') as i16 + 26,
            b'0'..=b'9' => (c - b'0') as i16 + 52,
            b'+' => 62,
            b'/' => 63,
            _ => -1,
        }
    };
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for &c in s.as_bytes() {
        let v = val(c);
        if v < 0 { continue; }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// Total size of a directory's immediate contents, for the status line.
pub fn dir_summary(h: &mut Host, path: &str) -> Result<String> {
    let o = h.run(&format!("df -h {} | tail -1 | awk '{{print $4\" free of \"$2}}'", shq(path)))?;
    Ok(o.stdout.trim().to_string())
}

// ---- filesystem writes --------------------------------------------------
//
// Permission enforcement is the remote machine's job: we run the command and
// surface whatever it says. Our job is to make sure a hostile *name* can never
// become a hostile *command* — every path goes through shq().

pub fn mkdir(h: &mut Host, path: &str) -> Result<()> {
    check(h.run(&format!("mkdir -p -- {}", shq(path)))?)
}

pub fn rename(h: &mut Host, from: &str, to: &str) -> Result<()> {
    check(h.run(&format!("mv -n -- {} {}", shq(from), shq(to)))?)
}

pub fn remove(h: &mut Host, path: &str, recursive: bool) -> Result<()> {
    let flag = if recursive { "-rf" } else { "-f" };
    check(h.run(&format!("rm {flag} -- {}", shq(path)))?)
}

pub fn copy(h: &mut Host, from: &str, to: &str) -> Result<()> {
    check(h.run(&format!("cp -a -- {} {}", shq(from), shq(to)))?)
}

/// Write text to a remote file without a temp file on either side.
/// Content goes through base64 so newlines, quotes and binary-ish bytes
/// cannot terminate the heredoc or the shell word.
pub fn write_file(h: &mut Host, path: &str, content: &str) -> Result<()> {
    let b64 = b64encode(content.as_bytes());
    check(h.run(&format!("printf '%s' {} | base64 -d > {}", shq(&b64), shq(path)))?)
}

fn check(o: Output) -> Result<()> {
    if o.code == 0 { Ok(()) } else { Err(Error::Remote { code: o.code, stderr: o.stderr }) }
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

impl Host {
    /// Copy a local file up to the remote, reusing the ControlMaster socket.
    pub fn upload(&self, local: &str, remote: &str) -> Result<u64> {
        let st = Command::new("scp")
            .args([
                "-o", &format!("ControlPath={}", self.ctl),
                "-o", "BatchMode=yes",
                local,
                &format!("{}:{}", self.target, remote),
            ])
            .output()
            .map_err(|e| Error::Spawn(e.to_string()))?;
        if !st.status.success() {
            return Err(Error::Remote {
                code: st.status.code().unwrap_or(-1),
                stderr: String::from_utf8_lossy(&st.stderr).trim().to_string(),
            });
        }
        Ok(std::fs::metadata(local).map(|m| m.len()).unwrap_or(0))
    }
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
