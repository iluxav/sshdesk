import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type DirListing, type Entry } from '../fw'
import { useFw } from '../wm/host'
import { useContextMenu, type MenuItem } from '../wm/ContextMenu'
import { FileSidebar, DEFAULT_SHORTCUTS, type Shortcut } from './FileSidebar'
import { useDrag, useDropTarget, dropProps } from '../wm/dnd'
import { useDialog } from '../wm/Dialog'

let instances = 0

const ROW = 28

export function FileExplorer({ setTitle }: { setTitle?: (t: string) => void }) {
  const [cwd, setCwd] = useState('~')
  const [d, setD] = useState<DirListing | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // Pinned to this window's machine, not whichever host is focused.
  const fw = useFw()
  const menu = useContextMenu()
  const selfId = useRef(++instances).current
  const dropId = `files:${selfId}`
  const { drag, start: startDrag } = useDrag()
  const dlg = useDialog()
  const [shortcuts, setShortcuts] = useState<Shortcut[]>(
    () => fw.prefs.get('files.shortcuts', DEFAULT_SHORTCUTS))
  const cwdRef = useRef('~')
  const scroller = useRef<HTMLDivElement>(null)
  const anchor = useRef<string | null>(null)
  const lastPath = useRef('')

  // setTitle is rebuilt by the parent on every render; capturing it in a ref
  // keeps `load` stable, otherwise the title dispatch re-renders the desktop,
  // which rebuilds load, which re-runs the mount effect in a loop.
  const titleRef = useRef(setTitle)
  useEffect(() => { titleRef.current = setTitle })

  const load = useCallback(async (path: string) => {
    setBusy(true); setErr(''); setNote('')
    try {
      const l = await fw.fs.list(path)
      setD(l); setCwd(l.path); cwdRef.current = l.path; setSel(new Set()); anchor.current = null
      titleRef.current?.(`Files — ${l.path}`)
      if (l.path !== lastPath.current) {
        scroller.current?.scrollTo({ top: 0 })
        lastPath.current = l.path
      }
    } catch (e) {
      setErr(String(e))
    } finally { setBusy(false) }
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load('~') }, [])

  useEffect(() => { fw.prefs.set('files.shortcuts', shortcuts) }, [shortcuts])

  // One handler per window; the destination arrives as `arg` from the element.
  useDropTarget(dropId, (payload, { meta, arg }) => transfer(payload.paths, arg, meta))

  // Another window changed something in the directory we are showing.
  useEffect(() => fw.bus.on('fs:changed', (p: { dirs?: string[]; from?: number }) => {
    if (p?.from === selfId) return
    if (p?.dirs?.some(d => d === cwdRef.current)) load(cwdRef.current)
  }), [load, selfId])

  const entries = useMemo(() => d?.entries ?? [], [d])

  const act = async (fn: () => Promise<unknown>) => {
    setErr('')
    try {
      await fn()
      await load(cwd)
      fw.bus.emit('fs:changed', { dirs: [cwd], from: selfId })
    } catch (e) { setErr(String(e)) }
  }

  /**
   * Move or copy paths into `dest`. Used by both drag-and-drop and paste.
   * Refuses to drop a directory into itself or into its own subtree, which
   * would otherwise recurse until the disk fills.
   */
  const transfer = async (paths: string[], dest: string, move: boolean) => {
    setErr('')
    const bad = paths.find(p => dest === p || dest.startsWith(p + '/'))
    if (bad) { setErr(`cannot move ${fw.path.base(bad)} into itself`); return }
    try {
      let n = 0
      for (const src of paths) {
        const d = fw.path.join(dest, fw.path.base(src))
        if (src === d) continue
        if (move) await fw.fs.rename(src, d)
        else await fw.fs.copy(src, d)
        n++
      }
      const dirs = [dest, ...paths.map(p => fw.path.parent(p))]
      await load(cwdRef.current)
      fw.bus.emit('fs:changed', { dirs, from: selfId })
      setNote(`${move ? 'moved' : 'copied'} ${n} to ${dest}`)
    } catch (e) { setErr(String(e)) }
  }

  const virt = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 12,
  })

  const open = (e: Entry) => {
    const full = fw.path.join(cwd, e.name)
    if (e.kind === 'dir') return load(full)
    // Files go to the editor app; it decides whether the content is text.
    fw.ui.open('editor', { path: full })
  }

  /** Finder/Explorer selection: click replaces, cmd toggles, shift extends. */
  function selectRow(ev: React.MouseEvent, e: Entry, index: number) {
    const meta = ev.metaKey || ev.ctrlKey
    const shift = ev.shiftKey

    if (shift && anchor.current) {
      const a = entries.findIndex(x => x.name === anchor.current)
      if (a >= 0) {
        const [lo, hi] = a < index ? [a, index] : [index, a]
        const range = entries.slice(lo, hi + 1).map(x => x.name)
        setSel(meta ? new Set([...sel, ...range]) : new Set(range))
        return
      }
    }
    if (meta) {
      const n = new Set(sel)
      n.has(e.name) ? n.delete(e.name) : n.add(e.name)
      setSel(n)
    } else {
      setSel(new Set([e.name]))
    }
    anchor.current = e.name
  }

  const selected = useMemo(() => entries.filter(e => sel.has(e.name)), [entries, sel])
  const one = selected.length === 1 ? selected[0] : null

  const removeList = async (list: Entry[]) => {
    const names = list.map(s => s.name)
    if (!names.length) return
    const label = names.length === 1 ? `"${names[0]}"` : `${names.length} items`
    const ok = await dlg.confirm({
      title: `Delete ${label}?`,
      message: names.length > 1 ? names.join(', ') : `in ${cwd}`,
      okLabel: 'Delete', danger: true,
    })
    if (!ok) return
    act(async () => {
      for (const s of list) {
        await fw.fs.remove(fw.path.join(cwd, s.name), s.kind === 'dir')
      }
    })
  }
  const removeSelected = () => removeList(selected)

  const downloadList = async (list: Entry[]) => {
    const files = list.filter(s => s.kind !== 'dir')
    if (!files.length) { setErr('select at least one file (folders cannot be downloaded yet)'); return }
    setErr('')
    try {
      for (const f of files) await fw.fs.download(fw.path.join(cwd, f.name), f.name)
      setNote(`saved ${files.length} file${files.length > 1 ? 's' : ''} to ~/Downloads`)
    } catch (e) { setErr(String(e)) }
  }

  const pathsOf = (list: Entry[]) => list.map(e => fw.path.join(cwd, e.name))

  const copyList = (l: Entry[]) => { fw.clip.set('copy', pathsOf(l)); setNote(`copied ${l.length}`) }
  const cutList  = (l: Entry[]) => { fw.clip.set('cut',  pathsOf(l)); setNote(`cut ${l.length}`) }
  const copySel = () => copyList(selected)
  const cutSel  = () => cutList(selected)

  const paste = () => {
    const c = fw.clip.get()
    if (!c) return
    act(async () => {
      for (const src of c.paths) {
        const base = fw.path.base(src)
        let dest = fw.path.join(cwd, base)
        // Copying into the same directory would collide with the source.
        if (c.op === 'copy' && src === dest) dest = fw.path.join(cwd, `${base} copy`)
        if (c.op === 'copy') await fw.fs.copy(src, dest)
        else await fw.fs.rename(src, dest)
      }
      if (c.op === 'cut') fw.clip.clear()
    })
  }

  const renameEntry = async (e: Entry) => {
    const n = await dlg.prompt({ title: 'Rename', label: e.name, value: e.name, okLabel: 'Rename' })
    if (n && n !== e.name)
      act(() => fw.fs.rename(fw.path.join(cwd, e.name), fw.path.join(cwd, n)))
  }

  /**
   * Menu contents depend entirely on the passed-in context.
   *
   * The list is passed explicitly rather than read from `selected`: a
   * right-click may need to change the selection first, and that setState has
   * not committed yet when the menu is built.
   */
  function itemsForSelection(list: Entry[]): MenuItem[] {
    const many = list.length > 1
    const target = list.length === 1 ? list[0] : null
    const items: MenuItem[] = []

    if (target) {
      items.push({
        label: 'Open',
        icon: target.kind === 'dir' ? '\u{1F4C2}' : '\u{1F4DD}',
        shortcut: '\u23CE',
        onSelect: () => open(target),
      })
    }
    if (list.some(s => s.kind !== 'dir')) {
      items.push({ label: many ? 'Download selected' : 'Download', icon: '\u2B07',
                   onSelect: () => downloadList(list) })
    }
    if (items.length) items.push({ type: 'separator' })

    items.push({ label: 'Copy', icon: '\u29C9', shortcut: '\u2318C', onSelect: () => copyList(list) })
    items.push({ label: 'Cut',  icon: '\u2702', shortcut: '\u2318X', onSelect: () => cutList(list) })
    items.push({ label: 'Paste', icon: '\u{1F4CB}', shortcut: '\u2318V',
                 disabled: fw.clip.isEmpty(), onSelect: paste })
    items.push({ type: 'separator' })

    if (target) items.push({ label: 'Rename', icon: '\u270E', onSelect: () => renameEntry(target) })
    items.push({
      label: many ? `Delete ${list.length} items` : 'Delete',
      icon: '\u{1F5D1}', shortcut: '\u232B', danger: true,
      onSelect: () => removeList(list),
    })
    return items
  }

  /** Right-click on empty space acts on the directory itself. */
  function itemsForBackground(): MenuItem[] {
    return [
      { label: 'New folder', icon: '📁',
        onSelect: async () => {
          const n = await dlg.prompt({ title: 'New folder', label: `Create inside ${cwd}`,
                                       placeholder: 'folder name', okLabel: 'Create' })
          if (n) act(() => fw.fs.mkdir(fw.path.join(cwd, n)))
        } },
      { label: 'Paste', icon: '📋', shortcut: '⌘V', disabled: fw.clip.isEmpty(), onSelect: paste },
      { type: 'separator' },
      { label: 'Refresh', icon: '⟳', onSelect: () => load(cwd) },
    ]
  }

  const parts = cwd.split('/').filter(Boolean)

  return (
    <div
      className="relative flex h-full bg-desk-panel text-desk-fg outline-none"
      tabIndex={0}
      onKeyDown={ev => {
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 'a') {
          ev.preventDefault(); setSel(new Set(entries.map(e => e.name)))
        } else if (ev.key === 'Escape') {
          setSel(new Set())
        } else if (ev.key === 'Enter' && one) {
          open(one)
        } else if ((ev.metaKey || ev.ctrlKey) && ev.key === 'c' && selected.length) {
          ev.preventDefault(); copySel()
        } else if ((ev.metaKey || ev.ctrlKey) && ev.key === 'x' && selected.length) {
          ev.preventDefault(); cutSel()
        } else if ((ev.metaKey || ev.ctrlKey) && ev.key === 'v') {
          ev.preventDefault(); paste()
        } else if ((ev.key === 'Backspace' || ev.key === 'Delete') && selected.length) {
          ev.preventDefault(); removeSelected()
        }
      }}
    >
      <FileSidebar
        cwd={cwd}
        shortcuts={shortcuts}
        dropId={dropId}
        onGo={load}
        onChange={setShortcuts}
      />

      <div className="flex flex-col flex-1 min-w-0">
      {/* toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-desk-line shrink-0">
        <button onClick={() => load(fw.path.parent(cwd))} disabled={cwd === '/'}
          title="Up" className="px-2 py-1 rounded hover:bg-white/10 disabled:opacity-30">↑</button>
        <button onClick={() => load(cwd)} title="Refresh"
          className="px-2 py-1 rounded hover:bg-white/10">⟳</button>
        <div className="w-px h-5 bg-desk-line mx-1" />

        <div className="flex items-center gap-0.5 text-xs overflow-x-auto flex-1 min-w-0">
          <button onClick={() => load('/')} className="px-1 rounded hover:bg-white/10 text-desk-accent">/</button>
          {parts.map((p, i) => (
            <span key={i} className="flex items-center gap-0.5 shrink-0">
              <button onClick={() => load('/' + parts.slice(0, i + 1).join('/'))}
                className="px-1 rounded hover:bg-white/10 text-desk-accent">{p}</button>
              {i < parts.length - 1 && <span className="text-desk-dim">/</span>}
            </span>
          ))}
        </div>

        <button
          title="New folder"
          aria-label="New folder"
          onClick={async () => {
            const n = await dlg.prompt({ title: 'New folder', label: `Create inside ${cwd}`,
                                         placeholder: 'folder name', okLabel: 'Create' })
            if (n) act(() => fw.fs.mkdir(fw.path.join(cwd, n)))
          }}
          className="px-2 py-1 rounded hover:bg-white/10 shrink-0"
        >
          <svg viewBox="0 0 20 20" className="w-4 h-4" fill="none" stroke="currentColor"
               strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 5.6a1 1 0 0 1 1-1h3.3a1 1 0 0 1 .8.4l.9 1.2h6.9a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1h-11.9a1 1 0 0 1-1-1z" />
            <path d="M10 9.6v4M8 11.6h4" />
          </svg>
        </button>
      </div>

      {err && (
        <div className="px-3 py-1.5 text-xs bg-desk-bad/15 text-desk-bad border-b border-desk-bad/30
                        shrink-0 select-text break-all">{err}</div>
      )}

      <div className="flex px-3 py-1 text-[10px] uppercase tracking-wide text-desk-dim
                      border-b border-desk-line shrink-0">
        <span className="flex-1">Name</span>
        <span className="w-20 text-right">Size</span>
        <span className="w-24 pl-3">Mode</span>
        <span className="w-32 pl-3">Modified</span>
      </div>

      {/* list — click the empty area below to clear the selection */}
      <div ref={scroller} {...dropProps(dropId, cwd)} className="flex-1 overflow-auto min-h-0"
           onClick={ev => { if (ev.target === ev.currentTarget) setSel(new Set()) }}
           onContextMenu={ev => {
             if (ev.target === ev.currentTarget) { setSel(new Set()); menu.open(ev, itemsForBackground()) }
           }}
           >
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map(v => {
            const e = entries[v.index]
            const isSel = sel.has(e.name)
            return (
              <div
                key={e.name}
                {...(e.kind === 'dir' ? dropProps(dropId, fw.path.join(cwd, e.name)) : {})}
                onPointerDown={ev => {
                  const list = sel.has(e.name) ? selected : [e]
                  if (!sel.has(e.name)) { setSel(new Set([e.name])); anchor.current = e.name }
                  startDrag(ev, {
                    host: fw.host.current(),
                    paths: list.map(x => fw.path.join(cwd, x.name)),
                    label: list.length === 1 ? list[0].name : `${list.length} items`,
                  })
                }}
                onClick={ev => selectRow(ev, e, v.index)}
                onDoubleClick={() => open(e)}
                onContextMenu={ev => {
                  // Right-clicking outside the current selection selects that row
                  // first; right-clicking inside it keeps the multi-selection.
                  const eff = sel.has(e.name) ? selected : [e]
                  if (!sel.has(e.name)) { setSel(new Set([e.name])); anchor.current = e.name }
                  menu.open(ev, itemsForSelection(eff))
                }}
                style={{ position: 'absolute', top: 0, left: 0, right: 0,
                         height: ROW, transform: `translateY(${v.start}px)` }}
                className={`flex items-center px-3 text-xs cursor-default select-none
                            ${drag?.over?.id === dropId
                                && drag.over.arg === fw.path.join(cwd, e.name)
                              ? 'bg-desk-accent/50 ring-1 ring-inset ring-desk-accent'
                              : isSel ? 'bg-desk-accent/30' : 'hover:bg-white/5'}`}
              >
                <span className="w-5 shrink-0 opacity-80">
                  {e.kind === 'dir' ? '📁' : e.kind === 'link' ? '🔗' : '📄'}
                </span>
                <span className={`flex-1 truncate ${e.kind === 'dir' ? 'text-desk-accent' : ''}`}>
                  {e.name}
                </span>
                <span className="w-20 text-right text-desk-dim font-mono">
                  {e.kind === 'dir' ? '' : fw.fmt.size(e.size)}
                </span>
                <span className="w-24 pl-3 text-desk-dim font-mono">{e.mode}</span>
                <span className="w-32 pl-3 text-desk-dim">{fw.fmt.time(e.mtime)}</span>
              </div>
            )
          })}
        </div>
        {!busy && entries.length === 0 && !err && (
          <p className="p-4 text-xs text-desk-dim">empty directory</p>
        )}
      </div>

      {/* status */}
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-desk-dim
                      border-t border-desk-line shrink-0">
        <span>{entries.length} items</span>
        {sel.size > 0 && <span className="text-desk-fg">· {sel.size} selected</span>}
        {d?.disk && <span>· {d.disk}</span>}
        {d && <span>· {d.elapsed_ms.toFixed(0)} ms</span>}
        {note && <span className="text-desk-ok">· {note}</span>}

      </div>

      </div>

    </div>
  )
}
