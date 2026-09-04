import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react'

/**
 * Pointer-based drag and drop.
 *
 * HTML5 drag-and-drop is unreliable inside WKWebView (dragstart fires but drop
 * never lands), and Tauri's native file-drop handler competes for the same
 * events. Since the whole desktop already drags windows with pointer events,
 * we do the same here: full control, a real drag ghost, and it works across
 * "windows" because they are all one document.
 */
export interface DragPayload {
  paths: string[]
  host: string
  label: string
  /**
   * The drag has passed the threshold and is really happening. Somewhere to
   * start work that a plain click must not trigger.
   */
  onArmed?: () => void
  /**
   * The pointer has left the app window while still held down — the cue to
   * hand the gesture to the OS. The internal drag is abandoned when this
   * fires, so the drop will not also be treated as a move between folders.
   */
  onLeaveWindow?: () => void
}

type DropHandler = (p: DragPayload, mods: { meta: boolean; alt: boolean; arg: string }) => void

const handlers = new Map<string, DropHandler>()

export interface DropOver { id: string; arg: string }
interface DragState { payload: DragPayload; x: number; y: number; over: DropOver | null }

const Ctx = createContext<{
  drag: DragState | null
  start: (e: React.PointerEvent, payload: DragPayload) => void
} | null>(null)

const THRESHOLD = 4   // px before a press becomes a drag rather than a click

export function DragProvider({ children }: { children: ReactNode }) {
  const [drag, setDrag] = useState<DragState | null>(null)
  const live = useRef<DragState | null>(null)

  const start = useCallback((e: React.PointerEvent, payload: DragPayload) => {
    let escaped = false
    if (e.button !== 0) return
    const ox = e.clientX, oy = e.clientY
    let armed = false

    const move = (ev: PointerEvent) => {
      if (!armed) {
        if (Math.hypot(ev.clientX - ox, ev.clientY - oy) < THRESHOLD) return
        armed = true
        document.body.style.cursor = 'grabbing'
        payload.onArmed?.()
      }
      // Dragging past the window edge means the destination is another app.
      // The mouse button is still down here, which is the only moment macOS
      // will accept a native drag — so this is where the handoff has to happen.
      if (!escaped && payload.onLeaveWindow && (
        ev.clientX <= 0 || ev.clientY <= 0 ||
        ev.clientX >= window.innerWidth - 1 || ev.clientY >= window.innerHeight - 1)) {
        escaped = true
        stop()
        payload.onLeaveWindow()
        return
      }
      // A drop target names its handler with data-drop-id and its destination
      // with data-drop-arg, so one handler per window serves every row.
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const t = el?.closest<HTMLElement>('[data-drop-id]')
      const over = t ? { id: t.dataset.dropId!, arg: t.dataset.dropArg ?? '' } : null
      live.current = { payload, x: ev.clientX, y: ev.clientY, over }
      setDrag(live.current)
    }

    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      live.current = null
      setDrag(null)
    }

    const up = (ev: PointerEvent) => {
      const s = live.current
      stop()
      if (armed && s?.over) {
        handlers.get(s.over.id)?.(payload, { meta: ev.metaKey, alt: ev.altKey, arg: s.over.arg })
      }
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [])

  return (
    <Ctx.Provider value={{ drag, start }}>
      {children}
      {drag && (
        <div
          style={{ left: drag.x + 12, top: drag.y + 10 }}
          className="fixed z-[10001] pointer-events-none px-2 py-1 rounded-md text-xs
                     bg-desk-accent/90 text-[#0b1220] font-medium shadow-lg shadow-black/50"
        >
          {drag.payload.label}
        </div>
      )}
    </Ctx.Provider>
  )
}

export function useDrag() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useDrag outside DragProvider')
  return c
}

/** Register one drop handler; elements opt in with data-drop-id / data-drop-arg. */
export function useDropTarget(id: string, handler: DropHandler) {
  const h = useRef(handler)
  useEffect(() => { h.current = handler })
  useEffect(() => {
    handlers.set(id, (p, m) => h.current(p, m))
    return () => { handlers.delete(id) }
  }, [id])
}

/** Props for an element that should accept drops, routed to `id` with `arg`. */
export const dropProps = (id: string, arg: string) =>
  ({ 'data-drop-id': id, 'data-drop-arg': arg }) as Record<string, string>
