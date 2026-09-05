# ssh-loopback

Two experiments in making an SSH connection aware of what is happening inside
it. **sshdesk** is a desktop for machines you reach over SSH; **sshloop** is the
one-file POC the idea started from.

## Install sshdesk

```sh
curl -fsSL https://raw.githubusercontent.com/iluxav/sshdesk/main/install.sh | sh
```

macOS, Apple Silicon or Intel. The installer checks the published SHA256 before
writing anything, and puts `sshdesk.app` in `/Applications`.

`curl` rather than a download link on purpose: the app is not notarised by
Apple, and macOS quarantines anything a *browser* fetches — a downloaded
archive would be refused by Gatekeeper. Nothing curl fetches is quarantined, so
installed this way it simply opens. Removing it is `rm -rf
/Applications/sshdesk.app`; nothing else is written outside `~/.sshdesk`.

Builds are produced by `.github/workflows/release.yml` on a `v*` tag, one per
architecture, since there is no cross-compilation for this.

---

# sshloop

Auto-forward remote listening ports over an already-open SSH connection.
You start a dev server on a remote box; a clickable `localhost:` link appears. You typed nothing.

This is the **deliberately dumb POC** — the two-week experiment, not the product.
No shell integration, no tmux, no PTY wrapper. Out-of-band only.

## Use

```sh
./sshloop watch iluxa@10.168.168.153   # run in a spare pane, leave it
./sshloop ports                        # what's forwarded right now
./sshloop stats                        # the number the experiment is for
./sshloop stop iluxa@10.168.168.153
```

## How it works

1. Opens one `ControlMaster` connection and keeps it alive.
2. Snapshots every port already listening — **baseline, never forwarded**.
3. Every 2s, lists remote listeners and diffs against the baseline.
4. New port → `ssh -O forward -L ...` on the *live* connection, no reconnect.
5. Port disappears → `ssh -O cancel`.

Nothing is installed on the remote. It only needs `ss`, which ships with every modern Linux.

## The two design decisions that matter

**Ownership filtering is free.** Non-root `ss -ltnp` only fills in the `users:(...)`
field for processes *you* own. So `grep users:` *is* the ownership check — other tenants'
and root's ports are invisible and can never be silently tunnelled to your laptop.
No denylist, no heuristics.

**Local ports are deterministic.** Preferred port first; if taken, a stable hash of
`host:remote_port` into 20000–29999. So `localhost:28275` is *always* `gpu-box:3001`
and your browser tab survives a reconnect. VS Code reshuffles and loses the tab.

## The experiment

The open question is not whether this works — it does. It's whether the pain it removes
is above the adoption threshold. So it logs, to `~/.sshloop/events.jsonl`:

- every forward opened and closed
- **gap to first use** — seconds between a port opening and anything connecting through it

`./sshloop stats` reports the median gap and lists forwards that were never used at all.

- Median gap of minutes → automation is decoration. Stop here, you saved a quarter.
- Median gap of seconds, every time → the shell-integration build is earned.
- Bimodal gap → the away-from-keyboard (agent) case is real.

Use it for two weeks **outside VS Code**, or it tests nothing — VS Code Remote already
does this, so running inside it means measuring a problem you don't have.

## Verified against real hosts

Both Ubuntu boxes, bash and zsh login shells:

- new port detected and forwarded without a reconnect (verified by content, not status code)
- remote port closes → forward cancelled → local port genuinely dead
- local collision → remapped to deterministic port, reason printed
- pre-existing ports (Next.js on :3000, postgres, ollama, sshd) correctly ignored
- other users' / root's ports never visible

## Known limits (all deliberate)

- **2s timer polling.** The right fix is OSC 133 command-*start* plus a burst-then-decay
  poll. Not command-*end* — `npm run dev` never ends, which is the whole use case.
  Deferred: needs shell integration.
- **Notifications are out-of-band** (macOS notification + this pane). Nothing is injected
  into your interactive shell, because the daemon doesn't own that tty. That's the hard
  architectural problem this POC exists to avoid committing to.
- macOS only (`osascript`, `netstat` flags).
- `first_use` detection reads `netstat`, not `lsof` — `TIME_WAIT` sockets are orphaned
  and invisible to `lsof`, and `TIME_WAIT` is exactly what proves a short request happened.
- IPv6-only listeners may not forward; target is resolved as `localhost` on the remote.
- Reverse forwards (`-O forward -R`) are the same primitive and not implemented yet.

## Clipboard (`sshloop clip`)

```sh
./sshloop clip iluxa@10.168.168.226
```

Then paste the two functions it prints into your remote shell:

```sh
cat build.log | rcopy      # remote -> your Mac clipboard
rpaste > local.txt         # your Mac clipboard -> remote
```

### Why not OSC 52

OSC 52 is the usual answer and it's the worse one. It only reliably does *copy*;
the read direction is unsupported almost everywhere (it's an obvious exfiltration
vector, so terminals disable it). It caps payloads at tens of KB. It needs the
terminal to cooperate, and needs a real tty in the path.

Instead this points a tunnel *backwards* — `ssh -O forward -R` on the same live
connection — at a small clipboard server on the Mac. Same primitive as the port
forwarding, opposite direction.

**Verified:** both directions against the Pi, and a 1 MB payload round-tripped with
matching md5. No terminal support needed, works under tmux, works with no tty at all.

### The catch

While the bridge is up, **any user on the remote box can read and write your Mac
clipboard.** It's loopback-bound on the remote, so nothing off-machine can reach it,
but that's still every account on that host. Fine on your own Pi, think hard on a
shared box. A per-session token would fix it and isn't implemented yet.
