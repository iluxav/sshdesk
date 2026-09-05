import { useCallback, useEffect, useRef, useState } from 'react'
import { fw } from '../fw'
import { Icon } from '../wm/Icon'
import { useContextMenu, type MenuItem } from '../wm/ContextMenu'
import { useDialog } from '../wm/Dialog'
import { handlerFor } from './registry'
import type { Entry } from '../fw'

/**
 * The desktop, as a folder.
 *
 * Backed by ~/Desktop on the machine this pane belongs to, so it is the remote
 * machine's desktop rather than a local imitation. Created on first use, since
 * a server rarely has one.
 *
 * Icons are laid out on a grid in a fixed order — directories first, then by
 * name — rather than remembering positions. Free placement means storing
 * coordinates per file per host and reconciling them when files appear and
 * disappear behind your back, which is a lot of machinery for an arrangement
 * most people never touch.
 */
export function DesktopFiles({ host, active }: { host: string; active: boolean }) {
  const api = fw.for(host)
  const menu = useContextMenu()
  const dlg = useDialog()
  const [entries, setEntries] = useState<Entry[]>([])
  const [dir, setDir] = useState('')
  const [sel, setSel] = useState('')
  const [err, setErr] = useState('')
  const [dropping, setDropping] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setErr('')
    try {
      const home = await api.fs.list('~').then(() => '~').catch(() => '~')
      const path = `${home}/Desktop`
      // A server usually has no Desktop. Make one rather than showing an error
      // about a folder the user never asked for.
      const listing = await api.fs.list(path).catch(async e => {
        if (!/no such file/i.test(String(e))) throw e
        await api.fs.mkdir(path)
        return api.fs.list(path)
      })
      setDir(listing.path)
      setEntries(listing.entries.filter(e => !e.name.startsWith('.')))
    } catch (e) { setErr(String(e)) }
  }, [api])

  useEffect(() => { load() }, [load])

  // Anything that changes the filesystem announces it; this is one more listener.
  useEffect(() => fw.bus.on('fs:changed', (p: { dirs?: string[] }) => {
    if (!dir || !p?.dirs?.length || p.dirs.includes(dir)) load()
  }), [dir, load])

  const open = (e: Entry) => {
    const path = fw.path.join(dir, e.name)
    if (e.kind === 'dir') fw.ui.open('files', { path, host })
    else fw.ui.open(handlerFor(path), { path, host })
  }

  const newFolder = async () => {
    const name = await dlg.prompt({ title: 'New folder', label: 'Name', value: 'untitled folder' })
    if (!name) return
    try { await api.fs.mkdir(fw.path.join(dir, name)); await load() }
    catch (e) { setErr(String(e)) }
  }

  const remove = async (e: Entry) => {
    const ok = await dlg.confirm({
      title: `Delete ${e.name}?`,
      message: e.kind === 'dir' ? 'The folder and everything in it.' : 'This cannot be undone.',
      okLabel: 'Delete', danger: true,
    })
    if (!ok) return
    try { await api.fs.remove(fw.path.join(dir, e.name), e.kind === 'dir'); await load() }
    catch (er) { setErr(String(er)) }
  }

  const rename = async (e: Entry) => {
    const name = await dlg.prompt({ title: `Rename ${e.name}`, label: 'New name', value: e.name })
    if (!name || name === e.name) return
    try {
      await api.fs.rename(fw.path.join(dir, e.name), fw.path.join(dir, name))
      await load()
    } catch (er) { setErr(String(er)) }
  }

  const itemMenu = (e: Entry): MenuItem[] => [
    { label: 'Open', icon: '↗', onSelect: () => open(e) },
    ...(e.kind === 'dir' ? [] : [{ label: 'Download to my Mac', icon: '⬇',
        onSelect: () => { void api.fs.download(fw.path.join(dir, e.name), e.name) } }]),
    { label: 'Rename…', icon: '✎', onSelect: () => rename(e) },
    { type: 'separator' as const },
    { label: 'Delete', icon: '🗑', danger: true, onSelect: () => remove(e) },
  ]

  const emptyMenu: MenuItem[] = [
    { label: 'New folder', icon: '📁', onSelect: newFolder },
    { label: 'Open in Files', icon: '↗', onSelect: () => fw.ui.open('files', { path: dir, host }) },
    { type: 'separator' },
    { label: 'Refresh', icon: '⟳', onSelect: () => { void load() } },
    { label: 'Desktop picture…', icon: '🖼', onSelect: () => fw.ui.open('settings', { host }) },
  ]

  // Files dropped from Finder land here, the same way they do in a Files
  // window — the desktop is a folder, so it accepts what a folder accepts.
  useEffect(() => {
    if (!active || !dir) return
    let un: (() => void) | null = null
    let cancelled = false
    import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => {
      if (cancelled) return
      getCurrentWebview().onDragDropEvent(async ev => {
        const p = ev.payload as any
        const inside = (pos: { x: number; y: number }) => {
          const dpr = window.devicePixelRatio || 1
          for (const [x, y] of [[pos.x / dpr, pos.y / dpr], [pos.x, pos.y]]) {
            const el = document.elementFromPoint(x, y)
            // Only when the drop lands on the desktop itself, not on a window.
            if (el && root.current?.contains(el) && !el.closest('[data-window]')) return true
          }
          return false
        }
        if (p.type === 'over' || p.type === 'enter') { setDropping(inside(p.position)); return }
        if (p.type === 'leave') { setDropping(false); return }
        if (p.type !== 'drop') return
        setDropping(false)
        if (!inside(p.position) || !p.paths?.length) return
        try { await api.fs.uploadFiles(p.paths, dir); await load() }
        catch (e) { setErr(String(e)) }
      }).then(f => { if (cancelled) f(); else un = f })
    })
    return () => { cancelled = true; un?.() }
  }, [active, dir, api, load])

  return (
    <div
      ref={root}
      onContextMenu={ev => {
        if ((ev.target as HTMLElement).closest('[data-desk-item]')) return
        ev.preventDefault()
        menu.open(ev, emptyMenu)
      }}
      onPointerDown={ev => { if (ev.target === ev.currentTarget) setSel('') }}
      className={`absolute inset-0 z-0 p-3 pt-8 content-start
                  grid grid-cols-[repeat(auto-fill,88px)] gap-1 auto-rows-min
                  ${dropping ? 'outline outline-2 -outline-offset-4 outline-desk-accent' : ''}`}
    >
      {entries.map(e => (
        <button
          key={e.name}
          data-desk-item
          onPointerDown={() => setSel(e.name)}
          onDoubleClick={() => open(e)}
          onContextMenu={ev => { ev.preventDefault(); setSel(e.name); menu.open(ev, itemMenu(e)) }}
          title={e.name}
          className={`flex flex-col items-center gap-1 p-2 rounded-lg text-center
                      ${sel === e.name ? 'bg-[var(--color-desk-selection)]' : 'hover:bg-white/5'}`}
        >
          <Icon token={e.kind === 'dir' ? 'files.directory'
                     : e.kind === 'link' ? 'files.link' : 'files.file'}
                host={host} size={34} />
          <span className="text-[11px] leading-tight line-clamp-2 break-all
                           text-desk-fg/90 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
            {e.name}
          </span>
        </button>
      ))}

      {err && (
        <p className="col-span-full text-[11px] text-desk-bad">{err}</p>
      )}
    </div>
  )
}
