/**
 * Turn resolved tokens into CSS.
 *
 * One generated <style> element, rewritten whenever config changes. No
 * re-render: the browser recalculates style, which is what it is good at.
 *
 * Scoping mirrors the config layering. Global tokens land on :root, an app's
 * tokens on `.app-<id>`, and a host's overrides on `[data-host="..."]` so they
 * reach only that host's windows — the reason the dock can never be repainted
 * by whichever box you happened to connect to first.
 */
import { declarations, resolve, layerFor, configKey, type TokenType } from './tokens'

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
      if (decl.type === 'icon') continue
      out.push([appId, name, decl.type])
    }
  }
  return out
}

export function buildCss(hostNames: string[]): string {
  const root: string[] = []
  const perApp = new Map<string, string[]>()

  for (const [appId, name] of themeTokens()) {
    const id = `${appId}.${name}`
    const v = resolve(id).value
    if (!v) continue
    const decl = `${cssVar(appId, name)}: ${v};`
    if (appId === 'desk') root.push(decl)
    else (perApp.get(appId) ?? perApp.set(appId, []).get(appId)!).push(decl)
  }

  let css = root.length ? `:root {\n  ${root.join('\n  ')}\n}\n` : ''
  for (const [appId, decls] of perApp) {
    css += `.app-${appId} {\n  ${decls.join('\n  ')}\n}\n`
  }

  // Host overrides: only the keys that host actually sets, scoped to its windows.
  for (const host of hostNames) {
    const layer = layerFor(host)
    const lines: string[] = []
    for (const [appId, name, type] of themeTokens()) {
      const key = configKey(`${appId}.${name}`, type)
      const v = layer[key]
      if (v) lines.push(`${cssVar(appId, name)}: ${v};`)
    }
    if (lines.length) {
      css += `[data-host="${cssEscape(host)}"] {\n  ${lines.join('\n  ')}\n}\n`
    }
  }
  return css
}

/** Host names come from the user, so they are escaped before entering a selector. */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&')
}

export function applyTheme(hostNames: string[]) {
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = buildCss(hostNames)
}
