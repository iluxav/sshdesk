/**
 * Content type from a file name, used to decide which app opens it.
 *
 * Extension only. Sniffing magic bytes would mean a round trip per file just
 * to pick a window, and a wrong guess costs nothing worse than the editor —
 * which is where unknown types go anyway.
 *
 * Rust has its own copy of this for labelling the data URL it returns. The two
 * are derived from the same rule and the worst case if they drift is a data URL
 * whose type the browser sniffs past.
 */
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon', cur: 'image/x-icon',
  svg: 'image/svg+xml',
  tif: 'image/tiff', tiff: 'image/tiff',
  heic: 'image/heic', heif: 'image/heic',

  pdf: 'application/pdf',
  json: 'application/json',
  toml: 'text/toml', yaml: 'text/yaml', yml: 'text/yaml',
  md: 'text/markdown', markdown: 'text/markdown',
  html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  ts: 'text/typescript', tsx: 'text/typescript', jsx: 'text/javascript',
  rs: 'text/rust', py: 'text/x-python', go: 'text/x-go', sql: 'text/x-sql',
  sh: 'text/x-shellscript', bash: 'text/x-shellscript', zsh: 'text/x-shellscript',
  c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c', hpp: 'text/x-c',
  txt: 'text/plain', log: 'text/plain', conf: 'text/plain',
  cfg: 'text/plain', ini: 'text/plain', service: 'text/plain',
}

export function mimeOf(path: string): string {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'application/octet-stream'
  return TYPES[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream'
}

/** Does `pattern` (`image/png`, `image/*`, `*`) cover `mime`? */
export function mimeMatches(pattern: string, mime: string): boolean {
  if (pattern === '*' || pattern === mime) return true
  if (pattern.endsWith('/*')) return mime.startsWith(pattern.slice(0, -1))
  return false
}
