/**
 * Design tokens: icons and theme values, declared by apps and overridden by
 * config.
 *
 * One config file, on the machine you are sitting at, holding both the values
 * that apply everywhere and any a single machine overrides.
 *
 * An earlier attempt put per-host config *on the host*, which failed badly: the
 * dock and menu bar resolve without a host, so a value saved there was written
 * successfully and then changed nothing anybody could see. Keeping every layer
 * local fixes that — the file is one place, visible and hand-editable, and
 * Settings states which scope each value came from.
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

export type TokenType = 'icon' | 'color' | 'length' | 'image'

export interface TokenDecl {
  type: TokenType
  /**
   * True when this can only be set globally.
   *
   * The menu bar and the dock sit outside every pane, so a per-machine value
   * would be written successfully and change nothing — which is exactly the
   * failure that made the first attempt at per-host config worthless. Better
   * to say so than to let it be set.
   */
  global?: boolean
  /** A literal, or `@other.token` to inherit from another token. */
  default: string
  label: string
  hint?: string
}

export type TokenMap = Record<string, TokenDecl>
export type Layer = 'default' | 'set' | 'machine'

export interface Resolved {
  value: string
  layer: Layer
  /** Set when the value arrived through an `@` reference. */
  via?: string
}

type Flat = Record<string, string>

const decls = new Map<string, TokenMap>()
let values: Flat = {}
/** target -> the keys that machine overrides. */
let machines: Record<string, Flat> = {}
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
  const section = type === 'icon' ? 'icons.' : type === 'image' ? 'images.' : 'theme.'
  return section + id
}

export function setConfig(next: Flat, per: Record<string, Flat> = {}) {
  values = next ?? {}
  machines = per ?? {}
  notify()
}

/** The stored values, so the UI can tell "set" from "default". */
export function config(): Flat { return values }

/** What one machine overrides. */
export function machineConfig(host?: string): Flat {
  return (host && machines[host]) || {}
}

/**
 * Update one key in memory without a round trip.
 *
 * A write used to be followed by a re-read whose failure was swallowed, so the
 * UI could say "saved" and still show the old value. Applying the known value
 * directly makes the update deterministic; the re-read only confirms it.
 */
export function setValue(key: string, value?: string, host?: string) {
  const target = host ? (machines[host] ??= {}) : values
  if (value === undefined) delete target[key]
  else target[key] = value
  notify()
}

/**
 * Resolve a token: the stored value if there is one, else the declared default.
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
  // This machine, then everywhere, then the declared default.
  let value: string | undefined = host ? machines[host]?.[key] : undefined
  let layer: Layer = 'machine'
  if (value === undefined) { value = values[key]; layer = 'set' }
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
