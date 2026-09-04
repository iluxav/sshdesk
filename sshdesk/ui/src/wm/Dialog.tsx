import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react'

/**
 * In-app dialogs.
 *
 * WKWebView does not implement window.prompt() — it returns null without ever
 * showing anything, so every prompt-driven action silently did nothing.
 * confirm() is unreliable for the same reason. These replace both, and are
 * styleable and keyboard-driven besides.
 */
type Spec =
  | { kind: 'prompt'; title: string; label?: string; value?: string; placeholder?: string
      okLabel?: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; title: string; message?: string; okLabel?: string; danger?: boolean
      resolve: (v: boolean) => void }
  | { kind: 'alert'; title: string; message?: string; resolve: () => void }

const Ctx = createContext<{
  prompt: (o: Omit<Extract<Spec, { kind: 'prompt' }>, 'kind' | 'resolve'>) => Promise<string | null>
  confirm: (o: Omit<Extract<Spec, { kind: 'confirm' }>, 'kind' | 'resolve'>) => Promise<boolean>
  alert: (o: Omit<Extract<Spec, { kind: 'alert' }>, 'kind' | 'resolve'>) => Promise<void>
} | null>(null)

export function DialogProvider({ children }: { children: ReactNode }) {
  const [spec, setSpec] = useState<Spec | null>(null)
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (spec?.kind === 'prompt') {
      setText(spec.value ?? '')
      // select the name so typing replaces it, as a rename dialog should
      requestAnimationFrame(() => { input.current?.focus(); input.current?.select() })
    }
  }, [spec])

  const api = {
    prompt: useCallback((o: any) => new Promise<string | null>(resolve =>
      setSpec({ kind: 'prompt', ...o, resolve })), []),
    confirm: useCallback((o: any) => new Promise<boolean>(resolve =>
      setSpec({ kind: 'confirm', ...o, resolve })), []),
    alert: useCallback((o: any) => new Promise<void>(resolve =>
      setSpec({ kind: 'alert', ...o, resolve })), []),
  }

  // Narrow by kind before resolving: the union of resolvers collapses to
  // `never` if we try to call it generically.
  const finish = (accepted: boolean) => {
    if (!spec) return
    if (spec.kind === 'prompt') spec.resolve(accepted ? (text.trim() || null) : null)
    else if (spec.kind === 'confirm') spec.resolve(accepted)
    else spec.resolve()
    setSpec(null)
  }
  const cancel = () => finish(false)
  const accept = () => finish(true)

  return (
    <Ctx.Provider value={api}>
      {children}
      {spec && (
        <div className="fixed inset-0 z-[10002] bg-black/50 flex items-center justify-center"
             onPointerDown={cancel}>
          <div
            onPointerDown={e => e.stopPropagation()}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); accept() }
              if (e.key === 'Escape') { e.preventDefault(); cancel() }
            }}
            className="w-[min(420px,86vw)] rounded-xl border border-desk-line bg-desk-panel
                       shadow-2xl shadow-black/60 p-4 text-desk-fg"
          >
            <h2 className="text-sm font-semibold mb-1">{spec.title}</h2>

            {spec.kind === 'prompt' && (
              <>
                {spec.label && <p className="text-xs text-desk-dim mb-2">{spec.label}</p>}
                <input
                  ref={input}
                  value={text}
                  placeholder={spec.placeholder}
                  onChange={e => setText(e.target.value)}
                  className="w-full bg-black/40 border border-desk-line rounded px-2 py-1.5
                             text-sm outline-none focus:border-desk-accent select-text"
                />
              </>
            )}
            {spec.kind !== 'prompt' && spec.message && (
              <p className="text-xs text-desk-dim mt-1 break-words">{spec.message}</p>
            )}

            <div className="flex justify-end gap-2 mt-4">
              {spec.kind !== 'alert' && (
                <button onClick={cancel}
                  className="px-3 py-1.5 rounded text-xs border border-desk-line hover:bg-white/10">
                  Cancel
                </button>
              )}
              <button
                autoFocus={spec.kind !== 'prompt'}
                onClick={accept}
                className={`px-3 py-1.5 rounded text-xs font-medium
                  ${spec.kind === 'confirm' && spec.danger
                    ? 'bg-desk-bad text-[#1a0b0b] hover:brightness-110'
                    : 'bg-desk-accent text-[#0b1220] hover:brightness-110'}`}
              >
                {(spec as any).okLabel ?? (spec.kind === 'alert' ? 'OK' : spec.kind === 'confirm' ? 'Confirm' : 'OK')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  )
}

export function useDialog() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useDialog outside DialogProvider')
  return c
}
