//! Configuration.
//!
//! One file, on the machine you are sitting at:
//!
//! ```text
//! defaults   every app's declared tokens (these live in the frontend)
//! config     ~/.sshdesk/config.toml
//! ```
//!
//! This started out layered, with per-host overrides read over SFTP. That was
//! a mistake in practice rather than in theory: the desktop chrome resolves
//! without a host, so anything saved to a host was written successfully and
//! then had no visible effect — "saved" was true and useless. One file, one
//! place, no scope to pick.
//!
//! Defaults are deliberately not handled here. They are declared by app
//! manifests in JS, and teaching Rust about them would duplicate the registry
//! for no gain.
//!
//! Keys are flattened to dotted form (`theme.files.row_hover`) so a merge is a
//! map merge and provenance stays trackable per key.

use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type Flat = BTreeMap<String, String>;

/// Configuration is per machine. Every value — colours, icons, the desktop
/// picture — belongs to one target:
///
/// ```toml
/// [machine."iluxa@10.168.168.226".theme.desk]
/// accent = "#60a5fa"
///
/// [machine."iluxa@10.168.168.153".theme.desk]
/// accent = "#f87171"
/// ```
///
/// There is no shared layer. It existed for one revision and the result was
/// that every edit silently applied to both machines, which is the opposite of
/// what a desktop per machine is for. Anything not set falls back to the app's
/// declared default, which is the only other layer there is.
///
/// They are kept apart rather than flattened into one map, because a target is
/// full of dots — `machine.iluxa@10.168.168.153.theme.desk.accent` has no
/// reading that says where the machine name ends.
pub const MACHINE_TABLE: &str = "machine";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    /// Applies everywhere.
    pub values: Flat,
    /// target -> the keys that machine overrides.
    pub machines: BTreeMap<String, Flat>,
    /// Non-fatal problems worth showing rather than swallowing.
    pub warnings: Vec<String>,
}

fn flatten(v: &toml::Value, prefix: &str, out: &mut Flat) {
    match v {
        toml::Value::Table(t) => {
            for (k, sub) in t {
                let key = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                flatten(sub, &key, out);
            }
        }
        toml::Value::String(s) => { out.insert(prefix.into(), s.clone()); }
        toml::Value::Integer(n) => { out.insert(prefix.into(), n.to_string()); }
        toml::Value::Float(n) => { out.insert(prefix.into(), n.to_string()); }
        toml::Value::Boolean(b) => { out.insert(prefix.into(), b.to_string()); }
        // Arrays and datetimes have no meaning in this schema; ignoring them is
        // better than failing the whole file over one stray key.
        _ => {}
    }
}

pub fn parse(text: &str) -> Result<Flat> {
    let (global, _) = parse_all(text)?;
    Ok(global)
}

/// Global values and per-machine overrides, kept separate.
pub fn parse_all(text: &str) -> Result<(Flat, BTreeMap<String, Flat>)> {
    let v: toml::Value = text.parse().map_err(|e| Error::Io(format!("bad toml: {e}")))?;
    let mut machines: BTreeMap<String, Flat> = BTreeMap::new();
    let mut global = Flat::new();

    if let toml::Value::Table(root) = &v {
        for (k, sub) in root {
            if k == MACHINE_TABLE {
                if let toml::Value::Table(per) = sub {
                    for (target, table) in per {
                        let mut f = Flat::new();
                        flatten(table, "", &mut f);
                        machines.insert(target.clone(), f);
                    }
                }
            } else {
                flatten(sub, k, &mut global);
            }
        }
    }
    Ok((global, machines))
}

/// Render back to TOML, grouping by section so a hand-editor sees something
/// familiar rather than a wall of dotted keys.
pub fn render(flat: &Flat) -> String { render_all(flat, &BTreeMap::new()) }

/// TOML for the whole file, global values first and each machine after.
pub fn render_all(flat: &Flat, machines: &BTreeMap<String, Flat>) -> String {
    let mut out = render_sections(flat, "");
    for (target, over) in machines {
        if over.is_empty() { continue }
        // The target is quoted as one key, so dots in an address stay inside it.
        out.push_str(&render_sections(over, &format!("{MACHINE_TABLE}.\"{target}\".")));
    }
    out
}

