# Settings and configuration

A native-feeling Settings app, config that lives with the machine it describes,
and one place to change an icon or a colour so everything follows.

## Four decisions

**Config is one file on the machine you are sitting at.**

```
defaults   every app's declared tokens (in code)
config     ~/.sshdesk/config.toml
```

> **Reversed after first use.** This was originally layered, with per-host
> overrides read and written over SFTP, scoped so a host could only restyle its
> own windows. It survived about a day.
>
> The failure was not in the idea but in what it did to the user. The dock,
> menu bar and Settings sidebar all resolve *without* a host, so an icon saved
> at host scope was written successfully, reported "saved", and then changed
> nothing anybody could see. Worse, the scope toggle made that the easy mistake
> to make: the setting went to a Pi and stayed invisible.
>
> A layer whose effects are invisible from most of the UI is not a feature with
> a bug in it. One file, no scope to choose.

**Remote config may name an icon, never supply one.** Packs live on the Mac.
A host says `lucide:folder`; it cannot hand SVG to the webview. SVG is an
active document and this is the trust boundary.

**Apps declare their tokens.** A manifest lists each token with a type, a
default and a label. Settings enumerates registered apps and generates its UI,
so an app shipped years later is editable with no change to Settings. Same
lesson D-Bus introspection taught: self-describing beats hardcoded.

**Tokens all the way down, no raw CSS.** Depth comes from app-scoped tokens,
not from a CSS escape hatch. Every value is parsed before it reaches the
stylesheet, so `url()` has no route in even from a host.

## Token resolution

Namespace is the registered app id, so there is one mechanical rule and no
separate name registry. For `files.directory.icon`, first hit wins:

```
1. host layer    icons."files.directory"
2. local layer   icons."files.directory"
3. declared default in the manifest
```

Inheritance is an explicit reference, never an implicit walk up a hierarchy:

```js
tokens: { 'file.icon': { type: 'icon', default: '@files.file.icon' } }
```

The rejected alternative — unset keys silently falling back to a global — reads
as convenient and behaves as spooky action: change one app's icon, watch three
others move for reasons nothing in the config explains. `@` is greppable, and
Settings can render it as "inherits from Files → File".

References resolve with a visited set. A cycle yields the declared default and
one warning, not a hung render. Unknown token, unknown pack, malformed value:
all resolve to the default. Config is advisory and can never leave a hole.

## Icons

A pack is a directory of SVGs; the id is `pack:name`.

```
~/.sshdesk/icons/lucide/folder.svg  →  "lucide:folder"
```

A default pack is compiled into the binary, so a fresh install renders with
nothing on disk. Packs on disk shadow it by name, which replaces one icon
without forking a set.

Rust sanitises every SVG on load — strip `<script>`, `on*` attributes, and any
reference pointing off-machine. These are local files, but a pack is something
people download. Sanitised symbols are injected once into a hidden sprite and
rendered with `<use>`; fill is `currentColor`, so icons take the theme without
the pack knowing anything about it.

**Emoji remain valid.** A value that is not `pack:name` renders as a glyph.
This matters: emoji are hardcoded across `FileExplorer.tsx`, `registry.ts`,
`Dock.tsx` and every plugin manifest, and each can become a token when
convenient rather than in one sweeping commit that misses some.

## Theme

Values become CSS variables in one generated `<style>` element:

```css
:root              { --color-desk-accent: #f87171; }
.app-files         { --files-row-hover: #ffffff14; }
[data-host="prod"] { --color-desk-accent: #ef4444; }
```

Windows carry `data-host` and their app class, so host overrides land only on
that host's windows — section 1's scoping expressed in CSS rather than in
JavaScript. No re-render; the browser recalculates style.

## Settings

A core app, not a plugin, because it writes config.

It reads the same declarations everything else does and generates its UI:
enumerate apps, group by app, render an editor per token type. Nothing about
any particular plugin appears in its source.

Each row still says whether its value is `set` or `default`, and shows `↳ token`
when it arrived through an `@` reference. With one file that is a smaller claim
than it was, but it is still the difference between "my change did nothing" and
"my change is not where I thought".

Apps are listed by their display name, not their id — a plugin whose id is
`systemctl` calls itself "Services" everywhere else, and Settings disagreeing
made it look like a different app.

A write applies to the in-memory config immediately and re-reads only to
confirm. The re-read used to come first with its failure swallowed, which let
the UI say "saved" beside a stale value.

Raw TOML stays first-class: a button opens the file in the existing Editor,
which already speaks SFTP.

## Format and writes

TOML, not JSON. People edit this over SSH in vim and comments matter. That
costs the `toml` crate, which is a different trade from hand-rolling base64.

Writes go through a Rust command, never the frontend directly, so validation
happens once on the way in for both the UI and a hand-edited file.

Settings that were written to a host before this reversal are migrated into the
local file on sight; the leftover `~/.config/sshdesk/` on a remote is inert.

Reload is explicit: Settings writes, re-reads, re-applies. No file watching —
`inotify` has no bus API, and a polling loop is poor value for something that
changes a few times a year.
