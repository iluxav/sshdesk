use sshdesk_core::{deps, Host};
use std::collections::BTreeMap;

#[test]
#[ignore]
fn install_openvscode_server() {
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
    println!("  {}", deps::install(&mut h, &req, "").expect("install"));
    let st = deps::probe(&mut h, std::slice::from_ref(&req)).unwrap();
    println!("  found at {}", st[0].path);
    let help = h.run(&format!("{} --help 2>&1 | head -40", st[0].path)).unwrap();
    println!("--- flags ---\n{}", help.stdout);
    h.disconnect();
}
