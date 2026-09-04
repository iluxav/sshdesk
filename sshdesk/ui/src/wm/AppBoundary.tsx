import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Keep one app's crash inside one window.
 *
 * Apps — plugins especially — are other people's code. Without a boundary a
 * single render error unmounts the whole tree, and the desktop goes black with
 * nothing on screen to say why. That is what happened, and the blank screen was
 * worse than the bug behind it.
 *
 * This is deliberately a class: error boundaries have no hook equivalent.
 */
export class AppBoundary extends Component<
  { name: string; children: ReactNode },
  { error: Error | null; info: string }
> {
  state = { error: null as Error | null, info: '' }

  static getDerivedStateFromError(error: Error) {
    return { error, info: '' }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console is the only place a stack survives in a release build.
    console.error(`[${this.props.name}] crashed:`, error, info.componentStack)
    this.setState({ error, info: (info.componentStack ?? '').trim().split('\n').slice(0, 6).join('\n') })
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-6
                      bg-desk-panel text-desk-fg">
        <p className="text-sm text-desk-bad">{this.props.name} stopped</p>
        <p className="max-w-lg text-xs text-desk-dim break-words text-center">
          {String(error?.message || error)}
        </p>
        {info && (
          <pre className="max-w-lg max-h-40 overflow-auto p-2 rounded text-[10px]
                          bg-desk-bg border border-desk-line text-desk-dim">{info}</pre>
        )}
        <button
          onClick={() => this.setState({ error: null, info: '' })}
          className="px-3 py-1.5 text-xs rounded border border-desk-line hover:bg-white/5">
          try again
        </button>
      </div>
    )
  }
}
