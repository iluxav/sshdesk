import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFw } from '../wm/host'
import { APPS } from '../desktop/registry'
import { Icon } from '../wm/Icon'
import { declarations, resolve, configKey, setConfig, setValue, config,
         type TokenDecl, type Layer } from '../fw/tokens'
import { searchIcons, iconCount } from '../fw/icons'
import { applyTheme } from '../fw/theme'

/**
 * Settings.
 *
 * Generic over declarations: it enumerates whatever apps have registered and
 * renders an editor per token type, so an app shipped years from now is
 * editable here without a line of code being added.
 *
 * Two things layered config fails confusingly without, both present below:
 * every row states which layer won, and a scope toggle makes "tint the prod
 * box" two clicks instead of a hand-edited file over SSH.
 */

/**
 * Split a colour into its opaque part and its alpha.
 *
 * `<input type="color">` has no concept of alpha — it silently returns
 * `#rrggbb` — so the two are edited separately and recombined. Every surface
 * in the theme is translucent, so alpha is not a detail here.
 */
function splitColor(v: string): { rgb: string; alpha: number } {
  const m = /^#([0-9a-f]{3,8})$/i.exec((v ?? '').trim())
  if (!m) return { rgb: '#000000', alpha: 1 }
  let h = m[1]
  if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('')
  return {
    rgb: '#' + h.slice(0, 6),
    alpha: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  }
}

function joinColor(rgb: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha))
  // Fully opaque stays six digits, so a hand-edited config keeps the shorter,
  // more familiar form.
  if (a >= 0.999) return rgb
  return rgb + Math.round(a * 255).toString(16).padStart(2, '0')
}

const LAYER_LABEL: Record<Layer, string> = {
  default: 'default',
  set: 'set',
}

const APP_TITLES: Record<string, string> = {
  desk: 'Appearance',
}

/**
 * Show an app's real name, not its id. A plugin whose id is `systemctl` calls
 * itself "Services" everywhere else, and having Settings alone disagree makes
 * it look like a different thing entirely.
 */
function titleOf(id: string): string {
  return APP_TITLES[id] ?? APPS.find(a => a.id === id)?.title ?? id
}