fn render_sections(flat: &Flat, prefix: &str) -> String {
    let mut sections: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for (k, v) in flat {
        let (section, leaf) = match k.rfind('.') {
            Some(i) => (k[..i].to_string(), k[i + 1..].to_string()),
            None => (String::new(), k.clone()),
        };
        sections.entry(section).or_default().push((leaf, v.clone()));
    }
    let mut out = if prefix.is_empty() {
        String::from("# sshdesk configuration\n\
                     # Written by Settings; safe to edit by hand.\n")
    } else {
        String::new()
    };
    for (section, entries) in sections {
        if section.is_empty() { continue }
        out.push_str(&format!("\n[{prefix}{section}]\n"));
        for (k, v) in entries {
            // Quote the key when it is not a bare identifier — icon tokens are
            // dotted, e.g. icons."files.directory".
            let key = if k.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                k
            } else {
                format!("\"{k}\"")
            };
            out.push_str(&format!("{key} = \"{}\"\n", v.replace('\\', "\\\\").replace('"', "\\\"")));
        }
    }
    out
}

// ---- validation ---------------------------------------------------------
//
// Applied on the way in, so a hand-edited file and the Settings UI get the same
// treatment. Nothing reaches the stylesheet as an opaque string: that is what
// keeps `url()` out even when the value arrived from a host.

fn is_color(v: &str) -> bool {
    let v = v.trim();
    if let Some(hex) = v.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
    }
    // rgb()/rgba()/hsl()/hsla() with only numbers, %, commas, slashes and spaces.
    for f in ["rgb(", "rgba(", "hsl(", "hsla("] {
        if let Some(rest) = v.strip_prefix(f) {
            if let Some(inner) = rest.strip_suffix(')') {
                return !inner.is_empty() && inner.chars().all(
                    |c| c.is_ascii_digit() || " .,%/-".contains(c))
            }
        }
    }
    false
}

fn is_length(v: &str) -> bool {
    let v = v.trim();
    let num: String = v.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-').collect();
    if num.is_empty() || num.parse::<f64>().is_err() { return false }
    matches!(&v[num.len()..], "" | "px" | "rem" | "em" | "%")
}

/// An icon is either `pack:name` or a short literal glyph (emoji).
fn is_icon(v: &str) -> bool {
    if v.is_empty() || v.chars().count() > 64 { return false }
    if let Some((pack, name)) = v.split_once(':') {
        let ok = |s: &str| !s.is_empty()
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        return ok(pack) && ok(name)
    }
    // A glyph: no path separators, no scheme, nothing that could be a URL.
    !v.contains('/') && !v.contains('\\') && !v.contains(':') && v.chars().count() <= 8
}

/// Validate one dotted key/value pair. Returns why it was rejected.
pub fn validate(key: &str, value: &str) -> std::result::Result<(), String> {
    if key.len() > 200 || key.is_empty() {
        return Err("key is empty or absurdly long".into())
    }
    if key.starts_with("icons.") {
        return if is_icon(value) { Ok(()) }
            else { Err(format!("not an icon id or glyph: {value:?}")) }
    }
    if key.starts_with("images.") {
        // A local path on this Mac, only ever opened for reading and only by
        // this process. Empty and control characters are the useful checks.
        return if !value.is_empty() && value.len() < 4096
            && !value.contains(|c: char| c.is_control()) { Ok(()) }
            else { Err("not a usable file path".into()) }
    }
    if key.starts_with("theme.") {
        return if is_color(value) || is_length(value) { Ok(()) }
            else { Err(format!("not a colour or length: {value:?}")) }
    }
    // Unknown namespaces are allowed through as plain strings; apps declare
    // their own token types and can reject what they do not understand.
    Ok(())
}

/// Drop anything that fails validation, reporting what was dropped. A bad key
/// must never take the rest of the file down with it.
pub fn sanitize(flat: Flat, origin: &str, warnings: &mut Vec<String>) -> Flat {
    flat.into_iter()
        .filter(|(k, v)| match validate(k, v) {
            Ok(()) => true,
            Err(why) => { warnings.push(format!("{origin}: dropped {k} — {why}")); false }
        })
        .collect()
}

// ---- storage ------------------------------------------------------------

pub fn local_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    std::path::Path::new(&home).join(".sshdesk/config.toml")
}

pub fn read_local(warnings: &mut Vec<String>) -> Flat {
    read_all(warnings).0
}

