use sshdesk_core::Host;

/// The whole VS Code path as the plugin runs it: start on a unix socket,
/// forward it to a local TCP port, and fetch the workbench.
///
/// Covers the failure that produced a blank frame: the token arrived as a
/// SameSite=Lax cookie through a redirect, which a cross-origin iframe never
/// keeps, so every request after the first got a 403.
#[test]
#[ignore]
fn vscode_serves_over_a_forwarded_socket() {
    let target = std::env::var("SSHDESK_HOST").expect("SSHDESK_HOST");
    let mut h = Host::connect(&target).expect("connect");

    let opt = "$HOME/.sshdesk/opt";
    let start = format!(r#"
    set -e
    umask 077
    D="{opt}/openvscode-server"
    if [ -f "{opt}/openvscode.pid" ] && kill -0 "$(cat "{opt}/openvscode.pid" 2>/dev/null)" 2>/dev/null && [ -S "{opt}/openvscode.sock" ]; then chmod 700 "{opt}/openvscode.sock"; echo "SOCKET={opt}/openvscode.sock"; exit 0; fi
    rm -f "{opt}/openvscode.log" "{opt}/openvscode.sock"
    nohup "$D/bin/openvscode-server" --socket-path "{opt}/openvscode.sock" --without-connection-token --server-data-dir "{opt}/openvscode-data" --telemetry-level off --accept-server-license-terms > "{opt}/openvscode.log" 2>&1 &
    echo $! > "{opt}/openvscode.pid"
    for _ in $(seq 1 80); do [ -S "{opt}/openvscode.sock" ] && break; sleep 0.25; done
    [ -S "{opt}/openvscode.sock" ] || {{ echo "no socket" >&2; exit 1; }}
    chmod 700 "{opt}/openvscode.sock"
    echo "SOCKET={opt}/openvscode.sock"
    "#);

    let out = h.run_argv(&["sh".into(), "-c".into(), start], None).expect("start");
    let line = out.stdout.lines().find(|l| l.starts_with("SOCKET="))
        .unwrap_or_else(|| panic!("no socket: {:?} / {:?}", out.stdout, out.stderr));
    let remote_sock = line.trim_start_matches("SOCKET=").to_string();
    println!("  socket: {remote_sock}");

    let perms = h.run(&format!("stat -c %a {remote_sock}")).expect("stat");
    assert_eq!(perms.stdout.trim(), "700",
               "socket must be owner-only, got {}", perms.stdout.trim());
    println!("  ✓ socket is 0700 — no other user on the box can open it");

    let local = 47811u16;
    h.forward_socket(local, &remote_sock).expect("forward");
    println!("  ✓ forwarded to 127.0.0.1:{local}");

    let body = std::process::Command::new("curl")
        .args(["-s", "-w", "\n%{http_code}", &format!("http://127.0.0.1:{local}/")])
        .output().expect("curl");
    let text = String::from_utf8_lossy(&body.stdout);
    let code = text.lines().last().unwrap_or("");
    assert_eq!(code, "200", "expected the workbench, got {code}");
    assert!(text.contains("DOCTYPE html") || text.contains("<html>"), "not the workbench");
    println!("  ✓ 200 and the workbench HTML, with no token and no cookie");

    h.cancel_forward_socket(local, &remote_sock).ok();
    h.run_argv(&["sh".into(), "-c".into(),
        format!("kill $(cat {opt}/openvscode.pid) 2>/dev/null || true; rm -f {opt}/openvscode.pid {opt}/openvscode.sock")],
        None).ok();
    println!("  ✓ stopped and cleaned up");
    h.disconnect();
}
