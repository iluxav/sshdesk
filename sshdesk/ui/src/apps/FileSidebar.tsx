import { fw } from '../fw'
import { useContextMenu, type MenuItem } from '../wm/ContextMenu'
import { useDrag, dropProps } from '../wm/dnd'
import { useDialog } from '../wm/Dialog'

export interface Shortcut { label: string; path: string; icon: string }

export const DEFAULT_SHORTCUTS: Shortcut[] = [
  { label: 'Home',    path: '~',        icon: '🏠' },
  { label: 'Root',    path: '/',        icon: '💽' },
  { label: 'etc',     path: '/etc',     icon: '⚙️' },
  { label: 'var/log', path: '/var/log', icon: '📜' },
  { label: 'tmp',     path: '/tmp',     icon: '🗂' },
  { label: 'opt',     path: '/opt',     icon: '📦' },
]

export function FileSidebar({
  cwd, shortcuts, dropId, onGo, onChange,
}: {
  cwd: string
  shortcuts: Shortcut[]
  dropId: string
  onGo: (path: string) => void
  onChange: (next: Shortcut[]) => void
}) {
  const menu = useContextMenu()
  const { drag } = useDrag()
  const dlg = useDialog()

  const itemsFor = (s: Shortcut, i: number): MenuItem[] => [
    { label: 'Open', icon: '📂', onSelect: () => onGo(s.path) },
    { type: 'separator' },
    {
      label: 'Rename shortcut', icon: '✎',
      onSelect: async () => {
        const n = await dlg.prompt({ title: 'Rename shortcut', value: s.label, okLabel: 'Rename' })
        if (n) onChange(shortcuts.map((x, j) => (j === i ? { ...x, label: n } : x)))
      },
    },
    {
      label: 'Remove shortcut', icon: '🗑', danger: true,
      onSelect: () => onChange(shortcuts.filter((_, j) => j !== i)),
    },
  ]

  const pinned = shortcuts.some(s => s.path === cwd)

  return (
    <div className="w-44 shrink-0 flex flex-col border-r border-desk-line bg-black/20">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-desk-dim shrink-0">
        Shortcuts
      </div>

      <div className="flex-1 overflow-auto py-0.5">
        {shortcuts.map((s, i) => {
          const active = cwd === s.path
          const isOver = drag?.over?.id === dropId && drag.over.arg === s.path
          return (
            <button
              key={s.path + i}
              {...dropProps(dropId, s.path)}
              onClick={() => onGo(s.path)}
              onContextMenu={ev => menu.open(ev, itemsFor(s, i))}
              className={`w-full flex items-center gap-2 px-3 py-1 text-xs text-left truncate
                          ${isOver ? 'bg-desk-accent/50 ring-1 ring-inset ring-desk-accent'
                                   : active ? 'bg-white/10' : 'hover:bg-white/5'}`}
            >
              <span className="w-4 shrink-0 pointer-events-none">{s.icon}</span>
              <span className="truncate pointer-events-none">{s.label}</span>
            </button>
          )
        })}
      </div>

      <button
        disabled={pinned}
        onClick={() => onChange([...shortcuts, { label: fw.path.base(cwd) || '/', path: cwd, icon: '📌' }])}
        className="shrink-0 m-2 px-2 py-1 rounded text-[11px] border border-desk-line
                   hover:bg-white/10 text-desk-dim disabled:opacity-30"
      >
        {pinned ? 'Pinned' : '+ Pin this folder'}
      </button>
    </div>
  )
}
