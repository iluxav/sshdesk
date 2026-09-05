import { Icon } from './Icon'
import { useRef, type ReactNode } from 'react'
import { useWM, type Win } from './store'

// The dock hides itself now, so a maximized window gets the full height and
// the dock floats over it when summoned — the way it works on macOS.
const DOCK_H = 0

/** Resize handles: [class for positioning, which edges it moves] */
const HANDLES: [string, 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'][] = [
  ['top-0 left-2 right-2 h-1 cursor-ns-resize', 'n'],
  ['bottom-0 left-2 right-2 h-1 cursor-ns-resize', 's'],
  ['right-0 top-2 bottom-2 w-1 cursor-ew-resize', 'e'],
  ['left-0 top-2 bottom-2 w-1 cursor-ew-resize', 'w'],
  ['top-0 right-0 w-3 h-3 cursor-nesw-resize', 'ne'],
  ['top-0 left-0 w-3 h-3 cursor-nwse-resize', 'nw'],
  ['bottom-0 right-0 w-3 h-3 cursor-nwse-resize', 'se'],
  ['bottom-0 left-0 w-3 h-3 cursor-nesw-resize', 'sw'],
]

const MIN_W = 320, MIN_H = 180

export function Window({ win, children }: { win: Win; children: ReactNode }) {
  const { dispatch } = useWM()
  const el = useRef<HTMLDivElement>(null)
  // Live geometry during a gesture. Never in React state — a setState per
  // pointermove would drop frames. We write the DOM directly and commit once.
  const g = useRef({ x: win.x, y: win.y, w: win.w, h: win.h })

  const focus = () => dispatch({ t: 'focus', id: win.id })

  function startDrag(e: React.PointerEvent) {
    if (win.maximized) return
    focus()
    const node = el.current!
    const off = { x: e.clientX - win.x, y: e.clientY - win.y }
    g.current = { x: win.x, y: win.y, w: win.w, h: win.h }
    node.setPointerCapture(e.pointerId)
    document.body.classList.add('desk-dragging')

    const move = (ev: PointerEvent) => {
      g.current.x = Math.max(0, ev.clientX - off.x)
      g.current.y = Math.max(0, ev.clientY - off.y)
      node.style.left = g.current.x + 'px'
      node.style.top = g.current.y + 'px'
    }
    const up = () => {
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', up)
      document.body.classList.remove('desk-dragging')
      dispatch({ t: 'geom', id: win.id, x: g.current.x, y: g.current.y })
    }
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerup', up)
  }

  function startResize(e: React.PointerEvent, dir: string) {
    e.stopPropagation()
    focus()
    const node = el.current!
    const s = { mx: e.clientX, my: e.clientY, x: win.x, y: win.y, w: win.w, h: win.h }
    g.current = { x: win.x, y: win.y, w: win.w, h: win.h }
    node.setPointerCapture(e.pointerId)

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - s.mx, dy = ev.clientY - s.my
      let { x, y, w, h } = s
      if (dir.includes('e')) w = Math.max(MIN_W, s.w + dx)
      if (dir.includes('s')) h = Math.max(MIN_H, s.h + dy)
      if (dir.includes('w')) { w = Math.max(MIN_W, s.w - dx); x = s.x + (s.w - w) }
      if (dir.includes('n')) { h = Math.max(MIN_H, s.h - dy); y = s.y + (s.h - h) }
      g.current = { x, y, w, h }
      node.style.left = x + 'px'; node.style.top = y + 'px'
      node.style.width = w + 'px'; node.style.height = h + 'px'
    }
    const up = () => {
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', up)
      dispatch({ t: 'geom', id: win.id, ...g.current })
    }
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerup', up)
  }

  if (win.minimized) return null

  return (
    <div
      ref={el}
      data-window
      onPointerDown={focus}
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z,
               borderRadius: 'var(--color-desk-radius, 12px)',
               borderColor: 'var(--color-desk-border)' }}
      // The app class is what the generated theme selectors hook onto, so an
      // app's tokens apply to its own windows. data-host is kept for
      // debugging; it no longer drives styling.
      data-host={win.host}
      className={`absolute flex flex-col overflow-hidden app-${win.appId}
                 bg-desk-panel border shadow-2xl shadow-black/60`}
    >
      <div
        onPointerDown={startDrag}
        onDoubleClick={() => dispatch({
          t: 'toggleMax', id: win.id,
          deskW: window.innerWidth, deskH: window.innerHeight - DOCK_H,
        })}
        className="flex items-center gap-2 h-9 px-3 shrink-0 cursor-grab active:cursor-grabbing
                   bg-desk-panel border-b border-desk-line"
      >
        <div className="flex gap-1.5 group">
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={() => dispatch({ t: 'close', id: win.id })}
            title="Close"
            className="w-3 h-3 rounded-full bg-desk-bad/90 hover:bg-desk-bad" />
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={() => dispatch({ t: 'minimize', id: win.id })}
            title="Minimize"
            className="w-3 h-3 rounded-full bg-amber-400/90 hover:bg-amber-400" />
          <button
            onPointerDown={e => e.stopPropagation()}
            onClick={() => dispatch({
              t: 'toggleMax', id: win.id,
              deskW: window.innerWidth, deskH: window.innerHeight - DOCK_H,
            })}
            title="Maximize"
            className="w-3 h-3 rounded-full bg-desk-ok/90 hover:bg-desk-ok" />
        </div>
        <span className="opacity-70 flex items-center">
          <Icon token={`${win.appId}.app`} host={win.host} fallback={win.icon} size={13} />
        </span>
        <span className="text-xs font-medium truncate">{win.title}</span>
        <span className="ml-auto pl-2 text-[10px] text-desk-dim truncate max-w-[40%]">
          {win.host.replace(/^.*@/, '')}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>

      {!win.maximized && HANDLES.map(([cls, dir]) => (
        <div key={dir} onPointerDown={e => startResize(e, dir)}
             className={`absolute ${cls}`} />
      ))}
    </div>
  )
}
