import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, checking, exec, focused, machines, panes, readTextFile, run, shared, theme } from "herdr";
import { WebSocket } from "websocket";

const PORT = 7777;
const PROTOCOL = 3;
const ICONS = { claude: { svg: "icons/claude.svg" }, agy: { image: "icons/antigravity.svg" } };
const AGENTS = { claude: "Claude", agy: "Antigravity" };

const icon = (backend, size, color) => {
  const i = ICONS[backend] ?? ICONS.claude;
  return i.image ? image(i.image).size(size).flex_none() : svg(i.svg).size(size).flex_none().text_color(color);
};
const machineColor = (m) => (shared("machine.colors") ?? {})[m ?? "local"] ?? null;
const tilde = (path, h) => (h && path?.startsWith(h) ? `~${path.slice(h.length)}` : path ?? "");
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : s < 86400 * 30 ? `${Math.floor(s / 86400)}d` : new Date(ms).toISOString().slice(0, 10);
};

// Same lookup as herdr-chat's panes: machines.json, else the ssh host on the default port.
async function endpoint(machine) {
  let url = `ws://127.0.0.1:${PORT}`;
  if (machine) {
    const map = JSON.parse((await readTextFile(`${appHome()}/data/herdr-chat/machines.json`).catch(() => null)) ?? "{}");
    if (map[machine]) url = map[machine];
    else {
      const r = await exec("ssh", ["-G", machine]);
      url = `ws://${r.stdout.match(/^hostname (\S+)/m)?.[1] ?? machine}:${PORT}`;
    }
  }
  const r = await exec("sh", ["-c", "cat ~/.config/herdr-chat/token"], { on: machine });
  if (r.code !== 0) throw new Error("no herdr-chat engine");
  return { url, token: r.stdout.trim() };
}

export default class ChatHistory extends View {
  init(_props, cx) {
    this.links = new Map();
    this.results = new Map();
    this.query = "";
    this.asked = 0;
    this.at = 0;
    this.search = InputState.new({ placeholder: "Search chats on every machine" });
    this.search.on("change", (_e, cx) => {
      this.query = this.search.value();
      const n = ++this.asked;
      cx.timer.after(250, () => { if (n === this.asked) this.ask(); });
    });
    this.search.on("submit", (_e, cx) => this.open(this.list()[this.at], cx));
    this.search.focus();
    cx.timer.after(150, () => this.search.focus());
    if (checking()) return;
    cx.timer.every(5000, (cx) => { this.sync(cx); cx.notify(); });
    this.sync(cx);
  }

  // One socket per connected machine; new ones join, gone ones drop out of the list.
  sync(cx) {
    const names = machines().filter((m) => m.layout === "ready").map((m) => m.name ?? "");
    for (const name of names) if (!this.links.has(name)) this.connect(name, cx);
    for (const name of [...this.links.keys()]) if (!names.includes(name)) { this.links.get(name).ws?.close().catch(() => {}); this.links.delete(name); this.results.delete(name); }
  }

  connect(name, cx) {
    const link = { ws: null, state: "connecting", home: null };
    this.links.set(name, link);
    const machine = name || null;
    cx.spawn(async (cx) => {
      while (this.links.get(name) === link) {
        try {
          link.home ??= (await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine })).stdout;
          const { url, token } = await endpoint(machine);
          link.ws = await WebSocket.connect(url);
          await link.ws.write(JSON.stringify({ type: "hello", v: PROTOCOL, token }));
          link.state = "searching";
          this.askOne(name);
          cx.notify();
          for (;;) {
            const raw = await link.ws.read();
            if (typeof raw !== "string") continue;
            const m = JSON.parse(raw);
            if (m.type === "history" && m.id === link.id) {
              this.results.set(name, m.chats.map((c) => ({ ...c, machine })));
              link.state = "ready";
              cx.notify();
            }
          }
        } catch {
          link.ws = null;
          link.state = "offline";
          cx.notify();
        }
        await new Promise((r) => cx.timer.after(10_000, () => r(null)));
      }
    });
  }

  askOne(name) {
    const link = this.links.get(name);
    if (!link?.ws) return;
    link.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    link.state = "searching";
    link.ws.write(JSON.stringify({ type: "history", id: link.id, q: this.query })).catch(() => {});
  }

  ask() {
    this.at = 0;
    for (const name of this.links.keys()) this.askOne(name);
  }

  list() {
    return [...this.results.values()].flat().sort((a, b) => b.when - a.when);
  }

  me() {
    return panes().find((x) => x.mod === "chat-history" && x.focused && x.tab === focused()?.tab)?.pane;
  }

  open(c, cx) {
    if (!c) return;
    const open = c.handoffKey && panes().find((x) => x.mod === "herdr-chat" && shared(`herdr-chat:info:${x.pane}`)?.key === c.handoffKey);
    if (open) return run("pane.focus", { pane: open.pane });
    const key = c.handoffKey ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const props = c.handoffKey ? { key, cwd: c.cwd, machine: c.machine, backend: c.backend, reopen: true } : { key, cwd: c.cwd, machine: c.machine, resume: c.id, backend: c.backend };
    const pane = this.me();
    run("pane.split", { ...(pane && { pane }), direction: "right", mod: "herdr-chat", props });
    cx.notify();
  }

  key(e, cx) {
    const n = this.list().length;
    if (e.key === "down") this.at = Math.min(n - 1, this.at + 1);
    else if (e.key === "up") this.at = Math.max(0, this.at - 1);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  row(c, i, t) {
    const home = this.links.get(c.machine ?? "")?.home;
    const color = machineColor(c.machine);
    const where = `${c.machine ?? "this computer"} · ${tilde(c.cwd, home) || "?"}`;
    return h_flex().id(`chat-${c.machine ?? ""}-${c.id}`).gap(10).px(10).py(7).rounded(8).items_start().cursor_pointer()
      .when(i === this.at, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.at = i; this.open(c, cx); })
      .child(div().pt(2).child(icon(c.backend, 14, t.dim)))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(c.title))
          .child(div().flex_none().text_size(11.5).text_color(t.dim).child(ago(c.when))))
        .when(Boolean(c.snippet), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(c.snippet)))
        .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
          .when(Boolean(color), (el) => el.child(div().w(7).h(7).rounded(4).flex_none().bg(color)))
          .child(div().flex_1().min_w(0).truncate().child(where))
          .when(Boolean(c.branch) && c.branch !== "HEAD", (el) => el.child(div().flex_none().child(c.branch)))));
  }

  render(cx) {
    const t = theme();
    const list = this.list();
    const waiting = [...this.links.entries()].filter(([, l]) => l.state === "searching" || l.state === "connecting").map(([n]) => n || "this computer");
    const offline = [...this.links.entries()].filter(([, l]) => l.state === "offline").map(([n]) => n || "this computer");
    const status = [
      waiting.length ? `Searching ${waiting.join(", ")}…` : `${list.length} chat${list.length === 1 ? "" : "s"}`,
      ...(offline.length ? [`no engine on ${offline.join(", ")}`] : []),
    ].join(" · ");
    return v_flex().size_full().min_h(0).bg(t.background).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().h(40).flex_none().mx(10).mt(8).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.input).bg(t.surface)
        .child(Input.new(this.search).flex_1().h_full().text_size(13).text_color(t.foreground)))
      .child(div().px(20).pt(8).pb(4).text_size(11.5).text_color(t.dim).child(status))
      .child(v_flex().id("chat-history-list").flex_1().min_h(0).px(10).pb(10).gap(1).overflow_y_scrollbar()
        .children(list.map((c, i) => this.row(c, i, t))));
  }
}
