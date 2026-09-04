//! Icon packs.
//!
//! A pack is a directory of SVGs; the id is `pack:name`. The default pack is
//! compiled in, so a fresh install renders with nothing on disk, and packs
//! found on disk shadow it by name — which replaces one icon without forking
//! a whole set.
//!
//! Every SVG is sanitised on load. These are local files, but a pack is
//! something people download, and SVG is an active document: it can carry
//! script, event handlers and off-machine references. Doing this here means
//! the trust boundary does not depend on where the file came from.
//!
//! Remote hosts never reach this code. Config may *name* an icon; supplying
//! one is not a thing a host can do.

use serde::Serialize;
use std::collections::BTreeMap;

pub const DEFAULT_PACK: &str = "desk";
pub const LIBRARY_PACK: &str = "lucide";

/// The full Lucide set (ISC, see assets/icons/LICENSE.lucide), packed as one
/// blob rather than 2066 `include_str!` calls — same bytes, a compile that
/// finishes, and one file to update.
const LUCIDE: &str = include_str!("../assets/icons/lucide.pack");

fn lucide() -> BTreeMap<String, String> {
    LUCIDE.split('\u{1e}')
        .filter_map(|rec| rec.split_once('\n'))
        .map(|(name, svg)| (name.to_string(), sanitize(svg)))
        .collect()
}

const BUNDLED: &[(&str, &str)] = &[
    ("app", include_str!("../assets/icons/desk/app.svg")),
    ("chevron-right", include_str!("../assets/icons/desk/chevron-right.svg")),
    ("cpu", include_str!("../assets/icons/desk/cpu.svg")),
    ("disk", include_str!("../assets/icons/desk/disk.svg")),
    ("download", include_str!("../assets/icons/desk/download.svg")),
    ("editor", include_str!("../assets/icons/desk/editor.svg")),
    ("file", include_str!("../assets/icons/desk/file.svg")),
    ("file-code", include_str!("../assets/icons/desk/file-code.svg")),
    ("file-text", include_str!("../assets/icons/desk/file-text.svg")),
    ("folder", include_str!("../assets/icons/desk/folder.svg")),
    ("folder-open", include_str!("../assets/icons/desk/folder-open.svg")),
    ("home", include_str!("../assets/icons/desk/home.svg")),
    ("link", include_str!("../assets/icons/desk/link.svg")),
    ("network", include_str!("../assets/icons/desk/network.svg")),
    ("plus", include_str!("../assets/icons/desk/plus.svg")),
    ("refresh", include_str!("../assets/icons/desk/refresh.svg")),
    ("search", include_str!("../assets/icons/desk/search.svg")),
    ("service", include_str!("../assets/icons/desk/service.svg")),
    ("settings", include_str!("../assets/icons/desk/settings.svg")),
    ("terminal", include_str!("../assets/icons/desk/terminal.svg")),
    ("trash", include_str!("../assets/icons/desk/trash.svg")),
    ("upload", include_str!("../assets/icons/desk/upload.svg")),
];

#[derive(Debug, Clone, Serialize)]
pub struct Pack {
    pub name: String,
    /// icon name -> sanitised svg
    pub icons: BTreeMap<String, String>,
    /// true when it ships inside the binary rather than living on disk
    pub bundled: bool,
}

pub fn packs_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    std::path::Path::new(&home).join(".sshdesk/icons")
}

/// Strip anything active out of an SVG.
///
/// Removal rather than rejection: one bad attribute should cost you that
/// attribute, not the icon. What goes: script and foreignObject elements
/// entirely, every `on*` handler, and any reference carrying a scheme.
pub fn sanitize(svg: &str) -> String {
    let mut out = String::with_capacity(svg.len());
    let b = svg.as_bytes();
    let mut i = 0;

    while i < b.len() {
        if b[i] != b'<' { out.push(b[i] as char); i += 1; continue }

        // Drop dangerous elements along with their contents.
        let rest = &svg[i..];
        let lower = rest[..rest.len().min(16)].to_ascii_lowercase();
        for tag in ["<script", "<foreignobject", "<use", "<image", "<a "] {
            if lower.starts_with(tag) {
                let close = format!("</{}", tag.trim_start_matches('<').trim_end());
                if let Some(end) = rest.to_ascii_lowercase().find(&close) {
                    if let Some(gt) = rest[end..].find('>') { i += end + gt + 1; }
                    else { i = svg.len(); }
                } else if let Some(gt) = rest.find('>') {
                    i += gt + 1;                       // self-closing
                } else { i = svg.len(); }
                continue
            }
        }
        if i >= b.len() { break }
        if b[i] != b'<' { continue }

        // Copy one tag, filtering its attributes.
        let Some(gt) = svg[i..].find('>') else { break };
        let tag = &svg[i..i + gt + 1];
        out.push_str(&filter_attrs(tag));
        i += gt + 1;
    }
    out
}

