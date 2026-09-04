import { useCallback, useEffect, useRef, useState } from 'react'
import { useFw } from '../wm/host'
import { Icon } from '../wm/Icon'
import { mimeOf } from '../fw/mime'

/**
 * Image preview.
 *
 * Bytes come over SFTP and become a data URL. That is the whole trick: the
 * webview cannot reach the remote, and a local HTTP shim to serve one image
 * would be a server, a port and a lifetime to manage for something a base64
 * string does in one round trip.
 *
 * SVG is rendered through <img>, where scripts do not run — worth being
 * deliberate about, since these bytes come from a machine you may not control.
 */
export function ImageViewer({ path, setTitle }: {
  path?: string
  setTitle?: (t: string) => void
}) {
  const fw = useFw()
  const [src, setSrc] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [size, setSize] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)

  /** null means fit-to-window; a number is an explicit scale. */
  const [zoom, setZoom] = useState<number | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const box = useRef<HTMLDivElement>(null)

  const name = path ? fw.path.base(path) : ''

  useEffect(() => { setTitle?.(name || 'Preview') }, [name, setTitle])

  const load = useCallback(async () => {
    if (!path) return
    setBusy(true); setErr(''); setSrc(''); setDims(null)
    setZoom(null); setPan({ x: 0, y: 0 })
    try {
      const r = await fw.fs.readBinary(path)
      setSize(r.size)
      setTruncated(r.truncated)
      setSrc(`data:${r.mime || mimeOf(path)};base64,${r.b64}`)
    } catch (e) { setErr(String(e)) } finally { setBusy(false) }
  }, [fw, path])

  useEffect(() => { load() }, [load])

  // Fit is computed rather than left to CSS so the status bar can report a
  // percentage, and so toggling to 1:1 has something to toggle back to.
  const fitScale = () => {
    const el = box.current
    if (!el || !dims) return 1
    return Math.min(1, (el.clientWidth - 24) / dims.w, (el.clientHeight - 24) / dims.h)
  }
  const scale = zoom ?? fitScale()

  const nudgeZoom = (factor: number) => {
    setZoom(z => Math.min(16, Math.max(0.05, (z ?? fitScale()) * factor)))
  }

  const drag = useRef<{ x: number; y: number } | null>(null)

  return (
    <div className="flex flex-col h-full bg-desk-panel text-desk-fg">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-desk-line shrink-0">
        <button onClick={() => nudgeZoom(1 / 1.25)} title="Zoom out"
          className="px-2 py-0.5 text-xs rounded hover:bg-white/10">−</button>
        <button onClick={() => { setZoom(null); setPan({ x: 0, y: 0 }) }} title="Fit to window"
          className={`px-2 py-0.5 text-xs rounded hover:bg-white/10 ${
            zoom === null ? 'text-desk-accent' : ''}`}>fit</button>
        <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} title="Actual size"
          className={`px-2 py-0.5 text-xs rounded hover:bg-white/10 ${
            zoom === 1 ? 'text-desk-accent' : ''}`}>1:1</button>
        <button onClick={() => nudgeZoom(1.25)} title="Zoom in"
          className="px-2 py-0.5 text-xs rounded hover:bg-white/10">+</button>
        <button onClick={load} title="Reload"
          className="px-2 py-0.5 rounded hover:bg-white/10"><Icon id="desk:refresh" size={13} /></button>
        <span className="ml-2 text-xs text-desk-dim truncate">{name}</span>
      </div>

      <div
        ref={box}
        onWheel={e => {
          if (!e.metaKey && !e.ctrlKey) return
          e.preventDefault()
          nudgeZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1)
        }}
        onPointerDown={e => {
          if (scale <= fitScale()) return           // nothing to pan
          drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
          ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        }}
        onPointerMove={e => {
          if (!drag.current) return
          setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y })
        }}
        onPointerUp={() => { drag.current = null }}
        onDoubleClick={() => { setZoom(z => (z === 1 ? null : 1)); setPan({ x: 0, y: 0 }) }}
        className="flex-1 min-h-0 overflow-hidden flex items-center justify-center relative"
        style={{
          // Checkerboard, so transparency reads as transparent rather than as
          // whatever the panel colour happens to be.
          backgroundImage:
            'linear-gradient(45deg,#0000000d 25%,transparent 25%,transparent 75%,#0000000d 75%),' +
            'linear-gradient(45deg,#0000000d 25%,transparent 25%,transparent 75%,#0000000d 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 8px 8px',
          cursor: drag.current ? 'grabbing' : scale > fitScale() ? 'grab' : 'default',
        }}
      >
        {busy && <p className="text-xs text-desk-dim">loading…</p>}
        {err && <p className="px-6 text-xs text-desk-bad text-center">{err}</p>}
        {!busy && !err && !path && <p className="text-xs text-desk-dim">no file</p>}
        {src && (
          <img
            src={src}
            alt={name}
            draggable={false}
            onLoad={e => setDims({
              w: (e.target as HTMLImageElement).naturalWidth,
              h: (e.target as HTMLImageElement).naturalHeight,
            })}
            onError={() => setErr('could not decode this image')}
            style={{
              width: dims ? dims.w * scale : undefined,
              height: dims ? dims.h * scale : undefined,
              transform: `translate(${pan.x}px, ${pan.y}px)`,
              imageRendering: scale >= 2 ? 'pixelated' : 'auto',
              maxWidth: 'none', maxHeight: 'none',
            }} />
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-desk-dim
                      border-t border-desk-line shrink-0">
        {dims && <span>{dims.w} × {dims.h}</span>}
        {size > 0 && <span>· {fw.fmt.size(size)}</span>}
        {dims && <span>· {Math.round(scale * 100)}%</span>}
        {truncated && <span className="text-desk-bad">· truncated — file is larger than the read cap</span>}
        <span className="ml-auto opacity-70">⌘-scroll to zoom · double-click for 1:1</span>
      </div>
    </div>
  )
}
