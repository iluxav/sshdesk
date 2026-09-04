import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFw } from '../wm/host'
import { Icon } from '../wm/Icon'
import { declarations, resolve, configKey, setLayers, layerFor, localLayer,
         type TokenDecl, type Layer } from '../fw/tokens'
import { iconPacks } from '../fw/icons'
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

const LAYER_LABEL: Record<Layer, string> = {
  default: 'default',
  local: 'this Mac',
  host: 'this host',
}

const APP_TITLES: Record<string, string> = {
  desk: 'Appearance',
  files: 'Files',
  terminal: 'Terminal',
  editor: 'Editor',
  settings: 'Settings',
}

export function Settings({ setTitle }: { setTitle?: (t: string) => void }) {
  const fw = useFw()
  const host = fw.host.current()

  const [scope, setScope] = useState<'local' | 'host'>('local')
  const [section, setSection] = useState('desk')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [, bump] = useState(0)
  const [picking, setPicking] = useState<string | null>(null)

  useEffect(() => { setTitle?.('Settings') }, [setTitle])

  const apps = declarations()
  const tokens = useMemo(
    () => apps.find(([id]) => id === section)?.[1] ?? {},
    [apps, section])

  const reload = useCallback(async () => {
    const layers = await fw.config.load(host).catch(() => null)
    if (layers) setLayers(layers, host)
    applyTheme([host])
    bump(n => n + 1)
  }, [fw, host])

  const write = useCallback(async (id: string, decl: TokenDecl, value?: string) => {
    setBusy(true); setErr(''); setNote('')
    try {
      await fw.config.set(scope, configKey(id, decl.type), value, host)
      await reload()
      setNote(value === undefined ? 'reset to the layer below' : 'saved')
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }, [fw, scope, host, reload])

  const openRaw = async () => {
    try {
      const path = await fw.config.path(scope)
      fw.ui.open('editor', { path, host })
    } catch (e) { setErr(String(e)) }
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
            <Icon token={`${id}.app`} host={host} size={14} />
            <span className="truncate">{APP_TITLES[id] ?? id}</span>
            <span className="ml-auto text-[10px] opacity-50">{Object.keys(decls).length}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-col flex-1 min-w-0">
        {/* scope */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-desk-line shrink-0">
          <div className="flex rounded-md overflow-hidden border border-desk-line text-[11px]">
            {(['local', 'host'] as const).map(s => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`px-2.5 py-1 ${scope === s
                  ? 'bg-desk-accent/20 text-desk-fg' : 'text-desk-dim hover:bg-white/5'}`}>
                {s === 'local' ? 'This Mac' : host.replace(/^.*@/, '') || 'This host'}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-desk-dim">
            {scope === 'local'
              ? 'applies everywhere'
              : 'applies only to windows on this host'}
          </span>
          <button onClick={openRaw}
            className="ml-auto text-[11px] text-desk-dim hover:text-desk-fg">
            edit file…
          </button>
        </div>

        {/* tokens */}
        <div className="flex-1 overflow-auto">
          {Object.entries(tokens).map(([name, decl]) => {
            const id = `${section}.${name}`
            const r = resolve(id, host)
            const key = configKey(id, decl.type)
            const setHere = (scope === 'local' ? localLayer() : layerFor(host))[key] !== undefined
            return (
              <div key={id}
                className="flex items-center gap-3 px-3 py-2 border-b border-desk-line/50">
                <div className="w-40 shrink-0">
                  <div className="text-xs">{decl.label}</div>
                  <div className="text-[10px] text-desk-dim font-mono truncate">{id}</div>
                </div>

                <div className="flex-1 min-w-0">
                  {decl.type === 'icon' ? (
                    <button
                      onClick={() => setPicking(picking === id ? null : id)}
                      className="flex items-center gap-2 px-2 py-1 rounded border border-desk-line
                                 hover:bg-white/5 text-xs">
                      <Icon id={r.value} size={16} />
                      <span className="font-mono text-[11px] text-desk-dim">{r.value || '—'}</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      {decl.type === 'color' && (
                        <input
                          type="color"
                          value={/^#[0-9a-f]{6}$/i.test(r.value) ? r.value : '#000000'}
                          onChange={e => write(id, decl, e.target.value)}
                          className="w-7 h-7 rounded border border-desk-line bg-transparent" />
                      )}
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
                  disabled={!setHere || busy}
                  onClick={() => write(id, decl)}
                  title={setHere ? 'Remove this override' : 'Nothing set at this layer'}
                  className="w-6 text-xs text-desk-dim hover:text-desk-fg disabled:opacity-20">↺</button>
              </div>
            )
          })}

          {picking && (
            <IconPicker
              onPick={v => {
                const name = picking.slice(picking.indexOf('.') + 1)
                const decl = tokens[name]
                if (decl) write(picking, decl, v)
                setPicking(null)
              }}
              onClose={() => setPicking(null)} />
          )}
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-desk-dim
                        border-t border-desk-line shrink-0">
          <span>{Object.keys(tokens).length} tokens</span>
          {busy && <span>· saving…</span>}
          {note && <span className="text-desk-ok">· {note}</span>}
          {err && <span className="text-desk-bad truncate">· {err}</span>}
        </div>
      </div>
    </div>
  )
}

/** Grid of every icon in every installed pack, plus a few glyph escapes. */
function IconPicker({ onPick, onClose }: { onPick: (v: string) => void; onClose: () => void }) {
  const packs = iconPacks()
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
         onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="w-[520px] max-h-[70%] overflow-auto rounded-lg border border-desk-line
                   bg-desk-panel p-3 shadow-2xl">
        {packs.map(pack => (
          <div key={pack.name} className="mb-3">
            <div className="text-[11px] text-desk-dim mb-1">
              {pack.name}{pack.bundled ? ' · bundled' : ''}
            </div>
            <div className="grid grid-cols-10 gap-1">
              {Object.keys(pack.icons).map(name => {
                const id = `${pack.name}:${name}`
                return (
                  <button key={id} title={id} onClick={() => onPick(id)}
                    className="flex items-center justify-center h-9 rounded hover:bg-white/10">
                    <Icon id={id} size={18} />
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        <div className="text-[11px] text-desk-dim">
          Emoji work too — type one into the field instead of picking here.
        </div>
      </div>
    </div>
  )
}
