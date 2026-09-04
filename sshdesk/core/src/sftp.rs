//! SFTP subsystem client.
//!
//! Replaces the `find -printf` / `scp` / `cd && pwd` shell layer with the real
//! typed protocol. Same justification as everything else here: we do not
//! reimplement SSH, we run `ssh -s sftp` against the *existing* ControlMaster,
//! so this costs no authentication and no new TCP connection — it is one more
//! multiplexed channel.
//!
//! Why this matters beyond taste:
//!   * filenames are byte strings on the wire, so an exotic name can no longer
//!     desync the line-framed shell (it used to kill the whole connection),
//!   * `copy-data` copies server-side — bytes never cross the network,
//!   * `statvfs@openssh.com` returns numbers instead of `df -h | awk`,
//!   * `expand-path@openssh.com` resolves `~` without mutating a shell's cwd.

use crate::{Error, Result};
use serde::Serialize;
use std::collections::HashSet;
use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

// packet types
const INIT: u8 = 1;
const VERSION: u8 = 2;
const OPEN: u8 = 3;
const CLOSE: u8 = 4;
const READ: u8 = 5;
const WRITE: u8 = 6;
const LSTAT: u8 = 7;
const OPENDIR: u8 = 11;
const READDIR: u8 = 12;
const REMOVE: u8 = 13;
const MKDIR: u8 = 14;
const RMDIR: u8 = 15;
const REALPATH: u8 = 16;
const STAT: u8 = 17;
const RENAME: u8 = 18;
const STATUS: u8 = 101;
const HANDLE: u8 = 102;
const DATA: u8 = 103;
const NAME: u8 = 104;
const ATTRS: u8 = 105;
const EXTENDED: u8 = 200;
const EXTENDED_REPLY: u8 = 201;

// open flags
const F_READ: u32 = 0x1;
const F_WRITE: u32 = 0x2;
const F_CREAT: u32 = 0x8;
const F_TRUNC: u32 = 0x10;

// attribute flags
const A_SIZE: u32 = 0x1;
const A_UIDGID: u32 = 0x2;
const A_PERMS: u32 = 0x4;
const A_TIME: u32 = 0x8;
const A_EXT: u32 = 0x8000_0000;

fn status_msg(code: u32) -> &'static str {
    match code {
        1 => "end of file",
        2 => "no such file",
        3 => "permission denied",
        4 => "failure",
        5 => "bad message",
        6 => "no connection",
        7 => "connection lost",
        8 => "operation unsupported",
        _ => "sftp error",
    }
}

// ---- wire helpers -------------------------------------------------------

#[derive(Default)]
struct Buf(Vec<u8>);

impl Buf {
    fn u32(&mut self, v: u32) -> &mut Self { self.0.extend_from_slice(&v.to_be_bytes()); self }
    fn u64(&mut self, v: u64) -> &mut Self { self.0.extend_from_slice(&v.to_be_bytes()); self }
    fn bytes(&mut self, v: &[u8]) -> &mut Self {
        self.u32(v.len() as u32);
        self.0.extend_from_slice(v);
        self
    }
    fn str(&mut self, v: &str) -> &mut Self { self.bytes(v.as_bytes()) }
}

struct Cur<'a> { b: &'a [u8], i: usize }

impl<'a> Cur<'a> {
    fn new(b: &'a [u8]) -> Self { Cur { b, i: 0 } }
    fn left(&self) -> usize { self.b.len().saturating_sub(self.i) }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.left() < n { return Err(Error::Io("short sftp packet".into())) }
        let s = &self.b[self.i..self.i + n];
        self.i += n;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn bytes(&mut self) -> Result<&'a [u8]> {
        let n = self.u32()? as usize;
        self.take(n)
    }
    /// Filenames are byte strings. Lossy is a deliberate choice at the API
    /// boundary: the UI speaks String, and unlike the old `find` parser an
    /// undecodable name now degrades to replacement chars instead of
    /// desyncing the connection.
    fn string(&mut self) -> Result<String> {
        Ok(String::from_utf8_lossy(self.bytes()?).into_owned())
    }
}

