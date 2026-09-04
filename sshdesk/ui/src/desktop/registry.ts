import type { ComponentType } from 'react'
import { FileExplorer } from '../apps/FileExplorer'
import { Editor } from '../apps/Editor'
import { Terminal } from '../apps/Terminal'
import { Settings } from '../apps/Settings'
import { ImageViewer } from '../apps/ImageViewer'
import { mimeMatches, mimeOf } from '../fw/mime'

/** An app is just a React component plus how to launch it. */
export interface AppDef {
  id: string
  title: string
  /**
   * Fallback glyph. The real icon comes from the `<id>.app` token, so this is
   * only what shows before icon packs have loaded.
   */
  icon: string
  component: ComponentType<any>
  w: number
  h: number
  /** Hidden apps are launched by other apps, not from the dock. */
  hidden?: boolean
  /**
   * Content types this app can open, as `image/png` or `image/*`.
   *
   * Declared rather than hardcoded in the file manager, so a plugin that
   * handles a type starts receiving it without anything else changing.
   */
  opens?: string[]
}

export const APPS: AppDef[] = [
  { id: 'files',  title: 'Files',  icon: '📁', component: FileExplorer, w: 900, h: 560 },
  { id: 'editor', title: 'Editor', icon: '📝', component: Editor, w: 980, h: 640 },
  { id: 'terminal', title: 'Terminal', icon: '⌨️', component: Terminal, w: 780, h: 460 },
  { id: 'settings', title: 'Settings', icon: '⚙️', component: Settings, w: 780, h: 560 },
  {
    id: 'image', title: 'Preview', icon: '🖼', component: ImageViewer,
    w: 820, h: 620, hidden: true, opens: ['image/*'],
  },
]

/**
 * Which app opens a file.
 *
 * Exact type beats a wildcard, so an app claiming `image/svg+xml` wins over one
 * claiming `image/*`. Anything unclaimed goes to the editor, which already
 * decides for itself whether the bytes are text.
 */
export function handlerFor(path: string): string {
  const mime = mimeOf(path)
  const exact = APPS.find(a => a.opens?.some(p => p === mime))
  if (exact) return exact.id
  const wild = APPS.find(a => a.opens?.some(p => p !== mime && mimeMatches(p, mime)))
  return wild?.id ?? 'editor'
}
