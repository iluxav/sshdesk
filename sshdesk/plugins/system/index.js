// src/adapter.js
var SEP = "__SSHDESK_SECTION__";
var OVERVIEW = [
  "df -PB1 -x tmpfs -x devtmpfs -x squashfs 2>/dev/null",
  `echo ${SEP}`,
  "free -b 2>/dev/null",
  `echo ${SEP}`,
  "systemctl --failed --no-legend --no-pager 2>/dev/null",
  `echo ${SEP}`,
  'docker system df --format "{{.Type}}|{{.Size}}|{{.Reclaimable}}" 2>/dev/null',
  `echo ${SEP}`,
  "uptime -p 2>/dev/null; uptime 2>/dev/null | head -1",
  `echo ${SEP}`,
  "nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null",
  `echo ${SEP}`,
  "nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null"
].join("; ");
var num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
function parseDf(text) {
  return text.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
    const f = l.split(/\s+/);
    if (f.length < 6) return null;
    const size = num(f[1]), used = num(f[2]), avail = num(f[3]);
    return {
      device: f[0],
      mount: f.slice(5).join(" "),
      size,
      used,
      avail,
      pct: size ? Math.round(used / size * 100) : 0
    };
  }).filter(Boolean).filter((fs) => fs.size > 0);
}
function parseFree(text) {
  const out = { total: 0, used: 0, available: 0, swapTotal: 0, swapUsed: 0 };
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (/^Mem:/.test(line)) {
      out.total = num(f[1]);
      out.used = num(f[2]);
      out.available = num(f[6] ?? f[3]);
    } else if (/^Swap:/.test(line)) {
      out.swapTotal = num(f[1]);
      out.swapUsed = num(f[2]);
    }
  }
  return out;
}
function parseSize(s) {
  const m = /([\d.]+)\s*([KMGT]?)B/i.exec(s || "");
  if (!m) return 0;
  const mult = { "": 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2].toUpperCase()] ?? 1;
  return Math.round(parseFloat(m[1]) * mult);
}
function createAdapter(sdk) {
  const hasDocker = () => sdk.capability("docker", async (exec) => (await exec(["sh", "-c", "command -v docker >/dev/null && docker info >/dev/null 2>&1 && echo yes"])).stdout.includes("yes"));
  return {
    async overview() {
      const r = await sdk.exec(["sh", "-c", OVERVIEW]);
      const [df, free, failed, docker, up, gpu, gpuProcs] = r.stdout.split(SEP).map((s) => s.trim());
      return {
        filesystems: parseDf(df || ""),
        memory: parseFree(free || ""),
        failed: (failed || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
          const f = l.replace(/^[●*\s]+/, "").split(/\s+/);
          return { unit: f[0], active: f[2] || "", sub: f[3] || "", description: f.slice(4).join(" ") };
        }),
        docker: (docker || "").split("\n").filter(Boolean).map((l) => {
          const [type, size, reclaimable] = l.split("|");
          return { type, size, reclaimable, bytes: parseSize(size), free: parseSize(reclaimable) };
        }),
        uptime: (up || "").split("\n")[0] || "",
        load: (/load average:\s*([\d.]+)/.exec(up || "") || [])[1] || "",
        gpus: (gpu || "").split("\n").filter(Boolean).map((l) => {
          const f = l.split(",").map((x) => x.trim());
          return {
            index: num(f[0]),
            name: f[1],
            usedMb: num(f[2]),
            totalMb: num(f[3]),
            util: num(f[4]),
            temp: num(f[5])
          };
        }),
        gpuProcs: (gpuProcs || "").split("\n").filter(Boolean).map((l) => {
          const f = l.split(",").map((x) => x.trim());
          return { pid: num(f[0]), name: f[1], usedMb: num(f[2]) };
        })
      };
    },
    async restartUnit(unit) {
      if (!/^[A-Za-z0-9@._:\\-]+$/.test(unit)) throw new Error(`refusing unit: ${unit}`);
      const r = await sdk.sudo(["systemctl", "restart", unit]);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `restart failed (${r.code})`);
    },
    async unitLog(unit) {
      if (!/^[A-Za-z0-9@._:\\-]+$/.test(unit)) throw new Error(`refusing unit: ${unit}`);
      const r = await sdk.exec(["journalctl", "-u", unit, "-n", "60", "--no-pager"]);
      return r.stdout || r.stderr;
    },
    /** Reclaim disk. Each verb is fixed; nothing here is user-supplied. */
    async prune(what) {
      if (!await hasDocker()) throw new Error("docker is not available here");
      const argv = {
        build: ["docker", "builder", "prune", "-af"],
        images: ["docker", "image", "prune", "-af"],
        all: ["docker", "system", "prune", "-af"]
      }[what];
      if (!argv) throw new Error(`unknown prune target: ${what}`);
      let r = await sdk.exec(argv);
      if (r.code !== 0 && /permission denied/i.test(r.stderr)) r = await sdk.sudo(argv);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `prune failed (${r.code})`);
      return r.stdout.trim().split("\n").pop() || "done";
    },
    /** Biggest directories under a path — the "what is eating my disk" answer. */
    async bigDirs(path = "/") {
      const r = await sdk.sudo(["du", "-xh", "-d1", path]);
      return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        const [size, ...rest] = l.split(/\s+/);
        return { size, path: rest.join(" ") };
      }).filter((d) => d.path && d.path !== path).sort((a, b) => parseSize(a.size.replace(/([KMGT])$/, "$1B")) < parseSize(b.size.replace(/([KMGT])$/, "$1B")) ? 1 : -1).slice(0, 12);
    }
  };
}