fn filter_attrs(tag: &str) -> String {
    // Cheap scanner: names are the tokens before '=', values are quoted.
    let mut out = String::with_capacity(tag.len());
    let mut rest = tag;
    while let Some(eq) = rest.find('=') {
        let (before, after) = rest.split_at(eq);
        let name_start = before.rfind(|c: char| c.is_whitespace()).map(|p| p + 1).unwrap_or(0);
        let name = before[name_start..].trim().to_ascii_lowercase();

        let after = &after[1..];
        let quote = after.chars().next().unwrap_or('"');
        let (value, consumed) = if quote == '"' || quote == '\'' {
            match after[1..].find(quote) {
                Some(e) => (&after[1..1 + e], 1 + e + 1),
                None => (&after[1..], after.len() - 1),
            }
        } else {
            let e = after.find(|c: char| c.is_whitespace() || c == '>').unwrap_or(after.len());
            (&after[..e], e)
        };

        let drop = name.starts_with("on")
            || ((name.ends_with("href") || name == "src" || name == "xlink:href")
                && value.contains(':'));

        if drop {
            out.push_str(&before[..name_start]);
        } else {
            out.push_str(before);
            out.push('=');
            out.push_str(&after[..consumed.min(after.len())]);
        }
        rest = &after[consumed.min(after.len())..];
    }
    out.push_str(rest);
    out
}

pub fn load() -> Vec<Pack> {
    let mut bundled = Pack {
        name: DEFAULT_PACK.into(),
        icons: BUNDLED.iter().map(|(n, s)| ((*n).to_string(), sanitize(s))).collect(),
        bundled: true,
    };

    let mut packs: Vec<Pack> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(packs_dir()) {
        for e in entries.flatten() {
            if !e.path().is_dir() { continue }
            let name = e.file_name().to_string_lossy().to_string();
            let mut icons = BTreeMap::new();
            if let Ok(files) = std::fs::read_dir(e.path()) {
                for f in files.flatten() {
                    let p = f.path();
                    if p.extension().and_then(|s| s.to_str()) != Some("svg") { continue }
                    let Some(stem) = p.file_stem().map(|s| s.to_string_lossy().to_string())
                        else { continue };
                    if let Ok(text) = std::fs::read_to_string(&p) {
                        icons.insert(stem, sanitize(&text));
                    }
                }
            }
            if icons.is_empty() { continue }
            // A disk pack sharing the default's name shadows it per icon,
            // rather than replacing the set and losing everything it omits.
            if name == DEFAULT_PACK {
                bundled.icons.extend(icons);
                bundled.bundled = false;
            } else {
                packs.push(Pack { name, icons, bundled: false });
            }
        }
    }
    packs.insert(0, bundled);

    // The library goes last: a curated name should win over the same name in a
    // 2000-icon set, and callers scanning packs in order find `desk` first.
    let library = lucide();
    if !library.is_empty() {
        packs.push(Pack { name: LIBRARY_PACK.into(), icons: library, bundled: true });
    }
    packs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(s: &str) -> String { sanitize(s).to_ascii_lowercase() }

    #[test]
    fn strips_script_and_contents() {
        let out = clean(r#"<svg><script>alert(1)</script><path d="M0 0"/></svg>"#);
        assert!(!out.contains("script"), "{out}");
        assert!(!out.contains("alert"), "{out}");
        assert!(out.contains("path"), "path survived: {out}");
    }

    #[test]
    fn strips_event_handlers_but_keeps_the_element() {
        let out = clean(r#"<svg><path onload="x()" d="M0 0" onclick='y()'/></svg>"#);
        assert!(!out.contains("onload"), "{out}");
        assert!(!out.contains("onclick"), "{out}");
        assert!(out.contains(r#"d="m0 0""#), "geometry survived: {out}");
    }

    #[test]
    fn strips_external_references() {
        let out = clean(r#"<svg><path href="https://evil/x" d="M0 0"/></svg>"#);
        assert!(!out.contains("https"), "{out}");
        assert!(out.contains("d="), "{out}");
    }

    #[test]
    fn drops_elements_that_can_load_or_navigate() {
        for bad in ["<image href=\"x.png\"/>", "<use href=\"#a\"/>", "<a href=\"h\"><path/></a>"] {
            let out = clean(&format!("<svg>{bad}<circle r=\"1\"/></svg>"));
            assert!(!out.contains("<image"), "{out}");
            assert!(!out.contains("<use"), "{out}");
        }
    }

    #[test]
    fn keeps_ordinary_icons_intact() {
        let src = r#"<svg viewBox="0 0 24 24" stroke="currentColor"><path d="M3 7a2 2 0 0 1 2-2"/></svg>"#;
        let out = sanitize(src);
        assert!(out.contains("currentColor"), "{out}");
        assert!(out.contains("viewBox"), "{out}");
        assert!(out.contains("M3 7a2 2 0 0 1 2-2"), "{out}");
    }

    #[test]
    fn every_bundled_icon_survives_its_own_sanitiser() {
        for (name, svg) in BUNDLED {
            let out = sanitize(svg);
            assert!(out.contains("<path") || out.contains("<circle")
                    || out.contains("<rect") || out.contains("<ellipse"),
                    "{name} lost all geometry: {out}");
            assert!(out.contains("currentColor"), "{name} lost theming");
        }
    }
}

#[cfg(test)]
mod library_tests {
    use super::*;

    #[test]
    fn the_library_pack_parses_and_survives_sanitising() {
        let icons = lucide();
        assert!(icons.len() > 1500, "only {} icons", icons.len());
        for name in ["folder", "file", "terminal", "settings", "search"] {
            let svg = icons.get(name).unwrap_or_else(|| panic!("{name} missing"));
            assert!(svg.contains("currentColor"), "{name} lost theming");
            assert!(svg.contains("viewBox"), "{name} lost its viewBox");
        }
    }
}
