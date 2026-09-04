# sshdesk — spike

Proves the architecture: **a local GUI that drives real Linux boxes over plain SSH,
with nothing installed on the remote.**

```
ui (webview)  ──IPC──▶  Rust backend  ──spawns──▶  ssh  ──▶  remote
                        holds one persistent shell per host
```

## Run

```sh
make run     # rebuild (UI + Rust) and launch
make help    # all targets
```

**Tauri embeds `ui/index.html` into the binary at build time.** Editing the HTML has
no effect until you rebuild — always use `make run`, never just relaunch the binary.

Enter `user@host`, hit Connect. Sudo password is only needed for actions that change state.

## The two decisions that matter

**Shell out to the real `ssh` binary.** Not a Rust or JS SSH library. That inherits
ControlMaster multiplexing, `~/.ssh/config`, ssh-agent, `ProxyJump`, `known_hosts` and
host-key verification — and keeps every line of crypto out of this codebase. "SSH already
has the security; don't reinvent it" taken literally.

**One persistent shell per host, not a channel per command.** Commands are written to a
long-lived `bash --noprofile --norc` stdin and framed with generated delimiters.

## Measured against a Raspberry Pi on LAN (4.2 ms ping)

| Approach | Latency |
|---|---|
| Fresh SSH connection per command | 390–800 ms |
| Multiplexed channel per command | ~40 ms |
| **Persistent shell (this)** | **~19 ms** |
| No-op round trip | **4.9 ms** — equal to ping, the physical floor |

Of the 19 ms, ~4 ms is network and ~15 ms is the remote spawning `systemctl`/`ps`/`ss`.
**The remote process costs 4× the entire network path**, so transport-layer optimisation
(WASM, service workers) targets the wrong 1 ms. The wins are batching, streaming and
caching.

## What's verified

Against a real Ubuntu 25.10 Pi, via `core/src/bin/probe.rs`:

- persistent shell survives many commands, no leakage between them
- stdout, stderr and exit code separated correctly (asserted)
- 193 services parsed from `systemctl -o json` — structured, not screen-scraped
- 173 processes, 11 listening ports
- **sudo works over the persistent shell** using `sudo -S` (password on stdin)
- ownership filter: 2 ports mine, 9 root's and correctly not actionable

```sh
SSHDESK_PW=... ./core/target/release/sshdesk-probe iluxa@10.168.168.226
```

## Design notes

**`sudo -S`, never `--askpass`.** Ubuntu 25.10 ships sudo-rs, which does not implement
`--askpass` — that is exactly what breaks Cockpit's admin mode on a default install.
`-S` works on both classic sudo and sudo-rs.

**Machine-readable output only.** `systemctl -o json`, explicit `ps -o` fields. Parsing
human-formatted output is how these tools rot across distros.

**Ownership comes free.** Non-root `ss -ltnp` only fills the `users:(...)` field for your
own processes, so it *is* the permission check — no denylist, and other tenants' ports
can never be acted on.

**Unit names are never trusted back as shell input**, even though they came from the
remote. Actions are whitelisted.

## Not done

- Password is held in the UI and passed per action. Real version wants a cached sudo
  timestamp or an askpass helper.
- No streaming yet — refresh is manual. A remote watcher loop pushing changes down one
  channel costs zero round trips (see `../sshloop`).
- One host at a time in the UI; the backend already keys by target and holds many.
- UI is a spike, not a design. The desktop shell is yours to build.
