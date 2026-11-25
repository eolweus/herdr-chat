import { exec, focused, hc, notify, panes } from "herdr";

// Same names as the Artifacts page uses, so it lists these servers and reuses its own.
const hash = (s) => {
  let h = 5381;
  for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return h.toString(36);
};
const sh = (script, args, on, timeout = 30000) => exec("sh", ["-c", script, "sh", ...args], { on, timeout });
const reachable = async (url) => {
  const r = await exec("curl", ["-s", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", url]).catch(() => null);
  return Boolean(r && /^[1-5]\d\d$/.test(r.stdout.trim()));
};
const terminals = async () => (JSON.parse((await hc(["ls", "--json"])).stdout || "{}").terminals ?? []).filter((t) => t.state === "live");
const freePort = async (on) => Number((await sh(`python3 -c 'import socket; s=socket.socket(); s.bind(("", 0)); print(s.getsockname()[1])'`, [], on)).stdout.trim());
const wait = async (url) => { for (let i = 0; i < 20 && !(await reachable(url)); i++) await exec("sleep", ["0.25"]); };

async function serve(machine, dir) {
  const key = hash(dir);
  for (const t of await terminals()) {
    const m = /^html-(.+)-(\d+)$/.exec(t.name ?? "");
    if (m && m[1] === key && t.address.startsWith(`${machine}/`)) return Number(m[2]);
  }
  const port = await freePort(machine);
  if (!port) throw new Error(`Couldn't find a free port on ${machine}`);
  const r = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", "--name", `html-${key}-${port}`, "--on", machine, "--cwd", dir,
    "--", "sh", "-c", 'exec "${SHELL:-sh}" -lic "$1"', "sh", `exec python3 -m http.server ${port} --bind 0.0.0.0`]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Couldn't start a server for the page");
  for (let i = 0; i < 20; i++) {
    if ((await sh(`curl -s -m 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/"`, [String(port)], machine, 5000).catch(() => null))?.stdout.trim().startsWith("2")) break;
    await exec("sleep", ["0.25"]);
  }
  return port;
}

async function reach(machine, port) {
  if (await reachable(`http://${machine}:${port}/`)) return `http://${machine}:${port}`;
  const open = (await terminals()).map((t) => /^tunnel-(.+)-(\d+)-(\d+)$/.exec(t.name ?? "")).find((m) => m && m[1] === machine && Number(m[3]) === port);
  if (open) return `http://localhost:${open[2]}`;
  const local = await freePort(null);
  const r = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", "--name", `tunnel-${machine}-${local}-${port}`, "--",
    "ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-L", `${local}:127.0.0.1:${port}`, machine]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "ssh tunnel failed");
  await wait(`http://localhost:${local}/`);
  return `http://localhost:${local}`;
}

const browser = (args) => exec("/bin/zsh", ["-lc", 'exec herdr-browser "$@"', "zsh", ...args], { timeout: 30000 });

// A browser already shown in the chat's tab, else in the tab on screen, takes the page instead of a new pane.
async function nearby(tab) {
  const ls = (await browser(["ls"])).stdout.split("\n").map((l) => l.split("\t")[0]).filter(Boolean);
  const where = (t) => panes().find((x) => x.tab === t && ls.includes(x.terminal))?.terminal;
  return (tab && where(tab)) ?? where(focused()?.tab);
}

// HTML opens in a terminal browser beside the chat; another machine's folder is served first.
export async function openHtml(path, machine, beside, tab) {
  try {
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const url = machine ? (await reach(machine, await serve(machine, dir))) + encodeURI(path.slice(dir.length)) : `file://${encodeURI(path)}`;
    const t = await nearby(tab);
    if (t && (await browser(["action", t, "--", "open", url])).code === 0) return;
    const r = await browser(["open", url, "--right", ...(beside ? ["--pane", beside] : [])]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "herdr-browser failed");
  } catch (e) {
    notify({ title: "Couldn't open the page", body: String(e?.message ?? e), level: "error" });
  }
}
