use sshdesk_core::{deps, Host};
use std::collections::BTreeMap;

/// The exact requirement the VS Code plugin declares, checked the way the
/// launcher checks it. This is what showed "the app declared an unusable
/// download" with the Install button disabled.
#[test]
#[ignore]
fn the_vscode_requirement_is_installable() {
    let target = std::env::var("SSHDESK_HOST").expect("SSHDESK_HOST");
    let mut h = Host::connect(&target).expect("connect");
    let m = |p: &[(&str, &str)]| p.iter()
        .map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>();

    let req = deps::Requirement::Archive {
        command: "openvscode-server".into(),
        url: "https://github.com/gitpod-io/openvscode-server/releases/download/\
openvscode-server-v1.109.5/openvscode-server-v1.109.5-linux-${arch}.tar.gz".into(),
        sha256: m(&[
            ("aarch64", "36d9c14036489b63de84ebace837fcacf7e60e669a0dc715802c5443684ea4dc"),
            ("x86_64",  "b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363"),
            ("armv7l",  "f84ac0dcea0bdeac07e172e58903b38bc5ef0ac94b0bf2ab2ce4eca325ab98bb"),
        ]),
        into: "openvscode-server".into(),
        bin: "bin/openvscode-server".into(),
        strip_components: 1,
        arch_map: m(&[("aarch64", "arm64"), ("x86_64", "x64"), ("armv7l", "armhf")]),
    };

    let st = &deps::probe(&mut h, std::slice::from_ref(&req)).expect("probe")[0];
    println!("  present={} installable={} detail={:?}", st.present, st.installable, st.detail);
    assert!(!st.present, "remove it first to test the offer");
    assert!(st.installable, "Install would be disabled: {}", st.detail);
    assert!(st.detail.contains("no root"), "detail should say what happens: {}", st.detail);
    println!("  ✓ the sheet would offer to install it");
    h.disconnect();
}
