/**
 * Icon packs, injected once as a hidden SVG sprite.
 *
 * The SVGs arrive already sanitised by the Rust side — script, event handlers
 * and off-machine references are gone before they reach here. This module only
 * reshapes them into <symbol>s so they can be referenced by <use>, which keeps
 * one copy of each path no matter how many times an icon is drawn.
 */
const SPRITE_ID = 'sshdesk-icon-sprite'

export interface IconPack { name: string; icons: Record<string, string>; bundled: boolean }

let packs: IconPack[] = []
const available = new Set<string>()

export function iconPacks(): IconPack[] { return packs }
export function hasIcon(id: string): boolean { return available.has(id) }

/** `desk:folder` -> `sshdesk-icon-desk-folder` */
export function symbolId(id: string): string {
  return 'sshdesk-icon-' + id.replace(':', '-')
}

export async function loadIconPacks(): Promise<IconPack[]> {
  const invoke = (window as any).__TAURI__?.core?.invoke
  if (!invoke) return []
  packs = await invoke('icon_packs')
  buildSprite()
  return packs
}

function buildSprite() {
  const existing = document.getElementById(SPRITE_ID) as SVGSVGElement | null
  const sprite: SVGSVGElement =
    existing ?? document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  if (!existing) {
    sprite.id = SPRITE_ID
    sprite.setAttribute('aria-hidden', 'true')
    sprite.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden')
    document.body.appendChild(sprite)
  }
  sprite.textContent = ''
  available.clear()

  const parser = new DOMParser()
  // Presentation attributes live on the root <svg>; a <symbol> does not inherit
  // them, so they are carried across explicitly or every icon renders as a
  // filled blob instead of a stroke.
  const carry = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']

  for (const pack of packs) {
    for (const [name, svg] of Object.entries(pack.icons)) {
      const doc = parser.parseFromString(svg, 'image/svg+xml')
      const root = doc.documentElement
      if (!root || root.nodeName === 'parsererror') continue

      const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'symbol')
      symbol.id = symbolId(`${pack.name}:${name}`)
      symbol.setAttribute('viewBox', root.getAttribute('viewBox') ?? '0 0 24 24')
      for (const a of carry) {
        const v = root.getAttribute(a)
        if (v) symbol.setAttribute(a, v)
      }
      symbol.innerHTML = root.innerHTML
      sprite.appendChild(symbol)
      available.add(`${pack.name}:${name}`)
    }
  }
}
