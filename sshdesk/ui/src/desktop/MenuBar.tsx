import { useEffect, useState } from 'react'
import { fw } from '../fw'
import { useContextMenu } from '../wm/ContextMenu'

/**
 * macOS-style menu bar.
 *
 * The clock shows the *server's* local time, not yours. It syncs once on
 * connect (and every few minutes after), then ticks from the local clock using
 * the measured skew — a round trip per second would be absurd on a 200 ms link.
 */
export function MenuBar({ hosts, active, onSwitch, onAdd, onDisconnect, onReloadPlugins }: {
  hosts: string[]
  active: string
  onSwitch: (target: string) => void
  onAdd: () => void
  onDisconnect: (target: string) => void
  onReloadPlugins?: () => Promise<string[]>
}) {
  const target = active
  const menu = useContextMenu()
  const [skew, setSkew] = useState<{ deltaMs: number; offsetMin: number; zone: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const host = target.includes('@') ? target.split('@')[1] : target

  /**
   * The machine's own name, not the address you typed to reach it.
   *
   * From hostname1 on the bus rather than `uname -n`: typed, and it costs no
   * process on the remote. Resolved once per host and remembered, because a
   * hostname does not change while you are looking at it.
   */
  const [names, setNames] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    for (const h of hosts) {
      if (names[h] !== undefined) continue
      fw.for(h).dbus
        .get('org.freedesktop.hostname1', '/org/freedesktop/hostname1',
             'org.freedesktop.hostname1', 'Hostname')
        .then(v => { if (live && typeof v === 'string' && v) setNames(n => ({ ...n, [h]: v })) })
        .catch(() => { if (live) setNames(n => ({ ...n, [h]: '' })) })
    }
    return () => { live = false }
  }, [hosts, names])

  // ⌘R reloads plugins rather than the webview — a full reload would drop the
  // SSH session and every open window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault()
        void onReloadPlugins?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onReloadPlugins])

  useEffect(() => {
    let alive = true
    const sync = async () => {
      try {
        const t = await fw.sys.clock()
        if (!alive) return
        setSkew({ deltaMs: t.epoch * 1000 - Date.now(), offsetMin: t.offset_minutes, zone: t.zone })
      } catch { /* leave the clock blank rather than showing a wrong time */ }
    }
    void sync()
    const resync = setInterval(sync, 5 * 60 * 1000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => { alive = false; clearInterval(resync); clearInterval(tick) }
  }, [target])

  let time = '', date = ''
  if (skew) {
    // Shift into the server's zone, then format in UTC so the browser's own
    // timezone cannot shift it back.
    const d = new Date(now + skew.deltaMs + skew.offsetMin * 60_000)
    time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
    date = d.toLocaleDateString(undefined,
      { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  }

  return (
    <div
      // The window is Overlay-styled, so the native traffic lights float over
      // this bar instead of occupying a row of their own. The left padding is
      // their space; dragging the bar moves the window, as a title bar would.
      data-tauri-drag-region
      className="absolute top-0 inset-x-0 h-8 z-[9998] flex items-center gap-3 pl-[78px] pr-3 text-xs
                 bg-white/[0.07] backdrop-blur-2xl backdrop-saturate-150
                 border-b border-white/10 shadow-[0_1px_0_rgba(255,255,255,0.05)_inset]"
    >
      <button
        onClick={ev => menu.open(ev, [
          ...hosts.map(h => ({
            label: h,
            icon: h === active ? '●' : '○',
            onSelect: () => onSwitch(h),
          })),
          { type: 'separator' as const },
          { label: 'Connect to another machine…', icon: '＋', onSelect: onAdd },
          { label: 'Reload plugins', icon: '⟳', shortcut: '⌘R',
            onSelect: () => { void onReloadPlugins?.() } },
          { type: 'separator' as const },
          { label: 'Minimize', icon: '▁', shortcut: '⌘M',
            onSelect: () => { void fw.win.minimize() } },
          { label: 'Zoom', icon: '▢', onSelect: () => { void fw.win.toggleMaximize() } },
          { type: 'separator' as const },
          { label: `Log out of ${host}`, icon: '⏻', onSelect: () => onDisconnect(active) },
          { label: 'Quit sshdesk', icon: '✕', danger: true,
            onSelect: () => { void fw.win.close() } },
        ])}
        className="font-semibold tracking-tight hover:bg-white/10 rounded px-1.5 py-0.5"
      >
        sshdesk
      </button>

      {hosts.map(h => {
        const [, addr] = h.includes('@') ? h.split('@') : ['', h]
        const on = h === active
        const name = names[h]
        // The machine menu. Switching is a click; everything that changes
        // state lives behind this so it cannot be hit by accident.
        const machineMenu = [
          ...(on ? [] : [{ label: 'Switch to this machine', icon: '→',
                           onSelect: () => onSwitch(h) }]),
          { label: 'Minimize', icon: '▁', shortcut: '⌘M',
            onSelect: () => { void fw.win.minimize() } },
          { label: 'Zoom', icon: '▢', onSelect: () => { void fw.win.toggleMaximize() } },
          { type: 'separator' as const },
          { label: `Log out of ${name || addr}`, icon: '⏻',
            onSelect: () => onDisconnect(h) },
          { label: 'Quit sshdesk', icon: '✕', danger: true,
            onSelect: () => { void fw.win.close() } },
        ]
        return (
          <button
            key={h}
            onClick={ev => (on ? menu.open(ev, machineMenu) : onSwitch(h))}
            onContextMenu={ev => menu.open(ev, machineMenu)}
            title={on ? `${h} — click for machine options` : `${h} — click to focus this pane`}
            className={`flex items-baseline gap-1.5 px-2 py-0.5 rounded transition
                        ${on ? 'bg-white/10' : 'hover:bg-white/[0.06] opacity-60'}`}
          >
            <span className={`self-center w-1.5 h-1.5 rounded-full ${
              on ? 'bg-desk-ok shadow-[0_0_6px] shadow-desk-ok/60' : 'bg-desk-dim'}`} />
            <span className="text-desk-fg/90">{name || addr}</span>
            {name && <span className="text-desk-dim text-[10px]">{addr}</span>}
          </button>
        )
      })}
      <button onClick={onAdd} title="Connect to another machine"
              className="px-1.5 py-0.5 rounded text-desk-dim hover:bg-white/10">＋</button>

      <span className="ml-auto flex items-center gap-3 text-desk-fg/80">
        {skew ? (
          <>
            <span className="text-desk-dim">{date}</span>
            <span className="tabular-nums font-medium">{time}</span>
            <span className="text-desk-dim text-[10px]">{skew.zone}</span>
          </>
        ) : (
          <span className="text-desk-dim">syncing clock…</span>
        )}
      </span>
    </div>
  )
}
