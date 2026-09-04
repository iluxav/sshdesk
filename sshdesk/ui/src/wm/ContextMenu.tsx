import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect,
  useRef, useState, type ReactNode,
} from 'react'

/** A menu entry. Apps build these from whatever their current context is. */
export type MenuItem =
  | { type: 'separator' }
  | {
      type?: 'item'
      label: string
      icon?: string
      shortcut?: string
      disabled?: boolean
      danger?: boolean
      onSelect: () => void
    }

interface MenuState { x: number; y: number; items: MenuItem[] }

const Ctx = createContext<{
  open: (e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) => void
  close: () => void
} | null>(null)

const isItem = (m: MenuItem): m is Extract<MenuItem, { label: string }> => m.type !== 'separator'

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [active, setActive] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)

  const close = useCallback(() => { setMenu(null); setActive(-1) }, [])

  const open = useCallback((e: { clientX: number; clientY: number; preventDefault?: () => void },
                            items: MenuItem[]) => {
    e.preventDefault?.()
    if (!items.length) return
    setMenu({ x: e.clientX, y: e.clientY, items })
    setActive(-1)
  }, [])

  // Keep the menu on screen: measure after paint, then nudge it back inside.
  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const nx = Math.min(menu.x, window.innerWidth - r.width - 8)
    const ny = Math.min(menu.y, window.innerHeight - r.height - 8)
    if (nx !== menu.x || ny !== menu.y) setMenu({ ...menu, x: Math.max(4, nx), y: Math.max(4, ny) })
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => {
      const items = menu.items
      if (e.key === 'Escape') { close(); return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        let i = active
        for (let n = 0; n < items.length; n++) {
          i = (i + step + items.length) % items.length
          const it = items[i]
          if (isItem(it) && !it.disabled) break
        }
        setActive(i)
      }
      if (e.key === 'Enter' && active >= 0) {
        const it = items[active]
        if (isItem(it) && !it.disabled) { close(); it.onSelect() }
      }
    }
    const onScroll = () => close()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onScroll)
    window.addEventListener('wheel', onScroll, { passive: true })
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('wheel', onScroll)
    }
  }, [menu, active, close])

  return (
    <Ctx.Provider value={{ open, close }}>
      {children}
      {menu && (
        <div className="fixed inset-0 z-[10000]"
             onPointerDown={close}
             onContextMenu={e => { e.preventDefault(); close() }}>
          <div
            ref={ref}
            style={{ left: menu.x, top: menu.y }}
            onPointerDown={e => e.stopPropagation()}
            className="absolute min-w-44 py-1 rounded-lg border border-desk-line
                       bg-desk-panel/95 backdrop-blur-xl shadow-2xl shadow-black/60
                       text-desk-fg text-xs select-none"
          >
            {menu.items.map((m, i) =>
              m.type === 'separator' ? (
                <div key={i} className="my-1 h-px bg-desk-line" />
              ) : (
                <button
                  key={i}
                  disabled={m.disabled}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => { close(); m.onSelect() }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left
                              disabled:opacity-35 disabled:cursor-default
                              ${m.danger ? 'text-desk-bad' : ''}
                              ${active === i && !m.disabled
                                ? (m.danger ? 'bg-desk-bad/20' : 'bg-desk-accent/25')
                                : ''}`}
                >
                  <span className="w-4 opacity-80">{m.icon ?? ''}</span>
                  <span className="flex-1">{m.label}</span>
                  {m.shortcut && <span className="text-desk-dim">{m.shortcut}</span>}
                </button>
              )
            )}
          </div>
        </div>
      )}
    </Ctx.Provider>
  )
}

export function useContextMenu() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useContextMenu outside ContextMenuProvider')
  return c
}
