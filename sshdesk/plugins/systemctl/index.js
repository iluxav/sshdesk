/**
 * sshdesk plugin: systemctl
 *
 * Convention: ~/.sshdesk/plugins/<name>/index.js exporting `manifest`,
 * `createAdapter` and `createApp`.
 *
 * Ported to tier 1: reads go over D-Bus (typed both ways, no parsing, nothing
 * spawned on the remote), writes stay on sudo, and only the log tail still
 * shells out. Everything above the adapter is ordinary JavaScript — the
 * platform passes React in, so a plugin never bundles its own copy.
 */

export const manifest = {
  id: 'systemctl',
  name: 'Services',
  icon: '⚙️',
  window: { w: 940, h: 580 },
}

export function createAdapter(sdk) {
  const SYSTEMD = 'org.freedesktop.systemd1'
  const MANAGER = '/org/freedesktop/systemd1'

  const UNIT = /^[A-Za-z0-9@._:-]+$/
  const checkUnit = u => {
    if (!UNIT.test(u)) throw new Error(`refusing suspicious unit name: ${u}`)
    return u
  }

  const ACTIONS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable']

  /** ListUnits returns a tuple per unit; these are its field positions. */
  const NAME = 0, DESC = 1, LOAD = 2, ACTIVE = 3, SUB = 4, OBJ = 6

  return {
    /**
     * Tier 1. This replaces a capability probe (does systemd support -o json?),
     * a JSON path, and a whole column-splitting fallback parser for older
     * systemd — because the bus API has been the same shape the entire time.
     * It also spawns no process on the remote, which is where the latency was.
     */
    async list() {
      const [units] = await sdk.dbus.systemd('ListUnits')
      return units
        .filter(u => u[NAME].endsWith('.service'))
        .map(u => ({
          unit: u[NAME],
          description: u[DESC],
          load: u[LOAD],
          active: u[ACTIVE],
          sub: u[SUB],
          path: u[OBJ],
        }))
    },

    /** Typed property, so there is no exit code to reinterpret. */
    async isActive(unit) {
      const [path] = await sdk.dbus.systemd('GetUnit', 's', [checkUnit(unit)])
      return await sdk.dbus.get(SYSTEMD, path, `${SYSTEMD}.Unit`, 'ActiveState')
    },

    /**
     * Deliberately mixed tiers: the facts come from typed properties, the log
     * tail from journalctl. There is no bus API that renders a log, and
     * pretending otherwise would mean parsing something worse.
     */
    async status(unit) {
      const name = checkUnit(unit)
      const [path] = await sdk.dbus.systemd('GetUnit', 's', [name])
      const props = ['Description', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState']
      const svc = ['MainPID', 'ExecMainStartTimestamp']

      const head = {}
      for (const p of props) {
        head[p] = await sdk.dbus.get(SYSTEMD, path, `${SYSTEMD}.Unit`, p)
      }
      for (const p of svc) {
        try { head[p] = await sdk.dbus.get(SYSTEMD, path, `${SYSTEMD}.Service`, p) }
        catch { /* not a service unit */ }
      }

      const lines = [
        `${name} - ${head.Description ?? ''}`,
        `   Loaded: ${head.LoadState} (${head.UnitFileState ?? 'n/a'})`,
        `   Active: ${head.ActiveState} (${head.SubState})`,
      ]
      if (head.MainPID) lines.push(` Main PID: ${head.MainPID}`)

      // tier 3 for the log tail only
      const r = await sdk.exec(['journalctl', '-u', name, '-n', '40', '--no-pager', '-o', 'short'])
      return lines.join('\n') + '\n\n' + (r.stdout || r.stderr || '(no journal entries)')
    },

    /**
     * Still tier 3, and on purpose. The bus equivalent is refused by polkit
     * unless a pkttyagent is registered for this ssh session and the call sets
     * ALLOW_INTERACTIVE_AUTHORIZATION — machinery that would replace one line
     * which already works. See sshdesk's dbus.rs for the full finding.
     */
    async action(verb, unit) {
      if (!ACTIONS.includes(verb)) throw new Error(`unknown action: ${verb}`)
      const r = await sdk.sudo(['systemctl', verb, checkUnit(unit)])
      if (r.code !== 0) throw new Error(r.stderr.trim() || `${verb} failed (exit ${r.code})`)
      return true
    },
  }
}

export function createApp({ React, html, api, fw }) {
  const { useState, useEffect, useCallback, useMemo } = React

  return function Services({ setTitle }) {
    const [units, setUnits] = useState([])
    const [filter, setFilter] = useState('')
    const [onlyRunning, setOnlyRunning] = useState(false)
    const [sel, setSel] = useState(null)
    const [detail, setDetail] = useState('')
    const [err, setErr] = useState('')
    const [busy, setBusy] = useState(false)
    // Push activity, so "working but quiet" is distinguishable from "broken".
    const [live, setLive] = useState(false)
    const [pushes, setPushes] = useState(0)
    const [lastPush, setLastPush] = useState(0)

    const load = useCallback(async () => {
      setBusy(true); setErr('')
      try { setUnits(await api.list()) }
      catch (e) { setErr(String(e)) }
      finally { setBusy(false) }
    }, [])

    useEffect(() => { load() }, [load])

    // Push, not poll. The backend holds one D-Bus subscription per host and
    // systemd tells us when a job finishes — so starting a service in a
    // terminal updates this list too, with no timer and no round trips.
    //
    // Two things this has to get right that are easy to miss:
    //
    // 1. Signals arrive in bursts. A single ssh login emits UnitNew +
    //    JobRemoved + UnitRemoved for its session scope. Reloading per signal
    //    would mean four full ListUnits calls for one uninteresting event, so
    //    they are coalesced.
    // 2. A refresh that returns identical data is invisible. Without some
    //    indicator, a working push looks exactly like a broken one — which is
    //    precisely how this felt the first time it ran.
    useEffect(() => {
      let mounted = true
      let timer = null

      fw.sys.watchUnits()
        .then(() => { if (mounted) setLive(true) })
        .catch(() => { /* older backend: stay manual */ })

      // JobRemoved carries the unit at args[2]; UnitNew/UnitRemoved at args[0].
      const unitOf = p =>
        p && (p.member === 'JobRemoved' ? p.args?.[2] : p.args?.[0])

      const off = fw.bus.on('units:changed', payload => {
        if (!mounted) return
        setPushes(n => n + 1)
        setLastPush(Date.now())

        // Every ssh login churns a session-N.scope. Counting it as activity is
        // honest; refetching 193 units because of it is not.
        const unit = String(unitOf(payload) ?? '')
        if (!unit.endsWith('.service')) return

        clearTimeout(timer)
        timer = setTimeout(() => { if (mounted) load() }, 250)
      })
      const offStop = fw.bus.on('units:stopped', () => { if (mounted) setLive(false) })

      return () => { mounted = false; clearTimeout(timer); off(); offStop() }
    }, [load])

    // Re-render the "Ns ago" label without re-fetching anything.
    const [, tick] = useState(0)
    useEffect(() => {
      if (!lastPush) return
      const t = setInterval(() => tick(n => n + 1), 1000)
      return () => clearInterval(t)
    }, [lastPush])
    useEffect(() => { setTitle && setTitle('Services') }, [setTitle])

    const rows = useMemo(() => {
      const f = filter.toLowerCase()
      return units
        .filter(u => !onlyRunning || u.sub === 'running')
        .filter(u => !f || u.unit.toLowerCase().includes(f) ||
                     (u.description || '').toLowerCase().includes(f))
        .sort((a, b) => (b.sub === 'running') - (a.sub === 'running') ||
                        a.unit.localeCompare(b.unit))
    }, [units, filter, onlyRunning])

    const act = async verb => {
      if (!sel) return
      setErr(''); setBusy(true)
      try { await api.action(verb, sel.unit); await load() }
      catch (e) { setErr(String(e)) }
      finally { setBusy(false) }
    }

    const show = async u => {
      if (sel && sel.unit === u.unit) { setSel(null); setDetail(''); return }
      setSel(u); setDetail('loading\u2026')
      try { setDetail(await api.status(u.unit)) }
      catch (e) { setDetail(String(e)) }
    }

    const dot = u =>
      u.sub === 'running' ? 'bg-desk-ok'
      : u.active === 'failed' ? 'bg-desk-bad'
      : 'bg-desk-dim/50'

    const VERBS = ['start', 'stop', 'restart', 'enable', 'disable']

    return html`
      <div class="flex flex-col h-full bg-desk-panel text-desk-fg">

        <div class="flex items-center gap-2 px-2 py-1.5 border-b border-desk-line shrink-0">
          <input
            value=${filter}
            placeholder="filter services"
            spellcheck="false"
            onInput=${e => setFilter(e.target.value)}
            class="bg-black/40 border border-desk-line rounded px-2 py-1 text-xs w-56
                   outline-none focus:border-desk-accent select-text" />
          <label class="flex items-center gap-1 text-[11px] text-desk-dim">
            <input type="checkbox" checked=${onlyRunning}
                   onChange=${e => setOnlyRunning(e.target.checked)} />
            running only
          </label>
          <button onClick=${load} class="px-2 py-1 rounded hover:bg-white/10 text-xs">\u27F3</button>
          <span class="ml-auto flex gap-1">
            ${VERBS.map(v => html`
              <button key=${v} disabled=${!sel || busy} onClick=${() => act(v)}
                class="px-2 py-1 rounded text-xs border border-desk-line
                       hover:bg-white/10 disabled:opacity-30">${v}</button>`)}
          </span>
        </div>

        ${err && html`
          <div class="px-3 py-1.5 text-xs bg-desk-bad/15 text-desk-bad
                      border-b border-desk-bad/30 shrink-0 select-text break-all">${err}</div>`}

        <div class="flex flex-1 min-h-0 overflow-hidden">
          <div class="flex-1 min-w-0 overflow-auto">
            <table class="w-full text-xs"><tbody>
              ${rows.map(u => html`
                <tr key=${u.unit} onClick=${() => show(u)}
                    class=${'cursor-default ' + (sel && sel.unit === u.unit
                      ? 'bg-desk-accent/25' : 'hover:bg-white/5')}>
                  <td class="px-3 py-1 w-4">
                    <span class=${'inline-block w-1.5 h-1.5 rounded-full ' + dot(u)}></span>
                  </td>
                  <td class="py-1 font-mono truncate">${u.unit}</td>
                  <td class="py-1 px-2 text-desk-dim truncate">${u.description || ''}</td>
                  <td class="py-1 px-2 w-20 text-desk-dim">${u.sub || ''}</td>
                </tr>`)}
            </tbody></table>
          </div>

          ${sel && html`
            <div class="sysctl-detail">
              <div class="sysctl-detail-head">
                <span class="font-mono truncate">${sel.unit}</span>
                <button class="sysctl-close" title="Back to list"
                        onClick=${() => { setSel(null); setDetail('') }}>\u00D7</button>
              </div>
              <pre class="sysctl-log">${detail}</pre>
            </div>`}
        </div>

        <div class="px-3 py-1.5 text-[11px] text-desk-dim border-t border-desk-line shrink-0">
          ${rows.length} of ${units.length} services${sel ? ' \u00B7 ' + sel.unit : ''}${busy ? ' \u00B7 working\u2026' : ''}
          ${live && html`<span class="sc-live" title=${
            pushes
              ? `${pushes} push(es) from systemd; last ${Math.round((Date.now() - lastPush) / 1000)}s ago`
              : 'subscribed to systemd — nothing has changed on this host yet'
          }> \u00B7 <span class="sc-dot"></span> live${
            pushes ? ` \u00B7 ${pushes} push${pushes === 1 ? '' : 'es'}` : ''
          }${
            lastPush ? ` \u00B7 ${Math.round((Date.now() - lastPush) / 1000)}s ago` : ''
          }</span>`}
        </div>
      </div>`
  }
}
