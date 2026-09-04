import { fw } from '../fw'

export interface ExecOut { stdout: string; stderr: string; code: number; elapsed_ms: number }

/** What the platform hands a plugin's adapter. */
export interface Sdk {
  /** Run argv on the connected host. Elements are quoted individually, so a
   *  value passed through here can never widen into extra arguments. */
  exec(argv: string[]): Promise<ExecOut>
  /** Same, under sudo. Prompts once per host per session and caches. */
  sudo(argv: string[]): Promise<ExecOut>
  /** Probe once per host and cache the answer. */
  capability(name: string, probe: (exec: Sdk['exec']) => Promise<boolean>): Promise<boolean>
  host(): string
}

const caps = new Map<string, Promise<boolean>>()
const passwords = new Map<string, string>()   // session only, never persisted

let askPassword: ((host: string) => Promise<string | null>) | null = null
export function setPasswordPrompt(fn: (host: string) => Promise<string | null>) {
  askPassword = fn
}

const invoke = <T,>(cmd: string, args: Record<string, unknown>): Promise<T> =>
  (window as any).__TAURI__.core.invoke(cmd, args)

/**
 * `hostOf` lets a window pin its sdk to its own machine. Without it a plugin
 * polling in the background would follow whatever host is focused.
 */
export function makeSdk(hostOf: () => string = () => fw.host.current()): Sdk {
  const exec = (argv: string[]) =>
    invoke<ExecOut>('exec', { target: hostOf(), argv })

  const sudo = async (argv: string[]) => {
    const host = hostOf()
    let pw = passwords.get(host)
    if (pw === undefined) {
      const got = await askPassword?.(host)
      if (got == null) throw new Error('cancelled')
      pw = got
    }
    const out = await invoke<ExecOut>('exec', { target: host, argv, password: pw })
    // Only remember a password that actually worked.
    if (out.code === 0) passwords.set(host, pw)
    else if (/incorrect password|Sorry, try again/i.test(out.stderr)) {
      passwords.delete(host)
      throw new Error('incorrect password')
    }
    return out
  }

  return {
    exec,
    sudo,
    host: hostOf,
    capability(name, probe) {
      const key = `${hostOf()}:${name}`
      let p = caps.get(key)
      if (!p) {
        p = probe(exec).catch(() => false)
        caps.set(key, p)
      }
      return p
    },
  }
}

/** Forget cached credentials and probes for a host (on disconnect). */
export function resetSdk(host: string) {
  passwords.delete(host)
  for (const k of [...caps.keys()]) if (k.startsWith(host + ':')) caps.delete(k)
}
