//! D-Bus client, speaking the wire protocol to a *remote* system bus.
//!
//! The bus socket is reached with `ssh -O forward -L <local>:/run/dbus/system_bus_socket`
//! on the connection we already hold, so — as everywhere else here — nothing is
//! installed on the remote and no second authentication happens.
//!
//! Two things are not obvious and cost real debugging time:
//!
//! **EXTERNAL auth must send the REMOTE uid.** The bus verifies the claimed
//! identity against SO_PEERCRED of the peer, which is sshd running as your
//! remote user. Sending the local uid is rejected, and sending no data at all
//! makes the server ask for it rather than falling back to socket credentials.
//! So the uid is a parameter, never `geteuid()`.
//!
//! **Privileged calls need ALLOW_INTERACTIVE_AUTHORIZATION.** Without that
//! header flag polkit returns InteractiveAuthorizationRequired immediately
//! instead of issuing a challenge — even with an auth agent registered and
//! idle, which is exactly how this looks like "polkit doesn't work over SSH".

use crate::{Error, Result};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

const MSG_CALL: u8 = 1;
const MSG_RETURN: u8 = 2;
const MSG_ERROR: u8 = 3;
const MSG_SIGNAL: u8 = 4;

/// Header flag: let the service raise a polkit challenge rather than refusing.
pub const ALLOW_INTERACTIVE_AUTH: u8 = 0x04;

// ---- values -------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Byte(u8),
    Bool(bool),
    U16(u16),
    I16(i16),
    U32(u32),
    I32(i32),
    U64(u64),
    I64(i64),
    F64(f64),
    Str(String),
    Path(String),
    Sig(String),
    /// element signature + items — kept so an empty array still marshals.
    Array(String, Vec<Val>),
    Struct(Vec<Val>),
    Variant(Box<Val>),
    Dict(String, Vec<(Val, Val)>),
}

impl Val {
    pub fn signature(&self) -> String {
        match self {
            Val::Byte(_) => "y".into(),
            Val::Bool(_) => "b".into(),
            Val::U16(_) => "q".into(),
            Val::I16(_) => "n".into(),
            Val::U32(_) => "u".into(),
            Val::I32(_) => "i".into(),
            Val::U64(_) => "t".into(),
            Val::I64(_) => "x".into(),
            Val::F64(_) => "d".into(),
            Val::Str(_) => "s".into(),
            Val::Path(_) => "o".into(),
            Val::Sig(_) => "g".into(),
            Val::Array(e, _) => format!("a{e}"),
            Val::Dict(e, _) => format!("a{{{e}}}"),
            Val::Struct(f) => format!("({})", f.iter().map(|v| v.signature()).collect::<String>()),
            Val::Variant(_) => "v".into(),
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Val::Str(s) | Val::Path(s) | Val::Sig(s) => Some(s),
            Val::Variant(v) => v.as_str(),
            _ => None,
        }
    }
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Val::Byte(v) => Some(*v as u64),
            Val::U16(v) => Some(*v as u64),
            Val::U32(v) => Some(*v as u64),
            Val::U64(v) => Some(*v),
            Val::I32(v) => Some(*v as u64),
            Val::I64(v) => Some(*v as u64),
            Val::Variant(v) => v.as_u64(),
            _ => None,
        }
    }

    /// Flatten to JSON for the UI. Variants unwrap and dicts become objects:
    /// type information is kept where it matters and dropped where it would
    /// only make the frontend's life harder.
    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::Value as J;
        match self {
            Val::Byte(v) => J::from(*v),
            Val::Bool(v) => J::from(*v),
            Val::U16(v) => J::from(*v),
            Val::I16(v) => J::from(*v),
            Val::U32(v) => J::from(*v),
            Val::I32(v) => J::from(*v),
            Val::U64(v) => J::from(*v),
            Val::I64(v) => J::from(*v),
            Val::F64(v) => J::from(*v),
            Val::Str(s) | Val::Path(s) | Val::Sig(s) => J::from(s.clone()),
            Val::Array(_, items) => J::Array(items.iter().map(|v| v.to_json()).collect()),
            Val::Struct(f) => J::Array(f.iter().map(|v| v.to_json()).collect()),
            Val::Variant(v) => v.to_json(),
            Val::Dict(_, entries) => {
                let mut m = serde_json::Map::new();
                for (k, v) in entries {
                    let key = k.as_str().map(|s| s.to_string())
                        .unwrap_or_else(|| k.as_u64().map(|n| n.to_string()).unwrap_or_default());
                    m.insert(key, v.to_json());
                }
                J::Object(m)
            }
        }
    }
}

