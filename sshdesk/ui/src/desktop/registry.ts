import type { ComponentType } from 'react'
import { FileExplorer } from '../apps/FileExplorer'
import { Editor } from '../apps/Editor'
import { Terminal } from '../apps/Terminal'
import { Settings } from '../apps/Settings'

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
}

export const APPS: AppDef[] = [
  { id: 'files',  title: 'Files',  icon: '📁', component: FileExplorer, w: 900, h: 560 },
  { id: 'editor', title: 'Editor', icon: '📝', component: Editor, w: 980, h: 640 },
  { id: 'terminal', title: 'Terminal', icon: '⌨️', component: Terminal, w: 780, h: 460 },
  { id: 'settings', title: 'Settings', icon: '⚙️', component: Settings, w: 780, h: 560 },
]
