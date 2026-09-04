import * as monaco from 'monaco-editor'
// monaco's package exports map "./*" -> "./esm/vs/*.js", so the esm/vs prefix
// must be omitted here or it gets doubled during resolution.
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

// Monaco's default loader fetches from a CDN. Under Tauri there is no network
// origin and the CSP would block it, so the workers are bundled locally by Vite.
;(self as any).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

monaco.editor.defineTheme('sshdesk', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1a1d24',
    'editorGutter.background': '#1a1d24',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorLineNumber.foreground': '#5a6272',
    'editorLineNumber.activeForeground': '#8b93a1',
  },
})

/**
 * Map a filename to a Monaco language id.
 *
 * Monaco already knows dozens of extensions; this fills in the ones that matter
 * on a Linux box and are not covered — dotfiles, unit files, extensionless
 * scripts — and otherwise defers to Monaco's own registry.
 */
const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'makefile',
  'docker-compose.yml': 'yaml', 'docker-compose.yaml': 'yaml',
  '.bashrc': 'shell', '.bash_profile': 'shell', '.bash_logout': 'shell',
  '.zshrc': 'shell', '.profile': 'shell', '.gitconfig': 'ini',
  '.gitignore': 'plaintext', '.env': 'shell', hosts: 'plaintext',
  fstab: 'plaintext', crontab: 'plaintext', 'known_hosts': 'plaintext',
  'authorized_keys': 'plaintext', passwd: 'plaintext', group: 'plaintext',
}

const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'html',
  md: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', lua: 'lua', r: 'r', pl: 'perl',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  service: 'ini', socket: 'ini', timer: 'ini', mount: 'ini', target: 'ini',
  sql: 'sql', xml: 'xml', svg: 'xml', log: 'plaintext', txt: 'plaintext',
  csv: 'plaintext', tsv: 'plaintext', diff: 'diff', patch: 'diff',
  gradle: 'groovy', tf: 'hcl', hcl: 'hcl', proto: 'proto', graphql: 'graphql',
}

export function languageFor(filename: string): string {
  const name = filename.toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]

  const dot = name.lastIndexOf('.')
  if (dot > 0) {
    const ext = name.slice(dot + 1)
    if (BY_EXT[ext]) return BY_EXT[ext]
    // fall back to Monaco's own extension registry
    const hit = monaco.languages.getLanguages()
      .find(l => l.extensions?.some(e => e.toLowerCase() === '.' + ext))
    if (hit) return hit.id
  }
  return 'plaintext'
}

export { monaco }