// ---- signatures ---------------------------------------------------------

pub fn split_sig(s: &str) -> Vec<String> {
    let b: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let start = i;
        let mut depth = 0usize;
        loop {
            if i >= b.len() { break }
            match b[i] {
                '(' | '{' => { depth += 1; i += 1; }
                ')' | '}' => { depth -= 1; i += 1; if depth == 0 { break } }
                'a' => { i += 1; continue }
                _ => { i += 1; if depth == 0 { break } }
            }
            if depth == 0 { break }
        }
        out.push(b[start..i.min(b.len())].iter().collect());
    }
    out
}

fn alignment(sig: &str) -> usize {
    match sig.chars().next().unwrap_or('y') {
        'y' | 'g' | 'v' => 1,
        'n' | 'q' => 2,
        'b' | 'i' | 'u' | 's' | 'o' | 'a' => 4,
        'x' | 't' | 'd' | '(' | '{' => 8,
        _ => 1,
    }
}

// ---- marshalling --------------------------------------------------------

struct M { b: Vec<u8>, base: usize }

impl M {
    fn new(base: usize) -> M { M { b: Vec::new(), base } }
    fn pos(&self) -> usize { self.base + self.b.len() }
    fn align(&mut self, n: usize) { while self.pos() % n != 0 { self.b.push(0) } }
    fn raw(&mut self, v: &[u8]) { self.b.extend_from_slice(v) }

    fn value(&mut self, v: &Val) {
        match v {
            Val::Byte(x) => self.b.push(*x),
            Val::Bool(x) => { self.align(4); self.raw(&(*x as u32).to_le_bytes()) }
            Val::U16(x) => { self.align(2); self.raw(&x.to_le_bytes()) }
            Val::I16(x) => { self.align(2); self.raw(&x.to_le_bytes()) }
            Val::U32(x) => { self.align(4); self.raw(&x.to_le_bytes()) }
            Val::I32(x) => { self.align(4); self.raw(&x.to_le_bytes()) }
            Val::U64(x) => { self.align(8); self.raw(&x.to_le_bytes()) }
            Val::I64(x) => { self.align(8); self.raw(&x.to_le_bytes()) }
            Val::F64(x) => { self.align(8); self.raw(&x.to_le_bytes()) }
            Val::Str(s) | Val::Path(s) => {
                self.align(4);
                self.raw(&(s.len() as u32).to_le_bytes());
                self.raw(s.as_bytes());
                self.b.push(0);
            }
            Val::Sig(s) => {
                self.b.push(s.len() as u8);
                self.raw(s.as_bytes());
                self.b.push(0);
            }
            Val::Variant(inner) => {
                self.value(&Val::Sig(inner.signature()));
                self.value(inner);
            }
            Val::Array(elem, items) => {
                self.align(4);
                let len_at = self.b.len();
                self.raw(&0u32.to_le_bytes());
                self.align(alignment(elem));
                let start = self.b.len();
                for it in items { self.value(it) }
                let n = (self.b.len() - start) as u32;
                self.b[len_at..len_at + 4].copy_from_slice(&n.to_le_bytes());
            }
            Val::Dict(_, entries) => {
                self.align(4);
                let len_at = self.b.len();
                self.raw(&0u32.to_le_bytes());
                self.align(8);
                let start = self.b.len();
                for (k, v) in entries {
                    self.align(8);
                    self.value(k);
                    self.value(v);
                }
                let n = (self.b.len() - start) as u32;
                self.b[len_at..len_at + 4].copy_from_slice(&n.to_le_bytes());
            }
            Val::Struct(fields) => {
                self.align(8);
                for f in fields { self.value(f) }
            }
        }
    }
}

