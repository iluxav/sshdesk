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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    pub values: Flat,
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
    let v: toml::Value = text.parse().map_err(|e| Error::Io(format!("bad toml: {e}")))?;
    let mut out = Flat::new();
    flatten(&v, "", &mut out);
    Ok(out)
}

/// Render back to TOML, grouping by section so a hand-editor sees something
/// familiar rather than a wall of dotted keys.
pub fn render(flat: &Flat) -> String {
    let mut sections: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for (k, v) in flat {
        let (section, leaf) = match k.rfind('.') {
            Some(i) => (k[..i].to_string(), k[i + 1..].to_string()),
            None => (String::new(), k.clone()),
        };
        sections.entry(section).or_default().push((leaf, v.clone()));
    }
    let mut out = String::from("# sshdesk configuration\n\
                               # Written by Settings; safe to edit by hand.\n");
    for (section, entries) in sections {
        if section.is_empty() { continue }
        out.push_str(&format!("\n[{section}]\n"));
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
    let path = local_path();
    let Ok(text) = std::fs::read_to_string(&path) else { return Flat::new() };
    match parse(&text) {
        Ok(f) => sanitize(f, "local config", warnings),
        Err(e) => { warnings.push(format!("local config: {e}")); Flat::new() }
    }
}

pub fn write_local(flat: &Flat) -> Result<()> {
    let path = local_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| Error::Io(e.to_string()))?;
    }
    std::fs::write(&path, render(flat)).map_err(|e| Error::Io(e.to_string()))
}

/// Everything the UI needs, in one call.
pub fn load() -> Settings {
    let mut warnings = Vec::new();
    let values = read_local(&mut warnings);
    Settings { values, warnings }
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
