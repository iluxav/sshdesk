import { createContext, useContext, useReducer, type ReactNode } from 'react'

export interface Win {
  id: string
  appId: string
  /** The machine this window acts on. Fixed for the window's lifetime. */
  host: string
  title: string
  icon: string
  x: number; y: number; w: number; h: number
  z: number
  minimized: boolean
  maximized: boolean
  restore?: { x: number; y: number; w: number; h: number }
  props?: Record<string, unknown>
}

type Action =
  | { t: 'open'; win: Omit<Win, 'z' | 'minimized' | 'maximized'> }
  | { t: 'close'; id: string }
  | { t: 'focus'; id: string }
  | { t: 'geom'; id: string; x?: number; y?: number; w?: number; h?: number }
  | { t: 'minimize'; id: string }
  | { t: 'toggleMax'; id: string; deskW: number; deskH: number }
  | { t: 'title'; id: string; title: string }

interface State { wins: Win[]; topZ: number }

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'open': {
      const z = s.topZ + 1
      return { topZ: z, wins: [...s.wins, { ...a.win, z, minimized: false, maximized: false }] }
    }
    case 'close':
      return { ...s, wins: s.wins.filter(w => w.id !== a.id) }
    case 'focus': {
      const w = s.wins.find(x => x.id === a.id)
      if (!w || w.z === s.topZ) return w?.minimized
        ? { ...s, wins: s.wins.map(x => x.id === a.id ? { ...x, minimized: false } : x) }
        : s
      const z = s.topZ + 1
      return { topZ: z, wins: s.wins.map(x => x.id === a.id ? { ...x, z, minimized: false } : x) }
    }
    case 'geom':
      return { ...s, wins: s.wins.map(w => w.id === a.id
        ? { ...w, x: a.x ?? w.x, y: a.y ?? w.y, w: a.w ?? w.w, h: a.h ?? w.h } : w) }
    case 'minimize':
      return { ...s, wins: s.wins.map(w => w.id === a.id ? { ...w, minimized: true } : w) }
    case 'toggleMax':
      return { ...s, wins: s.wins.map(w => {
        if (w.id !== a.id) return w
        return w.maximized && w.restore
          ? { ...w, maximized: false, ...w.restore, restore: undefined }
          : { ...w, maximized: true, restore: { x: w.x, y: w.y, w: w.w, h: w.h },
              x: 0, y: 0, w: a.deskW, h: a.deskH }
      }) }
    case 'title': {
      // Bail out if unchanged: returning a fresh object here re-renders the
      // whole desktop and invalidates every callback passed down to apps.
      const cur = s.wins.find(w => w.id === a.id)
      if (!cur || cur.title === a.title) return s
      return { ...s, wins: s.wins.map(w => w.id === a.id ? { ...w, title: a.title } : w) }
    }
  }
}

const Ctx = createContext<{ state: State; dispatch: React.Dispatch<Action> } | null>(null)

export function WindowProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { wins: [], topZ: 0 })
  return <Ctx.Provider value={{ state, dispatch }}>{children}</Ctx.Provider>
}

export function useWM() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useWM outside WindowProvider')
  return c
}

let seq = 0
export const nextId = (appId: string) => `${appId}-${++seq}`
