# sshdesk plugins

A plugin is a directory containing `index.js`. sshdesk scans the plugin root at
boot, evaluates each `index.js` as an ES module, and registers what it exports.
No recompilation of sshdesk is needed.

```
plugins/
  ports/
    index.js        # required — the module sshdesk loads
    style.css       # optional — injected at load
    src/index.jsx   # optional — source, if you use a build step
    package.json    # optional — only if you build
```

**Plugin root**, in order of preference:
1. `$SSHDESK_PLUGINS`
2. `<repo>/plugins` (used during development)
3. `~/.sshdesk/plugins`

Press **⌘R** (or *sshdesk → Reload plugins*) to re-read from disk without
restarting. Windows belonging to plugins are closed first, since their component
identity changes.

---

## The three exports

```js
export const manifest = {
  id: 'ports',                    // unique; also the app id and token namespace
  name: 'Ports',                  // dock label and window title
  icon: '🔌',                     // fallback glyph, before icon packs load
  window: { w: 940, h: 520 },     // optional initial size

  // What this plugin needs on the remote. Checked when a window opens; the
  // user is shown what would happen and asked before anything is installed.
  requires: [
    // probe only — a missing command is reported, never installed
    { kind: 'command', command: 'git', hint: 'install git to use this' },

    // a real package. Names differ per distro, and they have to be declared:
    // PackageKit's apt backend cannot map a *missing* file to a package.
    { kind: 'package', command: 'docker',
      packages: { apt: 'docker.io', dnf: 'docker', default: 'docker' } },

    // not in any repo. Lands in ~/.sshdesk/opt, so it needs no root at all
    // and `rm -rf` undoes it. The checksum is required, not optional.
    { kind: 'archive', command: 'openvscode-server',
      url: 'https://example.com/openvscode-server-${arch}.tar.gz',
      sha256: { aarch64: '…64 hex…', x86_64: '…64 hex…' },
      into: 'openvscode-server', bin: 'bin/openvscode-server' },
  ],

  // Tokens you own. Settings renders an editor for these with no code written
  // for your plugin, and users change them in one place for every app.
  tokens: {
    app:      { type: 'icon',  default: 'desk:network', label: 'App icon' },
    listening:{ type: 'icon',  default: 'desk:service', label: 'Listening port' },
    // '@' inherits from another token: retint the desktop and this follows.
    mine:     { type: 'color', default: '@desk.ok',     label: 'My port' },
  },
}

export function createAdapter(sdk) { ... }   // JSON -> CLI -> JSON. Optional.
export function createApp(ctx) { ... }       // returns a React component. Required.
```

Nothing else is loaded. A plugin that throws during load is skipped with a
console error; the rest of the desktop still boots.

---

## `createAdapter(sdk)` — the machine boundary

Return an object of async functions. This is the only place that talks to the
remote machine.

### Three tiers, and you should always take the highest one available

Linux desktops do not shell out. They call typed IPC — D-Bus for system
services, the kernel's own interfaces for state. `systemctl` is *itself* a
D-Bus client; `ss` queries netlink. Parsing their output means asking a CLI to
render a typed API into text so you can turn it back into data, and that text
is the part that changes between distro releases.

So the sdk gives you three tiers. The tier tells you what reliability you get.

**Tier 1 — a real protocol exists. No parsing, ever.**

| | |
|---|---|
| `sdk.fs.list(path)` | Directory entries with typed attrs — size, mtime, mode, user, group |
| `sdk.fs.read / write / mkdir / rename / copy / remove` | SFTP. `copy` is server-side where the host supports it |
| `sdk.fs.disk(path)` | `{ total, free, avail }` as numbers |
| `sdk.fs.caps()` | Which SFTP extensions this server offers |
| `sdk.dbus.systemd(member, sig?, args?)` | Call the systemd manager |
| `sdk.dbus.call(dest, path, iface, member, sig?, args?)` | Any bus service |
| `sdk.dbus.get(dest, path, iface, prop)` | One property, typed |

```js
// every unit on the box, typed, no parser, no process spawned on the remote
const [units] = await sdk.dbus.systemd('ListUnits')
const failed = units.filter(u => u[3] === 'failed')
```

`signature` describes argument types exactly as `busctl call` does — `'ss'` is
two strings — because JSON cannot tell a byte from a uint32.

**Tier 2 — no protocol, but a stable kernel ABI.** Process listing and
listening ports have no bus service. `snapshot()` reads `/proc` and `ss` for
you; both are far steadier than `ps` output formatting.

**Tier 3 — the escape hatch.** For docker, nginx, your own daemons: anything
without a schema.

| | |
|---|---|
| `sdk.exec(argv)` | Run on the connected host. Returns `{ stdout, stderr, code, elapsed_ms }` |
| `sdk.sudo(argv)` | Same, escalated. Prompts once per host per session, cached in memory only |
| `sdk.capability(name, probe)` | Run `probe(exec)` once per host and cache the boolean |
| `sdk.host()` | Current `user@host` |

**`argv` is an array, never a string.** Each element is shell-quoted
separately, so a value can never widen into extra arguments or a second
command. Validate anything that came from the machine before passing it back:

