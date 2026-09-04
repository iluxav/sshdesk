use sshdesk_core::{deps, Host};
use std::collections::BTreeMap;

fn req(sha: &str) -> deps::Requirement {
    let mut m = BTreeMap::new();
    m.insert("aarch64".to_string(), sha.to_string());
    deps::Requirement::Archive {
        command: "rg".into(),
        url: "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/\
              ripgrep-14.1.1-${arch}-unknown-linux-gnu.tar.gz".replace(' ', "").into(),
        sha256: m,
        into: "ripgrep-test".into(),
        bin: "rg".into(),
        strip_components: 1,
        arch_map: BTreeMap::new(),
    }
}

/// Opt-in: needs a reachable host and the network.
///
///     SSHDESK_HOST=user@box cargo test --test deps_live -- --ignored --nocapture
#[test]
#[ignore]
fn archive_install_verifies_before_it_unpacks() {
    let target = std::env::var("SSHDESK_HOST")
        .expect("set SSHDESK_HOST=user@box to run this");
    let mut h = Host::connect(&target).expect("connect");

    // Wrong checksum must be refused, and must leave nothing behind.
    let bad = req(&"0".repeat(64));
    match deps::install(&mut h, &bad, "") {
        Err(e) => println!("  ✓ wrong checksum refused: {e}"),
        Ok(_) => panic!("a wrong checksum was accepted"),
    }
    let after = deps::list_installed(&mut h).unwrap();
    assert!(!after.iter().any(|i| i.name == "ripgrep-test"),
            "a refused download still left a directory: {after:?}");
    println!("  ✓ nothing left behind by the refusal");

    // Correct checksum installs and the binary is executable.
    let good = req("c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f");
    let msg = deps::install(&mut h, &good, "").expect("install");
    println!("  ✓ {msg}");

    let st = deps::probe(&mut h, std::slice::from_ref(&good)).unwrap();
    assert!(st[0].present, "probe did not find it: {st:?}");
    println!("  ✓ probe finds it at {}", st[0].path);

    let out = h.run(&format!("{} --version", st[0].path)).unwrap();
    assert!(out.stdout.contains("ripgrep"), "did not run: {out:?}", out = out.stdout);
    println!("  ✓ it runs: {}", out.stdout.lines().next().unwrap_or(""));

    let listed = deps::list_installed(&mut h).unwrap();
    let entry = listed.iter().find(|i| i.name == "ripgrep-test").expect("not listed");
    println!("  ✓ listed as installed, {} KB", entry.size / 1024);

    println!("  ✓ {}", deps::remove_archive(&mut h, "ripgrep-test").unwrap());
    let gone = deps::list_installed(&mut h).unwrap();
    assert!(!gone.iter().any(|i| i.name == "ripgrep-test"), "not removed");
    println!("  ✓ removed cleanly");
    h.disconnect();
}
