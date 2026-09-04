// Mirrors the Rust types in core/src/lib.rs.
// TODO: generate this from Rust (ts-rs) so it can never drift.

export interface Entry {
  name: string
  kind: 'dir' | 'file' | 'link' | string
  size: number
  mtime: number
  mode: string
  user: string
  group: string
}

export interface DirListing {
  path: string
  entries: Entry[]
  /** Typed statvfs numbers — format them however the view wants. */
  disk: { total: number; free: number; avail: number }
  /** Server supports `copy-data`: copies never ship bytes over the wire. */
  server_side_copy: boolean
  elapsed_ms: number
}

export interface FileRead {
  text: string
  truncated: boolean
  binary: boolean
  size: number
}

export interface Service {
  unit: string; load: string; active: string; sub: string; description: string
}
export interface Process {
  pid: number; user: string; cpu: number; mem: number; command: string
}
export interface Port {
  port: number; bind: string; process: string; mine: boolean
}
export interface Snapshot {
  services: Service[]; processes: Process[]; ports: Port[]; elapsed_ms: number
}

export interface ServerTime { epoch: number; offset_minutes: number; zone: string }

/** A remembered connection. Passwords are deliberately never stored. */
export interface SavedConn { host: string; user: string; lastUsed: number }
