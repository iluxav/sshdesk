use sshdesk_core::Host;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

fn answers(port: u16) -> bool {
    let a = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    TcpStream::connect_timeout(&a, Duration::from_millis(400)).is_ok()
}

/// What a restart actually looks like: the ControlMaster outlives the app, so
/// its forwards are still registered and the port still bound when the app
/// comes back. Re-adding the same forward is a silent no-op, which is how the
/// port drifted and how a frame ended up pointing at nothing.
#[test]
#[ignore]
fn a_forward_can_be_re_established_on_the_same_port() {
    let target = std::env::var("SSHDESK_HOST").expect("SSHDESK_HOST");
    let mut h = Host::connect(&target).expect("connect");
    let home = h.sftp().unwrap().home().unwrap();
    let sock = format!("{home}/.sshdesk/opt/openvscode.sock");

    let out = h.run(&format!("test -S {sock} && echo yes || echo no")).unwrap();
    if out.stdout.trim() != "yes" {
        println!("  (no vscode server on this host — skipping)");
        return
    }

    let port = 24173u16;
    let _ = h.cancel_forward_socket(port, &sock);

    h.forward_socket(port, &sock).expect("first forward");
    assert!(answers(port), "a fresh forward should answer");
    println!("  ✓ forwarded and answering on {port}");

    h.forward_socket(port, &sock).expect("redundant add");
    assert!(answers(port), "still answering after a redundant add");
    println!("  ✓ re-adding the same forward is harmless");

    h.cancel_forward_socket(port, &sock).expect("cancel");
    assert!(!answers(port), "a cancelled forward should stop answering");
    println!("  ✓ a dead forward stops answering, so it is detectable");

    let _ = h.cancel_forward_socket(port, &sock);
    h.forward_socket(port, &sock).expect("re-forward");
    assert!(answers(port), "should recover on the same port");
    println!("  ✓ recovered on {port} — the web origin is preserved");

    h.cancel_forward_socket(port, &sock).ok();
    h.disconnect();
}