// ---- unmarshalling ------------------------------------------------------

struct U<'a> { b: &'a [u8], i: usize }

impl<'a> U<'a> {
    fn align(&mut self, n: usize) { while self.i % n != 0 { self.i += 1 } }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.b.len() < self.i + n { return Err(Error::Io("short dbus message".into())) }
        let s = &self.b[self.i..self.i + n];
        self.i += n;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32> {
        self.align(4);
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn value(&mut self, sig: &str) -> Result<Val> {
        let c = sig.chars().next().ok_or_else(|| Error::Io("empty signature".into()))?;
        Ok(match c {
            'y' => Val::Byte(self.take(1)?[0]),
            'b' => Val::Bool(self.u32()? != 0),
            'n' => { self.align(2); Val::I16(i16::from_le_bytes(self.take(2)?.try_into().unwrap())) }
            'q' => { self.align(2); Val::U16(u16::from_le_bytes(self.take(2)?.try_into().unwrap())) }
            'i' => { self.align(4); Val::I32(i32::from_le_bytes(self.take(4)?.try_into().unwrap())) }
            'u' => Val::U32(self.u32()?),
            'x' => { self.align(8); Val::I64(i64::from_le_bytes(self.take(8)?.try_into().unwrap())) }
            't' => { self.align(8); Val::U64(u64::from_le_bytes(self.take(8)?.try_into().unwrap())) }
            'd' => { self.align(8); Val::F64(f64::from_le_bytes(self.take(8)?.try_into().unwrap())) }
            's' | 'o' => {
                let n = self.u32()? as usize;
                let s = String::from_utf8_lossy(self.take(n)?).into_owned();
                self.take(1)?;
                if c == 'o' { Val::Path(s) } else { Val::Str(s) }
            }
            'g' => {
                let n = self.take(1)?[0] as usize;
                let s = String::from_utf8_lossy(self.take(n)?).into_owned();
                self.take(1)?;
                Val::Sig(s)
            }
            'v' => {
                let inner = match self.value("g")? { Val::Sig(s) => s, _ => unreachable!() };
                Val::Variant(Box::new(self.value(&inner)?))
            }
            'a' => {
                let elem = &sig[1..];
                let n = self.u32()? as usize;
                let is_dict = elem.starts_with('{');
                self.align(if is_dict { 8 } else { alignment(elem) });
                let end = self.i + n;
                if is_dict {
                    let inner = &elem[1..elem.len() - 1];
                    let parts = split_sig(inner);
                    let ks = parts.first().cloned().unwrap_or_default();
                    let vs = parts.get(1).cloned().unwrap_or_default();
                    let mut out = Vec::new();
                    while self.i < end {
                        self.align(8);
                        let k = self.value(&ks)?;
                        let v = self.value(&vs)?;
                        out.push((k, v));
                    }
                    Val::Dict(inner.to_string(), out)
                } else {
                    let mut out = Vec::new();
                    while self.i < end { out.push(self.value(elem)?) }
                    Val::Array(elem.to_string(), out)
                }
            }
            '(' => {
                self.align(8);
                let inner = &sig[1..sig.len().saturating_sub(1)];
                let mut out = Vec::new();
                for p in split_sig(inner) { out.push(self.value(&p)?) }
                Val::Struct(out)
            }
            _ => return Err(Error::Io(format!("unsupported dbus type '{c}'"))),
        })
    }
}

/// Build a value from JSON, driven by a D-Bus signature.
///
/// This is what lets a plugin make an arbitrary bus call from JavaScript: the
/// signature says what the wire types are (exactly as `busctl call` requires),
/// and JSON supplies the data. Without the signature there is no way to know
/// whether `2` is a byte, a uint32 or a double.
pub fn from_json(sig: &str, v: &serde_json::Value) -> Result<Val> {
    use serde_json::Value as J;
    let c = sig.chars().next().ok_or_else(|| Error::Io("empty signature".into()))?;
    let bad = || Error::Io(format!("value {v} does not fit signature '{sig}'"));
    Ok(match c {
        'y' => Val::Byte(v.as_u64().ok_or_else(bad)? as u8),
        'b' => Val::Bool(v.as_bool().ok_or_else(bad)?),
        'n' => Val::I16(v.as_i64().ok_or_else(bad)? as i16),
        'q' => Val::U16(v.as_u64().ok_or_else(bad)? as u16),
        'i' => Val::I32(v.as_i64().ok_or_else(bad)? as i32),
        'u' => Val::U32(v.as_u64().ok_or_else(bad)? as u32),
        'x' => Val::I64(v.as_i64().ok_or_else(bad)?),
        't' => Val::U64(v.as_u64().ok_or_else(bad)?),
        'd' => Val::F64(v.as_f64().ok_or_else(bad)?),
        's' => Val::Str(v.as_str().ok_or_else(bad)?.to_string()),
        'o' => Val::Path(v.as_str().ok_or_else(bad)?.to_string()),
        'g' => Val::Sig(v.as_str().ok_or_else(bad)?.to_string()),
        'v' => Val::Variant(Box::new(match v {
            J::String(s) => Val::Str(s.clone()),
            J::Bool(b) => Val::Bool(*b),
            J::Number(n) if n.is_i64() => Val::I64(n.as_i64().unwrap()),
            J::Number(n) => Val::F64(n.as_f64().unwrap_or(0.0)),
            _ => return Err(bad()),
        })),
        'a' => {
            let elem = &sig[1..];
            if elem.starts_with('{') {
                let inner = &elem[1..elem.len() - 1];
                let parts = split_sig(inner);
                let (ks, vs) = (parts.first().cloned().unwrap_or_default(),
                                parts.get(1).cloned().unwrap_or_default());
                let obj = v.as_object().ok_or_else(bad)?;
                let mut out = Vec::new();
                for (k, val) in obj {
                    out.push((from_json(&ks, &J::String(k.clone()))?, from_json(&vs, val)?));
                }
                Val::Dict(inner.to_string(), out)
            } else {
                let arr = v.as_array().ok_or_else(bad)?;
                let mut out = Vec::new();
                for it in arr { out.push(from_json(elem, it)?) }
                Val::Array(elem.to_string(), out)
            }
        }
        '(' => {
            let arr = v.as_array().ok_or_else(bad)?;
            let parts = split_sig(&sig[1..sig.len() - 1]);
            let mut out = Vec::new();
            for (p, it) in parts.iter().zip(arr) { out.push(from_json(p, it)?) }
            Val::Struct(out)
        }
        _ => return Err(Error::Io(format!("unsupported signature '{sig}'"))),
    })
}

// ---- messages -----------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Signal {
    pub path: String,
    pub interface: String,
    pub member: String,
    pub args: Vec<Val>,
}

