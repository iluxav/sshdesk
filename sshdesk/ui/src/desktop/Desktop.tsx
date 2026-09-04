import { useCallback, useEffect, useRef, useState } from 'react'
import { useWM, nextId } from '../wm/store'
import { Window } from '../wm/Window'
import { HostScope } from '../wm/host'
import { declareCoreTokens } from './tokens'
import { onTokensChanged, setConfig } from '../fw/tokens'
import { loadIconPacks } from '../fw/icons'
import { applyTheme } from '../fw/theme'
import { APPS } from './registry'
import { Dock } from './Dock'
import { MenuBar } from './MenuBar'
import { Connections } from './Connections'
import { fw } from '../fw'
import { useDialog } from '../wm/Dialog'
import { setPasswordPrompt, resetSdk } from '../ext/sdk'
import { reloadPlugins, onPluginsChanged } from '../ext/loader'

export function Desktop() {
  const { state, dispatch } = useWM()
  /** Every connected machine. Windows are pinned to one of these. */
  const [hosts, setHosts] = useState<string[]>([])
  // Re-rendering on theme change keeps icon tokens live without every consumer
  // subscribing individually.
  const [, bumpTheme] = useState(0)
  /**
   * The focused pane. Each connected machine gets its own column, so where a
   * window *is* on screen tells you which machine it acts on — no mode to
   * remember, and no way to confuse two identical-looking Files windows.
   */
  const [active, setActive] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const dlg = useDialog()
  const [, bumpPlugins] = useState(0)

  const winsRef = useRef(state.wins)
  useEffect(() => { winsRef.current = state.wins })
  const activeRef = useRef<string | null>(null)
  useEffect(() => { activeRef.current = active }, [active])

  // Tokens, icon packs and config, once at boot.
  useEffect(() => {
    declareCoreTokens()
    let live = true
    ;(async () => {
      await loadIconPacks().catch(() => [])
      const cfg = await fw.config.load().catch(() => null)
      if (!live) return
      if (cfg) {
        setConfig(cfg.values)
        for (const w of cfg.warnings) console.warn('config:', w)
      }
      applyTheme()
      bumpTheme(n => n + 1)
    })()
    return () => { live = false }
  }, [])

  useEffect(() => onTokensChanged(() => {
    applyTheme()
    bumpTheme(n => n + 1)
  }), [])

  useEffect(() => { fw.ui._installDialogs(dlg) }, [dlg])
  useEffect(() => onPluginsChanged(() => bumpPlugins(n => n + 1)), [])

  useEffect(() => {
    setPasswordPrompt(async host =>
      dlg.prompt({
        title: 'Administrator password',
        label: `Needed to run a privileged command on ${host}`,
        placeholder: 'password',
        okLabel: 'Run',
      }))
  }, [dlg])

  // Apps opening other apps inherit the calling window's host when possible.
  useEffect(() => {
    fw.ui._install((appId, props) => {
      const app = APPS.find(a => a.id === appId)
      if (!app) return
      const host = (props?.host as string) ?? activeRef.current
      if (!host) return
      const existing = winsRef.current.find(w =>
        w.appId === appId && w.host === host && props?.path && (w.props as any)?.path === props.path)
      if (existing) { dispatch({ t: 'focus', id: existing.id }); return }
      const n = winsRef.current.filter(w => w.appId === appId).length
      dispatch({ t: 'open', win: {
        id: nextId(appId), appId, host, title: app.title, icon: app.icon,
        x: 100 + (n % 6) * 30, y: 70 + (n % 6) * 28, w: app.w, h: app.h, props,
      }})
    })
  }, [dispatch])

  const reload = useCallback(async () =>
    reloadPlugins(appIds => {
      winsRef.current
        .filter(w => appIds.includes(w.appId))
        .forEach(w => dispatch({ t: 'close', id: w.id }))
    }), [dispatch])

  const connected = useCallback((target: string) => {
    setHosts(h => (h.includes(target) ? h : [...h, target]))
    setActive(target)
    setAdding(false)
  }, [])

  /** Disconnect one machine: its windows go with it, the others stay. */
  const disconnect = useCallback(async (target: string) => {
    winsRef.current.filter(w => w.host === target)
      .forEach(w => dispatch({ t: 'close', id: w.id }))
    try { await fw.for(target).host.disconnect() } catch { /* already gone */ }
    resetSdk(target)
    setHosts(prev => {
      const next = prev.filter(h => h !== target)
      setActive(cur => (cur === target ? next[0] ?? null : cur))
      return next
    })
  }, [dispatch])

  if (!active || adding) {
    return (
      <Connections
        connected={hosts}
        onConnected={connected}
        onCancel={hosts.length ? () => setAdding(false) : undefined}
      />
    )
  }

  return (
    <div className="relative w-full h-full overflow-hidden
                    bg-[radial-gradient(ellipse_at_30%_0%,#1b2430_0%,#0f1116_60%)]">
      <MenuBar
        hosts={hosts}
        active={active}
        onSwitch={setActive}
        onAdd={() => setAdding(true)}
        onDisconnect={disconnect}
        onReloadPlugins={reload}
      />

      {/* One column per machine. Windows are absolutely positioned inside their
          own pane, so a window can never drift onto another machine's half. */}
      <div className="absolute inset-0 top-7 bottom-14 flex">
        {hosts.map((h, i) => {
          const mine = state.wins.filter(w => w.host === h)
          const focused = h === active
          return (
            <div
              key={h}
              onPointerDownCapture={() => setActive(h)}
              className={`relative flex-1 min-w-0 overflow-hidden transition-colors
                          ${i > 0 ? 'border-l border-desk-line' : ''}
                          ${focused ? 'bg-white/[0.015]' : ''}`}
            >
              {hosts.length > 1 && (
                <div className={`absolute top-0 inset-x-0 h-6 px-3 flex items-center gap-2
                                 text-[10px] pointer-events-none z-0
                                 ${focused ? 'text-desk-fg/70' : 'text-desk-dim/50'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    focused ? 'bg-desk-ok' : 'bg-desk-dim/60'}`} />
                  <span className="truncate">{h}</span>
                </div>
              )}

              {mine.length === 0 && (
                <div className="absolute inset-0 grid place-items-center pointer-events-none">
                  <p className="text-desk-dim text-xs">
                    {focused ? 'Open an app from the dock.' : 'click to focus'}
                  </p>
                </div>
              )}

              {mine.map(w => {
                const app = APPS.find(a => a.id === w.appId)
                if (!app) return null
                const C = app.component
                return (
                  <Window key={w.id} win={w}>
                    <HostScope host={w.host}>
                      <C
                        winId={w.id}
                        host={w.host}
                        setTitle={(title: string) => dispatch({ t: 'title', id: w.id, title })}
                        {...(w.props ?? {})}
                      />
                    </HostScope>
                  </Window>
                )
              })}
            </div>
          )
        })}
      </div>

      <Dock host={active} paneCount={hosts.length} />
    </div>
  )
}