export function Settings({ setTitle }: { setTitle?: (t: string) => void }) {
  const fw = useFw()

  const [section, setSection] = useState('desk')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [, bump] = useState(0)
  const [picking, setPicking] = useState<string | null>(null)
  const [deps, setDeps] = useState<{ name: string; size: number }[] | null>(null)
  /** Thumbnails for image tokens, keyed by path. */
  const [preview, setPreview] = useState<Record<string, string>>({})
  const host = fw.host.current()

  useEffect(() => { setTitle?.('Settings') }, [setTitle])

  const apps = declarations()
  const tokens = useMemo(
    () => apps.find(([id]) => id === section)?.[1] ?? {},
    [apps, section])

  // Resolve thumbnails for whatever image tokens the current section declares.
  useEffect(() => {
    let live = true
    for (const [name, decl] of Object.entries(tokens)) {
      if (decl.type !== 'image') continue
      const path = resolve(`${section}.${name}`).value
      if (!path || preview[path] !== undefined) continue
      fw.wallpaper(path)
        .then(url => { if (live) setPreview(p => ({ ...p, [path]: url })) })
        .catch(() => { if (live) setPreview(p => ({ ...p, [path]: '' })) })
    }
    return () => { live = false }
    // Deliberately not depending on `tokens` or `preview`: both change identity
    // on every render, and this only needs to run when the section does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fw, section])


  // Re-read to confirm what landed. The optimistic update in `write` has
  // already moved the UI, so a hiccup here cannot leave "saved" on screen
  // beside a stale value — which is exactly how this failed before.
  const reload = useCallback(async () => {
    const cfg = await fw.config.load()
    setConfig(cfg.values)
    bump(n => n + 1)
  }, [fw])

  const write = useCallback(async (id: string, decl: TokenDecl, value?: string) => {
    const key = configKey(id, decl.type)
    setBusy(true); setErr(''); setNote('')
    try {
      await fw.config.set(key, value)
      // Apply what we know before confirming, so the UI never reports success
      // while still showing the old value.
      setValue(key, value)
      applyTheme()
      await reload()
      setNote(value === undefined ? 'reset to default' : 'saved')
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }, [fw, reload])

  const openRaw = async () => {
    try { fw.ui.open('editor', { path: await fw.config.path(), host: '' }) }
    catch (e) { setErr(String(e)) }
  }

  return (
    <div className="flex h-full text-desk-fg">
      {/* sections */}
      <div className="w-44 shrink-0 border-r border-desk-line overflow-auto py-2">
        {apps.map(([id, decls]) => (
          <button
            key={id}
            onClick={() => setSection(id)}
            className={`flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs
              ${section === id ? 'bg-desk-accent/15 text-desk-fg' : 'text-desk-dim hover:bg-white/5'}`}>
            <Icon token={`${id}.app`} size={14} />
            <span className="truncate">{titleOf(id)}</span>
            <span className="ml-auto text-[10px] opacity-50">{Object.keys(decls).length}</span>
          </button>
        ))}

        <div className="mt-2 pt-2 border-t border-desk-line">
          <button
            onClick={() => {
              setSection('__deps')
              setDeps(null)
              fw.deps.installed().then(setDeps).catch(e => { setErr(String(e)); setDeps([]) })
            }}
            className={`flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs
              ${section === '__deps' ? 'bg-desk-accent/15 text-desk-fg' : 'text-desk-dim hover:bg-white/5'}`}>
            <Icon id="desk:download" size={14} />
            <span className="truncate">Installed</span>
          </button>
        </div>
      </div>

      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-desk-line shrink-0">
          <span className="text-[11px] text-desk-dim">
            Saved on this Mac, and applies to every machine you connect to.
          </span>
          <button onClick={openRaw}
            className="ml-auto text-[11px] text-desk-dim hover:text-desk-fg">
            edit file…
          </button>
        </div>

        {/* what sshdesk put on the connected host */}
        {section === '__deps' ? (
          <div className="flex-1 overflow-auto p-3">
            <p className="text-[11px] text-desk-dim mb-3">
              Software sshdesk installed under <code>~/.sshdesk/opt</code> on{' '}
              {host ? host.replace(/^.*@/, '') : 'this host'}. Packages installed
              through the Packages app are not listed here — those belong to the
              machine, and removing them is its owner's business.
            </p>
            {deps === null && <p className="text-xs text-desk-dim">reading…</p>}
            {deps?.length === 0 && (
              <p className="text-xs text-desk-dim">nothing installed on this host</p>
            )}
            {deps?.map(d => (
              <div key={d.name}
                className="flex items-center gap-3 py-2 border-b border-desk-line/50">
                <Icon id="desk:app" size={14} className="text-desk-dim" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-mono truncate">{d.name}</div>
                  <div className="text-[10px] text-desk-dim">{fw.fmt.size(d.size)}</div>
                </div>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true); setErr(''); setNote('')
                    try {
                      setNote(await fw.deps.remove(d.name))
                      setDeps(await fw.deps.installed())
                    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
                  }}
                  className="px-2 py-0.5 rounded text-[11px] border border-desk-line
                             text-desk-dim hover:text-desk-bad hover:border-desk-bad
                             disabled:opacity-40">
                  remove
                </button>
              </div>
            ))}
          </div>
        ) : (
        <div className="flex-1 overflow-auto">
          {Object.entries(tokens).map(([name, decl]) => {
            const id = `${section}.${name}`
            const r = resolve(id)
            const key = configKey(id, decl.type)
            const isSet = config()[key] !== undefined
            return (
              <div key={id}
                className="flex items-center gap-3 px-3 py-2 border-b border-desk-line/50">
                <div className="w-40 shrink-0">
                  <div className="text-xs">{decl.label}</div>
                  <div className="text-[10px] text-desk-dim font-mono truncate"
                       title={`config key: ${configKey(id, decl.type)}`}>{id}</div>
                </div>

                <div className="flex-1 min-w-0">
                  {decl.type === 'image' ? (
                    <div className="flex items-center gap-2">
                      {r.value && (
                        <span className="w-10 h-6 rounded border border-desk-line overflow-hidden
                                         bg-desk-bg shrink-0">
                          <img src={preview[r.value] ?? ''} alt=""
                               className="w-full h-full object-cover" />
                        </span>
                      )}
                      <button
                        onClick={async () => {
                          const { open } = await import('@tauri-apps/plugin-dialog')
                          const picked = await open({
                            multiple: false, directory: false,
                            title: 'Choose a desktop picture',
                            filters: [{ name: 'Images',
                              extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'heic'] }],
                          })
                          if (typeof picked === 'string') write(id, decl, picked)
                        }}
                        className="px-2 py-1 text-xs rounded border border-desk-line
                                   hover:bg-white/5">choose…</button>
                      <span className="text-[11px] text-desk-dim truncate max-w-[14rem]"
                            title={r.value}>
                        {r.value ? r.value.split('/').pop() : 'none'}
                      </span>
                    </div>
                  ) : decl.type === 'icon' ? (
                    <button
                      onClick={() => setPicking(picking === id ? null : id)}
                      className="flex items-center gap-2 px-2 py-1 rounded border border-desk-line
                                 hover:bg-white/5 text-xs">
                      <Icon id={r.value} size={16} />
                      <span className="font-mono text-[11px] text-desk-dim">{r.value || '—'}</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      {decl.type === 'color' && (() => {
                        const { rgb, alpha } = splitColor(r.value)
                        return (
                          <>
                            {/* Checkerboard behind the swatch, so a translucent
                                colour reads as translucent rather than as a
                                slightly different shade of the panel. */}
                            <span className="w-7 h-7 rounded border border-desk-line overflow-hidden
                                             shrink-0 relative"
                                  style={{ backgroundImage:
                                    'linear-gradient(45deg,#8884 25%,transparent 25%,transparent 75%,#8884 75%),' +
                                    'linear-gradient(45deg,#8884 25%,transparent 25%,transparent 75%,#8884 75%)',
                                    backgroundSize: '8px 8px',
                                    backgroundPosition: '0 0, 4px 4px' }}>
                              <span className="absolute inset-0" style={{ background: r.value }} />
                              <input
                                type="color"
                                value={rgb}
                                onChange={e => write(id, decl, joinColor(e.target.value, alpha))}
                                className="absolute inset-0 opacity-0 cursor-pointer" />
                            </span>
                            <input
                              type="range" min={0} max={100} step={1}
                              value={Math.round(alpha * 100)}
                              title={`opacity ${Math.round(alpha * 100)}%`}
                              // Live while dragging, written once on release —
                              // a config file rewritten per pixel of travel
                              // would be silly.
                              onChange={e => {
                                const v = joinColor(rgb, Number(e.target.value) / 100)
                                setValue(configKey(id, decl.type), v)
                                applyTheme()
                              }}
                              onPointerUp={e => write(id, decl,
                                joinColor(rgb, Number((e.target as HTMLInputElement).value) / 100))}
                              className="w-20 accent-[var(--color-desk-accent)]" />
                            <span className="w-8 text-[10px] text-desk-dim tabular-nums">
                              {Math.round(alpha * 100)}%
                            </span>
                          </>
                        )
                      })()}
                      <input
                        defaultValue={r.value}
                        key={r.value}
                        onBlur={e => e.target.value !== r.value && write(id, decl, e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        className="w-40 px-2 py-1 text-xs font-mono rounded border border-desk-line
                                   bg-desk-bg outline-none focus:border-desk-accent" />
                    </div>
                  )}
                </div>

                {/* provenance — the thing that stops "why is nothing changing" */}
                <span className="text-[10px] text-desk-dim shrink-0 w-24 text-right">
                  {r.via ? `↳ ${r.via}` : LAYER_LABEL[r.layer]}
                </span>

                <button
                  disabled={!isSet || busy}
                  onClick={() => write(id, decl)}
                  title={isSet ? 'Reset to default' : 'Already the default'}
                  className="w-6 text-xs text-desk-dim hover:text-desk-fg disabled:opacity-20">↺</button>
              </div>
            )
          })}

          {picking && (
            <IconPicker
              current={resolve(picking).value}
              onPick={v => {
                const name = picking.slice(picking.indexOf('.') + 1)
                const decl = tokens[name]
                // Never fail quietly: an unresolvable declaration used to drop
                // the pick on the floor, which is indistinguishable from the
                // write not working.
                if (decl) write(picking, decl, v)
                else setErr(`no declaration for ${picking} — cannot save`)
                setPicking(null)
              }}
              onClose={() => setPicking(null)} />
          )}
        </div>
        )}

        <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-desk-dim
                        border-t border-desk-line shrink-0">
          <span>{section === '__deps'
            ? `${deps?.length ?? 0} installed`
            : `${Object.keys(tokens).length} tokens`}</span>
          {busy && <span>· saving…</span>}
          {note && <span className="text-desk-ok">· {note}</span>}
          {err && <span className="text-desk-bad truncate">· {err}</span>}
        </div>
      </div>
    </div>
  )
}

/**
 * Icon browser.
 *
 * Search-driven rather than a wall of everything: the library pack alone is
 * over 2000 icons, so results are ranked (exact name, then prefix, then
 * substring) and capped. Symbols are injected as they are drawn, so browsing
 * costs only what is on screen.
 */
function IconPicker({ current, onPick, onClose }: {
  current: string
  onPick: (v: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [glyph, setGlyph] = useState('')
  const results = useMemo(() => searchIcons(q, 400), [q])
  const total = iconCount()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
         onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="w-[600px] h-[70%] flex flex-col rounded-lg border border-desk-line
                   bg-desk-panel shadow-2xl overflow-hidden">

        <div className="flex items-center gap-2 p-3 border-b border-desk-line shrink-0">
          <Icon id="desk:search" size={14} className="text-desk-dim" />
          <input
            autoFocus
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'Enter' && results[0]) onPick(results[0])
            }}
            placeholder={`Search ${total.toLocaleString()} icons…`}
            className="flex-1 px-2 py-1 text-xs rounded border border-desk-line bg-desk-bg
                       outline-none focus:border-desk-accent" />
          <span className="text-[11px] text-desk-dim tabular-nums">
            {results.length}{results.length === 400 ? '+' : ''}
          </span>
        </div>

        <div className="flex-1 overflow-auto p-2">
          <div className="grid grid-cols-12 gap-1">
            {results.map(id => (
              <button
                key={id}
                title={id}
                onClick={() => onPick(id)}
                className={`flex items-center justify-center h-9 rounded hover:bg-white/10
                  ${id === current ? 'ring-1 ring-desk-accent bg-desk-accent/15' : ''}`}>
                <Icon id={id} size={18} />
              </button>
            ))}
          </div>
          {!results.length && (
            <p className="p-6 text-center text-xs text-desk-dim">
              nothing matches “{q}”
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 p-2 border-t border-desk-line shrink-0">
          <span className="text-[11px] text-desk-dim">or an emoji:</span>
          <input
            value={glyph}
            onChange={e => setGlyph(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && glyph.trim() && onPick(glyph.trim())}
            placeholder="📁"
            className="w-16 px-2 py-1 text-xs rounded border border-desk-line bg-desk-bg
                       outline-none focus:border-desk-accent" />
          <button
            disabled={!glyph.trim()}
            onClick={() => onPick(glyph.trim())}
            className="text-[11px] text-desk-dim hover:text-desk-fg disabled:opacity-30">use</button>
          <span className="ml-auto text-[11px] text-desk-dim font-mono truncate max-w-[45%]">
            {current || '—'}
          </span>
        </div>
      </div>
    </div>
  )
}