pub fn read_all(warnings: &mut Vec<String>) -> (Flat, BTreeMap<String, Flat>) {
    let path = local_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return (Flat::new(), BTreeMap::new())
    };
    match parse_all(&text) {
        Ok((g, m)) => (
            sanitize(g, "config", warnings),
            m.into_iter()
                .map(|(t, f)| {
                    let f = sanitize(f, &format!("config for {t}"), warnings);
                    (t, f)
                })
                .filter(|(_, f)| !f.is_empty())
                .collect(),
        ),
        Err(e) => { warnings.push(format!("config: {e}")); (Flat::new(), BTreeMap::new()) }
    }
}

pub fn write_local(flat: &Flat) -> Result<()> {
    write_all(flat, &BTreeMap::new())
}

pub fn write_all(flat: &Flat, machines: &BTreeMap<String, Flat>) -> Result<()> {
    let path = local_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| Error::Io(e.to_string()))?;
    }
    std::fs::write(&path, render_all(flat, machines)).map_err(|e| Error::Io(e.to_string()))
}

/// Everything the UI needs, in one call.
pub fn load() -> Settings {
    let mut warnings = Vec::new();
    let (values, machines) = read_all(&mut warnings);
    Settings { values, machines, warnings }
}

/// Write one key for one machine.
pub fn set(key: &str, value: Option<&str>, machine: Option<&str>) -> Result<()> {
    let target = machine.ok_or_else(||
        Error::Io("configuration belongs to a machine; connect to one first".into()))?;
    if let Some(v) = value { validate(key, v).map_err(Error::Io)?; }
    let mut warnings = Vec::new();
    let (global, mut machines) = read_all(&mut warnings);
    let e = machines.entry(target.to_string()).or_default();
    match value { Some(v) => e.insert(key.into(), v.into()), None => e.remove(key) };
    if e.is_empty() { machines.remove(target); }
    write_all(&global, &machines)
}

