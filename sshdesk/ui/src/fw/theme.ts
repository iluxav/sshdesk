/**
 * Turn resolved tokens into CSS.
 *
 * One generated <style> element, rewritten whenever config changes. No
 * re-render: the browser recalculates style, which is what it is good at.
 *
 * Global tokens land on :root and an app's on `.app-<id>`, so one app can be
 * restyled without touching anything else. A machine's overrides land on
 * `[data-host="…"]`, which every window and every pane carries — so they reach
 * that machine's things and nothing else.
 */
import { declarations, resolve, machineConfig, configKey, type TokenType } from './tokens'

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

export function buildCss(hosts: string[] = []): string {
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

  // Only the keys a machine actually overrides, so a host block stays small
  // and it is obvious in devtools what that machine changed.
  for (const host of hosts) {
    const over = machineConfig(host)
    const lines: string[] = []
    for (const [appId, name, type] of themeTokens()) {
      const v = over[configKey(`${appId}.${name}`, type)]
      if (v) lines.push(`${cssVar(appId, name)}: ${v};`)
    }
    if (lines.length) css += `[data-host="${cssEscape(host)}"] {\n  ${lines.join('\n  ')}\n}\n`
  }
  return css
}

/** Host names come from the user, so they are escaped before entering a selector. */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&')
}

export function applyTheme(hosts: string[] = []) {
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = buildCss(hosts)
}
