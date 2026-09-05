import { ensureSymbol, symbolId } from '../fw/icons'
import { value as tokenValue } from '../fw/tokens'

/**
 * Draw an icon from a token, or from a literal id.
 *
 * A value of `pack:name` renders from the sprite; anything else renders as a
 * text glyph. That is what keeps emoji valid: they are hardcoded across this
 * codebase and every plugin manifest, so each can become a token when it is
 * convenient rather than in one sweeping commit that inevitably misses some.
 */
export function Icon({ token, id, host, size = 16, className, title, fallback }: {
  /** Token id, e.g. `files.directory`. */
  token?: string
  /** Literal value, e.g. `desk:folder` or an emoji. Wins over `token`. */
  id?: string
  /**
   * Which machine's configuration to read.
   *
   * Colours reach a machine through a [data-host] CSS block, but an icon is
   * chosen in JavaScript, so it has to be asked for by name. Without this a
   * per-machine icon is written to the config and never drawn.
   */
  host?: string
  size?: number
  className?: string
  title?: string
  /** Drawn when the token resolves to nothing. */
  fallback?: string
}) {
  const v = id ?? (token ? tokenValue(token, host) : '') ?? ''
  // An undeclared or unresolved token must still draw something. Rendering
  // nothing is how the dock ended up with blank slots for plugins.
  const shown = v || fallback || ''
  if (!shown) return null

  // Injected here rather than in an effect so the <use> resolves on first
  // paint. It is an idempotent write to a detached sprite outside React's
  // tree, which is the trade for not flashing an empty box on every icon.
  if (shown.includes(':') && ensureSymbol(shown)) {
    return (
      <svg
        width={size} height={size} className={className} aria-hidden={!title}
        style={{ display: 'inline-block', verticalAlign: '-0.125em', flexShrink: 0 }}>
        {title && <title>{title}</title>}
        <use href={`#${symbolId(shown)}`} />
      </svg>
    )
  }

  // Glyph fallback — also what an unknown pack id lands on, so a bad config
  // value degrades to something visible rather than a hole in the row.
  return (
    <span
      className={className} title={title} aria-hidden={!title}
      style={{ fontSize: size, lineHeight: 1, display: 'inline-block', flexShrink: 0 }}>
      {shown.includes(':') ? '▢' : shown}
    </span>
  )
}
