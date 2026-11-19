// /move <machine> [folder] [--force]: carry this chat's session to another machine's engine and close it here.
// The app reaches both machines itself, so the transcript is copied with scp and resumed through /api/adopt.

import { appHome, exec, machines, notify, panes, props, readTextFile, run, spaces } from "herdr";

const PORT = 7777;
const enc = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const label = (m) => m ?? "mac";
const at = (m, path) => (m ? `${m}:${path}` : path);

async function engine(machine, own) {
  let url = own && props()?.engine ? props().engine.replace(/^ws/, "http") : `http://127.0.0.1:${PORT}`;
  if (machine && !(own && props()?.engine)) {
    const map = JSON.parse((await readTextFile(`${appHome()}/data/herdr-chat/machines.json`).catch(() => null)) ?? "{}");
    if (map[machine]) url = map[machine].replace(/^ws/, "http");
    else {
      const r = await exec("ssh", ["-G", machine]);
      url = `http://${r.stdout.match(/^hostname (\S+)/m)?.[1] ?? machine}:${PORT}`;
    }
  }
  const r = await exec("sh", ["-c", "cat ~/.config/herdr-chat/token"], { on: machine });
  if (r.code !== 0) throw new Error(`no chat engine token on ${label(machine)}`);
  const token = r.stdout.trim();
  return async (path, body) => {
    const res = await fetch(`${url.replace(/\/+$/, "")}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error ?? `${path}: HTTP ${res.status}`);
    return out;
  };
}

// HOME, and the folder's git state if it is a checkout.
async function probe(machine, dir) {
  const script = `printf 'home=%s\\n' "$HOME"; d=${dir ? q(dir) : '""'}; [ -n "$d" ] || exit 0; [ -d "$d" ] && echo exists=1 || exit 0
    cd "$d" && git rev-parse --git-dir >/dev/null 2>&1 || exit 0
    printf 'branch=%s\\nsha=%s\\ndirty=%s\\n' "$(git branch --show-current)" "$(git rev-parse --short HEAD 2>/dev/null)" "$(git status --porcelain | wc -l | tr -d ' ')"`;
  const r = await exec("sh", ["-c", script], { on: machine, timeout: 30000 });
  if (r.code !== 0) throw new Error(`can't reach ${label(machine)}: ${(r.stderr || r.stdout).trim()}`);
  return Object.fromEntries(r.stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

function machineArg(name) {
  if (["mac", "local", "here", "this"].includes(name)) return null;
  if (machines().some((m) => m.name === name)) return name;
  throw new Error(`no machine called ${name} (known: mac, ${machines().map((m) => m.name).filter(Boolean).join(", ")})`);
}

export async function moveChat(view, args) {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const force = words.includes("--force");
  const [target, folder] = words.filter((w) => w !== "--force");
  if (!target) throw new Error("say where: /move mac or /move munin");
  const src = view.machine ?? null;
  const dst = machineArg(target);
  if (dst === src) throw new Error(`this chat already runs on ${label(src)}`);
  if (view.state.busy || view.pending()) throw new Error("stop the current turn (or answer its card) first");
  const sid = view.state.session;
  if (!sid) throw new Error("nothing to move yet: send a message first");

  const from = await probe(src, view.cwd);
  const home = (await probe(dst, null)).home;
  const rel = view.cwd === from.home ? "~" : view.cwd?.startsWith(`${from.home}/`) ? `~${view.cwd.slice(from.home.length)}` : view.cwd;
  const spot = folder ?? rel;
  const cwd = spot.startsWith("~") ? home + spot.slice(1) : spot;
  const to = await probe(dst, cwd);
  if (!to.exists) throw new Error(`${spot} doesn't exist on ${label(dst)}; clone it there, or name a folder: /move ${target} <folder>`);
  if (Number(from.dirty) > 0 && !force) {
    throw new Error(`${from.dirty} uncommitted change(s) in ${rel} on ${label(src)} won't move. Commit and get them to ${label(dst)} first, or /move ${target} --force`);
  }
  const git = from.sha && to.sha && (from.sha !== to.sha || from.branch !== to.branch)
    ? ` The checkout there is on ${to.branch || "a detached HEAD"} at ${to.sha}; on ${label(src)} it was ${from.branch || "a detached HEAD"} at ${from.sha}.`
    : "";
  if (git) notify({ title: `${label(dst)}'s checkout differs`, body: git.trim(), level: "warning" });

  notify({ title: `Moving this chat to ${label(dst)}…`, level: "info" });
  const file = `${from.home}/.claude/projects/${enc(view.cwd)}/${sid}`;
  const dir = `${home}/.claude/projects/${enc(cwd)}`;
  const mk = await exec("sh", ["-c", `mkdir -p ${q(dir)}`], { on: dst });
  if (mk.code !== 0) throw new Error(`can't make ${dir} on ${label(dst)}`);
  const both = src && dst ? ["-3"] : [];
  const copy = await exec("scp", ["-q", ...both, at(src, `${file}.jsonl`), at(dst, `${dir}/`)], { timeout: 300000 });
  if (copy.code !== 0) throw new Error(`copying the conversation failed: ${copy.stderr.trim()}`);
  const extra = await exec("sh", ["-c", `test -d ${q(file)}`], { on: src });
  if (extra.code === 0) await exec("scp", ["-q", "-r", ...both, at(src, file), at(dst, `${dir}/`)], { timeout: 300000 });

  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const preamble = `[This session moved from ${label(src)} to ${label(dst)}. The working folder is now ${cwd} (it was ${view.cwd} on ${label(src)}); paths and output in earlier messages refer to ${label(src)}.${git}]`;
  await (await engine(dst, false))("/api/adopt", { key, cwd, session: sid, preamble, mode: view.state.mode, model: view.state.model || undefined });

  const tab = view.pane && panes().find((p) => p.pane === view.pane)?.tab;
  const space = tab && spaces().find((s) => s.tabs.some((x) => x.id === tab))?.id;
  run("tab.new", { mod: "herdr-chat", props: { key, machine: dst, cwd }, ...(space ? { space } : {}) });
  await (await engine(src, true))("/api/close", { key: view.key }).catch(() => {});
  if (view.pane) run("pane.close", { pane: view.pane });
  notify({ title: `Moved to ${label(dst)}`, body: `${spot} · the conversation continues there`, level: "success" });
}
