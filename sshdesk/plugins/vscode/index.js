/**
 * sshdesk plugin: VS Code
 *
 * A test of whether the platform is real: this adds a full IDE with no change
 * to sshdesk itself. The dependency comes from the manifest, the server is
 * started with `sdk.exec`, the port is forwarded with `fw.net.forward` on the
 * live connection, and the result is an iframe. Nothing here is privileged.
 *
 * Why a server on the remote rather than VS Code Web bundled in the app: web
 * builds only run *web* extensions. No rust-analyzer, no gopls, no debugger —
 * anything that spawns a process needs an extension host on a machine. Putting
 * that host where the code already is, is the whole point.
 */

const VERSION = '1.109.5'
const REL = `https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${VERSION}`

export const manifest = {
  id: 'vscode',
  name: 'VS Code',
  icon: '🧑‍💻',
  window: { w: 1180, h: 780 },

  requires: [{
    kind: 'archive',
    command: 'openvscode-server',
    url: `${REL}/openvscode-server-v${VERSION}-linux-\${arch}.tar.gz`,
    // Published by GitHub alongside the assets. Checked before anything is
    // unpacked — this downloads a binary that then gets executed.
    sha256: {
      aarch64: '36d9c14036489b63de84ebace837fcacf7e60e669a0dc715802c5443684ea4dc',
      x86_64:  'b433bf4f0227321a7014d8460d10a8f958adc0f45aa79bd889e84e65e8f88363',
      armv7l:  'f84ac0dcea0bdeac07e172e58903b38bc5ef0ac94b0bf2ab2ce4eca325ab98bb',
    },
    // uname -m says aarch64; the release calls it arm64.
    arch_map: { aarch64: 'arm64', x86_64: 'x64', armv7l: 'armhf' },
    into: 'openvscode-server',
    bin: 'bin/openvscode-server',
  }],

  tokens: {
    app: { type: 'icon', default: 'lucide:code-xml', label: 'App icon' },
  },
}

const OPT = '$HOME/.sshdesk/opt'
const LOG = `${OPT}/openvscode.log`
const PID = `${OPT}/openvscode.pid`

/** Pull the port and token out of the line the server prints on startup. */
function parseUrl(text) {
  const m = /http:\/\/localhost:(\d+)\??tkn=([0-9a-f]+)/.exec(text || '')
  return m ? { port: Number(m[1]), token: m[2] } : null
}

export function createAdapter(sdk) {
  // Started with nohup and a pidfile so it outlives the command that launched
  // it — the persistent shell is for request/response, and a server is not
  // that. Re-running is idempotent: an already-live server is reused rather
  // than a second one started beside it.
  const START = `
    set -e
    D="${OPT}/openvscode-server"
    if [ -f "${PID}" ] && kill -0 "$(cat "${PID}" 2>/dev/null)" 2>/dev/null; then
      grep -o 'http://localhost:[0-9]*?tkn=[0-9a-f]*' "${LOG}" | tail -1
      exit 0
    fi
    TOK=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n')
    rm -f "${LOG}"
    nohup "$D/bin/openvscode-server" \
      --host 127.0.0.1 --port 0 --connection-token "$TOK" \
      --server-data-dir "${OPT}/openvscode-data" \
      --telemetry-level off --accept-server-license-terms \
      > "${LOG}" 2>&1 &
    echo $! > "${PID}"
    for _ in $(seq 1 80); do
      grep -q 'available at' "${LOG}" 2>/dev/null && break
      sleep 0.25
    done
    grep -o 'http://localhost:[0-9]*?tkn=[0-9a-f]*' "${LOG}" | tail -1
  `

  const STOP = `
    if [ -f "${PID}" ]; then kill "$(cat "${PID}")" 2>/dev/null || true; rm -f "${PID}"; fi
  `

  return {
    /** Start (or adopt) the server and return where it is listening. */
    async start() {
      const r = await sdk.exec(['sh', '-c', START])
      const found = parseUrl(r.stdout)
      if (!found) {
        const why = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n')
        throw new Error(why || 'the server did not report a URL')
      }
      return found
    },

    async stop() {
      await sdk.exec(['sh', '-c', STOP])
    },

    /** Last few log lines, for when starting goes wrong. */
    async log() {
      const r = await sdk.exec(['sh', '-c', `tail -30 "${LOG}" 2>/dev/null || true`])
      return r.stdout
    },
  }
}

export function createApp({ React, html, api, fw }) {
  const { useState, useEffect, useCallback, useRef } = React

  return function VSCode({ setTitle }) {
    const [url, setUrl] = useState('')
    const [err, setErr] = useState('')
    const [log, setLog] = useState('')
    const [status, setStatus] = useState('starting the server…')
    const remotePort = useRef(0)

    useEffect(() => { setTitle && setTitle('VS Code') }, [setTitle])

    const boot = useCallback(async () => {
      setErr(''); setLog(''); setUrl(''); setStatus('starting the server…')
      try {
        const { port, token } = await api.start()
        remotePort.current = port
        setStatus('forwarding the port…')
        // Same primitive as everything else: added to the connection that is
        // already open, so there is no reconnect and no second authentication.
        const local = await fw.net.forward(port)
        // 127.0.0.1 is a trustworthy origin, so an http iframe inside the app
        // is not blocked as mixed content the way any other host would be.
        setUrl(`http://127.0.0.1:${local}/?tkn=${token}`)
        setStatus('')
      } catch (e) {
        setErr(String(e))
        setStatus('')
        try { setLog(await api.log()) } catch { /* best effort */ }
      }
    }, [])

    useEffect(() => { boot() }, [boot])

    const restart = async () => {
      try { await api.stop() } catch { /* it may already be gone */ }
      if (remotePort.current) {
        try { await fw.net.unforward(remotePort.current) } catch { /* ditto */ }
      }
      boot()
    }

    if (url) {
      return html`
        <iframe
          src=${url}
          title="VS Code"
          style="width:100%;height:100%;border:0;display:block;background:var(--color-desk-bg)"
          allow="clipboard-read; clipboard-write" />`
    }

    return html`
      <div class="vsc-boot">
        ${status && html`<p class="vsc-status">${status}</p>`}
        ${err && html`
          <div class="vsc-err">
            <p>${err}</p>
            ${log && html`<pre class="vsc-log">${log}</pre>`}
            <button class="vsc-btn" onClick=${restart}>try again</button>
          </div>`}
      </div>`
  }
}