/// Move anything left over from the shared layer into the machines that were
/// using it, once.
///
/// Config used to have a global section. Dropping it silently would have reset
/// everyone's colours, so on first sight the old values become each known
/// machine's starting point and the shared section is written away. Machines
/// that already set a key keep their own.
pub fn migrate_globals(targets: &[String]) -> Result<usize> {
    let mut warnings = Vec::new();
    let (global, mut machines) = read_all(&mut warnings);
    if global.is_empty() { return Ok(0) }

    let moved = global.len();
    for t in targets {
        let e = machines.entry(t.clone()).or_default();
        for (k, v) in &global {
            e.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }
    write_all(&Flat::new(), &machines)?;
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_nested_sections() {
        let f = parse("[theme]\naccent = \"#f00\"\n[theme.files]\nrow_hover = \"#fff\"\n").unwrap();
        assert_eq!(f.get("theme.accent").map(String::as_str), Some("#f00"));
        assert_eq!(f.get("theme.files.row_hover").map(String::as_str), Some("#fff"));
    }

    #[test]
    fn quoted_dotted_keys_survive_a_round_trip() {
        let src = "[icons]\n\"files.directory\" = \"desk:folder\"\n";
        let f = parse(src).unwrap();
        assert_eq!(f.get("icons.files.directory").map(String::as_str), Some("desk:folder"));
        // rendering must produce something that parses back to the same map
        assert_eq!(parse(&render(&f)).unwrap(), f);
    }

    #[test]
    fn colours_and_lengths_are_accepted() {
        for v in ["#fff", "#ffffff", "#ffffff14", "rgb(1,2,3)", "hsl(1 2% 3%)"] {
            assert!(validate("theme.accent", v).is_ok(), "{v} rejected");
        }
        for v in ["8px", "0.5rem", "50%", "0"] {
            assert!(validate("theme.radius", v).is_ok(), "{v} rejected");
        }
    }

    #[test]
    fn css_injection_is_rejected() {
        for v in ["url(https://evil/x)", "red; background: url(x)", "expression(1)",
                  "var(--x)", "#ffg", "javascript:1"] {
            assert!(validate("theme.accent", v).is_err(), "{v} was allowed through");
        }
    }

    #[test]
    fn icons_must_be_an_id_or_a_glyph() {
        assert!(validate("icons.files.directory", "desk:folder").is_ok());
        assert!(validate("icons.files.directory", "\u{1F4C1}").is_ok());
        for v in ["../../etc/passwd", "http://x/y.svg", "/abs/path.svg", "a/b"] {
            assert!(validate("icons.files.directory", v).is_err(), "{v} was allowed through");
        }
    }

    #[test]
    fn one_bad_key_does_not_take_the_file_down() {
        let f = parse("[theme]\naccent = \"#f00\"\nbad = \"url(x)\"\n").unwrap();
        let mut warns = Vec::new();
        let clean = sanitize(f, "test", &mut warns);
        assert_eq!(clean.get("theme.accent").map(String::as_str), Some("#f00"));
        assert!(!clean.contains_key("theme.bad"));
        assert_eq!(warns.len(), 1, "{warns:?}");
    }
}

#[cfg(test)]
mod machine_tests {
    use super::*;

    /// The reason machines are not flattened with everything else: a target is
    /// full of dots, so `machine.iluxa@10.168.168.153.theme.desk.accent` has no
    /// reading that says where the machine name ends.
    #[test]
    fn a_dotted_target_survives_a_round_trip() {
        let mut global = Flat::new();
        global.insert("theme.desk.accent".into(), "#60a5fa".into());

        let mut per = BTreeMap::new();
        let mut prod = Flat::new();
        prod.insert("theme.desk.accent".into(), "#f87171".into());
        prod.insert("images.desk.wallpaper".into(), "/Users/me/prod.png".into());
        per.insert("iluxa@10.168.168.153".into(), prod);

        let text = render_all(&global, &per);
        let (g, m) = parse_all(&text).expect("re-read");

        assert_eq!(g.get("theme.desk.accent").map(String::as_str), Some("#60a5fa"),
                   "global lost:\n{text}");
        let back = m.get("iluxa@10.168.168.153").expect(&format!("machine lost:\n{text}"));
        assert_eq!(back.get("theme.desk.accent").map(String::as_str), Some("#f87171"));
        assert_eq!(back.get("images.desk.wallpaper").map(String::as_str),
                   Some("/Users/me/prod.png"));
    }

    #[test]
    fn a_machine_override_does_not_leak_into_the_global_map() {
        let text = "[theme]\n\"desk.accent\" = \"#111111\"\n\
                    \n[machine.\"a@b.c\".theme]\n\"desk.accent\" = \"#222222\"\n";
        let (g, m) = parse_all(text).unwrap();
        assert_eq!(g.get("theme.desk.accent").map(String::as_str), Some("#111111"));
        assert_eq!(g.keys().filter(|k| k.contains("machine")).count(), 0, "{g:?}");
        assert_eq!(m["a@b.c"].get("theme.desk.accent").map(String::as_str), Some("#222222"));
    }

    /// A shared section used to exist. Dropping it without moving the values
    /// would silently reset colours somebody chose, so the migration copies
    /// them onto each machine — and must be safe to run on every launch.
    #[test]
    fn migration_copies_shared_values_and_then_does_nothing() {
        let text = "[theme.desk]\naccent = \"#f00\"\nbg = \"#111\"\n\
                    \n[machine.\"a@1\".theme.desk]\naccent = \"#0f0\"\n";
        let (global, mut machines) = parse_all(text).unwrap();
        assert_eq!(global.len(), 2);

        // What migrate_globals does, without touching the real file.
        let targets = ["a@1".to_string(), "b@2".to_string()];
        for t in &targets {
            let e = machines.entry(t.clone()).or_default();
            for (k, v) in &global { e.entry(k.clone()).or_insert_with(|| v.clone()); }
        }
        let after = render_all(&Flat::new(), &machines);
        let (g2, m2) = parse_all(&after).unwrap();

        assert!(g2.is_empty(), "shared section survived: {after}");
        // A machine that had its own value keeps it.
        assert_eq!(m2["a@1"].get("theme.desk.accent").map(String::as_str), Some("#0f0"));
        assert_eq!(m2["a@1"].get("theme.desk.bg").map(String::as_str), Some("#111"));
        // One that had none inherits both.
        assert_eq!(m2["b@2"].get("theme.desk.accent").map(String::as_str), Some("#f00"));
        assert_eq!(m2["b@2"].len(), 2);
    }

    #[test]
    fn machine_values_are_validated_like_any_other() {
        let text = "[machine.\"a@b\".theme]\n\"desk.accent\" = \"url(https://evil/x)\"\n\
                    \"desk.ok\" = \"#00ff00\"\n";
        let (_, m) = parse_all(text).unwrap();
        let mut warns = Vec::new();
        let clean = sanitize(m["a@b"].clone(), "machine a@b", &mut warns);
        assert!(!clean.contains_key("theme.desk.accent"), "url() survived");
        assert_eq!(clean.get("theme.desk.ok").map(String::as_str), Some("#00ff00"));
        assert_eq!(warns.len(), 1);
    }
}
