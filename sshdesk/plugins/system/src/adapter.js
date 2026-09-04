// No '#': in sh, a word starting with '#' begins a comment, and since these
// commands are joined with ';' on one line it would swallow everything after it.
const SEP = '__SSHDESK_SECTION__'

/**
 * One shell invocation for the whole overview.
 *
 * Six separate round trips would cost ~1.2s on a 200ms link; batched it is one.
 * The script is a module constant with no interpolation, so passing it to
 * `sh -c` introduces nothing an attacker could influence — unlike the argv
 * calls elsewhere, which carry values from the machine.
 */
const OVERVIEW = [
  'df -PB1 -x tmpfs -x devtmpfs -x squashfs 2>/dev/null',
  `echo ${SEP}`,
  'free -b 2>/dev/null',
  `echo ${SEP}`,
  'systemctl --failed --no-legend --no-pager 2>/dev/null',
  `echo ${SEP}`,
  'docker system df --format "{{.Type}}|{{.Size}}|{{.Reclaimable}}" 2>/dev/null',
  `echo ${SEP}`,
  'uptime -p 2>/dev/null; uptime 2>/dev/null | head -1',
  `echo ${SEP}`,
  'nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null',
  `echo ${SEP}`,
  'nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null',
].join('; ')

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function parseDf(text) {
  return text.split('\n').slice(1).map(l => l.trim()).filter(Boolean).map(l => {
    const f = l.split(/\s+/)
    if (f.length < 6) return null
    const size = num(f[1]), used = num(f[2]), avail = num(f[3])
    return {
      device: f[0], mount: f.slice(5).join(' '),
      size, used, avail,
      pct: size ? Math.round((used / size) * 100) : 0,
    }
  }).filter(Boolean).filter(fs => fs.size > 0)
}

function parseFree(text) {
  const out = { total: 0, used: 0, available: 0, swapTotal: 0, swapUsed: 0 }
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (/^Mem:/.test(line)) {
      out.total = num(f[1]); out.used = num(f[2]); out.available = num(f[6] ?? f[3])
    } else if (/^Swap:/.test(line)) {
      out.swapTotal = num(f[1]); out.swapUsed = num(f[2])
    }
  }
  return out
}

/** "13.07GB (93%)" -> bytes */
function parseSize(s) {
  const m = /([\d.]+)\s*([KMGT]?)B/i.exec(s || '')
  if (!m) return 0
  const mult = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2].toUpperCase()] ?? 1
  return Math.round(parseFloat(m[1]) * mult)
}

export function createAdapter(sdk) {
  const hasDocker = () => sdk.capability('docker', async exec =>
    (await exec(['sh', '-c', 'command -v docker >/dev/null && docker info >/dev/null 2>&1 && echo yes'])).stdout.includes('yes'))

  return {
    async overview() {
      const r = await sdk.exec(['sh', '-c', OVERVIEW])
      const [df, free, failed, docker, up, gpu, gpuProcs] =
        r.stdout.split(SEP).map(s => s.trim())

      return {
        filesystems: parseDf(df || ''),
        memory: parseFree(free || ''),
        failed: (failed || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
          const f = l.replace(/^[●*\s]+/, '').split(/\s+/)
          return { unit: f[0], active: f[2] || '', sub: f[3] || '', description: f.slice(4).join(' ') }
        }),
        docker: (docker || '').split('\n').filter(Boolean).map(l => {
          const [type, size, reclaimable] = l.split('|')
          return { type, size, reclaimable, bytes: parseSize(size), free: parseSize(reclaimable) }
        }),
        uptime: (up || '').split('\n')[0] || '',
        load: (/load average:\s*([\d.]+)/.exec(up || '') || [])[1] || '',
        gpus: (gpu || '').split('\n').filter(Boolean).map(l => {
          const f = l.split(',').map(x => x.trim())
          return {
            index: num(f[0]), name: f[1],
            usedMb: num(f[2]), totalMb: num(f[3]),
            util: num(f[4]), temp: num(f[5]),
          }
        }),
        gpuProcs: (gpuProcs || '').split('\n').filter(Boolean).map(l => {
          const f = l.split(',').map(x => x.trim())
          return { pid: num(f[0]), name: f[1], usedMb: num(f[2]) }
        }),
      }
    },

    async restartUnit(unit) {
      if (!/^[A-Za-z0-9@._:\\-]+$/.test(unit)) throw new Error(`refusing unit: ${unit}`)
      const r = await sdk.sudo(['systemctl', 'restart', unit])
      if (r.code !== 0) throw new Error(r.stderr.trim() || `restart failed (${r.code})`)
    },

    async unitLog(unit) {
      if (!/^[A-Za-z0-9@._:\\-]+$/.test(unit)) throw new Error(`refusing unit: ${unit}`)
      const r = await sdk.exec(['journalctl', '-u', unit, '-n', '60', '--no-pager'])
      return r.stdout || r.stderr
    },

    /** Reclaim disk. Each verb is fixed; nothing here is user-supplied. */
    async prune(what) {
      if (!(await hasDocker())) throw new Error('docker is not available here')
      const argv = {
        build:  ['docker', 'builder', 'prune', '-af'],
        images: ['docker', 'image', 'prune', '-af'],
        all:    ['docker', 'system', 'prune', '-af'],
      }[what]
      if (!argv) throw new Error(`unknown prune target: ${what}`)
      let r = await sdk.exec(argv)
      if (r.code !== 0 && /permission denied/i.test(r.stderr)) r = await sdk.sudo(argv)
      if (r.code !== 0) throw new Error(r.stderr.trim() || `prune failed (${r.code})`)
      return r.stdout.trim().split('\n').pop() || 'done'
    },

    /** Biggest directories under a path — the "what is eating my disk" answer. */
    async bigDirs(path = '/') {
      const r = await sdk.sudo(['du', '-xh', '-d1', path])
      return r.stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const [size, ...rest] = l.split(/\s+/)
        return { size, path: rest.join(' ') }
      }).filter(d => d.path && d.path !== path)
        .sort((a, b) => parseSize(a.size.replace(/([KMGT])$/, '$1B')) <
                        parseSize(b.size.replace(/([KMGT])$/, '$1B')) ? 1 : -1)
        .slice(0, 12)
    },
  }
}