/// One directory entry, typed straight off the wire.
#[derive(Debug, Serialize, Clone, Default)]
pub struct Entry {
    pub name: String,
    pub kind: String, // "dir" | "file" | "link" | "other"
    pub size: u64,
    pub mtime: i64,
    pub mode: String,
    pub user: String,
    pub group: String,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Attrs {
    pub size: u64,
    pub uid: u32,
    pub gid: u32,
    pub perms: u32,
    pub mtime: i64,
}

impl Attrs {
    fn parse(c: &mut Cur) -> Result<Attrs> {
        let f = c.u32()?;
        let mut a = Attrs::default();
        if f & A_SIZE != 0 { a.size = c.u64()?; }
        if f & A_UIDGID != 0 { a.uid = c.u32()?; a.gid = c.u32()?; }
        if f & A_PERMS != 0 { a.perms = c.u32()?; }
        if f & A_TIME != 0 { let _at = c.u32()?; a.mtime = c.u32()? as i64; }
        if f & A_EXT != 0 {
            let n = c.u32()?;
            for _ in 0..n { let _ = c.bytes()?; let _ = c.bytes()?; }
        }
        Ok(a)
    }
    pub fn kind(&self) -> &'static str {
        match self.perms & 0o170000 {
            0o040000 => "dir",
            0o100000 => "file",
            0o120000 => "link",
            _ => "other",
        }
    }
    /// Render like `ls -l` so the UI keeps the column it already has.
    pub fn mode_string(&self) -> String {
        let t = match self.kind() { "dir" => 'd', "link" => 'l', _ => '-' };
        let bit = |i: u32, c: char| if self.perms & (1 << i) != 0 { c } else { '-' };
        format!("{t}{}{}{}{}{}{}{}{}{}",
            bit(8,'r'), bit(7,'w'), bit(6,'x'),
            bit(5,'r'), bit(4,'w'), bit(3,'x'),
            bit(2,'r'), bit(1,'w'), bit(0,'x'))
    }
}

/// Filesystem totals, from `statvfs@openssh.com`.
#[derive(Debug, Serialize, Clone, Default)]
pub struct DiskInfo {
    pub total: u64,
    pub free: u64,
    pub avail: u64,
}

// ---- the client ---------------------------------------------------------

pub struct Sftp {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    id: u32,
    ext: HashSet<String>,
    max_read: usize,
    max_write: usize,
}

impl Drop for Sftp {
    fn drop(&mut self) { let _ = self.child.kill(); }
}