struct Msg {
    typ: u8,
    reply_serial: u32,
    error_name: Option<String>,
    path: String,
    interface: String,
    member: String,
    body: Vec<Val>,
}

pub struct Dbus {
    s: UnixStream,
    serial: u32,
    pending: VecDeque<Signal>,
    pub unique_name: String,
}

impl Dbus {
    /// `remote_uid` is the uid on the machine the bus lives on — see the note
    /// at the top of this file. Get it once with `id -u` at connect time.
    pub fn connect(socket_path: &str, remote_uid: u32) -> Result<Dbus> {
        let mut s = UnixStream::connect(socket_path).map_err(|e| Error::Io(e.to_string()))?;
        s.set_read_timeout(Some(Duration::from_secs(30))).ok();

        let hex: String = remote_uid.to_string().bytes().map(|b| format!("{b:02X}")).collect();
        s.write_all(format!("\0AUTH EXTERNAL {hex}\r\n").as_bytes())
            .map_err(|e| Error::Io(e.to_string()))?;
        let mut buf = [0u8; 512];
        let n = s.read(&mut buf).map_err(|e| Error::Io(e.to_string()))?;
        let reply = String::from_utf8_lossy(&buf[..n]);
        if !reply.starts_with("OK") {
            return Err(Error::Spawn(format!(
                "dbus auth rejected for uid {remote_uid}: {}", reply.trim())))
        }
        s.write_all(b"BEGIN\r\n").map_err(|e| Error::Io(e.to_string()))?;

        let mut d = Dbus { s, serial: 0, pending: VecDeque::new(), unique_name: String::new() };
        let out = d.call_flags("org.freedesktop.DBus", "/org/freedesktop/DBus",
                               "org.freedesktop.DBus", "Hello", &[], 0)?;
        d.unique_name = out.first().and_then(|v| v.as_str()).unwrap_or("").to_string();
        Ok(d)
    }

