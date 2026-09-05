use sshdesk_core::Host;

/// The plugin's start script, run the way sdk.exec runs it, then the token it
/// reports is checked against the server it started.
#[test]
#[ignore]
fn start_reports_a_token_that_the_server_enforces() {
    let target = std::env::var("SSHDESK_HOST").expect("SSHDESK_HOST");
    let mut h = Host::connect(&target).expect("connect");
    let opt = "$HOME/.sshdesk/opt";

    // Stop whatever is there so this exercises the fresh-start path.
    h.run_argv(&["sh".into(), "-c".into(), format!(
        "P={opt}/openvscode.pid; [ -f $P ] && kill $(cat $P) 2>/dev/null; \
         rm -f $P {opt}/openvscode.sock {opt}/openvscode.token")], None).ok();

    let start = format!(r#"
    set -e
    umask 077
    D="{opt}/openvscode-server"
    rm -f "{opt}/openvscode.log" "{opt}/openvscode.sock"
    TOK=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
    printf '%s' "$TOK" > "{opt}/openvscode.token"; chmod 600 "{opt}/openvscode.token"
    nohup "$D/bin/openvscode-server" --socket-path "{opt}/openvscode.sock" \
      --connection-token "$TOK" --server-data-dir "{opt}/openvscode-data" \
      --user-data-dir "{opt}/openvscode-user" --extensions-dir "{opt}/openvscode-extensions" \
      --telemetry-level off --accept-server-license-terms > "{opt}/openvscode.log" 2>&1 &
    echo $! > "{opt}/openvscode.pid"
    for _ in $(seq 1 80); do [ -S "{opt}/openvscode.sock" ] && break; sleep 0.25; done
    chmod 700 "{opt}/openvscode.sock"
    echo "SOCKET={opt}/openvscode.sock"
    echo "TOKEN=$TOK"
    "#);

    let out = h.run_argv(&["sh".into(), "-c".into(), start], None).expect("start");
    let line = |p: &str| out.stdout.lines().find(|l| l.starts_with(p))
        .unwrap_or_else(|| panic!("no {p} in {:?} / {:?}", out.stdout, out.stderr));
    let sock = line("SOCKET=").trim_start_matches("SOCKET=").to_string();
    let token = line("TOKEN=").trim_start_matches("TOKEN=").to_string();
    assert_eq!(token.len(), 32, "token looks wrong: {token:?}");
    println!("  socket {sock}\n  token  {}…", &token[..8]);

    let port = 24188u16;
    let _ = h.cancel_forward_socket(port, &sock);
    h.forward_socket(port, &sock).expect("forward");

    let code = |url: &str| {
        let o = std::process::Command::new("curl")
            .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", url])
            .output().expect("curl");
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    let without = code(&format!("http://127.0.0.1:{port}/"));
    let with = code(&format!("http://127.0.0.1:{port}/?tkn={token}"));
    println!("  no token  -> {without}");
    println!("  token     -> {with}");
    assert_eq!(without, "403", "the token is not being enforced");
    assert!(with == "302" || with == "200", "token was rejected: {with}");
    println!("  ✓ socket has no TCP port, and the forwarded port needs the secret");

    h.cancel_forward_socket(port, &sock).ok();
    h.disconnect();
}
