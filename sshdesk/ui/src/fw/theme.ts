/**
 * Turn resolved tokens into CSS.
 *
 * One generated <style> element, rewritten whenever config changes. No
 * re-render: the browser recalculates style, which is what it is good at.
 *
 * Global tokens land on :root and an app's on `.app-<id>`, so one app can be
 * restyled without touching anything else.
 */
import { declarations, resolve, type TokenType } from './tokens'

const STYLE_ID = 'sshdesk-theme'

/** `desk.accent` -> `--color-desk-accent`, `files.row_hover` -> `--files-row-hover`. */
function cssVar(appId: string, name: string): string {
  const flat = name.replace(/\./g, '-').replace(/_/g, '-')
  return appId === 'desk' ? `--color-desk-${flat}` : `--${appId}-${flat}`
}

function themeTokens(): Array<[string, string, TokenType]> {
  const out: Array<[string, string, TokenType]> = []
  for (const [appId, tokens] of declarations()) {
    for (const [name, decl] of Object.entries(tokens)) {
      // Icons are drawn and images become a background elsewhere; neither is
      // a CSS custom property.
      if (decl.type === 'icon' || decl.type === 'image') continue
      out.push([appId, name, decl.type])
    }
  }
  return out
}

export function buildCss(): string {
  const root: string[] = []
  const perApp = new Map<string, string[]>()

  for (const [appId, name] of themeTokens()) {
    const v = resolve(`${appId}.${name}`).value
    if (!v) continue
    const decl = `${cssVar(appId, name)}: ${v};`
    if (appId === 'desk') root.push(decl)
    else {
      const list = perApp.get(appId) ?? []
      list.push(decl)
      perApp.set(appId, list)
    }
  }

  let css = root.length ? `:root {\n  ${root.join('\n  ')}\n}\n` : ''
  for (const [appId, decls] of perApp) {
    css += `.app-${appId} {\n  ${decls.join('\n  ')}\n}\n`
  }
  return css
}

export function applyTheme() {
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = buildCss()
}