```js
const UNIT = /^[A-Za-z0-9@._:-]+$/
if (!UNIT.test(name)) throw new Error(`refusing suspicious unit: ${name}`)
```

### Tokens: icons and colours

Read a token with `sdk.token(id)`; draw an icon with the platform's `Icon`.
The namespace is your plugin's id, so `ports.listening` is yours and
`files.directory` is the file manager's.

```js
// your own token
html`<${ctx.Icon} token="ports.listening" />`

// deliberately the same icon Files uses, so the two stay consistent
html`<${ctx.Icon} token="files.file" />`
```

Config lives in two layers — the user's Mac and, scoped to its own windows,
each host:

```toml
[icons]
"ports.listening" = "desk:network"

[theme]
"ports.mine" = "#4ade80"
```

An icon value is either `pack:name` or a plain glyph, so `"🔌"` stays valid and
you can adopt tokens one at a time rather than converting everything at once.

Colour tokens become CSS variables scoped to your windows — `ports.mine` is
`var(--ports-mine)` inside `.app-ports` — so plain CSS in your `style.css`
picks them up.

### If you are on tier 3, three things worth doing

**Probe capabilities, don't assume.** The same command differs across distros.
(On tier 1 you don't need this — D-Bus is introspectable and `sdk.fs.caps()`
tells you what the file server supports.)

**Prefer machine-readable output** — `-o json`, explicit `--format`. Parsing
human output is what rots across versions.

**A non-zero exit is not always an error.** `systemctl is-active` returns 3 for
"inactive". Map the code; don't throw.

---

## `createApp(ctx)` — the UI

Return a React component. `ctx` provides:

| | |
|---|---|
| `React` | The platform's React — **do not import your own**, hooks would break |
| `html` | `htm` tagged template, for JSX-like markup with no build step |
| `api` | Whatever `createAdapter` returned |
| `fw` | The platform API (see below) |

Your component receives `{ setTitle }` to set its window title.

### Two ways to write markup

**No build step** — use `html`:

```js
export function createApp({ React, html, api }) {
  return function App() {
    return html`<div class="my-root">hello</div>`
  }
}
```

**With a build step** — real JSX. Build with the *classic* transform so `<div/>`
compiles to `React.createElement`, which resolves to the injected `React`:

```json
{ "scripts": {
  "build": "esbuild src/index.jsx --bundle --format=esm --jsx=transform --outfile=index.js"
} }
```

Never `import React from 'react'` — the classic transform picks up the `React`
you destructured from `ctx`, and the plugin ships no React of its own.

### Styling: use `style.css`, not Tailwind

Tailwind generates classes by scanning source **at build time**, so a plugin
installed later can never rely on it. Ship a `style.css` and write plain CSS
against the desktop's tokens:

```css
.my-root { background: var(--color-desk-panel); color: var(--color-desk-fg); }
.my-row:hover { background: rgb(255 255 255 / .05); }
```

Available tokens: `--color-desk-bg`, `--color-desk-panel`, `--color-desk-line`,
`--color-desk-fg`, `--color-desk-dim`, `--color-desk-accent`,
`--color-desk-ok`, `--color-desk-bad`.

### Useful bits of `fw`

```js
fw.fs.list(path) / read / write / mkdir / rename / copy / remove / download / upload
fw.net.forward(remotePort, preferredLocal?) / unforward / forwards / openUrl
fw.prefs.get(key, fallback) / set(key, value)      // localStorage, persisted
fw.bus.on(topic, fn) / emit(topic, payload)        // cross-window sync
fw.host.current()
fw.path.join / parent / base      fw.fmt.size / time
```

Emit `fs:changed` with `{ dirs: [...] }` after mutating the filesystem so open
Files windows refresh themselves.

---

## Security model

Plugins are **trusted code** today, like VS Code extensions. A plugin runs in
the same context as the desktop and can call `fw` directly — the adapter is not
a sandbox. Install plugins you trust.

What the tiers change is that this is now *fixable*. When every plugin's only
primitive was `exec(argv)`, a manifest could not say anything meaningful — full
shell or nothing. With typed lanes a manifest can be scoped:

```json
{ "permissions": {
    "dbus": ["org.freedesktop.systemd1"],
    "fs":   ["/etc/systemd/system"],
    "exec": false } }
```

That enforcement is not built yet, and it has to live in Rust rather than JS to
mean anything. But tier 1 is the precondition for it.

---

## A minimal plugin

`~/.sshdesk/plugins/uptime/index.js`:

```js
export const manifest = { id: 'uptime', name: 'Uptime', icon: '⏱' }

export function createAdapter(sdk) {
  return {
    async read() {
      const r = await sdk.exec(['uptime', '-p'])
      if (r.code !== 0) throw new Error(r.stderr)
      return r.stdout.trim()
    },
  }
}

export function createApp({ React, html, api }) {
  return function Uptime() {
    const [text, setText] = React.useState('…')
    React.useEffect(() => { api.read().then(setText).catch(e => setText(String(e))) }, [])
    return html`<div style="padding:16px">${text}</div>`
  }
}
```

Drop it in, press ⌘R, and it is in the dock.
