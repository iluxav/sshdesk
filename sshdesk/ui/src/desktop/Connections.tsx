import { useEffect, useRef, useState } from 'react'
import { fw, type SavedConn } from '../fw'
import { useContextMenu } from '../wm/ContextMenu'

export function Connections({ onConnected, connected = [], onCancel }: {
  onConnected: (target: string) => void
  /** Already-connected targets, shown as such so you do not reconnect them. */
  connected?: string[]
  /** Present when other machines are already connected, so this is cancellable. */
  onCancel?: () => void
}) {
  const menu = useContextMenu()
  const [saved, setSaved] = useState<SavedConn[]>(() => fw.conns.list())
  const [form, setForm] = useState<{ host: string; user: string; password: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const first = useRef<HTMLInputElement>(null)

  // Depend on whether the form is open, not on its contents: `form` changes on
  // every keystroke, which re-ran this and yanked focus back to the first field
  // after each character.
  const formOpen = form !== null
  useEffect(() => {
    if (formOpen) requestAnimationFrame(() => first.current?.focus())
  }, [formOpen])

  const connect = async (user: string, host: string, password: string) => {
    const target = `${user}@${host}`
    setBusy(target); setErr('')
    try {
      await fw.host.connect(target, password || undefined)
      fw.conns.remember(user, host)      // host + user only, never the password
      setSaved(fw.conns.list())
      onConnected(target)
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ''))
    } finally { setBusy(null) }
  }

  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-6
                    bg-[radial-gradient(ellipse_at_30%_0%,#1b2430_0%,#0f1116_60%)]">
      <div className="text-center">
        <h1 className="text-lg font-semibold tracking-tight">sshdesk</h1>
        <p className="text-xs text-desk-dim mt-1">
          {connected.length
            ? `Connect another machine · ${connected.length} already connected`
            : 'Pick a machine, or add a new one.'}
        </p>
        {onCancel && (
          <button onClick={onCancel}
            className="mt-3 px-3 py-1 rounded text-xs border border-desk-line hover:bg-white/10">
            Back to desktop
          </button>
        )}
      </div>

      {err && (
        <div className="max-w-lg px-3 py-2 rounded-lg text-xs bg-desk-bad/15 text-desk-bad
                        border border-desk-bad/30 select-text break-all">{err}</div>
      )}

      <div className="flex flex-wrap gap-3 justify-center max-w-3xl px-6">
        {saved.map(c => {
          const target = `${c.user}@${c.host}`
          const already = connected.includes(target)
          return (
            <button
              key={target}
              disabled={!!busy || already}
              onClick={() => setForm({ host: c.host, user: c.user, password: '' })}
              onContextMenu={ev => menu.open(ev, [
                { label: 'Connect', icon: '→',
                  onSelect: () => setForm({ host: c.host, user: c.user, password: '' }) },
                { type: 'separator' },
                { label: 'Forget this connection', icon: '🗑', danger: true,
                  onSelect: () => { fw.conns.forget(c.user, c.host); setSaved(fw.conns.list()) } },
              ])}
              className="w-44 p-3 rounded-xl text-left border border-white/10
                         bg-white/[0.04] hover:bg-white/[0.08] backdrop-blur-xl
                         transition disabled:opacity-40"
            >
              <div className="w-9 h-9 rounded-lg grid place-items-center text-lg
                              bg-desk-accent/15 border border-desk-accent/25 mb-2">🖥</div>
              <div className="text-sm font-medium truncate">{c.host}</div>
              <div className="text-[11px] text-desk-dim truncate">{c.user}</div>
              <div className="text-[10px] text-desk-dim mt-1">
                {already ? 'connected'
                  : busy === target ? 'connecting…'
                  : new Date(c.lastUsed).toLocaleDateString()}
              </div>
            </button>
          )
        })}

        <button
          onClick={() => setForm({ host: '', user: '', password: '' })}
          className="w-44 p-3 rounded-xl text-left border border-dashed border-white/15
                     bg-transparent hover:bg-white/[0.05] transition"
        >
          <div className="w-9 h-9 rounded-lg grid place-items-center text-lg
                          border border-white/15 text-desk-dim mb-2">+</div>
          <div className="text-sm font-medium">New connection</div>
          <div className="text-[11px] text-desk-dim">host, user, password</div>
        </button>
      </div>

      {form && (
        <div className="fixed inset-0 z-[10002] bg-black/50 flex items-center justify-center"
             onPointerDown={() => setForm(null)}>
          <form
            onPointerDown={e => e.stopPropagation()}
            onSubmit={e => { e.preventDefault(); void connect(form.user, form.host, form.password) }}
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setForm(null) } }}
            className="w-[min(400px,86vw)] rounded-xl border border-desk-line bg-desk-panel
                       shadow-2xl shadow-black/60 p-4 flex flex-col gap-3"
          >
            <h2 className="text-sm font-semibold">
              {saved.some(c => c.host === form.host && c.user === form.user)
                ? `Connect to ${form.host}` : 'New connection'}
            </h2>

            <label className="text-[11px] text-desk-dim">
              Host / IP
              <input
                ref={first}
                value={form.host}
                onChange={e => setForm({ ...form, host: e.target.value })}
                placeholder="10.0.0.5"
                spellCheck={false}
                className="mt-1 w-full bg-black/40 border border-desk-line rounded px-2 py-1.5
                           text-sm text-desk-fg outline-none focus:border-desk-accent select-text"
              />
            </label>

            <label className="text-[11px] text-desk-dim">
              Username
              <input
                value={form.user}
                onChange={e => setForm({ ...form, user: e.target.value })}
                placeholder="root"
                spellCheck={false}
                className="mt-1 w-full bg-black/40 border border-desk-line rounded px-2 py-1.5
                           text-sm text-desk-fg outline-none focus:border-desk-accent select-text"
              />
            </label>

            <label className="text-[11px] text-desk-dim">
              Password
              <input
                type="password"
                value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
                placeholder="leave empty to use your SSH key"
                className="mt-1 w-full bg-black/40 border border-desk-line rounded px-2 py-1.5
                           text-sm text-desk-fg outline-none focus:border-desk-accent select-text"
              />
              <span className="block mt-1 text-[10px] text-desk-dim">
                Not saved. Only the host and username are remembered.
              </span>
            </label>

            <div className="flex justify-end gap-2 mt-1">
              <button type="button" onClick={() => setForm(null)}
                className="px-3 py-1.5 rounded text-xs border border-desk-line hover:bg-white/10">
                Cancel
              </button>
              <button type="submit" disabled={!form.host || !form.user || !!busy}
                className="px-3 py-1.5 rounded text-xs font-medium bg-desk-accent text-[#0b1220]
                           hover:brightness-110 disabled:opacity-40">
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
