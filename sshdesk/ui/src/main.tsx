import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './fw'          // installs window.fw
import App from './App'
import { loadPlugins } from './ext/loader'

// Suppress WebKit's native menu so apps own right-click — except in text
// fields and selectable text, where the native copy/paste menu is useful.
document.addEventListener('contextmenu', e => {
  const t = e.target as HTMLElement | null
  if (!t?.closest('input, textarea, [contenteditable], .select-text')) e.preventDefault()
})

// Plugins register apps into the registry, so they must load before first
// paint or the dock would render without them.
loadPlugins()
  .then(ids => { if (ids.length) console.info('sshdesk: loaded plugins', ids) })
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode><App /></StrictMode>
    )
  })
