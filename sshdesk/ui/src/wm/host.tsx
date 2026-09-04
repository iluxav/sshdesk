import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { fw, type Fw } from '../fw'

/**
 * Which machine a window belongs to.
 *
 * Windows are pinned to the host they were opened on. Without this, a Ports
 * window polling every 4s would follow whatever host you last focused and
 * silently report another machine's data.
 */
const HostCtx = createContext<string | null>(null)

export function HostScope({ host, children }: { host: string; children: ReactNode }) {
  return <HostCtx.Provider value={host}>{children}</HostCtx.Provider>
}

/** The host of the window this component is rendered in. */
export function useHost(): string {
  return useContext(HostCtx) ?? fw.host.current()
}

/** The platform API pinned to this window's host. */
export function useFw(): Fw {
  const host = useHost()
  return useMemo(() => fw.for(host), [host])
}
