/**
 * Tokens owned by the desktop and its built-in apps.
 *
 * These are declarations, not values: they name what is configurable, give it
 * a label for Settings and a default for when nothing overrides it. Plugins
 * declare theirs the same way, which is why Settings needs no knowledge of any
 * particular app.
 *
 * The `desk` namespace is the global palette and maps to the --color-desk-*
 * variables plugins already style against.
 */
import { declareTokens } from '../fw/tokens'

export function declareCoreTokens() {
  declareTokens('desk', {
    // The palette plugins already style against.
    bg:        { type: 'color', default: '#0f1116', label: 'Background' },
    panel:     { type: 'color', default: '#1a1d24', label: 'Panel' },
    line:      { type: 'color', default: '#2b2f38', label: 'Divider' },
    fg:        { type: 'color', default: '#e6e8ec', label: 'Text' },
    dim:       { type: 'color', default: '#8b93a1', label: 'Muted text' },
    accent:    { type: 'color', default: '#60a5fa', label: 'Accent' },
    ok:        { type: 'color', default: '#4ade80', label: 'Success' },
    bad:       { type: 'color', default: '#f87171', label: 'Error' },
    warn:      { type: 'color', default: '#fbbf24', label: 'Warning' },

    // Surfaces, so the chrome can be retinted without disturbing the palette.
    // The alpha is deliberate — these sit over the wallpaper.
    menubar:   { type: 'color', default: '#ffffff12', label: 'Menu bar' },
    dock:      { type: 'color', default: '#1a1d24cc', label: 'Dock' },
    titlebar:  { type: 'color', default: '#ffffff0a', label: 'Window title bar' },
    border:    { type: 'color', default: '#2b2f38',   label: 'Window border' },
    selection: { type: 'color', default: '#60a5fa4d', label: 'Selection' },

    radius:    { type: 'length', default: '12px', label: 'Window corners' },

    /**
     * A file on this Mac, read once into a data URL rather than served over
     * file:// — it is one image chosen once, and this grants the webview no
     * filesystem access it would not otherwise have.
     */
    wallpaper: { type: 'image', default: '', label: 'Desktop picture' },
  })

  declareTokens('files', {
    app:       { type: 'icon',  default: 'desk:folder',      label: 'App icon' },
    directory: { type: 'icon',  default: 'desk:folder',      label: 'Folder' },
    open:      { type: 'icon',  default: 'desk:folder-open', label: 'Open folder' },
    file:      { type: 'icon',  default: 'desk:file',        label: 'File' },
    link:      { type: 'icon',  default: 'desk:link',        label: 'Symlink' },
    // Points at the global accent, so retinting the desktop moves folder
    // names with it. Change this to a literal to break that link.
    dir_fg:    { type: 'color', default: '@desk.accent',     label: 'Folder name' },
    row_hover: { type: 'color', default: '#ffffff0d',        label: 'Row hover' },
  })

  declareTokens('terminal', {
    app: { type: 'icon', default: 'desk:terminal', label: 'App icon' },
  })

  declareTokens('editor', {
    app:  { type: 'icon', default: 'desk:editor',    label: 'App icon' },
    code: { type: 'icon', default: 'desk:file-code', label: 'Source file' },
  })

  declareTokens('packages', {
    app:       { type: 'icon',  default: 'desk:app',      label: 'App icon' },
    installed: { type: 'icon',  default: 'lucide:check',  label: 'Installed' },
    available: { type: 'icon',  default: 'lucide:circle-dashed', label: 'Available' },
    row_hover: { type: 'color', default: '#ffffff0d',     label: 'Row hover' },
  })

  declareTokens('image', {
    app: { type: 'icon', default: 'desk:file', label: 'App icon' },
  })

  declareTokens('settings', {
    app: { type: 'icon', default: 'desk:settings', label: 'App icon' },
  })
}
