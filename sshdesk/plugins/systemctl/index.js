/**
 * sshdesk plugin: systemctl
 *
 * Convention: ~/.sshdesk/plugins/<name>/index.js exporting `manifest`,
 * `createAdapter` and `createApp`.
 *
 * The adapter is the whole JSON -> CLI -> JSON boundary. Everything above it is
 * ordinary JavaScript: the platform passes React in, so a plugin never bundles
 * its own copy and hooks keep working.
 */

export const manifest = {
  id: 'systemctl',
  name: 'Services',
  icon: '⚙️',
  window: { w: 940, h: 580 },
}

export function createAdapter(sdk) {
  // Probed once per host and cached by the platform.
  const hasJson = () =>
    sdk.capability('systemctl-json', async exec => {
      const r = await exec(['systemctl', '--version'])
      const m = /systemd (\d+)/.exec(r.stdout)
      return !!m && Number(m[1]) >= 246
    })

  /** Column form is only used on systemd < 246, where -o json does not exist. */
  function parseColumns(stdout) {
    return stdout.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const f = line.replace(/^[●*\s]+/, '').split(/\s+/)
      return {
        unit: f[0] ?? '',
        load: f[1] ?? '',
        active: f[2] ?? '',
        sub: f[3] ?? '',
        description: f.slice(4).join(' '),
      }
    }).filter(s => s.unit.endsWith('.service'))
  }

  const UNIT = /^[A-Za-z0-9@._:\\-]+$/
  const checkUnit = u => {
    if (!UNIT.test(u)) throw new Error(`refusing suspicious unit name: ${u}`)
    return u
  }

  const ACTIONS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable']

  return {
    async list() {
      if (await hasJson()) {
        const r = await sdk.exec([
          'systemctl', 'list-units', '--type=service', '--all',
          '--no-legend', '--no-pager', '-o', 'json',
        ])
        if (r.code === 0 && r.stdout.trim().startsWith('[')) {
          return JSON.parse(r.stdout)
        }
      }
      const r = await sdk.exec([
        'systemctl', 'list-units', '--type=service', '--all', '--no-legend', '--no-pager',
      ])
      if (r.code !== 0) throw new Error(r.stderr || 'systemctl failed')
      return parseColumns(r.stdout)
    },

    /** exit 3 means "inactive" — data, not failure. */
    async isActive(unit) {
      const r = await sdk.exec(['systemctl', 'is-active', checkUnit(unit)])
      return r.stdout.trim() || (r.code === 3 ? 'inactive' : 'unknown')
    },

    async status(unit) {
      const r = await sdk.exec([
        'systemctl', 'status', checkUnit(unit), '--no-pager', '-n', '40',
      ])
      // status exits 3 for a stopped unit but still prints what we want
      return r.stdout || r.stderr
    },

    async action(verb, unit) {
      if (!ACTIONS.includes(verb)) throw new Error(`unknown action: ${verb}`)
      const r = await sdk.sudo(['systemctl', verb, checkUnit(unit)])
      if (r.code !== 0) throw new Error(r.stderr.trim() || `${verb} failed (exit ${r.code})`)
      return true
    },
  }
}

export function createApp({ React, html, api }) {
  const { useState, useEffect, useCallback, useMemo } = React

  return function Services({ setTitle }) {
    const [units, setUnits] = useState([])
    const [filter, setFilter] = useState('')
    const [onlyRunning, setOnlyRunning] = useState(false)
    const [sel, setSel] = useState(null)
    const [detail, setDetail] = useState('')
    const [err, setErr] = useState('')
    const [busy, setBusy] = useState(false)

    const load = useCallback(async () => {
      setBusy(true); setErr('')
      try { setUnits(await api.list()) }
      catch (e) { setErr(String(e)) }
      finally { setBusy(false) }
    }, [])

    useEffect(() => { load() }, [load])
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
        </div>
      </div>`
  }
}
