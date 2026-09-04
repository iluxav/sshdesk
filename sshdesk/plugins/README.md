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
  id: 'ports',                    // unique; also the app id
  name: 'Ports',                  // dock label and window title
  icon: '🔌',                     // emoji
  window: { w: 940, h: 520 },     // optional initial size
}

export function createAdapter(sdk) { ... }   // JSON -> CLI -> JSON. Optional.
export function createApp(ctx) { ... }       // returns a React component. Required.
```

Nothing else is loaded. A plugin that throws during load is skipped with a
console error; the rest of the desktop still boots.

---

## `createAdapter(sdk)` — the CLI boundary

Return an object of async functions. This is the only place that talks to the
remote machine, and the only place that parses command output.

```js
export function createAdapter(sdk) {
  return {
    async list() {
      const r = await sdk.exec(['ss', '-ltnpH'])
      if (r.code !== 0) throw new Error(r.stderr || 'ss failed')
      return parse(r.stdout)          // parsing is your code, not a DSL
    },
  }
}
```

### The sdk

| | |
|---|---|
| `sdk.exec(argv)` | Run on the connected host. Returns `{ stdout, stderr, code, elapsed_ms }` |
| `sdk.sudo(argv)` | Same, escalated. sshdesk prompts once per host per session and caches in memory only |
| `sdk.capability(name, probe)` | Run `probe(exec)` once per host and cache the boolean |
| `sdk.host()` | Current `user@host` |

**`argv` is an array, never a string.** Each element is shell-quoted
separately, so a value can never widen into extra arguments or a second
command. Validate anything that came from the machine before passing it back:

```js
const UNIT = /^[A-Za-z0-9@._:\\-]+$/
if (!UNIT.test(name)) throw new Error(`refusing suspicious unit: ${name}`)
```

### Three things worth doing

**Probe capabilities, don't assume.** The same command differs across distros.

```js
const hasJson = () => sdk.capability('systemctl-json', async exec => {
  const r = await exec(['systemctl', '--version'])
  return Number(/systemd (\d+)/.exec(r.stdout)?.[1]) >= 246
})
```

**Prefer machine-readable output** — `-o json`, explicit `--format`, `find
-printf`. Parsing human output is what rots across versions.

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

Plugins are **trusted code**, like VS Code extensions. A plugin runs in the same
context as the desktop and can call `fw` directly — the adapter is not a
sandbox. What `sdk.exec(argv)` guarantees is that *user input flowing through an
adapter* cannot become a command. Install plugins you trust.

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
