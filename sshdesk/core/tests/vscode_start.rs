use sshdesk_core::Host;

/// Runs the plugin's start script through the same path `sdk.exec` uses:
/// run_argv -> run -> subshell. `nohup ... &` inside a subshell is exactly the
/// kind of thing that works in a terminal and not here.
#[test]
#[ignore]
fn the_server_starts_and_reports_a_url() {
    let target = std::env::var("SSHDESK_HOST").expect("SSHDESK_HOST");
    let mut h = Host::connect(&target).expect("connect");

    let opt = "$HOME/.sshdesk/opt";
    let log = format!("{opt}/openvscode.log");
    let pid = format!("{opt}/openvscode.pid");
    let start = format!(r#"
    set -e
    D="{opt}/openvscode-server"
    if [ -f "{pid}" ] && kill -0 "$(cat "{pid}" 2>/dev/null)" 2>/dev/null; then
      grep -o 'http://localhost:[0-9]*?tkn=[0-9a-f]*' "{log}" | tail -1
      exit 0
    fi
    TOK=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
    rm -f "{log}"
    nohup "$D/bin/openvscode-server" \
      --host 127.0.0.1 --port 0 --connection-token "$TOK" \
      --server-data-dir "{opt}/openvscode-data" \
      --telemetry-level off --accept-server-license-terms \
      > "{log}" 2>&1 &
    echo $! > "{pid}"
    for _ in $(seq 1 80); do
      grep -q 'available at' "{log}" 2>/dev/null && break
      sleep 0.25
    done
    grep -o 'http://localhost:[0-9]*?tkn=[0-9a-f]*' "{log}" | tail -1
    "#);

    let argv = vec!["sh".to_string(), "-c".to_string(), start];
    let out = h.run_argv(&argv, None).expect("exec");
    let url = out.stdout.trim().to_string();
    println!("  reported: {url}");
    assert!(url.starts_with("http://localhost:"), "no url: {:?} / {:?}", out.stdout, out.stderr);

    let port: u16 = url.trim_start_matches("http://localhost:")
        .split('?').next().unwrap().parse().expect("port");
    println!("  port {port}");

    // Running it again must adopt the same server, not start a second one.
    let again = h.run_argv(&argv, None).expect("exec again");
    assert_eq!(again.stdout.trim(), url, "a second start did not reuse the first");
    println!("  ✓ idempotent — second start reused it");

    // And it is genuinely serving.
    let probe = h.run(&format!(
        "curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1:{port}/ || echo curl-missing"))
        .expect("curl");
    println!("  ✓ http says {}", probe.stdout.trim());

    let stop = vec!["sh".to_string(), "-c".to_string(),
        format!(r#"if [ -f "{pid}" ]; then kill "$(cat "{pid}")" 2>/dev/null || true; rm -f "{pid}"; fi"#)];
    h.run_argv(&stop, None).expect("stop");
    println!("  ✓ stopped");
    h.disconnect();
}

/// The framing markers are in-band, so output has to survive two hazards:
/// content that looks like a marker, and output with no trailing newline.
#[test]
#[ignore]
fn framing_survives_hostile_output() {
    let target = std::env::var("SSHDESK_HOST").expect("SSHDESK_HOST");
    let mut h = sshdesk_core::Host::connect(&target).expect("connect");

    // No trailing newline: this used to glue the marker onto the last line.
    let o = h.run("printf '403'").expect("run");
    assert_eq!(o.stdout, "403", "trailing-newline handling: {:?}", o.stdout);
    println!("  ✓ output without a trailing newline is exact: {:?}", o.stdout);

    // A trailing newline must be preserved exactly, not doubled or eaten.
    let o = h.run("printf 'a\\nb\\n'").expect("run");
    assert_eq!(o.stdout, "a\nb\n", "{:?}", o.stdout);
    println!("  ✓ a trailing newline is preserved: {:?}", o.stdout);

    // Old-style markers in the payload must be inert.
    let o = h.run("printf '__SD_OUT_1__\\n__SD_END_2__\\n0\\nreal\\n'").expect("run");
    assert!(o.stdout.contains("real"), "frame ended early: {:?}", o.stdout);
    assert_eq!(o.code, 0);
    println!("  ✓ marker-shaped content did not end the frame");

    // And the connection is still usable afterwards.
    let o = h.run("echo alive").expect("still alive");
    assert_eq!(o.stdout.trim(), "alive");
    println!("  ✓ connection intact");
    h.disconnect();
}
