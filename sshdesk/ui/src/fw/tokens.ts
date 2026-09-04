/**
 * Design tokens: icons and theme values, declared by apps and overridden by
 * config.
 *
 * An app owns a namespace equal to its registered id, so there is one
 * mechanical rule and no separate name registry. A token id is
 * `<appId>.<name>`; the declared *type* routes it to a config section, which
 * keeps the TOML readable instead of repeating the type in every key:
 *
 *   [icons]
 *   "files.directory" = "desk:folder"
 *
 *   [theme]
 *   "desk.accent"     = "#f87171"
 *   "files.row_hover" = "#ffffff14"
 */

export type TokenType = 'icon' | 'color' | 'length'

export interface TokenDecl {
  type: TokenType
  /** A literal, or `@other.token` to inherit from another token. */
  default: string
  label: string
  hint?: string
}

export type TokenMap = Record<string, TokenDecl>
export type Layer = 'default' | 'local' | 'host'

export interface Resolved {
  value: string
  layer: Layer
  /** Set when the value arrived through an `@` reference. */
  via?: string
}

type Flat = Record<string, string>

const decls = new Map<string, TokenMap>()
let local: Flat = {}
const hosts = new Map<string, Flat>()
const listeners = new Set<() => void>()

/** Apps declare what they own; Settings renders whatever is declared. */
export function declareTokens(appId: string, tokens: TokenMap) {
  decls.set(appId, tokens)
  notify()
}

export function declarations(): Array<[string, TokenMap]> {
  return [...decls.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

export function declOf(id: string): TokenDecl | undefined {
  const dot = id.indexOf('.')
  if (dot < 0) return undefined
  return decls.get(id.slice(0, dot))?.[id.slice(dot + 1)]
}

/** Where a token is stored in the config file. */
export function configKey(id: string, type: TokenType): string {
  return (type === 'icon' ? 'icons.' : 'theme.') + id
}

export function setLayers(l: { local: Flat; host?: Flat }, host?: string) {
  local = l.local ?? {}
  if (host) hosts.set(host, l.host ?? {})
  notify()
}

export function layerFor(host?: string): Flat {
  return (host && hosts.get(host)) || {}
}

/** The local layer, for UI that needs to know whether a key is set *here*. */
export function localLayer(): Flat { return local }

/**
 * Resolve a token. First hit wins: host layer, local layer, declared default.
 *
 * `@` references are followed explicitly rather than letting unset keys walk up
 * some hierarchy. Implicit fallback reads as convenient and behaves as spooky
 * action — you change one app's icon and three others move for reasons nothing
 * in the config explains. A reference is greppable and Settings can show it.
 */
export function resolve(id: string, host?: string, seen = new Set<string>()): Resolved {
  const decl = declOf(id)
  if (!decl) return { value: '', layer: 'default' }

  const key = configKey(id, decl.type)
  const hostLayer = layerFor(host)

  let value = hostLayer[key]
  let layer: Layer = 'host'
  if (value === undefined) { value = local[key]; layer = 'local' }
  if (value === undefined) { value = decl.default; layer = 'default' }

  if (value?.startsWith('@')) {
    const target = value.slice(1)
    // A cycle yields the declared literal and one warning, never a hung render.
    if (seen.has(id)) {
      console.warn(`token cycle at ${id}`)
      return { value: '', layer }
    }
    seen.add(id)
    const inner = resolve(target, host, seen)
    return { value: inner.value, layer: inner.layer, via: target }
  }
  return { value: value ?? '', layer }
}

export function value(id: string, host?: string): string {
  return resolve(id, host).value
}

export function onTokensChanged(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

function notify() { listeners.forEach(f => { try { f() } catch { /* isolate */ } }) }
