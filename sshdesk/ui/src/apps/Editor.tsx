import { useCallback, useEffect, useRef, useState } from 'react'
import { useFw } from '../wm/host'
import { monaco, languageFor } from './monaco-setup'

export function Editor({ path, setTitle }: { path?: string; setTitle?: (t: string) => void }) {
  const fw = useFw()
  const host = useRef<HTMLDivElement>(null)
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const model = useRef<monaco.editor.ITextModel | null>(null)

  const [status, setStatus] = useState('loading…')
  const [dirty, setDirty] = useState(false)
  const [err, setErr] = useState('')
  const [lang, setLang] = useState('plaintext')
  const [meta, setMeta] = useState<{ size: number; truncated: boolean } | null>(null)

  const name = path ? fw.path.base(path) : 'untitled'
  const titleRef = useRef(setTitle)
  useEffect(() => { titleRef.current = setTitle })

  const save = useCallback(async () => {
    if (!path || !model.current) return
    setErr(''); setStatus('saving…')
    try {
      await fw.fs.write(path, model.current.getValue())
      setDirty(false)
      setStatus('saved')
      fw.bus.emit('fs:changed', { dirs: [fw.path.parent(path)] })
    } catch (e) {
      setStatus('')
      setErr(String(e))          // permission is the machine's call; just show it
    }
  }, [path])

  // create the editor once
  useEffect(() => {
    if (!host.current) return
    const editor = monaco.editor.create(host.current, {
      theme: 'sshdesk',
      automaticLayout: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      minimap: { enabled: true, maxColumn: 60 },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      tabSize: 2,
      readOnly: !path,
    })
    ed.current = editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void saveRef.current() })
    return () => { editor.dispose(); model.current?.dispose() }
  }, [path])

  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save })

  // load the file
  useEffect(() => {
    if (!path) { setStatus('no file'); return }
    let cancelled = false
    setStatus('loading…'); setErr('')
    fw.fs.read(path)
      .then(r => {
        if (cancelled) return
        if (r.binary) {
          setStatus('')
          setErr(`${name} looks binary (${fw.fmt.size(r.size)}) — not opening it as text`)
          return
        }
        const language = languageFor(name)
        setLang(language)
        setMeta({ size: r.size, truncated: r.truncated })
        const m = monaco.editor.createModel(r.text, language,
          monaco.Uri.parse(`sshdesk://${fw.host.current()}${path}`))
        model.current?.dispose()
        model.current = m
        ed.current?.setModel(m)
        m.onDidChangeContent(() => { setDirty(true); setStatus('') })
        setDirty(false)
        setStatus(r.truncated ? 'truncated at 2 MB — saving would lose the rest' : '')
        ed.current?.updateOptions({ readOnly: r.truncated })
        titleRef.current?.(`${name} — ${path}`)
      })
      .catch(e => { setStatus(''); setErr(String(e)) })
    return () => { cancelled = true }
  }, [path, name])

  return (
    <div className="flex flex-col h-full bg-desk-panel text-desk-fg">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-desk-line shrink-0 text-xs">
        <button
          onClick={() => void save()}
          disabled={!dirty || !path}
          title="Save (⌘S)"
          className="px-2 py-1 rounded hover:bg-white/10 disabled:opacity-30
                     border border-desk-line"
        >
          Save
        </button>
        <span className={`truncate ${dirty ? 'text-desk-accent' : 'text-desk-dim'}`}>
          {dirty ? '● ' : ''}{path ?? 'no file'}
        </span>
        <span className="ml-auto flex items-center gap-2 text-desk-dim shrink-0">
          <select
            value={lang}
            onChange={e => {
              setLang(e.target.value)
              if (model.current) monaco.editor.setModelLanguage(model.current, e.target.value)
            }}
            className="bg-black/30 border border-desk-line rounded px-1 py-0.5 outline-none"
          >
            {monaco.languages.getLanguages().map(l => l.id).sort()
              .map(id => <option key={id} value={id}>{id}</option>)}
          </select>
          {meta && <span>{fw.fmt.size(meta.size)}</span>}
        </span>
      </div>

      {err && (
        <div className="px-3 py-1.5 text-xs bg-desk-bad/15 text-desk-bad
                        border-b border-desk-bad/30 shrink-0 select-text break-all">{err}</div>
      )}
      {status && !err && (
        <div className="px-3 py-1 text-[11px] text-desk-dim border-b border-desk-line shrink-0">
          {status}
        </div>
      )}

      <div ref={host} className="flex-1 min-h-0" />
    </div>
  )
}
