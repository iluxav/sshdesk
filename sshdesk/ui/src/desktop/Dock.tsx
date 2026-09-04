import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../wm/Icon'
import { APPS } from './registry'
import { useWM, nextId } from '../wm/store'
import { useContextMenu, type MenuItem } from '../wm/ContextMenu'

export function Dock({ host, paneCount }: { host: string; paneCount: number }) {
  /**
   * Auto-hiding, so a window can use the full height of the screen.
   *
   * Revealed two ways, because neither is enough on its own:
   *
   *   * a `pointermove` listener on the window, which is generous (24px) and
   *     works everywhere the page itself is;
   *   * a thin strip pinned above everything, because pointer events inside a
   *     cross-origin iframe never reach the parent document. With VS Code
   *     maximized its frame covers the whole desktop, so without the strip the
   *     only place the pointer is visible at all is the sliver below it — which
   *     is exactly what "I have to go all the way to the edge" was.
   *
   * The strip is 4px and exists only while the dock is hidden, so it eats a
   * click at the very bottom edge and nothing more.
   */
  const [shown, setShown] = useState(false)
  const hideTimer = useRef<number | null>(null)

  const reveal = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
    setShown(true)
  }, [])

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    // Long enough to survive crossing a gap in the dock, short enough not to
    // feel stuck open.
    hideTimer.current = window.setTimeout(() => setShown(false), 450)
  }, [])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const fromBottom = window.innerHeight - e.clientY
      if (fromBottom <= 24) reveal()
      else if (fromBottom > 90) scheduleHide()
    }
    window.addEventListener('pointermove', onMove)
    return () => {
      window.removeEventListener('pointermove', onMove)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [reveal, scheduleHide])

  const { state, dispatch } = useWM()
  const menu = useContextMenu()

  /** Every launch opens a new window, cascaded so they don't stack exactly. */
  const launch = (appId: string) => {
    const app = APPS.find(a => a.id === appId)!
    // Cascade across every window of this app, not per host — otherwise two
    // hosts' windows land in exactly the same place and hide each other.
    const n = state.wins.filter(w => w.appId === appId).length
    // A window opens inside its pane, so its default size must fit one column.
    const paneW = Math.floor(window.innerWidth / Math.max(1, paneCount))
    const paneH = window.innerHeight - 28 - 56
    const w = Math.min(app.w, paneW - 32)
    const h = Math.min(app.h, paneH - 32)
    dispatch({ t: 'open', win: {
      id: nextId(appId), appId, host, title: app.title, icon: app.icon,
      x: Math.max(8, 24 + (n % 6) * 26),
      y: Math.max(8, 30 + (n % 6) * 24),
      w, h,
    }})
  }

  const dockMenu = (appId: string): MenuItem[] => {
    const wins = state.wins.filter(w => w.appId === appId && w.host === host)
    const items: MenuItem[] = [
      { label: 'New Window', icon: '✧', shortcut: '⌘N', onSelect: () => launch(appId) },
    ]
    if (wins.length) {
      items.push({ type: 'separator' })
      wins.forEach(w => items.push({
        label: w.title.replace(/^Files — /, '') || w.title,
        icon: w.minimized ? '▫' : '▪',
        onSelect: () => dispatch({ t: 'focus', id: w.id }),
      }))
      items.push({ type: 'separator' })
      items.push({
        label: `Close all (${wins.length})`, icon: '✕', danger: true,
        onSelect: () => wins.forEach(w => dispatch({ t: 'close', id: w.id })),
      })
    }
    return items
  }

  // An empty desktop keeps the dock up — there is nothing to uncover, and a
  // dock you have to discover on a blank screen is a bad first impression.
  const idle = state.wins.filter(w => w.host === host).length === 0
  const open = idle || shown

  return (
    <>
    {/* Above every window, so it still sees the pointer when an iframe owns
        the rest of the screen. Gone once the dock is up. */}
    {!open && (
      <div
        onPointerEnter={reveal}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 4, zIndex: 10000 }}
      />
    )}
    <div
      onPointerEnter={reveal}
      onPointerLeave={scheduleHide}
      style={{ pointerEvents: open ? 'auto' : 'none' }}
      className={`absolute bottom-0 inset-x-0 h-14 flex items-end justify-center pb-2 z-[9999]
                  transition-transform duration-150 ease-out
                  ${open ? 'translate-y-0' : 'translate-y-[calc(100%-2px)]'}`}>
      <div className="flex items-center gap-2 px-3 py-2 rounded-2xl
                      bg-desk-panel/80 backdrop-blur-xl border border-desk-line
                      shadow-2xl shadow-black/50">
        {APPS.map(app => {
          const wins = state.wins.filter(w => w.appId === app.id && w.host === host)
          return (
            <button
              key={app.id}
              onClick={() => launch(app.id)}
              onContextMenu={ev => menu.open(ev, dockMenu(app.id))}
              title={`${app.title} — click for a new window, right-click for open windows`}
              className="relative w-11 h-11 rounded-xl grid place-items-center text-2xl
                         bg-white/5 hover:bg-white/10 active:scale-95 transition"
            >
              <Icon token={`${app.id}.app`} fallback={app.icon} size={26} />
              {wins.length > 0 && (
                <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 flex gap-0.5">
                  {wins.slice(0, 4).map(w => (
                    <span key={w.id}
                          className={`w-1 h-1 rounded-full ${
                            w.minimized ? 'bg-desk-dim' : 'bg-desk-accent'}`} />
                  ))}
                </span>
              )}
            </button>
          )
        })}

        {state.wins.some(w => w.minimized && w.host === host) && <div className="w-px h-8 bg-desk-line mx-1" />}
        {state.wins.filter(w => w.minimized && w.host === host).map(w => (
          <button key={w.id} onClick={() => dispatch({ t: 'focus', id: w.id })}
            title={`Restore ${w.title}`}
            className="h-11 px-3 rounded-xl flex items-center gap-2 text-xs
                       bg-white/5 hover:bg-white/10 transition">
            <Icon token={`${w.appId}.app`} fallback={w.icon} size={13} />
            <span className="max-w-28 truncate opacity-70">
              {w.title.replace(/^Files — /, '')}
            </span>
          </button>
        ))}
      </div>
    </div>
    </>
  )
}
