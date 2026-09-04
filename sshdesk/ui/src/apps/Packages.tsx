import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useFw } from '../wm/host'
import { Icon } from '../wm/Icon'
import type { PkgItem, PkgDetails } from '../fw'

/**
 * Packages.
 *
 * Reads come from PackageKit over the bus, so they are typed and the same code
 * works on apt, dnf or zypper without knowing which. Writes go through
 * `sudo pkcon` for the same reason systemd writes go through `sudo systemctl`:
 * PackageKit gates installs behind polkit, and root is not subject to it.
 */

type Tab = 'search' | 'installed' | 'updates'

export function Packages({ setTitle }: { setTitle?: (t: string) => void }) {
  const fw = useFw()
  const [tab, setTab] = useState<Tab>('installed')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<PkgItem[]>([])
  const [sel, setSel] = useState<PkgItem | null>(null)
  const [details, setDetails] = useState<PkgDetails | null>(null)
  const [backend, setBackend] = useState('')
  const [busy, setBusy] = useState(false)
  const [working, setWorking] = useState('')
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => { setTitle?.('Packages') }, [setTitle])

  useEffect(() => {
    fw.pkg.backend().then(setBackend).catch(() => setBackend(''))
  }, [fw])

  const loadTab = useCallback(async (which: Tab, q = '') => {
    setBusy(true); setErr(''); setNote(''); setSel(null); setDetails(null)
    try {
      const list = which === 'installed' ? await fw.pkg.installed()
                 : which === 'updates'   ? await fw.pkg.updates()
                 : await fw.pkg.search(q)
      setItems(list)
      if (which === 'search' && q && list.length === 0) setNote(`nothing matches “${q}”`)
    } catch (e) { setErr(String(e)); setItems([]) } finally { setBusy(false) }
  }, [fw])

  useEffect(() => { loadTab('installed') }, [loadTab])

  // Details are a second round trip, so they are fetched on selection rather
  // than for every row in a 700-item list.
  useEffect(() => {
    if (!sel) return
    let live = true
    setDetails(null)
    fw.pkg.details(sel.id).then(d => { if (live) setDetails(d) }).catch(() => {})
    return () => { live = false }
  }, [fw, sel])

  const act = async (pkg: PkgItem, verb: 'install' | 'remove') => {
    const password = await fw.sys.sudoPassword(
      `Needed to ${verb} ${pkg.name} on this machine`)
    if (!password) return
    setWorking(`${verb === 'install' ? 'installing' : 'removing'} ${pkg.name}…`)
    setErr(''); setNote('')
    try {
      const msg = verb === 'install'
        ? await fw.pkg.install(pkg.name, password)
        : await fw.pkg.remove(pkg.name, password)
      setNote(msg)
      // The list is now stale by definition, so re-read rather than patch it.
      await loadTab(tab, query)
    } catch (e) {
      const text = String(e)
      if (/password|authentic/i.test(text)) fw.sys.forgetPassword()
      setErr(text)
    } finally { setWorking('') }
  }

  const refresh = async () => {
    const password = await fw.sys.sudoPassword('Needed to refresh the package index')
    if (!password) return
    setWorking('refreshing the package index…'); setErr('')
    try { setNote(await fw.pkg.refresh(password)) }
    catch (e) { setErr(String(e)) } finally { setWorking('') }
  }

  const rows = useMemo(() => items, [items])
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 44,
    overscan: 12,
  })

  return (
    <div className="flex flex-col h-full bg-desk-panel text-desk-fg">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-desk-line shrink-0">
        <div className="flex rounded-md overflow-hidden border border-desk-line text-[11px]">
          {(['installed', 'search', 'updates'] as Tab[]).map(k => (
            <button key={k}
              onClick={() => { setTab(k); loadTab(k, query) }}
              className={`px-2.5 py-1 ${tab === k
                ? 'bg-desk-accent/20 text-desk-fg' : 'text-desk-dim hover:bg-white/5'}`}>
              {k}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 flex-1 min-w-0">
          <Icon id="desk:search" size={13} className="text-desk-dim" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key !== 'Enter') return
              setTab('search'); loadTab('search', query)
            }}
            placeholder="search packages, then Enter"
            className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-desk-line
                       bg-desk-bg outline-none focus:border-desk-accent" />
        </div>

        <button onClick={refresh} disabled={!!working}
          title="Refresh the package index"
          className="px-2 py-0.5 rounded hover:bg-white/10 disabled:opacity-40">
          <Icon id="desk:refresh" size={13} />
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        <div ref={scroller} className="flex-1 overflow-auto min-w-0">
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map(v => {
              const p = rows[v.index]
              const isSel = sel?.id === p.id
              return (
                <div key={p.id}
                  onClick={() => setSel(p)}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0,
                           height: v.size, transform: `translateY(${v.start}px)` }}
                  className={`flex items-center gap-2 px-3 text-xs cursor-default
                    ${isSel ? 'bg-desk-accent/25' : 'hover:bg-[var(--pkg-row-hover)]'}`}>
                  <Icon token={p.installed ? 'packages.installed' : 'packages.available'}
                        size={15} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      {p.name}
                      <span className="ml-2 text-[10px] text-desk-dim font-mono">{p.version}</span>
                    </div>
                    <div className="truncate text-[11px] text-desk-dim">{p.summary}</div>
                  </div>
                  <button
                    disabled={!!working}
                    onClick={e => { e.stopPropagation(); act(p, p.installed ? 'remove' : 'install') }}
                    className={`px-2 py-0.5 rounded text-[11px] border disabled:opacity-40
                      ${p.installed
                        ? 'border-desk-line text-desk-dim hover:text-desk-bad hover:border-desk-bad'
                        : 'border-desk-accent/60 text-desk-accent hover:bg-desk-accent/15'}`}>
                    {p.installed ? 'remove' : 'install'}
                  </button>
                </div>
              )
            })}
          </div>
          {!busy && !rows.length && (
            <p className="p-6 text-center text-xs text-desk-dim">
              {note || (tab === 'search' ? 'type a name and press Enter' : 'nothing here')}
            </p>
          )}
        </div>

        {sel && (
          <div className="w-72 shrink-0 border-l border-desk-line overflow-auto p-3 text-xs">
            <div className="text-sm mb-1">{sel.name}</div>
            <div className="font-mono text-[11px] text-desk-dim mb-2 break-all">
              {sel.version} · {sel.arch}
            </div>
            <p className="text-desk-dim mb-3">{sel.summary}</p>
            {details ? (
              <>
                {details.description && (
                  <p className="whitespace-pre-wrap mb-3">{details.description}</p>
                )}
                <dl className="text-[11px] text-desk-dim space-y-1">
                  {details.size > 0 && (
                    <div>installed size · {fw.fmt.size(details.size)}</div>
                  )}
                  {details.license && details.license !== 'unknown' && (
                    <div>licence · {details.license}</div>
                  )}
                  <div className="break-all">repo · {sel.repo || '—'}</div>
                  {details.url && <div className="break-all">{details.url}</div>}
                </dl>
              </>
            ) : <p className="text-desk-dim">loading details…</p>}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-desk-dim
                      border-t border-desk-line shrink-0">
        <span>{rows.length} {tab === 'updates' ? 'updates' : 'packages'}</span>
        {backend && <span>· {backend}</span>}
        {busy && <span>· loading…</span>}
        {working && <span className="text-desk-accent">· {working}</span>}
        {note && !working && <span className="text-desk-ok truncate">· {note}</span>}
        {err && <span className="text-desk-bad truncate">· {err}</span>}
      </div>
    </div>
  )
}
