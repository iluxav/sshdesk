# sshdesk — spike

Proves the architecture: **a local GUI that drives real Linux boxes over plain SSH,
with nothing installed on the remote.**

```
                        ┌─ SFTP subsystem ────────▶ files      (typed)
ui (webview) ──IPC──▶   ├─ forwarded D-Bus socket ▶ systemd    (typed, + signals)
             Rust core  ├─ /proc via one command ─▶ processes  (kernel ABI)
                        └─ persistent bash shell ─▶ anything   (escape hatch)

                        all four multiplex over ONE ssh ControlMaster
```

## Run

```sh
make run     # rebuild (UI + Rust) and launch
make help    # all targets
```

**Tauri embeds `ui/index.html` into the binary at build time.** Editing the HTML has
no effect until you rebuild — always use `make run`, never just relaunch the binary.

Enter `user@host`, hit Connect. Sudo password is only needed for actions that change state.

## The three decisions that matter

**Use the protocol where one exists.** A Linux GUI does not shell out — it calls
D-Bus, and `systemctl` is itself just a D-Bus client. So files go over the SFTP
subsystem and system state over the remote system bus, reached by forwarding
`/run/dbus/system_bus_socket` with `-O forward` on the connection we already
hold. Both are typed in and out, both need nothing installed on the remote, and
neither spawns a process there — which is where the latency was.

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

Against a real Ubuntu Pi (systemd 257, OpenSSH 10.0p2), via `core/src/bin/probe.rs`:

- SFTP subsystem opens over the existing ControlMaster; 11 extensions detected,
  including `copy-data`, `posix-rename` and `statvfs`
- write → read round trip is **byte-identical even when the content contains an
  old frame marker** (`__SD_OUT_1__`), which used to desync the shell parser
- `café-tèst.txt` lists correctly — non-ASCII names no longer break anything
- server-side copy verified **by content**, not exit code
- typed attrs: size, kind, mode string, owner name
- `statvfs`: 88.5 GB free of 125.3 GB, as numbers
- D-Bus: 193 services in 34 ms, `Version = 257.9-0ubuntu2.5`, `Architecture = arm64`
- signal subscription accepted; a live signal was received during the run
- privileged write **correctly refused by polkit** — the documented boundary
- 167 processes from `/proc`, every one resolved to a user name via `/etc/passwd`
- ownership filter intact: 11 listening ports, 2 mine
- D-Bus 4.5 ms vs shell-plus-spawn 9.2 ms on the same box

```sh
./core/target/release/sshdesk-probe iluxa@10.168.168.226
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
  channel costs zero round trips.
- One host at a time in the UI; the backend already keys by target and holds many.
- UI is a spike, not a design. The desktop shell is yours to build.
