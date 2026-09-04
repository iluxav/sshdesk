import { WindowProvider } from './wm/store'
import { ContextMenuProvider } from './wm/ContextMenu'
import { DragProvider } from './wm/dnd'
import { DialogProvider } from './wm/Dialog'
import { Desktop } from './desktop/Desktop'

export default function App() {
  return (
    <WindowProvider>
      <DialogProvider>
        <DragProvider>
          <ContextMenuProvider>
            <Desktop />
          </ContextMenuProvider>
        </DragProvider>
      </DialogProvider>
    </WindowProvider>
  )
}
