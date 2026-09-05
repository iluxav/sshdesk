import type { DirListing, FileRead, SavedConn, ServerTime, Snapshot } from './types'
export * from './types'

export interface PkgItem {
  id: string; name: string; version: string; arch: string
  repo: string; summary: string; installed: boolean
}
export type PkgList = PkgItem[]

/** A remote dependency an app declares in its manifest. */
export type Requirement =
  | { kind: 'command'; command: string; hint?: string }
  | { kind: 'package'; command: string; packages: Record<string, string> }
  | { kind: 'archive'; command: string; url: string; sha256: Record<string, string>
      into: string; bin: string; strip_components?: number }

export interface DepStatus {
  command: string; present: boolean; path: string
  kind: string; detail: string; installable: boolean
}
export interface PkgDetails {
  id: string; description: string; license: string; url: string; size: number; group: number
}
export * from './tokens'
export { loadIconPacks, iconPacks, hasIcon, searchIcons, iconCount, ensureSymbol } from './icons'
export { applyTheme } from './theme'

const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  (window as any).__TAURI__.core.invoke(cmd, args)

/** Current host every fs/sys call is issued against. */
let host = ''

/**
 * Ghost shown under the cursor while dragging to Finder. The drag plugin
 * requires an image; a data URL keeps it out of the asset pipeline.
 */
const DRAG_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAA7UlEQVR42u3bSwrCMBSF4btOVxKKc7cRyD5cQAfdgxsIpdC5qVRw4Mh6H9H/wBk3+VpuqlARQsiRnNJ18KzXpkvrGqzFavNTwM0/O/3jnbd7EjrY/KMAKE77tZMOAADw5dS6pF4AtrUCoATQxXuAGkDrHP1NcFujKsCOUILe+dkE4LXevwbfrckUIGgBAAAAAAAAAAAjgHS+3DwKAADMAAAAAAAATgEAAGAGAAAAAAD83ikAAADMAAAAAAAA/g/44FQAAABmAACigdAFgNr3AgDUJXcAkEUz7QJj4M2PYpGgT0IWj+yng1uFEHIkd8bhfiQ/lnwwAAAAAElFTkSuQmCC'

/** Typed filesystem totals from `statvfs@openssh.com`. */
export interface DiskInfo { total: number; free: number; avail: number }

export interface Clipboard { op: 'copy' | 'cut'; paths: string[]; host: string }
let clipboard: Clipboard | null = null
/** Sudo passwords, in memory only, never persisted. */
const sudoCache = new Map<string, string>()

const listeners: Record<string, Set<(payload: any) => void>> = {}
let opener: ((appId: string, props?: Record<string, unknown>) => void) | null = null

interface Dialogs {
  confirm(o: any): Promise<boolean>
  prompt(o: any): Promise<string | null>
  alert(o: any): Promise<void>
}
let dialogs: Dialogs | null = null
/**
 * Bridge backend push events onto the local bus, once per session.
 *
 * The Rust side emits Tauri events from a thread reading D-Bus signals; apps
 * should not have to know that. They just subscribe to a topic like any other.
 */
let bridged = false
async function bridgeBackendEvents() {
  if (bridged) return
  bridged = true
  const { listen } = await import('@tauri-apps/api/event')
  for (const topic of ['units:changed', 'units:stopped', 'units:watching']) {
    await listen(topic, (e: any) => {
      listeners[topic]?.forEach(fn => { try { fn(e.payload) } catch { /* isolate */ } })
    })
  }
}

export const setHost = (h: string) => { host = h }
export const getHost = () => host


/**
 * The framework surface available to every app.
 *
 * Access control is deliberately NOT enforced here. The remote machine decides
 * what the user may do; a denied operation comes back as a thrown error whose
 * message is the actual stderr from Linux. Apps show that message.
 *
 * What *is* enforced below the line: `fs` and `dbus` never touch a shell at
 * all — SFTP carries paths as byte strings and D-Bus carries typed arguments,
 * so a hostile filename has nothing to escape into. Only the `exec` escape
 * hatch builds a command line, and there every argument is quoted separately.
 */
