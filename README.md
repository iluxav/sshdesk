# sshdesk

A desktop for machines you reach over SSH. Files, services, packages,
processes, a terminal and VS Code on any Linux box you can log into — with
nothing installed on it.

## Install

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

## What it does

Connect with `user@host` and you get a desktop for that machine:

- **Files** over the SFTP subsystem — typed attributes, server-side copy, and
  drag to and from Finder
- **Services** over systemd's D-Bus API, with live updates pushed from the box
  rather than polled
- **Packages** through PackageKit, so search and install work the same on apt,
  dnf or zypper
- **Processes** read from `/proc`, and listening ports from `ss`
- **A terminal**, a code editor, an image viewer, and **VS Code** — installed
  on demand into `~/.sshdesk/opt`, needing no root

Nothing is installed on the remote to make the first five work. Every one of
them rides the single SSH connection you already opened.

## Why it is built this way

Linux desktops do not shell out; they call typed IPC. `systemctl` is itself a
D-Bus client and `ss` queries netlink, so parsing their output means asking a
CLI to render a typed API into text and turning it back into data — and that
text is the part that changes between distro releases.

So sshdesk uses the protocol wherever one exists, in three tiers:

1. **A real protocol** — files over SFTP, system state over the remote D-Bus,
   both reached through the connection already open
2. **No protocol, but a stable kernel ABI** — `/proc` rather than `ps` output
3. **The escape hatch** — a persistent shell, for everything with no schema

The result is that a service list costs 34 ms and spawns no process on the
remote, where the shell path cost around four times that and spent most of it
starting `systemctl`.

## Apps

Built-in apps and plugins are the same thing. A plugin is a directory with an
`index.js` that declares what it needs — the tokens it owns, the content types
it opens, the software it requires on the remote — and sshdesk resolves the
rest. VS Code is a plugin, and adding it needed no change to sshdesk itself.

See [`sshdesk/plugins/README.md`](sshdesk/plugins/README.md).

## Building

```sh
cd sshdesk
make run                                    # rebuild and launch
make probe HOST=user@box                    # verify against a real machine
cargo test --manifest-path core/Cargo.toml  # unit tests
```

`make probe` is the useful one: it asserts the whole stack against a live host
by content rather than exit code, and has caught every interesting bug in this
codebase.