// src/index.jsx
var manifest = {
  id: "system",
  name: "System",
  icon: "\u{1F4CA}",
  window: { w: 1e3, h: 640 }
};
var gb = (b) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e3).toFixed(0)} KB`;
function createApp({ React, useFw, useApi }) {
  const { useState, useEffect, useCallback } = React;
  function Card({ tone = "ok", label, value, hint, onClick }) {
    return /* @__PURE__ */ React.createElement("button", { className: `sys-card sys-${tone}`, onClick, disabled: !onClick }, /* @__PURE__ */ React.createElement("div", { className: "sys-card-value" }, value), /* @__PURE__ */ React.createElement("div", { className: "sys-card-label" }, label), hint && /* @__PURE__ */ React.createElement("div", { className: "sys-card-hint" }, hint));
  }
  function Bar({ pct, tone }) {
    return /* @__PURE__ */ React.createElement("div", { className: "sys-bar" }, /* @__PURE__ */ React.createElement("div", { className: `sys-bar-fill sys-${tone}-fill`, style: { width: `${Math.min(100, pct)}%` } }));
  }
  return function System({ setTitle }) {
    const fw = useFw();
    const api = useApi();
    const [d, setD] = useState(null);
    const [err, setErr] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [log, setLog] = useState(null);
    const [big, setBig] = useState(null);
    const load = useCallback(async () => {
      setBusy(true);
      setErr("");
      try {
        setD(await api.overview());
      } catch (e) {
        setErr(String(e));
      } finally {
        setBusy(false);
      }
    }, []);
    useEffect(() => {
      load();
      const t = setInterval(load, 15e3);
      return () => clearInterval(t);
    }, [load]);
    useEffect(() => {
      setTitle && setTitle("System");
    }, [setTitle]);
    const act = async (fn, ok) => {
      setErr("");
      setNote("");
      setBusy(true);
      try {
        const r = await fn();
        setNote(ok || r || "done");
        await load();
      } catch (e) {
        setErr(String(e).replace(/^Error:\s*/, ""));
      } finally {
        setBusy(false);
      }
    };
    const prune = async (what) => {
      const labels = { build: "build cache", images: "unused images", all: "everything unused" };
      const ok = await fw.ui.confirm({
        title: `Prune ${labels[what]}?`,
        message: "This permanently deletes Docker data that is not in use by a running container.",
        okLabel: "Prune",
        danger: true
      });
      if (ok) act(() => api.prune(what));
    };
    if (!d) {
      return /* @__PURE__ */ React.createElement("div", { className: "sys-root" }, /* @__PURE__ */ React.createElement("div", { className: "sys-empty" }, err || "reading system\u2026"));
    }
    const fullest = d.filesystems.reduce((a, b) => b.pct > (a?.pct ?? -1) ? b : a, null);
    const reclaimable = d.docker.reduce((s, x) => s + x.free, 0);
    const swapping = d.memory.swapUsed > 0;
    const vram = d.gpus.reduce((s, g) => s + g.usedMb, 0);
    return /* @__PURE__ */ React.createElement("div", { className: "sys-root" }, /* @__PURE__ */ React.createElement("div", { className: "sys-bar-top" }, /* @__PURE__ */ React.createElement("button", { className: "sys-btn", onClick: load, disabled: busy }, "\u27F3 refresh"), /* @__PURE__ */ React.createElement("span", { className: "sys-dim" }, d.uptime), d.load && /* @__PURE__ */ React.createElement("span", { className: "sys-dim" }, "load ", d.load), /* @__PURE__ */ React.createElement("span", { className: "sys-spacer" }), note && /* @__PURE__ */ React.createElement("span", { className: "sys-note" }, note)), err && /* @__PURE__ */ React.createElement("div", { className: "sys-err" }, err), /* @__PURE__ */ React.createElement("div", { className: "sys-scroll" }, /* @__PURE__ */ React.createElement("div", { className: "sys-cards" }, /* @__PURE__ */ React.createElement(
      Card,
      {
        tone: d.failed.length ? "bad" : "ok",
        value: d.failed.length,
        label: "failed units",
        hint: d.failed.length ? "needs attention" : "all healthy"
      }
    ), /* @__PURE__ */ React.createElement(
      Card,
      {
        tone: fullest && fullest.pct >= 90 ? "bad" : fullest && fullest.pct >= 80 ? "warn" : "ok",
        value: fullest ? `${fullest.pct}%` : "\u2014",
        label: fullest ? `${fullest.mount} full` : "disk",
        hint: fullest ? `${gb(fullest.avail)} free` : ""
      }
    ), /* @__PURE__ */ React.createElement(
      Card,
      {
        tone: reclaimable > 5e9 ? "warn" : "ok",
        value: gb(reclaimable),
        label: "docker reclaimable",
        hint: reclaimable ? "click to prune" : "nothing to reclaim",
        onClick: reclaimable ? () => prune("all") : void 0
      }
    ), /* @__PURE__ */ React.createElement(
      Card,
      {
        tone: swapping ? "warn" : "ok",
        value: gb(d.memory.available),
        label: "memory available",
        hint: swapping ? `swapping ${gb(d.memory.swapUsed)}` : "not swapping"
      }
    ), d.gpus.length > 0 && /* @__PURE__ */ React.createElement(
      Card,
      {
        tone: vram > 0 ? "warn" : "ok",
        value: `${(vram / 1024).toFixed(1)} GB`,
        label: `VRAM in use \xB7 ${d.gpus.length} GPU${d.gpus.length > 1 ? "s" : ""}`,
        hint: d.gpus.map((g) => `${g.temp}\xB0C`).join(" \xB7 ")
      }
    )), d.failed.length > 0 && /* @__PURE__ */ React.createElement("section", { className: "sys-section" }, /* @__PURE__ */ React.createElement("h3", null, "Failed units"), d.failed.map((u) => /* @__PURE__ */ React.createElement("div", { key: u.unit, className: "sys-row" }, /* @__PURE__ */ React.createElement("span", { className: "sys-dot sys-bad-dot" }), /* @__PURE__ */ React.createElement("span", { className: "mono" }, u.unit), /* @__PURE__ */ React.createElement("span", { className: "sys-dim sys-grow" }, u.description), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "sys-btn",
        disabled: busy,
        onClick: () => api.unitLog(u.unit).then(setLog).catch((e) => setErr(String(e)))
      },
      "log"
    ), /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "sys-btn",
        disabled: busy,
        onClick: () => act(() => api.restartUnit(u.unit), `restarted ${u.unit}`)
      },
      "restart"
    )))), /* @__PURE__ */ React.createElement("section", { className: "sys-section" }, /* @__PURE__ */ React.createElement("h3", null, "Filesystems"), d.filesystems.map((fs) => /* @__PURE__ */ React.createElement("div", { key: fs.mount, className: "sys-fs" }, /* @__PURE__ */ React.createElement("div", { className: "sys-fs-head" }, /* @__PURE__ */ React.createElement("span", { className: "mono" }, fs.mount), /* @__PURE__ */ React.createElement("span", { className: "sys-dim" }, gb(fs.avail), " free of ", gb(fs.size)), /* @__PURE__ */ React.createElement("span", { className: fs.pct >= 90 ? "sys-bad-text" : fs.pct >= 80 ? "sys-warn-text" : "sys-dim" }, fs.pct, "%")), /* @__PURE__ */ React.createElement(Bar, { pct: fs.pct, tone: fs.pct >= 90 ? "bad" : fs.pct >= 80 ? "warn" : "ok" }))), /* @__PURE__ */ React.createElement("div", { className: "sys-actions" }, /* @__PURE__ */ React.createElement(
      "button",
      {
        className: "sys-btn",
        disabled: busy,
        onClick: () => act(async () => {
          setBig(await api.bigDirs("/"));
          return "scanned /";
        })
      },
      "what is using / ?"
    )), big && /* @__PURE__ */ React.createElement("div", { className: "sys-dirs" }, big.map((x) => /* @__PURE__ */ React.createElement("div", { key: x.path, className: "sys-row" }, /* @__PURE__ */ React.createElement("span", { className: "mono sys-size" }, x.size), /* @__PURE__ */ React.createElement("span", { className: "mono sys-dim" }, x.path))))), d.docker.length > 0 && /* @__PURE__ */ React.createElement("section", { className: "sys-section" }, /* @__PURE__ */ React.createElement("h3", null, "Docker"), d.docker.map((x) => /* @__PURE__ */ React.createElement("div", { key: x.type, className: "sys-row" }, /* @__PURE__ */ React.createElement("span", { className: "sys-grow" }, x.type), /* @__PURE__ */ React.createElement("span", { className: "sys-dim mono" }, x.size), /* @__PURE__ */ React.createElement("span", { className: x.free > 1e9 ? "sys-warn-text mono" : "sys-dim mono" }, x.reclaimable, " reclaimable"))), /* @__PURE__ */ React.createElement("div", { className: "sys-actions" }, /* @__PURE__ */ React.createElement("button", { className: "sys-btn", disabled: busy, onClick: () => prune("build") }, "prune build cache"), /* @__PURE__ */ React.createElement("button", { className: "sys-btn", disabled: busy, onClick: () => prune("images") }, "prune images"), /* @__PURE__ */ React.createElement("button", { className: "sys-btn sys-danger", disabled: busy, onClick: () => prune("all") }, "prune all"))), d.gpus.length > 0 && /* @__PURE__ */ React.createElement("section", { className: "sys-section" }, /* @__PURE__ */ React.createElement("h3", null, "GPU"), d.gpus.map((g) => /* @__PURE__ */ React.createElement("div", { key: g.index, className: "sys-fs" }, /* @__PURE__ */ React.createElement("div", { className: "sys-fs-head" }, /* @__PURE__ */ React.createElement("span", { className: "mono" }, g.name), /* @__PURE__ */ React.createElement("span", { className: "sys-dim" }, (g.usedMb / 1024).toFixed(1), " / ", (g.totalMb / 1024).toFixed(0), " GB"), /* @__PURE__ */ React.createElement("span", { className: "sys-dim" }, g.util, "% \xB7 ", g.temp, "\xB0C")), /* @__PURE__ */ React.createElement(
      Bar,
      {
        pct: g.totalMb ? g.usedMb / g.totalMb * 100 : 0,
        tone: g.usedMb / g.totalMb > 0.9 ? "bad" : "ok"
      }
    ))), d.gpuProcs.length > 0 && /* @__PURE__ */ React.createElement("div", { className: "sys-dirs" }, d.gpuProcs.map((p) => /* @__PURE__ */ React.createElement("div", { key: p.pid, className: "sys-row" }, /* @__PURE__ */ React.createElement("span", { className: "mono sys-size" }, (p.usedMb / 1024).toFixed(1), " GB"), /* @__PURE__ */ React.createElement("span", { className: "mono" }, p.name), /* @__PURE__ */ React.createElement("span", { className: "sys-dim mono" }, "pid ", p.pid)))))), log !== null && /* @__PURE__ */ React.createElement("div", { className: "sys-modal", onClick: () => setLog(null) }, /* @__PURE__ */ React.createElement("pre", { className: "sys-log", onClick: (e) => e.stopPropagation() }, log)));
  };
}
export {
  createAdapter,
  createApp,
  manifest
};