function makeApi(getHost: () => string) {
  const t = () => ({ target: getHost() })
  return {
  host: {
    connect: (target: string, password?: string) =>
      invoke<string>('connect', { target, password }).then(r => { setHost(target); return r }),
    disconnect: () => invoke<void>('disconnect', t()),
    current: () => getHost(),
  },

  fs: {
    list:     (path: string) => invoke<DirListing>('list_directory', { ...t(), path }),
    read:     (path: string) => invoke<FileRead>('read_text', { ...t(), path }),
    /** Raw bytes for viewers. Text goes through `read`, which classifies. */
    readBinary: (path: string, maxBytes?: number) =>
      invoke<{ b64: string; size: number; truncated: boolean; mime: string }>(
        'read_binary', { ...t(), path, maxBytes }),
    write:    (path: string, content: string) => invoke<void>('write_text', { ...t(), path, content }),
    mkdir:    (path: string) => invoke<void>('make_dir', { ...t(), path }),
    rename:   (from: string, to: string) => invoke<void>('rename_path', { ...t(), from, to }),
    copy:     (from: string, to: string) => invoke<void>('copy_path', { ...t(), from, to }),
    remove:   (path: string, recursive = false) => invoke<void>('remove_path', { ...t(), path, recursive }),
    download: (path: string, name: string) => invoke<string>('download_file', { ...t(), path, name }),
    upload:   (local: string, remote: string) => invoke<string>('upload_file', { ...t(), local, remote }),
    /** Typed free-space numbers. Was a parsed `df -h` string. */
    disk:     (path: string) => invoke<DiskInfo>('disk_info', { ...t(), path }),
    /** Which SFTP extensions this server offers — feature-detect, don't assume. */
    caps:     () => invoke<string[]>('sftp_extensions', t()),

    /**
     * Download files into a local staging directory so the OS can drag them.
     *
     * Deliberately separate from `beginDrag`. macOS will only track a drag
     * while the mouse button is genuinely down, so an SFTP round trip cannot
     * sit inside the gesture — by the time it returned, the drag was over and
     * nothing happened. Stage first, drag second.
     */
    stage: (paths: string[]) => invoke<string[]>('stage_for_drag', { ...t(), paths }),

    /**
     * Hand already-staged local files to the OS as a native drag.
     *
     * Synchronous up to the invoke on purpose: no dynamic import, no await
     * before the call, because every deferred tick is a chance for the mouse
     * button to come up first. Channel comes off the global Tauri object,
     * which `withGlobalTauri` puts there.
     */
    beginDrag: (localPaths: string[]) => {
      const core = (window as any).__TAURI__?.core
      if (!core?.Channel) {
        // Would otherwise throw synchronously, before any .catch is attached,
        // and surface as an unhandled error instead of a message.
        return Promise.reject(new Error('drag unavailable: Tauri core.Channel missing'))
      }
      if (!localPaths.length) return Promise.reject(new Error('nothing staged to drag'))
      return core.invoke('plugin:drag|start_drag', {
        item: localPaths,
        image: DRAG_ICON,
        options: { mode: 'copy' },
        onEvent: new core.Channel(),
      }) as Promise<void>
    },

    /** Upload files dropped from Finder into a remote directory. */
    uploadFiles: (locals: string[], remoteDir: string) =>
      invoke<string>('upload_files', { ...t(), locals, remoteDir }),
  },

  /**
   * The remote system bus, reached by forwarding /run/dbus/system_bus_socket
   * over the connection we already hold. Typed, introspectable, and it spawns
   * no process on the remote — which is where the shell lane's latency went.
   *
   * `signature` describes argument types exactly as `busctl call` does.
   */
  dbus: {
    call: (dest: string, path: string, iface: string, member: string,
           signature?: string, args?: unknown[]) =>
      invoke<unknown[]>('dbus_call', {
        ...t(), dest, path, interface: iface, member, signature, args,
      }),
    get: (dest: string, path: string, iface: string, property: string) =>
      invoke<unknown>('dbus_get', { ...t(), dest, path, interface: iface, property }),
    /** Shorthand for the systemd manager, far and away the common case. */
    systemd: (member: string, signature?: string, args?: unknown[]) =>
      invoke<unknown[]>('dbus_call', {
        ...t(),
        dest: 'org.freedesktop.systemd1',
        path: '/org/freedesktop/systemd1',
        interface: 'org.freedesktop.systemd1.Manager',
        member, signature, args,
      }),
    systemdProperty: (prop: string) => invoke<unknown>('systemd_property', { ...t(), prop }),
  },

  /**
   * Local port forwards over the live connection. Adding one costs no
   * reconnect — `ssh -O forward` on the existing ControlMaster.
   */
  net: {
    forward:   (remotePort: number, localPort?: number) =>
      invoke<number>('forward_port', { target: getHost(), remotePort, localPort }),
    unforward: (remotePort: number) =>
      invoke<void>('cancel_forward', { target: getHost(), remotePort }),
    forwards:  () => invoke<Record<number, number>>('list_forwards', { target: getHost() }),
    /**
     * Expose a remote unix socket on a local TCP port. Preferable to a port
     * forward when the service can bind a socket: file permissions keep
     * everything else on the remote out, and there is no port to find.
     */
    forwardSocket: (remotePath: string, localPort?: number) =>
      invoke<number>('forward_socket', { target: getHost(), remotePath, localPort }),
    unforwardSocket: (remotePath: string) =>
      invoke<void>('cancel_forward_socket', { target: getHost(), remotePath }),
    openUrl:   (url: string) => invoke<void>('open_url', { url }),
  },

  /** Interactive PTY sessions. Streaming, unlike everything else here. */
  term: {
    open:   (id: string, target: string, cols: number, rows: number) =>
      invoke<void>('term_open', { id, target, cols, rows }),
    write:  (id: string, data: string) => invoke<void>('term_write', { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      invoke<void>('term_resize', { id, cols, rows }),
    close:  (id: string) => invoke<void>('term_close', { id }),
  },

  /**
   * Configuration: one file on this Mac. Defaults live in app declarations.
   */
  config: {
    load: () => invoke<{
      values: Record<string, string>
      machines: Record<string, Record<string, string>>
      warnings: string[]
    }>('config_load'),
    /**
     * Write one key. No value removes it; `machine` scopes it to one target
     * rather than everywhere. Both end up in the same file on this Mac.
     */
    set: (key: string, value?: string, machine?: string) =>
      invoke<void>('config_set', { key, value, machine }),
    /** Where the file lives, so it can be opened in the Editor. */
    path: () => invoke<string>('config_path'),
  },

  sys: {
    snapshot:      () => invoke<Snapshot>('snapshot', t()),
    serviceAction: (unit: string, action: string, password: string) =>
      invoke<string>('service_action', { ...t(), unit, action, password }),
    kill: (pid: number, password = '') => invoke<string>('kill_process', { ...t(), pid, password }),
    clock: () => invoke<ServerTime>('clock', t()),

    /**
     * The sudo password for this host, asked for once and held in memory only.
     *
     * Core apps need this the same way plugins do. It is never written
     * anywhere; closing sshdesk forgets it, and so does disconnecting.
     */
    sudoPassword: async (why?: string): Promise<string | null> => {
      const host = getHost()
      const cached = sudoCache.get(host)
      if (cached !== undefined) return cached
      const got = await (dialogs?.prompt({
        title: `Password for ${host.replace(/^.*@/, '')}`,
        label: why ?? 'Needed to change packages on this machine',
        password: true,
        okLabel: 'Continue',
      }) ?? Promise.resolve(null))
      if (got) sudoCache.set(host, got)
      return got
    },

    /** Forget it — after a wrong password, or on disconnect. */
    forgetPassword: () => { sudoCache.delete(getHost()) },

    /**
     * Ask the backend to push unit changes instead of being polled.
     *
     * Idempotent — one watcher per host no matter how many windows call it.
     * Subscribe with `fw.bus.on('units:changed', fn)`; the payload carries the
     * signal member (JobRemoved, UnitNew, ...) and its arguments.
     */
    watchUnits: async () => {
      await bridgeBackendEvents()
      return invoke<boolean>('watch_units', t())
    },
  },

  /**
   * System clipboard for file operations. Lives in the framework rather than in
   * one app so a future app can cut in Files and paste elsewhere. Holds paths
   * only — nothing is read or copied until paste.
   */
  clip: {
    set(op: 'copy' | 'cut', paths: string[], fromHost = getHost()) {
      clipboard = paths.length ? { op, paths, host: fromHost } : null
    },
    get: () => clipboard,
    clear() { clipboard = null },
    isEmpty: () => clipboard === null,
  },

  /**
   * Remembered connections. Stores host and user only — never the password.
   * Re-connecting always asks again, which is the point.
   */
  conns: {
    list(): SavedConn[] {
      return (fw.prefs.get<SavedConn[]>('connections', []))
        .slice().sort((a, b) => b.lastUsed - a.lastUsed)
    },
    remember(user: string, host: string, name?: string) {
      const all = fw.prefs.get<SavedConn[]>('connections', [])
      const prev = all.find(c => c.user === user && c.host === host)
      const rest = all.filter(c => !(c.user === user && c.host === host))
      // Keep the last known name if this connection did not learn one, so a
      // machine does not lose its name because hostname1 was slow once.
      rest.push({ user, host, lastUsed: Date.now(), name: name ?? prev?.name })
      fw.prefs.set('connections', rest)
    },
    forget(user: string, host: string) {
      fw.prefs.set('connections', fw.prefs.get<SavedConn[]>('connections', [])
        .filter(c => !(c.user === user && c.host === host)))
    },
  },

  /** Small persisted key/value store for app preferences (localStorage). */
  prefs: {
    get<T>(key: string, fallback: T): T {
      try { const v = localStorage.getItem('sshdesk:' + key); return v ? JSON.parse(v) as T : fallback }
      catch { return fallback }
    },
    set(key: string, value: unknown) {
      try { localStorage.setItem('sshdesk:' + key, JSON.stringify(value)) } catch { /* quota */ }
    },

    /**
     * The same store, scoped to one machine.
     *
     * Anything shaped like a path belongs here. A pinned folder, a last-opened
     * directory, a port mapping — none of them mean anything on a different
     * box, and sharing them across machines is not a convenience, it is a
     * wrong answer that looks like a right one.
     *
     * `seed` migrates a value that used to be global, so nobody loses what
     * they had the first time a preference becomes per-machine.
     */
    hostGet<T>(key: string, fallback: T, seed?: string): T {
      const scoped = `host:${getHost()}:${key}`
      const raw = localStorage.getItem('sshdesk:' + scoped)
      if (raw !== null) {
        try { return JSON.parse(raw) as T } catch { return fallback }
      }
      if (seed) {
        const old = localStorage.getItem('sshdesk:' + seed)
        if (old !== null) {
          try {
            const v = JSON.parse(old) as T
            localStorage.setItem('sshdesk:' + scoped, old)
            return v
          } catch { /* fall through */ }
        }
      }
      return fallback
    },
    hostSet(key: string, value: unknown) {
      try {
        localStorage.setItem(`sshdesk:host:${getHost()}:${key}`, JSON.stringify(value))
      } catch { /* quota */ }
    },
  },

  /**
   * Framework event bus. Windows are independent component instances, so a
   * mutation in one has to tell the others to re-read. Emitting 'fs:changed'
   * with the affected directories keeps multiple explorers coherent.
   */
  bus: {
    on(topic: string, fn: (payload: any) => void) {
      (listeners[topic] ??= new Set()).add(fn)
      return () => { listeners[topic]?.delete(fn) }   // must return void for useEffect
    },
    emit(topic: string, payload?: any) {
      listeners[topic]?.forEach(fn => { try { fn(payload) } catch { /* isolate */ } })
    },
  },

  /**
   * Window management for apps. The desktop installs the real implementation
   * at mount; fw stays framework-agnostic and holds only the hook.
   */
  /** Read a local image as a data URL, for the desktop picture. */
  wallpaper: (path: string) => invoke<string>('wallpaper_data', { path }),

  /** The sshdesk window itself. */
  win: {
    minimize: async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().minimize()
    },
    toggleMaximize: async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().toggleMaximize()
    },
    close: async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().close()
    },
  },

  ui: {
    open(appId: string, props?: Record<string, unknown>) { opener?.(appId, props) },
    _install(fn: (appId: string, props?: Record<string, unknown>) => void) { opener = fn },

    /**
     * Dialogs for plugins. window.confirm/prompt are no-ops in WKWebView —
     * they return without ever showing anything — so plugins must use these.
     */
    confirm: (o: { title: string; message?: string; okLabel?: string; danger?: boolean }) =>
      dialogs ? dialogs.confirm(o) : Promise.resolve(false),
    prompt: (o: { title: string; label?: string; value?: string; placeholder?: string
                  okLabel?: string; password?: boolean }) =>
      dialogs ? dialogs.prompt(o) : Promise.resolve(null),
    alert: (o: { title: string; message?: string }) =>
      dialogs ? dialogs.alert(o) : Promise.resolve(),
    _installDialogs(d: Dialogs) { dialogs = d },
  },

  /**
   * Packages, via PackageKit. Reads are typed and cross-distro; writes go
   * through `sudo pkcon`, because PackageKit gates installs behind polkit.
   */
  pkg: {
    backend:   () => invoke<string>('pkg_backend', t()),
    search:    (query: string) => invoke<PkgList>('pkg_search', { ...t(), query }),
    installed: () => invoke<PkgList>('pkg_installed', t()),
    updates:   () => invoke<PkgList>('pkg_updates', t()),
    details:   (id: string) => invoke<PkgDetails>('pkg_details', { ...t(), id }),
    install:   (name: string, password: string) =>
      invoke<string>('pkg_install', { ...t(), name, password }),
    remove:    (name: string, password: string) =>
      invoke<string>('pkg_remove', { ...t(), name, password }),
    refresh:   (password: string) => invoke<string>('pkg_refresh', { ...t(), password }),
  },

  /**
   * What an app needs on the remote. Declared in its manifest, resolved here.
   */
  deps: {
    probe: (requirements: Requirement[]) =>
      invoke<DepStatus[]>('deps_probe', { ...t(), requirements }),
    install: (requirement: Requirement, password?: string) =>
      invoke<string>('deps_install', { ...t(), requirement, password }),
    remove: (name: string) => invoke<string>('deps_remove', { ...t(), name }),
    installed: () => invoke<{ name: string; size: number }[]>('deps_installed', t()),
  },

  path: {
    join: (dir: string, name: string) => (dir === '/' ? '' : dir) + '/' + name,
    parent: (p: string) => p.replace(/\/[^/]+$/, '') || '/',
    base: (p: string) => p.split('/').filter(Boolean).pop() ?? '/',
  },

  fmt: {
    size: (b: number) =>
      b < 1024 ? `${b} B`
      : b < 1048576 ? `${(b / 1024).toFixed(1)} K`
      : b < 1073741824 ? `${(b / 1048576).toFixed(1)} M`
      : `${(b / 1073741824).toFixed(1)} G`,
    time: (s: number) =>
      s ? new Date(s * 1000).toLocaleString(undefined,
        { year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '',
    },
  }
}

/**
 * The ambient API, bound to the *active* host. Fine for one-shot actions
 * triggered by the focused window.
 */
/**
 * One API object per host, kept.
 *
 * Returning a fresh object each call is a trap: `const api = fw.for(host)` in a
 * component body then produces a new identity every render, so any useCallback
 * or useEffect depending on it re-runs forever. That is a render loop throttled
 * only by the speed of the SSH round trip — which reads as the whole desktop
 * going slow rather than as an obvious hang. Caching makes the obvious usage
 * correct, including in plugins, where nobody would think to memoise it.
 */
const perHostApi = new Map<string, ReturnType<typeof makeApi>>()

export const fw = Object.assign(makeApi(() => host), {
  /**
   * A copy of the API pinned to one host. Windows use this so a background
   * poll keeps talking to its own machine even when you focus another.
   */
  for: (target: string) => {
    let a = perHostApi.get(target)
    if (!a) { a = makeApi(() => target); perHostApi.set(target, a) }
    return a
  },
})

// Apps can reach it globally, as specified.
;(window as any).fw = fw
export type Fw = ReturnType<typeof makeApi>
