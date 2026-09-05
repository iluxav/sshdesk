/**
 * sshdesk plugin: Ports
 *
 * Shows what is listening on the remote, who owns it, and — the part no other
 * tool does — lets you tunnel a loopback-only port to your Mac in one click,
 * because the SSH connection is already open and `ssh -O forward` can add a
 * forward to a live connection.
 *
 * Built with esbuild using the classic JSX transform, so `<div/>` compiles to
 * `React.createElement(...)` and resolves to the React the platform passes in.
 * The plugin never imports or bundles React.
 */

export const manifest = {
  id: 'ports',
  name: 'Ports',
  icon: 'lucide:ethernet-port',
  window: { w: 940, h: 520 },
}

export function createAdapter(sdk) {
  const LOOPBACK = /^(127\.|::1|\[?::1\]?)/

  /**
   * `ss -ltnpH` is the only zero-install source that also tells us ownership:
   * as non-root it fills users:(...) only for processes we own, so anything
   * without it belongs to root or another user and must not be actionable.
   */
  function parse(stdout) {
    return stdout.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const f = line.split(/\s+/)
      const addr = f[3] ?? ''
      const i = addr.lastIndexOf(':')
      if (i < 0) return null
      const bind = addr.slice(0, i)
      const port = Number(addr.slice(i + 1))
      if (!port) return null

      const mine = line.includes('users:((')
      const pm = /users:\(\("([^"]+)",pid=(\d+)/.exec(line)
      return {
        port,
        bind,
        loopback: LOOPBACK.test(bind),
        process: pm ? pm[1] : '',
        pid: pm ? Number(pm[2]) : 0,
        mine,
      }
    }).filter(Boolean)
  }

  return {
    async list() {
      const r = await sdk.exec(['ss', '-ltnpH'])
      if (r.code !== 0) throw new Error(r.stderr || 'ss failed')
      // one row per port; prefer the entry that carries ownership info
      const byPort = new Map()
      for (const e of parse(r.stdout)) {
        const prev = byPort.get(e.port)
        if (!prev || (!prev.mine && e.mine)) byPort.set(e.port, e)
      }
      return [...byPort.values()].sort((a, b) => a.port - b.port)
    },

    async kill(pid, { force = false } = {}) {
      if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing pid ${pid}`)
      const argv = force ? ['kill', '-9', String(pid)] : ['kill', String(pid)]
      let r = await sdk.exec(argv)
      if (r.code !== 0 && /not permitted|Operation not permitted/i.test(r.stderr)) {
        r = await sdk.sudo(argv)                    // ours by ss, but root-owned
      }
      if (r.code !== 0) throw new Error(r.stderr.trim() || `kill failed (${r.code})`)
      return true
    },
  }
}

export function createApp({ React, useFw, useApi }) {
  const { useState, useEffect, useCallback, useMemo, useRef } = React

  /**
   * Ports you have forwarded before on this host, as { remotePort: localPort }.
   *
   * Only remembered ports are auto-forwarded. Forwarding everything that
   * appears is the version that is delightful for a day and irritating by the
   * end of the week — a box has plenty of ports you never want on your Mac.
   * Reusing the same local port also keeps a bookmarked URL working.
   */
  return function Ports({ setTitle }) {
    // Pinned to this window's machine: the 4s poll must not follow focus.
    const fw = useFw()
    const api = useApi()

    const memKey = () => `ports.remembered.${fw.host.current()}`
    const remembered = () => fw.prefs.get(memKey(), {})
    const remember = (remote, local) =>
      fw.prefs.set(memKey(), { ...remembered(), [remote]: local })
    const forget = remote => {
      const m = { ...remembered() }
      delete m[remote]
      fw.prefs.set(memKey(), m)
    }
    const [rows, setRows] = useState([])
    const [fwds, setFwds] = useState({})
    const [filter, setFilter] = useState('')
    const [mineOnly, setMineOnly] = useState(false)
    const [err, setErr] = useState('')
    const [note, setNote] = useState('')
    const [busy, setBusy] = useState(false)
    const [auto, setAuto] = useState(() => fw.prefs.get('ports.auto', true))
    const reconciling = useRef(false)

    const load = useCallback(async () => {
      setBusy(true); setErr('')
      try {
        const [list, f] = await Promise.all([api.list(), fw.net.forwards()])
        setRows(list); setFwds(f)
      } catch (e) { setErr(String(e)) }
      finally { setBusy(false) }
    }, [])

    useEffect(() => { load() }, [load])
    useEffect(() => { setTitle && setTitle('Ports') }, [setTitle])
    useEffect(() => { fw.prefs.set('ports.auto', auto) }, [auto])

    /**
     * Re-establish remembered forwards for ports that are listening again.
     * Runs on a timer rather than on demand so a dev server started in the
     * terminal shows up on your Mac without touching this window.
     */
    const reconcile = useCallback(async () => {
      if (reconciling.current) return
      reconciling.current = true
      try {
        const [list, active] = await Promise.all([api.list(), fw.net.forwards()])
        setRows(list)
        const mem = remembered()
        let changed = false
        for (const r of list) {
          if (!r.mine) continue
          if (active[r.port]) continue
          const want = mem[r.port]
          if (want === undefined) continue
          const local = await fw.net.forward(r.port, want)
          if (local !== want) remember(r.port, local)   // port was taken; keep the new one
          changed = true
        }
        setFwds(changed ? await fw.net.forwards() : active)
      } catch { /* transient: host busy or reconnecting */ }
      finally { reconciling.current = false }
    }, [])

    useEffect(() => {
      if (!auto) return
      reconcile()
      const t = setInterval(reconcile, 4000)
      return () => clearInterval(t)
    }, [auto, reconcile])

    const shown = useMemo(() => {
      const f = filter.trim().toLowerCase()
      return rows
        .filter(r => !mineOnly || r.mine)
        .filter(r => !f || String(r.port).includes(f) ||
                     r.process.toLowerCase().includes(f) ||
                     r.bind.toLowerCase().includes(f))
    }, [rows, filter, mineOnly])

    const run = async (fn, ok) => {
      setErr(''); setNote(''); setBusy(true)
      try { await fn(); if (ok) setNote(ok) }
      catch (e) { setErr(String(e).replace(/^Error:\s*/, '')) }
      finally { setBusy(false) }
    }

    const forward = r => run(async () => {
      const local = await fw.net.forward(r.port, remembered()[r.port])
      remember(r.port, local)               // forwarding once opts the port in
      setFwds(await fw.net.forwards())
      setNote(`remote ${r.port} → localhost:${local}`)
    })

    const unforward = r => run(async () => {
      await fw.net.unforward(r.port)
      forget(r.port)                        // and unforwarding opts it back out
      setFwds(await fw.net.forwards())
    }, `stopped forwarding ${r.port}`)

    const kill = (r, force) => run(async () => {
      await api.kill(r.pid, { force })
      await load()
    }, `killed ${r.process} (${r.pid})`)

    return (
      <div className="ports-root">
        <div className="ports-bar">
          <input
            className="ports-input"
            value={filter}
            spellCheck={false}
            placeholder="filter port, process or bind"
            onChange={e => setFilter(e.target.value)}
          />
          <label className="ports-check">
            <input
              type="checkbox"
              checked={mineOnly}
              onChange={e => setMineOnly(e.target.checked)}
            />
            mine only
          </label>
          <label className="ports-check" title="Re-forward ports you have forwarded before on this host">
            <input
              type="checkbox"
              checked={auto}
              onChange={e => setAuto(e.target.checked)}
            />
            auto
          </label>
          <button className="ports-btn" onClick={load} title="Refresh">⟳</button>
          <span className="ports-spacer" />
          {note && <span className="ports-note">{note}</span>}
        </div>

        {err && <div className="ports-err">{err}</div>}

        <div className="ports-scroll">
          <table className="ports-table">
            <thead>
              <tr>
                <th style={{ width: 78 }}>Port</th>
                <th style={{ width: 132 }}>Bind</th>
                <th>Process</th>
                <th style={{ width: 74 }}>PID</th>
                <th style={{ width: 96 }}>Owner</th>
                <th style={{ width: 250 }} />
              </tr>
            </thead>
            <tbody>
              {shown.map(r => {
                const local = fwds[r.port]
                return (
                  <tr key={`${r.port}-${r.bind}`}>
                    <td className="mono">{r.port}</td>
                    <td className="dim mono">
                      {r.bind}
                      {r.loopback && <span className="ports-tag">loopback</span>}
                    </td>
                    <td className="mono">{r.process || <span className="dim">—</span>}</td>
                    <td className="dim mono">{r.pid || ''}</td>
                    <td>
                      <span className={r.mine ? 'ports-badge mine' : 'ports-badge'}>
                        {r.mine ? 'yours' : 'system'}
                      </span>
                    </td>
                    <td className="ports-actions">
                      {local ? (
                        <>
                          <button
                            className="ports-btn accent"
                            onClick={() => fw.net.openUrl(`http://localhost:${local}`)}
                          >
                            open :{local}
                          </button>
                          <button className="ports-btn" disabled={busy}
                                  onClick={() => unforward(r)}>
                            unforward
                          </button>
                        </>
                      ) : (
                        <button className="ports-btn" disabled={busy}
                                onClick={() => forward(r)}
                                title="Tunnel this port to your Mac">
                          forward
                        </button>
                      )}
                      {r.mine && r.pid > 1 && (
                        <button className="ports-btn danger" disabled={busy}
                                onClick={() => kill(r, false)}
                                title="SIGTERM (shift-click for SIGKILL)"
                                onMouseDown={e => { if (e.shiftKey) { e.preventDefault(); kill(r, true) } }}>
                          kill
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="ports-status">
          {shown.length} of {rows.length} listening
          {' · '}{rows.filter(r => r.mine).length} yours
          {' · '}{Object.keys(fwds).length} forwarded
          {' · '}{Object.keys(remembered()).length} remembered
          {auto && ' · auto'}
          {busy && ' · working…'}
        </div>
      </div>
    )
  }
}
