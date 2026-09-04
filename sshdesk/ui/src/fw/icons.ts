/**
 * Icon packs.
 *
 * The SVGs arrive already sanitised by Rust — script, event handlers and
 * off-machine references are gone before they reach here. This module keeps
 * them in memory and injects <symbol>s **on demand**.
 *
 * On demand matters: the library pack alone is over 2000 icons, and putting
 * every one in the document to draw the dozen actually on screen would be a
 * lot of DOM for nothing. A symbol is created the first time something asks
 * for that icon and reused from then on.
 */
const SPRITE_ID = 'sshdesk-icon-sprite'

export interface IconPack { name: string; icons: Record<string, string>; bundled: boolean }

let packs: IconPack[] = []
/** "pack:name" -> sanitised svg */
const byId = new Map<string, string>()
const injected = new Set<string>()
let sprite: SVGSVGElement | null = null

export function iconPacks(): IconPack[] { return packs }
export function hasIcon(id: string): boolean { return byId.has(id) }
export function iconCount(): number { return byId.size }

/** `desk:folder` -> `sshdesk-icon-desk-folder` */
export function symbolId(id: string): string {
  return 'sshdesk-icon-' + id.replace(':', '-')
}

/** Every id, pack order preserved so curated names come before the library. */
export function allIconIds(): string[] { return [...byId.keys()] }

/**
 * Substring match on the icon name, with exact and prefix hits first so
 * "file" finds `file` before `file-audio-2`.
 */
export function searchIcons(query: string, limit = 300): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return allIconIds().slice(0, limit)
  const exact: string[] = [], prefix: string[] = [], rest: string[] = []
  for (const id of byId.keys()) {
    const name = id.slice(id.indexOf(':') + 1)
    if (name === q) exact.push(id)
    else if (name.startsWith(q)) prefix.push(id)
    else if (name.includes(q) || id.toLowerCase().includes(q)) rest.push(id)
  }
  return [...exact, ...prefix, ...rest].slice(0, limit)
}

export async function loadIconPacks(): Promise<IconPack[]> {
  const invoke = (window as any).__TAURI__?.core?.invoke
  if (!invoke) return []
  packs = await invoke('icon_packs')

  byId.clear()
  injected.clear()
  for (const pack of packs) {
    for (const [name, svg] of Object.entries(pack.icons)) {
      const id = `${pack.name}:${name}`
      // Earlier packs win, so a curated name is not shadowed by the library.
      if (!byId.has(id)) byId.set(id, svg)
    }
  }
  if (sprite) { sprite.textContent = '' }
  return packs
}

function spriteEl(): SVGSVGElement {
  if (sprite && sprite.isConnected) return sprite
  const existing = document.getElementById(SPRITE_ID) as SVGSVGElement | null
  sprite = existing ?? document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  if (!existing) {
    sprite.id = SPRITE_ID
    sprite.setAttribute('aria-hidden', 'true')
    sprite.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden')
    document.body.appendChild(sprite)
  }
  return sprite
}

// Presentation attributes live on the root <svg>; a <symbol> does not inherit
// them, so they are carried across or every icon renders as a filled blob
// instead of a stroke.
const CARRY = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']

/** Make sure `id` is in the sprite. Returns false if no such icon exists. */
export function ensureSymbol(id: string): boolean {
  if (injected.has(id)) return true
  const svg = byId.get(id)
  if (!svg) return false

  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.nodeName === 'parsererror') return false

  const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'symbol')
  symbol.id = symbolId(id)
  symbol.setAttribute('viewBox', root.getAttribute('viewBox') ?? '0 0 24 24')
  for (const a of CARRY) {
    const v = root.getAttribute(a)
    if (v) symbol.setAttribute(a, v)
  }
  symbol.innerHTML = root.innerHTML
  spriteEl().appendChild(symbol)
  injected.add(id)
  return true
}