impl Sftp {
    /// Open the subsystem over an existing ControlMaster socket.
    pub fn open(target: &str, control_path: &str) -> Result<Sftp> {
        let mut child = Command::new("ssh")
            .args(["-S", control_path, "-o", "BatchMode=yes", "-s", target, "sftp"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| Error::Spawn(e.to_string()))?;
        let stdin = child.stdin.take().ok_or(Error::Closed)?;
        let stdout = BufReader::new(child.stdout.take().ok_or(Error::Closed)?);
        let mut s = Sftp {
            child, stdin, stdout, id: 0,
            ext: HashSet::new(),
            max_read: 32 * 1024,
            max_write: 32 * 1024,
        };

        let mut b = Buf::default();
        b.u32(3);
        s.send(INIT, &b.0)?;
        let (t, payload) = s.recv()?;
        if t != VERSION { return Err(Error::Io("sftp: no VERSION".into())) }
        let mut c = Cur::new(&payload);
        let ver = c.u32()?;
        if ver < 3 { return Err(Error::Io(format!("sftp version {ver} too old"))) }
        while c.left() > 0 {
            let name = c.string()?;
            let _data = c.bytes()?;
            s.ext.insert(name);
        }
        s.load_limits();
        Ok(s)
    }

    pub fn has(&self, ext: &str) -> bool { self.ext.contains(ext) }
    pub fn extensions(&self) -> Vec<String> {
        let mut v: Vec<String> = self.ext.iter().cloned().collect();
        v.sort();
        v
    }

    // -- framing --

    fn send(&mut self, typ: u8, payload: &[u8]) -> Result<()> {
        let len = (payload.len() + 1) as u32;
        self.stdin.write_all(&len.to_be_bytes()).map_err(|e| Error::Io(e.to_string()))?;
        self.stdin.write_all(&[typ]).map_err(|e| Error::Io(e.to_string()))?;
        self.stdin.write_all(payload).map_err(|e| Error::Io(e.to_string()))?;
        self.stdin.flush().map_err(|e| Error::Io(e.to_string()))
    }

    fn recv(&mut self) -> Result<(u8, Vec<u8>)> {
        let mut l = [0u8; 4];
        self.stdout.read_exact(&mut l).map_err(|_| Error::Closed)?;
        let len = u32::from_be_bytes(l) as usize;
        if len == 0 || len > 64 * 1024 * 1024 {
            return Err(Error::Io(format!("sftp: absurd packet length {len}")))
        }
        let mut buf = vec![0u8; len];
        self.stdout.read_exact(&mut buf).map_err(|_| Error::Closed)?;
        let typ = buf[0];
        Ok((typ, buf.split_off(1)))
    }

    fn next_id(&mut self) -> u32 { self.id += 1; self.id }

    /// Send one request and read its reply. The protocol allows pipelining by
    /// request id; we are strictly synchronous here because every caller is,
    /// and a desync would be worse than the latency.
    fn call(&mut self, typ: u8, build: impl FnOnce(&mut Buf)) -> Result<(u8, Vec<u8>)> {
        let id = self.next_id();
        let mut b = Buf::default();
        b.u32(id);
        build(&mut b);
        self.send(typ, &b.0)?;
        loop {
            let (t, p) = self.recv()?;
            let mut c = Cur::new(&p);
            let rid = c.u32()?;
            if rid == id { return Ok((t, p)) }
            // Ignore replies to abandoned requests rather than desyncing.
        }
    }

    fn expect_ok(&mut self, typ: u8, build: impl FnOnce(&mut Buf)) -> Result<()> {
        let (t, p) = self.call(typ, build)?;
        Self::check_status(t, &p)
    }

    fn check_status(t: u8, p: &[u8]) -> Result<()> {
        if t != STATUS { return Err(Error::Io(format!("sftp: unexpected reply type {t}"))) }
        let mut c = Cur::new(p);
        let _id = c.u32()?;
        let code = c.u32()?;
        if code == 0 { return Ok(()) }
        let msg = c.string().unwrap_or_default();
        Err(Error::Remote {
            code: code as i32,
            stderr: if msg.is_empty() { status_msg(code).into() } else { msg },
        })
    }

    fn load_limits(&mut self) {
        if !self.has("limits@openssh.com") { return }
        if let Ok((EXTENDED_REPLY, p)) = self.call(EXTENDED, |b| { b.str("limits@openssh.com"); }) {
            let mut c = Cur::new(&p);
            let _ = c.u32();
            if let (Ok(_pkt), Ok(rd), Ok(wr)) = (c.u64(), c.u64(), c.u64()) {
                if rd > 0 { self.max_read = (rd as usize).min(256 * 1024); }
                if wr > 0 { self.max_write = (wr as usize).min(256 * 1024); }
            }
        }
    }

    // -- operations --

    fn open_handle(&mut self, path: &str, flags: u32) -> Result<Vec<u8>> {
        let (t, p) = self.call(OPEN, |b| { b.str(path).u32(flags).u32(0); })?;
        if t == HANDLE {
            let mut c = Cur::new(&p);
            let _ = c.u32()?;
            return Ok(c.bytes()?.to_vec())
        }
        Self::check_status(t, &p).and(Err(Error::Io("sftp: no handle".into())))
    }

    fn close_handle(&mut self, h: &[u8]) -> Result<()> {
        self.expect_ok(CLOSE, |b| { b.bytes(h); })
    }

    pub fn stat(&mut self, path: &str) -> Result<Attrs> {
        let (t, p) = self.call(STAT, |b| { b.str(path); })?;
        if t != ATTRS { return Self::check_status(t, &p).and(Err(Error::Io("sftp: no attrs".into()))) }
        let mut c = Cur::new(&p);
        let _ = c.u32()?;
        Attrs::parse(&mut c)
    }

    /// List a directory. One OPENDIR, then READDIR until EOF — the server
    /// returns entries in batches, so a big directory is a handful of round
    /// trips rather than one per file.
    pub fn list(&mut self, path: &str) -> Result<Vec<Entry>> {
        let h = {
            let (t, p) = self.call(OPENDIR, |b| { b.str(path); })?;
            if t != HANDLE {
                return Self::check_status(t, &p).and(Err(Error::Io("sftp: opendir failed".into())))
            }
            let mut c = Cur::new(&p);
            let _ = c.u32()?;
            c.bytes()?.to_vec()
        };

        let mut out = Vec::new();
        loop {
            let (t, p) = self.call(READDIR, |b| { b.bytes(&h); })?;
            if t == STATUS {
                // code 1 is EOF, which is the normal terminator.
                let mut c = Cur::new(&p);
                let _ = c.u32()?;
                let code = c.u32()?;
                if code == 1 { break }
                let _ = self.close_handle(&h);
                return Err(Error::Remote { code: code as i32, stderr: status_msg(code).into() })
            }
            if t != NAME { break }
            let mut c = Cur::new(&p);
            let _ = c.u32()?;
            let n = c.u32()?;
            for _ in 0..n {
                let name = c.string()?;
                let long = c.string()?;
                let a = Attrs::parse(&mut c)?;
                if name == "." || name == ".." { continue }
                // v3 has no owner names; the long name carries them and is the
                // only place they appear without a second round trip.
                let mut f = long.split_whitespace().skip(2);
                out.push(Entry {
                    name,
                    kind: a.kind().to_string(),
                    size: a.size,
                    mtime: a.mtime,
                    mode: a.mode_string(),
                    user: f.next().unwrap_or_default().to_string(),
                    group: f.next().unwrap_or_default().to_string(),
                });
            }
        }
        self.close_handle(&h)?;
        out.sort_by(|a, b| (b.kind == "dir").cmp(&(a.kind == "dir"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    }

    pub fn read(&mut self, path: &str, max: usize) -> Result<(Vec<u8>, bool)> {
        let h = self.open_handle(path, F_READ)?;
        let mut data = Vec::new();
        let mut off = 0u64;
        let mut truncated = false;
        loop {
            let want = self.max_read.min(max + 1 - data.len().min(max + 1));
            if want == 0 { truncated = true; break }
            let (t, p) = self.call(READ, |b| { b.bytes(&h).u64(off).u32(want as u32); })?;
            if t == STATUS { break } // EOF
            if t != DATA { break }
            let mut c = Cur::new(&p);
            let _ = c.u32()?;
            let chunk = c.bytes()?;
            if chunk.is_empty() { break }
            off += chunk.len() as u64;
            data.extend_from_slice(chunk);
            if data.len() > max { truncated = true; data.truncate(max); break }
        }
        self.close_handle(&h)?;
        Ok((data, truncated))
    }

    pub fn write(&mut self, path: &str, data: &[u8]) -> Result<()> {
        let h = self.open_handle(path, F_WRITE | F_CREAT | F_TRUNC)?;
        let mut off = 0u64;
        for chunk in data.chunks(self.max_write.max(1)) {
            let r = self.expect_ok(WRITE, |b| { b.bytes(&h).u64(off).bytes(chunk); });
            if let Err(e) = r { let _ = self.close_handle(&h); return Err(e) }
            off += chunk.len() as u64;
        }
        self.close_handle(&h)
    }

    pub fn mkdir(&mut self, path: &str) -> Result<()> {
        self.expect_ok(MKDIR, |b| { b.str(path).u32(0); })
    }

    /// POSIX rename when the server offers it — atomic, and it replaces the
    /// destination the way `mv` does. Plain SFTP RENAME fails if the target
    /// exists, which is a different and surprising behaviour.
    pub fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        if self.has("posix-rename@openssh.com") {
            return self.expect_ok(EXTENDED, |b| {
                b.str("posix-rename@openssh.com").str(from).str(to);
            })
        }
        self.expect_ok(RENAME, |b| { b.str(from).str(to); })
    }

    pub fn remove_file(&mut self, path: &str) -> Result<()> {
        self.expect_ok(REMOVE, |b| { b.str(path); })
    }

    pub fn rmdir(&mut self, path: &str) -> Result<()> {
        self.expect_ok(RMDIR, |b| { b.str(path); })
    }

    /// Recursive delete walks the tree client-side, because SFTP has no
    /// bulk primitive. Depth-first so directories empty before they are removed.
    pub fn remove(&mut self, path: &str, recursive: bool) -> Result<()> {
        let a = self.stat(path)?;
        if a.kind() != "dir" { return self.remove_file(path) }
        if !recursive { return self.rmdir(path) }
        for e in self.list(path)? {
            let child = join(path, &e.name);
            if e.kind == "dir" { self.remove(&child, true)?; } else { self.remove_file(&child)?; }
        }
        self.rmdir(path)
    }

    /// Server-side copy — the bytes never cross the network. Falls back to a
    /// read/write round trip when the extension is missing.
    pub fn copy(&mut self, from: &str, to: &str) -> Result<()> {
        let a = self.stat(from)?;
        if a.kind() == "dir" {
            self.mkdir(to)?;
            for e in self.list(from)? {
                self.copy(&join(from, &e.name), &join(to, &e.name))?;
            }
            return Ok(())
        }
        if self.has("copy-data") {
            let src = self.open_handle(from, F_READ)?;
            let dst = match self.open_handle(to, F_WRITE | F_CREAT | F_TRUNC) {
                Ok(d) => d,
                Err(e) => { let _ = self.close_handle(&src); return Err(e) }
            };
            let r = self.expect_ok(EXTENDED, |b| {
                b.str("copy-data").bytes(&src).u64(0).u64(0).bytes(&dst).u64(0);
            });
            let _ = self.close_handle(&src);
            let _ = self.close_handle(&dst);
            if r.is_ok() { return Ok(()) }
        }
        let (data, _) = self.read(from, usize::MAX / 2)?;
        self.write(to, &data)
    }

    /// Absolute path. `expand-path` also expands `~` and `..`, which REALPATH
    /// alone does not — this is what replaces `cd … && pwd -P`, and with it the
    /// side effect of moving the persistent shell's working directory.
    pub fn realpath(&mut self, path: &str) -> Result<String> {
        let ext = self.has("expand-path@openssh.com");
        let (t, p) = if ext {
            self.call(EXTENDED, |b| { b.str("expand-path@openssh.com").str(path); })?
        } else {
            self.call(REALPATH, |b| { b.str(path); })?
        };
        if t != NAME { return Self::check_status(t, &p).and(Err(Error::Io("sftp: realpath failed".into()))) }
        let mut c = Cur::new(&p);
        let _ = c.u32()?;
        let n = c.u32()?;
        if n == 0 { return Err(Error::Io("sftp: empty realpath".into())) }
        c.string()
    }

    pub fn home(&mut self) -> Result<String> {
        if self.has("home-directory") {
            let (t, p) = self.call(EXTENDED, |b| { b.str("home-directory").str(""); })?;
            if t == NAME {
                let mut c = Cur::new(&p);
                let _ = c.u32()?;
                if c.u32()? > 0 { return c.string() }
            }
        }
        self.realpath(".")
    }

    pub fn disk(&mut self, path: &str) -> Result<DiskInfo> {
        if !self.has("statvfs@openssh.com") { return Ok(DiskInfo::default()) }
        let (t, p) = self.call(EXTENDED, |b| { b.str("statvfs@openssh.com").str(path); })?;
        if t != EXTENDED_REPLY { return Ok(DiskInfo::default()) }
        let mut c = Cur::new(&p);
        let _ = c.u32()?;
        let _bsize = c.u64()?;
        let frsize = c.u64()?;
        let blocks = c.u64()?;
        let bfree = c.u64()?;
        let bavail = c.u64()?;
        Ok(DiskInfo {
            total: blocks * frsize,
            free: bfree * frsize,
            avail: bavail * frsize,
        })
    }

    pub fn download(&mut self, remote: &str, local: &str) -> Result<u64> {
        let (data, _) = self.read(remote, usize::MAX / 2)?;
        std::fs::write(local, &data).map_err(|e| Error::Io(e.to_string()))?;
        Ok(data.len() as u64)
    }

    pub fn upload(&mut self, local: &str, remote: &str) -> Result<u64> {
        let data = std::fs::read(local).map_err(|e| Error::Io(e.to_string()))?;
        let n = data.len() as u64;
        self.write(remote, &data)?;
        Ok(n)
    }

    pub fn lstat(&mut self, path: &str) -> Result<Attrs> {
        let (t, p) = self.call(LSTAT, |b| { b.str(path); })?;
        if t != ATTRS { return Self::check_status(t, &p).and(Err(Error::Io("sftp: no attrs".into()))) }
        let mut c = Cur::new(&p);
        let _ = c.u32()?;
        Attrs::parse(&mut c)
    }
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}
