//! Interactive terminal sessions.
//!
//! Everything else in sshdesk is request/response over one persistent shell.
//! A terminal is not: it needs a real PTY so that `vim`, `top`, job control and
//! colours behave, plus continuous output in both directions.
//!
//! So each session allocates a *local* PTY and runs `ssh -tt` inside it against
//! the existing ControlMaster socket. Giving ssh a real tty is what makes window
//! resizes propagate to the remote — ssh forwards SIGWINCH as a window-change
//! request. It also costs no extra authentication, because the connection is
//! already open.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals(pub Mutex<HashMap<String, Session>>);

#[derive(Clone, Serialize)]
struct Chunk {
    id: String,
    /// base64 — raw PTY bytes are not guaranteed to split on UTF-8 boundaries.
    b64: String,
}

#[derive(Clone, Serialize)]
struct Exit {
    id: String,
    code: Option<i32>,
}

pub fn open(
    app: &AppHandle,
    terms: &Terminals,
    id: String,
    target: &str,
    control_path: &str,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("ssh");
    // -tt forces a remote PTY even though our stdin is a pty we made, not a
    // terminal the user typed into.
    cmd.args(["-tt", "-S", control_path, "-o", "BatchMode=yes", target]);
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app2.emit(
                        "term:data",
                        Chunk { id: id2.clone(), b64: sshdesk_core::b64encode(&buf[..n]) },
                    );
                }
            }
        }
        let _ = app2.emit("term:exit", Exit { id: id2, code: None });
    });

    terms
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, Session { master: pair.master, writer, child });
    Ok(())
}

pub fn write(terms: &Terminals, id: &str, data: &str) -> Result<(), String> {
    let mut map = terms.0.lock().map_err(|e| e.to_string())?;
    let s = map.get_mut(id).ok_or("no such terminal")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

pub fn resize(terms: &Terminals, id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let map = terms.0.lock().map_err(|e| e.to_string())?;
    let s = map.get(id).ok_or("no such terminal")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

pub fn close(terms: &Terminals, id: &str) -> Result<(), String> {
    let mut map = terms.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut s) = map.remove(id) {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
    Ok(())
}
