import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useFw } from './host'
import { Icon } from './Icon'
import type { DepStatus, Requirement } from '../fw'

/**
 * Gate an app on what it needs on the remote.
 *
 * Apps declare requirements; this checks them at launch and offers to resolve
 * what it can. Resolution is automatic, installation is not — clicking an app
 * icon should never quietly change a machine you administer. What will happen,
 * where it will land and whether it needs root are all on screen before the
 * button is pressed.
 *
 * "Not now" renders the app anyway. An app that is only partly crippled by a
 * missing tool is still the user's to use, and it can complain in its own
 * words better than a modal can.
 */
export function Requires({ requires, name, children }: {
  requires?: Requirement[]
  name: string
  children: ReactNode
}) {
  const fw = useFw()
  const [status, setStatus] = useState<DepStatus[] | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [working, setWorking] = useState('')
  const [err, setErr] = useState('')

  const check = useCallback(async () => {
    if (!requires?.length) { setStatus([]); return }
    setErr('')
    try { setStatus(await fw.deps.probe(requires)) }
    catch (e) { setErr(String(e)); setStatus([]) }
  }, [fw, requires])

  useEffect(() => { check() }, [check])

  const missing = (status ?? []).filter(s => !s.present)

  const installAll = async () => {
    setErr('')
    for (const s of missing) {
      const req = requires?.find(r => r.command === s.command)
      if (!req || !s.installable) continue
      // Only a package needs root; an archive goes in the user's own directory.
      let password: string | undefined
      if (req.kind === 'package') {
        const got = await fw.sys.sudoPassword(`Needed to install ${s.command}`)
        if (!got) return
        password = got
      }
      setWorking(`installing ${s.command}…`)
      try { await fw.deps.install(req, password) }
      catch (e) {
        setErr(`${s.command}: ${e}`)
        setWorking('')
        return
      }
    }
    setWorking('')
    await check()
  }

  if (status === null) {
    return <div className="flex items-center justify-center h-full text-xs text-desk-dim">
      checking what {name} needs…
    </div>
  }
  if (!missing.length || dismissed) return <>{children}</>

  const canInstall = missing.some(s => s.installable)

  return (
    <div className="flex items-center justify-center h-full p-6 bg-desk-panel">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2 mb-3">
          <Icon id="desk:download" size={16} className="text-desk-accent" />
          <span className="text-sm">
            {name} needs {missing.length === 1 ? 'one thing' : `${missing.length} things`}
          </span>
        </div>

        <div className="rounded-lg border border-desk-line divide-y divide-desk-line mb-3">
          {missing.map(s => (
            <div key={s.command} className="flex items-start gap-3 p-3">
              <Icon id={s.installable ? 'desk:plus' : 'desk:file'} size={14}
                    className={s.installable ? 'text-desk-accent mt-0.5' : 'text-desk-dim mt-0.5'} />
              <div className="min-w-0">
                <div className="text-xs font-mono">{s.command}</div>
                <div className="text-[11px] text-desk-dim">{s.detail}</div>
              </div>
              <span className="ml-auto text-[10px] text-desk-dim shrink-0">
                {s.kind === 'package' ? 'needs root' : s.kind === 'archive' ? 'no root' : ''}
              </span>
            </div>
          ))}
        </div>

        {err && <p className="mb-3 text-[11px] text-desk-bad break-words">{err}</p>}

        <div className="flex items-center gap-2">
          <button
            disabled={!canInstall || !!working}
            onClick={installAll}
            className="px-3 py-1.5 text-xs rounded bg-desk-accent/20 border border-desk-accent/60
                       text-desk-accent hover:bg-desk-accent/30 disabled:opacity-40">
            {working || 'Install'}
          </button>
          <button onClick={() => setDismissed(true)}
            className="px-3 py-1.5 text-xs rounded border border-desk-line
                       text-desk-dim hover:text-desk-fg">
            Not now
          </button>
          <button onClick={check} disabled={!!working}
            className="ml-auto text-[11px] text-desk-dim hover:text-desk-fg disabled:opacity-40">
            re-check
          </button>
        </div>

        {!canInstall && (
          <p className="mt-3 text-[11px] text-desk-dim">
            Nothing here can be installed automatically — these have to be put on
            the machine by hand.
          </p>
        )}
      </div>
    </div>
  )
}
