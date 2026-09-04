import { useEffect, useRef } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useFw } from '../wm/host'

let seq = 0

/** base64 -> bytes -> string, since PTY chunks can split a UTF-8 sequence. */
const decoder = new TextDecoder('utf-8', { fatal: false })
function decode(b64: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  // stream: true keeps a partial multi-byte char for the next chunk
  return decoder.decode(bytes, { stream: true })
}

export function Terminal({ setTitle }: { setTitle?: (t: string) => void }) {
  const fw = useFw()
  const host = useRef<HTMLDivElement>(null)
  const idRef = useRef(`term-${++seq}`)

  useEffect(() => {
    if (!host.current) return
    const id = idRef.current
    const target = fw.host.current()

    const term = new Xterm({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: '#1a1d24', foreground: '#e6e8ec', cursor: '#60a5fa',
        selectionBackground: '#60a5fa55',
        black: '#1a1d24', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
        blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e6e8ec',
        brightBlack: '#5a6272', brightRed: '#fca5a5', brightGreen: '#86efac',
        brightYellow: '#fcd34d', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9', brightWhite: '#ffffff',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(host.current)
    fit.fit()

    setTitle?.(`Terminal — ${target}`)

    let disposed = false
    const unlistens: Array<() => void> = []

    void (async () => {
      try {
        // withGlobalTauri is enabled, so use the global API rather than a
        // dynamic import of @tauri-apps/api — one less thing to bundle and
        // one less place for module resolution to fail silently.
        const listen = (window as any).__TAURI__?.event?.listen
        if (typeof listen !== 'function') {
          throw new Error('Tauri event API unavailable')
        }

        const un1 = await listen('term:data', (e: any) => {
          if (e.payload.id === id) term.write(decode(e.payload.b64))
        })
        const un2 = await listen('term:exit', (e: any) => {
          if (e.payload.id === id) term.write('\r\n\x1b[2m[session closed]\x1b[0m\r\n')
        })
        unlistens.push(un1, un2)
        if (disposed) { un1(); un2(); return }

        // Before layout settles xterm reports 0 — never ask for a 0x0 pty.
        const cols = term.cols > 0 ? term.cols : 80
        const rows = term.rows > 0 ? term.rows : 24
        await fw.term.open(id, target, cols, rows)

        term.onData(d => { void fw.term.write(id, d) })
        term.focus()
      } catch (err) {
        term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`)
      }
    })()

    // xterm needs an explicit fit; the window has no resize event of its own.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        void fw.term.resize(id, term.cols, term.rows)
      } catch { /* element detached */ }
    })
    ro.observe(host.current)

    return () => {
      disposed = true
      ro.disconnect()
      unlistens.forEach(u => u())
      void fw.term.close(id)
      term.dispose()
    }
  }, [setTitle])

  return <div ref={host} className="w-full h-full bg-desk-panel p-1 overflow-hidden" />
}
