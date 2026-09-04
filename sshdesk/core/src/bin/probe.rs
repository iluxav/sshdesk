//! Verification harness for the SSH core: proves the persistent shell works,
//! measures real latency, and exercises the domain queries.

use sshdesk_core::*;
use std::env;

fn main() {
    let target = env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: SSHDESK_PW=... sshdesk-probe <user@host>");
        std::process::exit(2);
    });
    // Never take a secret on argv - other local users can read it via `ps`.
    let password = env::var("SSHDESK_PW").ok();

    println!("connecting to {target} ...");
    let t0 = std::time::Instant::now();
    let mut h = match Host::connect(&target) {
        Ok(h) => h,
        Err(e) => { eprintln!("connect failed: {e}"); std::process::exit(1); }
    };
    println!("  connected in {:?}\n", t0.elapsed());

    // --- latency floor ---
    println!("=== round-trip latency (persistent shell) ===");
    let mut samples: Vec<u128> = Vec::new();
    for _ in 0..10 {
        let o = h.run("true").expect("noop failed");
        samples.push(o.elapsed.as_micros());
    }
    samples.sort();
    println!("  noop   median {:.1} ms   min {:.1} ms",
             samples[5] as f64 / 1000.0, samples[0] as f64 / 1000.0);

    // --- correctness: exit codes and stderr must be separated ---
    println!("\n=== stream separation ===");
    let o = h.run("echo to-stdout; echo to-stderr >&2; exit 7").unwrap();
    println!("  stdout : {:?}", o.stdout.trim());
    println!("  stderr : {:?}", o.stderr.trim());
    println!("  code   : {}", o.code);
    assert_eq!(o.stdout.trim(), "to-stdout", "stdout leaked");
    assert_eq!(o.stderr.trim(), "to-stderr", "stderr leaked");
    assert_eq!(o.code, 7, "exit code lost");
    println!("  OK - stdout/stderr/exit-code all separated");

    // --- domain queries ---
    println!("\n=== domain queries ===");
    let t = std::time::Instant::now();
    let svcs = list_services(&mut h).expect("services");
    println!("  services  {:>4} units    {:?}", svcs.len(), t.elapsed());

    let t = std::time::Instant::now();
    let procs = list_processes(&mut h).expect("processes");
    println!("  processes {:>4} procs    {:?}", procs.len(), t.elapsed());

    let t = std::time::Instant::now();
    let ports = list_ports(&mut h).expect("ports");
    println!("  ports     {:>4} listen   {:?}", ports.len(), t.elapsed());

    println!("\n  running services (first 6):");
    for s in svcs.iter().filter(|s| s.sub == "running").take(6) {
        println!("    {:<32} {:<10} {}", s.unit, s.active, s.description);
    }
    println!("\n  your ports (ownership filter):");
    for p in ports.iter().filter(|p| p.mine) {
        println!("    {:<6} {:<16} {}", p.port, p.bind, p.process);
    }
    println!("  ({} ports belong to root/others and are correctly not actionable)",
             ports.iter().filter(|p| !p.mine).count());

    // --- privileged action ---
    if let Some(pw) = password {
        println!("\n=== privileged action (sudo -S) ===");
        let o = h.sudo("systemctl is-active ssh.service", &pw).unwrap();
        println!("  sudo probe -> {:?} (code {})", o.stdout.trim(), o.code);
        if o.code == 0 || !o.stdout.trim().is_empty() {
            println!("  OK - sudo works over the persistent shell");
        } else {
            println!("  FAILED - stderr: {}", o.stderr);
        }
    } else {
        println!("\n(skipping sudo test - set SSHDESK_PW to test privileged actions)");
    }

    // --- filesystem ---
    println!("\n=== file browser ===");
    let home = resolve_path(&mut h, "~").expect("resolve home");
    println!("  home resolves to {home}");

    // Create deliberately awkward names, then verify they survive parsing.
    let setup = "mkdir -p /tmp/sdtest && cd /tmp/sdtest && \
        rm -rf ./* 2>/dev/null; \
        touch 'plain.txt' 'with space.txt' \"has'quote.txt\" 'unicode-\u{00e9}\u{00e5}.txt' && \
        mkdir -p 'a dir' && echo hello-from-pi > plain.txt && \
        dd if=/dev/zero of=big.bin bs=1k count=64 2>/dev/null; echo done";
    h.run(setup).expect("setup");

    let t = std::time::Instant::now();
    let entries = list_dir(&mut h, "/tmp/sdtest").expect("list_dir");
    println!("  listed {} entries in {:?}", entries.len(), t.elapsed());
    for e in &entries {
        println!("    {:<4} {:>7}  {:<10} {}", e.kind, e.size, e.mode, e.name);
    }

    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    for expect in ["plain.txt", "with space.txt", "has'quote.txt", "unicode-\u{00e9}\u{00e5}.txt", "a dir", "big.bin"] {
        assert!(names.contains(&expect), "MISSING entry: {expect}");
    }
    assert_eq!(entries[0].kind, "dir", "directories should sort first");
    println!("  OK - spaces, quotes and unicode all survived parsing");

    let r = read_file(&mut h, "/tmp/sdtest/plain.txt", 4096).expect("read");
    let (body, trunc) = (r.text.clone(), r.truncated);
    println!("  read plain.txt -> {:?} (truncated: {trunc})", body.trim());
    assert_eq!(body.trim(), "hello-from-pi");

    let trunc = read_file(&mut h, "/tmp/sdtest/big.bin", 1024).expect("read big").truncated;
    assert!(trunc, "64k file should report truncated at 1k cap");
    println!("  OK - large file correctly truncated at cap");

    // A path that needs quoting all the way through.
    let sub = list_dir(&mut h, "/tmp/sdtest/a dir").expect("list dir with space");
    println!("  OK - entered 'a dir' (contains {} entries)", sub.len());

    // --- writes ---
    println!("\n=== filesystem writes ===");
    mkdir(&mut h, "/tmp/sdtest/new dir/nested").expect("mkdir");
    println!("  mkdir with space + nested: ok");

    // Content designed to break naive quoting / heredocs.
    let nasty = "line1\n'single' \"double\" $VAR `cmd` \\backslash\nEOF\n$(whoami)\n";
    write_file(&mut h, "/tmp/sdtest/nasty.txt", nasty).expect("write_file");
    let back = read_file(&mut h, "/tmp/sdtest/nasty.txt", 4096).expect("read back").text;
    assert_eq!(back, nasty, "content mangled in transit");
    println!("  wrote+read shell-hostile content byte-identical: ok");

    rename(&mut h, "/tmp/sdtest/nasty.txt", "/tmp/sdtest/re named.txt").expect("rename");
    copy(&mut h, "/tmp/sdtest/re named.txt", "/tmp/sdtest/copy'd.txt").expect("copy");
    let e = list_dir(&mut h, "/tmp/sdtest").expect("relist");
    let names: Vec<&str> = e.iter().map(|x| x.name.as_str()).collect();
    assert!(names.contains(&"re named.txt"), "rename lost the file");
    assert!(names.contains(&"copy'd.txt"), "copy lost the file");
    println!("  rename + copy across awkward names: ok");

    // Permission failure must surface as an error, not silently succeed.
    match write_file(&mut h, "/etc/sshdesk-should-fail", "x") {
        Err(Error::Remote { code, stderr }) => {
            println!("  denied write to /etc surfaced correctly: code {code}, {:?}",
                     stderr.chars().take(50).collect::<String>());
        }
        Err(e) => println!("  denied write errored ({e})"),
        Ok(()) => panic!("SECURITY: write to /etc unexpectedly succeeded"),
    }

    remove(&mut h, "/tmp/sdtest/copy'd.txt", false).expect("remove");
    println!("  remove: ok");

    // --- binary detection ---
    println!("\n=== binary detection ===");
    h.run("head -c 4096 /dev/urandom > /tmp/sdtest/random.bin").expect("make binary");
    let bin = read_file(&mut h, "/tmp/sdtest/random.bin", 65536).expect("read bin");
    println!("  random.bin  -> binary={} size={}", bin.binary, bin.size);
    assert!(bin.binary, "random bytes should be detected as binary");

    let txt = read_file(&mut h, "/etc/hostname", 65536).expect("read hostname");
    println!("  /etc/hostname -> binary={} size={} text={:?}",
             txt.binary, txt.size, txt.text.trim());
    assert!(!txt.binary, "a text file must not be flagged binary");

    // UTF-8 multibyte must survive the base64 round trip
    h.run("printf 'héllo → wörld ✓\\n' > /tmp/sdtest/utf8.txt").expect("utf8");
    let u = read_file(&mut h, "/tmp/sdtest/utf8.txt", 4096).expect("read utf8");
    println!("  utf8.txt    -> {:?}", u.text.trim());
    assert_eq!(u.text.trim(), "héllo → wörld ✓");
    println!("  OK - binary vs text classified correctly, utf-8 preserved");

    h.run("rm -rf /tmp/sdtest").ok();

    h.disconnect();
    println!("\ndisconnected.");
}
