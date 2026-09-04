import * as React from 'react'
import htm from 'htm'
import { fw } from '../fw'
import { makeSdk, type Sdk } from './sdk'
import { useFw, useHost } from '../wm/host'
import { APPS, type AppDef } from '../desktop/registry'

interface PluginModule {
  manifest?: { id: string; name: string; icon?: string; window?: { w?: number; h?: number } }
  createAdapter?: (sdk: Sdk) => Record<string, unknown>
  createApp?: (ctx: {
    React: typeof React
    h: typeof React.createElement
    /** htm tagged template — JSX-like markup with no build step. */
    html: ReturnType<typeof htm.bind>
    /** Ambient API, bound to the focused host. Fine for one-shot actions. */
    fw: typeof fw
    /** Hook returning the API pinned to *this window's* host. Prefer it. */
    useFw: typeof useFw
    /** Ambient adapter, bound to the focused host. */
    api: Record<string, unknown>
    /** Hook returning the adapter pinned to *this window's* host. Prefer it. */
    useApi: () => Record<string, unknown>
  }) => React.ComponentType<any>
}

interface RawPlugin { name: string; dir: string; source: string; style?: string | null }

/**
 * Load plugins from disk at boot.
 *
 * Each plugin is <root>/<name>/index.js and must export `manifest`, and at
 * least one of `createAdapter` / `createApp`. The module is evaluated as ESM
 * from a blob URL, so plugins can use normal `export` syntax and top-level
 * await without us shipping a module loader.
 *
 * React is *passed in* rather than imported by the plugin, so a plugin never
 * bundles its own copy and hooks keep working.
 */
/** Ids currently provided by plugins, so a reload can retire ones that vanished. */
let installed: string[] = []

/** Subscribers re-render when the plugin set changes. */
const watchers = new Set<() => void>()
export function onPluginsChanged(fn: () => void) {
  watchers.add(fn)
  return () => { watchers.delete(fn) }
}

export async function loadPlugins(): Promise<string[]> {
  const invoke = (window as any).__TAURI__?.core?.invoke
  if (!invoke) return []

  let raw: RawPlugin[] = []
  try {
    raw = await invoke('list_plugins')
  } catch (e) {
    console.error('sshdesk: plugin discovery failed', e)
    return []
  }

  // Drop styles from the previous load so a reload does not stack them.
  document.querySelectorAll('style[data-plugin]').forEach(el => el.remove())

  const loaded: string[] = []
  for (const p of raw) {
    try {
      const url = URL.createObjectURL(new Blob([p.source], { type: 'text/javascript' }))
      let mod: PluginModule
      try {
        mod = (await import(/* @vite-ignore */ url)) as PluginModule
      } finally {
        URL.revokeObjectURL(url)
      }

      const m = mod.manifest
      if (!m?.id || !m.name) throw new Error('missing manifest { id, name }')

      // A plugin installed at runtime cannot have its Tailwind classes
      // generated, because Tailwind scans at build time. Its own style.css is
      // the reliable route — plain CSS against the desktop's design tokens.
      if (p.style) {
        const el = document.createElement('style')
        el.dataset.plugin = m.id
        el.textContent = p.style
        document.head.appendChild(el)
      }

      const build = mod.createAdapter
      const api = build ? build(makeSdk()) : {}

      // One adapter per host, built lazily. The adapter closes over an sdk, so
      // a single shared instance would send every window's calls to whichever
      // host happened to be focused.
      const perHost = new Map<string, Record<string, unknown>>()
      const useApi = () => {
        const h = useHost()
        if (!build) return api
        let a = perHost.get(h)
        if (!a) { a = build(makeSdk(() => h)); perHost.set(h, a) }
        return a
      }

      if (!mod.createApp) throw new Error('missing createApp')

      const html = htm.bind(React.createElement)
      const Component = mod.createApp({ React, h: React.createElement, html, fw, useFw, api, useApi })

      const def: AppDef = {
        id: m.id,
        title: m.name,
        icon: m.icon ?? '🧩',
        component: Component,
        w: m.window?.w ?? 860,
        h: m.window?.h ?? 540,
      }
      const at = APPS.findIndex(a => a.id === def.id)
      if (at >= 0) APPS[at] = def
      else APPS.push(def)
      loaded.push(m.id)
    } catch (e) {
      // One bad plugin must not stop the desktop from booting.
      console.error(`sshdesk: plugin "${p.name}" failed to load:`, e)
    }
  }

  // Retire apps whose plugin was deleted or now fails to load.
  for (const gone of installed.filter(id => !loaded.includes(id))) {
    const at = APPS.findIndex(a => a.id === gone)
    if (at >= 0) APPS.splice(at, 1)
  }
  installed = loaded
  watchers.forEach(fn => { try { fn() } catch { /* isolate */ } })
  return loaded
}

/**
 * Re-read plugins from disk without restarting.
 *
 * Each load creates a fresh blob URL, so the module is genuinely re-evaluated
 * rather than served from the module cache. Windows belonging to plugins are
 * closed first — their component identity changes, and React would otherwise
 * try to reconcile the old tree against a new type.
 */
export async function reloadPlugins(closeWindows: (appIds: string[]) => void) {
  closeWindows(installed.slice())
  const ids = await loadPlugins()
  return ids
}