    fn encode(&mut self, typ: u8, flags: u8, fields: Vec<(u8, Val)>, body: &[Val]) -> Vec<u8> {
        self.serial += 1;
        let serial = self.serial;

        let mut bm = M::new(0);
        for v in body { bm.value(v) }

        let mut fm = M::new(16);
        for (code, v) in &fields {
            fm.align(8);
            fm.b.push(*code);
            fm.value(&Val::Variant(Box::new(v.clone())));
        }

        let mut out = Vec::with_capacity(16 + fm.b.len() + bm.b.len() + 8);
        out.push(b'l');
        out.push(typ);
        out.push(flags);
        out.push(1);
        out.extend_from_slice(&(bm.b.len() as u32).to_le_bytes());
        out.extend_from_slice(&serial.to_le_bytes());
        out.extend_from_slice(&(fm.b.len() as u32).to_le_bytes());
        out.extend_from_slice(&fm.b);
        while out.len() % 8 != 0 { out.push(0) }
        out.extend_from_slice(&bm.b);
        out
    }

    fn read_msg(&mut self) -> Result<Msg> {
        let mut head = [0u8; 16];
        self.s.read_exact(&mut head).map_err(|_| Error::Closed)?;
        if head[0] != b'l' { return Err(Error::Io("only little-endian dbus supported".into())) }
        let typ = head[1];
        let body_len = u32::from_le_bytes(head[4..8].try_into().unwrap()) as usize;
        let fields_len = u32::from_le_bytes(head[12..16].try_into().unwrap()) as usize;
        let pad = (8 - (fields_len % 8)) % 8;

        let mut rest = vec![0u8; fields_len + pad + body_len];
        self.s.read_exact(&mut rest).map_err(|_| Error::Closed)?;

        // Header fields unmarshal with offsets relative to the message start,
        // so the whole buffer is reassembled rather than parsed piecewise.
        let mut whole = head.to_vec();
        whole.extend_from_slice(&rest);
        let mut u = U { b: &whole, i: 12 };
        let fields = u.value("a(yv)")?;

        let mut m = Msg { typ, reply_serial: 0, error_name: None,
                          path: String::new(), interface: String::new(),
                          member: String::new(), body: Vec::new() };
        let mut sig = String::new();
        if let Val::Array(_, items) = fields {
            for it in items {
                if let Val::Struct(f) = it {
                    let code = match f.first() { Some(Val::Byte(c)) => *c, _ => continue };
                    let v = match f.get(1) { Some(Val::Variant(v)) => (**v).clone(), _ => continue };
                    match code {
                        1 => m.path = v.as_str().unwrap_or("").into(),
                        2 => m.interface = v.as_str().unwrap_or("").into(),
                        3 => m.member = v.as_str().unwrap_or("").into(),
                        4 => m.error_name = Some(v.as_str().unwrap_or("").into()),
                        5 => m.reply_serial = v.as_u64().unwrap_or(0) as u32,
                        8 => sig = v.as_str().unwrap_or("").into(),
                        _ => {}
                    }
                }
            }
        }

        if !sig.is_empty() && body_len > 0 {
            let start = 16 + fields_len + pad;
            let mut bu = U { b: &whole[start..], i: 0 };
            for p in split_sig(&sig) { m.body.push(bu.value(&p)?) }
        }
        Ok(m)
    }

