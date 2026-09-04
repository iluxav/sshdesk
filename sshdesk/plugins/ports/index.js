// src/index.jsx
var manifest = {
  id: "ports",
  name: "Ports",
  icon: "\u{1F50C}",
  window: { w: 940, h: 520 }
};
function createAdapter(sdk) {
  const LOOPBACK = /^(127\.|::1|\[?::1\]?)/;
  function parse(stdout) {
    return stdout.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
      const f = line.split(/\s+/);
      const addr = f[3] ?? "";
      const i = addr.lastIndexOf(":");
      if (i < 0) return null;
      const bind = addr.slice(0, i);
      const port = Number(addr.slice(i + 1));
      if (!port) return null;
      const mine = line.includes("users:((");
      const pm = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
      return {
        port,
        bind,
        loopback: LOOPBACK.test(bind),
        process: pm ? pm[1] : "",
        pid: pm ? Number(pm[2]) : 0,
        mine
      };
    }).filter(Boolean);
  }
  return {
    async list() {
      const r = await sdk.exec(["ss", "-ltnpH"]);
      if (r.code !== 0) throw new Error(r.stderr || "ss failed");
      const byPort = /* @__PURE__ */ new Map();
      for (const e of parse(r.stdout)) {
        const prev = byPort.get(e.port);
        if (!prev || !prev.mine && e.mine) byPort.set(e.port, e);
      }
      return [...byPort.values()].sort((a, b) => a.port - b.port);
    },
    async kill(pid, { force = false } = {}) {
      if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing pid ${pid}`);
      const argv = force ? ["kill", "-9", String(pid)] : ["kill", String(pid)];
      let r = await sdk.exec(argv);
      if (r.code !== 0 && /not permitted|Operation not permitted/i.test(r.stderr)) {
        r = await sdk.sudo(argv);
      }
      if (r.code !== 0) throw new Error(r.stderr.trim() || `kill failed (${r.code})`);
      return true;
    }
  };
}
function createApp({ React, useFw, useApi }) {
  const { useState, useEffect, useCallback, useMemo, useRef } = React;
  return function Ports({ setTitle }) {
    const fw = useFw();
    const api = useApi();
    const memKey = () => `ports.remembered.${fw.host.current()}`;
    const remembered = () => fw.prefs.get(memKey(), {});
    const remember = (remote, local) => fw.prefs.set(memKey(), { ...remembered(), [remote]: local });
    const forget = (remote) => {
      const m = { ...remembered() };
      delete m[remote];
      fw.prefs.set(memKey(), m);
    };
    const [rows, setRows] = useState([]);
    const [fwds, setFwds] = useState({});
    const [filter, setFilter] = useState("");
    const [mineOnly, setMineOnly] = useState(false);
    const [err, setErr] = useState("");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [auto, setAuto] = useState(() => fw.prefs.get("ports.auto", true));
    const reconciling = useRef(false);
    const load = useCallback(async () => {
      setBusy(true);
      setErr("");
      try {
        const [list, f] = await Promise.all([api.list(), fw.net.forwards()]);
        setRows(list);
        setFwds(f);
      } catch (e) {
        setErr(String(e));
      } finally {
        setBusy(false);
      }
    }, []);
    useEffect(() => {
      load();
    }, [load]);
    useEffect(() => {
      setTitle && setTitle("Ports");
    }, [setTitle]);
    useEffect(() => {
      fw.prefs.set("ports.auto", auto);
    }, [auto]);
    const reconcile = useCallback(async () => {
      if (reconciling.current) return;
      reconciling.current = true;
      try {
        const [list, active] = await Promise.all([api.list(), fw.net.forwards()]);
        setRows(list);
        const mem = remembered();
        let changed = false;
        for (const r of list) {
          if (!r.mine) continue;
          if (active[r.port]) continue;
          const want = mem[r.port];
          if (want === void 0) continue;
          const local = await fw.net.forward(r.port, want);
          if (local !== want) remember(r.port, local);
          changed = true;
        }
        setFwds(changed ? await fw.net.forwards() : active);
      } catch {
      } finally {
        reconciling.current = false;
      }
    }, []);
    useEffect(() => {
      if (!auto) return;
      reconcile();
      const t = setInterval(reconcile, 4e3);
      return () => clearInterval(t);
    }, [auto, reconcile]);
    const shown = useMemo(() => {
      const f = filter.trim().toLowerCase();
      return rows.filter((r) => !mineOnly || r.mine).filter((r) => !f || String(r.port).includes(f) || r.process.toLowerCase().includes(f) || r.bind.toLowerCase().includes(f));
    }, [rows, filter, mineOnly]);
    const run = async (fn, ok) => {
      setErr("");
      setNote("");
      setBusy(true);
      try {
        await fn();
        if (ok) setNote(ok);
      } catch (e) {
        setErr(String(e).replace(/^Error:\s*/, ""));
      } finally {
        setBusy(false);
      }
    };
    const forward = (r) => run(async () => {
      const local = await fw.net.forward(r.port, remembered()[r.port]);
      remember(r.port, local);
      setFwds(await fw.net.forwards());
      setNote(`remote ${r.port} \u2192 localhost:${local}`);
    });
    const unforward = (r) => run(async () => {
      await fw.net.unforward(r.port);
      forget(r.port);
      setFwds(await fw.net.forwards());
    }, `stopped forwarding ${r.port}`);
    const kill = (r, force) => run(async () => {
      await api.kill(r.pid, { force });
      await load();
    }, `killed ${r.process} (${r.pid})`);
    return /* @__PURE__ */ React.createElement("div", { className: "ports-root" }, /* @__PURE__ */ React.createElement("div", { className: "ports-bar" }, /* @__PURE__ */ React.createElement(
      "input",
      {
        className: "ports-input",
        value: filter,
        spellCheck: false,
        placeholder: "filter port, process or bind",
        onChange: (e) => setFilter(e.target.value)
      }
    ), /* @__PURE__ */ React.createElement("label", { className: "ports-check" }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "checkbox",
        checked: mineOnly,
        onChange: (e) => setMineOnly(e.target.checked)
      }
    ), "mine only"), /* @__PURE__ */ React.createElement("label", { className: "ports-check", title: "Re-forward ports you have forwarded before on this host" }, /* @__PURE__ */ React.createElement(
      "input",
      {
        type: "checkbox",
        checked: auto,
        onChange: (e) => setAuto(e.target.checked)
      }
    ), "auto"), /* @__PURE__ */ React.createElement("button", { className: "ports-btn", onClick: load, title: "Refresh" }, "\u27F3"), /* @__PURE__ */ React.createElement("span", { className: "ports-spacer" }), note && /* @__PURE__ */ React.createElement("span", { className: "ports-note" }, note)), err && /* @__PURE__ */ React.createElement("div", { className: "ports-err" }, err), /* @__PURE__ */ React.createElement("div", { className: "ports-scroll" }, /* @__PURE__ */ React.createElement("table", { className: "ports-table" }, /* @__PURE__ */ React.createElement("thead", null, /* @__PURE__ */ React.createElement("tr", null, /* @__PURE__ */ React.createElement("th", { style: { width: 78 } }, "Port"), /* @__PURE__ */ React.createElement("th", { style: { width: 132 } }, "Bind"), /* @__PURE__ */ React.createElement("th", null, "Process"), /* @__PURE__ */ React.createElement("th", { style: { width: 74 } }, "PID"), /* @__PURE__ */ React.createElement("th", { style: { width: 96 } }, "Owner"), /* @__PURE__ */ React.createElement("th", { style: { width: 250 } }))), /* @__PURE__ */ React.createElement("tbody", null, shown.map((r) => {
      const local = fwds[r.port];
      return /* @__PURE__ */ React.createElement("tr", { key: `${r.port}-${r.bind}` }, /* @__PURE__ */ React.createElement("td", { className: "mono" }, r.port), /* @__PURE__ */ React.createElement("td", { className: "dim mono" }, r.bind, r.loopback && /* @__PURE__ */ React.createElement("span", { className: "ports-tag" }, "loopback")), /* @__PURE__ */ React.createElement("td", { className: "mono" }, r.process || /* @__PURE__ */ React.createElement("span", { className: "dim" }, "\u2014")), /* @__PURE__ */ React.createElement("td", { className: "dim mono" }, r.pid || ""), /* @__PURE__ */ React.createElement("td", null, /* @__PURE__ */ React.createElement("span", { className: r.mine ? "ports-badge mine" : "ports-badge" }, r.mine ? "yours" : "system")), /* @__PURE__ */ React.createElement("td", { className: "ports-actions" }, local ? /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement(
        "button",
        {
          className: "ports-btn accent",
          onClick: () => fw.net.openUrl(`http://localhost:${local}`)
        },
        "open :",
        local
      ), /* @__PURE__ */ React.createElement(
        "button",
        {
          className: "ports-btn",
          disabled: busy,
          onClick: () => unforward(r)
        },
        "unforward"
      )) : /* @__PURE__ */ React.createElement(
        "button",
        {
          className: "ports-btn",
          disabled: busy,
          onClick: () => forward(r),
          title: "Tunnel this port to your Mac"
        },
        "forward"
      ), r.mine && r.pid > 1 && /* @__PURE__ */ React.createElement(
        "button",
        {
          className: "ports-btn danger",
          disabled: busy,
          onClick: () => kill(r, false),
          title: "SIGTERM (shift-click for SIGKILL)",
          onMouseDown: (e) => {
            if (e.shiftKey) {
              e.preventDefault();
              kill(r, true);
            }
          }
        },
        "kill"
      )));
    })))), /* @__PURE__ */ React.createElement("div", { className: "ports-status" }, shown.length, " of ", rows.length, " listening", " \xB7 ", rows.filter((r) => r.mine).length, " yours", " \xB7 ", Object.keys(fwds).length, " forwarded", " \xB7 ", Object.keys(remembered()).length, " remembered", auto && " \xB7 auto", busy && " \xB7 working\u2026"));
  };
}
export {
  createAdapter,
  createApp,
  manifest
};