    fn call_flags(&mut self, dest: &str, path: &str, iface: &str, member: &str,
                  args: &[Val], flags: u8) -> Result<Vec<Val>> {
        let mut fields = vec![
            (1u8, Val::Path(path.into())),
            (2u8, Val::Str(iface.into())),
            (3u8, Val::Str(member.into())),
            (6u8, Val::Str(dest.into())),
        ];
        if !args.is_empty() {
            let sig: String = args.iter().map(|a| a.signature()).collect();
            fields.push((8u8, Val::Sig(sig)));
        }
        let msg = self.encode(MSG_CALL, flags, fields, args);
        let want = self.serial;
        self.s.write_all(&msg).map_err(|e| Error::Io(e.to_string()))?;

        loop {
            let m = self.read_msg()?;
            match m.typ {
                MSG_SIGNAL => self.pending.push_back(Signal {
                    path: m.path, interface: m.interface, member: m.member, args: m.body,
                }),
                MSG_RETURN if m.reply_serial == want => return Ok(m.body),
                MSG_ERROR if m.reply_serial == want => {
                    let detail = m.body.first().and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = m.error_name.unwrap_or_else(|| "dbus error".into());
                    return Err(Error::Remote {
                        code: 1,
                        stderr: if detail.is_empty() { name } else { format!("{name}: {detail}") },
                    })
                }
                _ => {}
            }
        }
    }

    pub fn call(&mut self, dest: &str, path: &str, iface: &str, member: &str, args: &[Val])
        -> Result<Vec<Val>> {
        self.call_flags(dest, path, iface, member, args, 0)
    }

    /// Same, but permits polkit to raise an interactive challenge. Only useful
    /// with an auth agent registered for the session — otherwise this blocks
    /// where the plain call would have failed fast.
    pub fn call_interactive(&mut self, dest: &str, path: &str, iface: &str, member: &str,
                            args: &[Val]) -> Result<Vec<Val>> {
        self.call_flags(dest, path, iface, member, args, ALLOW_INTERACTIVE_AUTH)
    }

    pub fn get(&mut self, dest: &str, path: &str, iface: &str, prop: &str) -> Result<Val> {
        let out = self.call(dest, path, "org.freedesktop.DBus.Properties", "Get",
            &[Val::Str(iface.into()), Val::Str(prop.into())])?;
        out.into_iter().next().ok_or_else(|| Error::Io("empty property reply".into()))
    }

    pub fn get_all(&mut self, dest: &str, path: &str, iface: &str) -> Result<Val> {
        let out = self.call(dest, path, "org.freedesktop.DBus.Properties", "GetAll",
            &[Val::Str(iface.into())])?;
        out.into_iter().next().ok_or_else(|| Error::Io("empty properties reply".into()))
    }

    pub fn add_match(&mut self, rule: &str) -> Result<()> {
        self.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                  "AddMatch", &[Val::Str(rule.into())])?;
        Ok(())
    }

    /// Block until the next signal, or None on timeout. Signals that arrived
    /// while a call was in flight are replayed first.
    pub fn next_signal(&mut self, timeout: Duration) -> Result<Option<Signal>> {
        if let Some(s) = self.pending.pop_front() { return Ok(Some(s)) }
        self.s.set_read_timeout(Some(timeout)).ok();
        match self.read_msg() {
            Ok(m) if m.typ == MSG_SIGNAL => Ok(Some(Signal {
                path: m.path, interface: m.interface, member: m.member, args: m.body,
            })),
            Ok(_) => Ok(None),
            Err(Error::Closed) => Err(Error::Closed),
            Err(_) => Ok(None), // read timeout
        }
    }
}
