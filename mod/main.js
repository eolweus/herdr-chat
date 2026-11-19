import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, InputState, ScrollHandle } from "gpui-base";
import { appHome, checking, exec, focused, home, nextCommand, notify, openOverlay, panes, props, readTextFile, run, settings, setShared, shared, spaces, theme } from "herdr";
import { WebSocket } from "websocket";
import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { CodeCache } from "./markdown.js";
import { userRow, textRow, thinkingRow, toolRow, noticeRow, endRow, groupRow } from "./rows.js";
import { Viewer } from "./viewer.js";
import { Panel } from "./panel.js";
import { FileView } from "./fileview.js";
import { permissionCard, questionCard } from "./cards.js";
import { composer } from "./composer.js";

const PROTOCOL = 1;
const PORT = 7777;
const DATA = "data/herdr-chat";
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const CYCLE = ["default", "acceptEdits", "plan", "auto"];

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  const r = Math.floor(Math.random() * 16);
  return (c === "x" ? r : 8 + (r % 4)).toString(16);
});
const safe = (s) => s.replace(/[^A-Za-z0-9_-]/g, "_");
const tilde = (path, h) => (h && path?.startsWith(h) ? `~${path.slice(h.length)}` : path ?? "");

export default class HerdrChat extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.viewer) return void (this.other = new Viewer(p, cx));
    if (p.panel) return void (this.other = new Panel(cx));
    if (p.file) return void (this.other = new FileView(p, cx));
    this.key = p.key ?? null;
    this.machine = p.machine || null;
    this.cwd = p.cwd ?? focused()?.cwd ?? null;
    this.items = [];
    this.byId = new Map();
    this.state = { busy: false, status: null, mode: "default", model: "", context: { used: 0, max: 0 }, queue: [], session: null };
    this.conn = "connecting";
    this.error = null;
    this.codes = new CodeCache();
    this.expanded = new Set();
    this.expandAll = Boolean(p.expand);
    this.mono = settings().font_family;
    this.modelMenu = Boolean(p.models);
    this.mcpMenu = p.mcp ? { servers: null, busy: new Set() } : null;
    this.remoteMenu = Boolean(p.remote);
    this.remotePending = false;
    this.picks = new Map();
    this.otherInputs = new Map();
    this.images = new Map();
    this.originals = new Set();
    this.attachments = [];
    this.following = true;
    this.stick = true;
    this.pane = null;
    this.scroll = ScrollHandle.new();
    this.input = TextareaState.new({ placeholder: "Ask Claude…" });
    this.input.set_auto_grow(1, 12);
    if (p.draft) this.setDraft(p.draft);
    this.input.on("submit", (e, cx) => this.enter(e, cx));
    this.input.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.input.on("change", (_e, cx) => { this.commandAt = 0; cx.notify(); });
    this.commandAt = 0;
    this.input.on("focus", (_e, cx) => { this.focusedInput = true; this.findPane(); cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.focusedInput = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.input.focus();
    cx.timer.after(150, () => this.input.focus());
    cx.timer.after(400, () => this.findPane());
    if (checking()) return;
    cx.spawn(async (cx) => this.connect(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.input.focus();
        else if (c === "compact" && this.active()) this.send({ type: "prompt", text: "/compact", images: [] });
        else if (c === "mcp" && this.active()) this.openMcp(null);
        else if (c === "signin" && shared("herdr-chat:signin")?.key === this.key) this.signIn(shared("herdr-chat:signin").server);
        cx.notify();
      }
    });
  }

  active() {
    return shared("herdr-chat:target") === this.key;
  }

  outputs() {
    const files = new Map();
    for (const i of this.items) {
      if (i.kind !== "tool" || i.status !== "ok" || !i.path || !["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(i.name)) continue;
      const f = files.get(i.path) ?? { path: i.path, name: i.meta, created: i.name === "Write", add: 0, del: 0 };
      for (const l of (i.detail ?? "").split("\n")) {
        if (l.startsWith("+")) f.add++;
        else if (l.startsWith("-")) f.del++;
      }
      files.delete(i.path);
      files.set(i.path, f);
    }
    return [...files.values()].reverse();
  }

  // Feeds the side panel, which shows the chat in the focused pane or tab.
  publish() {
    if (!this.key || !this.pane) return;
    const s = this.state;
    const data = {
      key: this.key, pane: this.pane, machine: this.machine, folder: tilde(this.cwd, this.home), branch: this.branch ?? null,
      model: s.model, mode: s.mode, usage: s.usage ?? null, context: s.context, outputs: this.outputs(), mcp: s.mcp ?? [], remote: s.remote ?? null, title: s.title ?? null,
    };
    const json = JSON.stringify(data);
    if (json === this.published) return;
    this.published = json;
    setShared(`herdr-chat:info:${this.pane}`, data);
  }

  // Read hands Claude a downscaled copy; the viewer shows the file itself while it's still there.
  async viewTools(thumbs, index) {
    const full = await Promise.all(thumbs.map((x) => this.original(x).catch(() => null)));
    this.viewImages(thumbs.map((x, i) => full[i] ?? x.path), index);
  }

  async original({ id, i }) {
    const tool = this.byId.get(id);
    const ext = tool?.path?.split(".").pop()?.toLowerCase();
    if (i || tool?.name !== "Read" || !MIME[ext]) return null;
    const rel = `${DATA}/img/${safe(id)}-full.${ext}`;
    if (this.originals.has(rel)) return rel;
    const r = await exec("sh", ["-c", 'base64 < "$1"', "sh", tool.path], { on: this.machine });
    if (r.code !== 0) return null;
    await fs.writeFile(`${appHome()}/${rel}`, Buffer.from(r.stdout.replace(/\s/g, ""), "base64"));
    this.originals.add(rel);
    return rel;
  }

  viewImages(paths, index) {
    openOverlay({ mod: "herdr-chat", props: { viewer: { paths, index } }, kind: "dialog", frame: "none", width: 0.92, height: 0.92 });
  }

  // Tools and thinking between two messages collapse into one summary line.
  blocks(shown) {
    const out = [];
    let group = null;
    for (const item of shown) {
      if (item.kind === "permission" && item.state === "allowed" && !item.plan) continue;
      if (item.kind === "tool" || item.kind === "thinking") {
        if (!group) {
          group = { kind: "group", id: `g:${item.id}`, items: [] };
          if (this.expandAll) this.expanded.add(group.id);
          out.push(group);
        }
        group.items.push(item);
      } else {
        group = null;
        out.push(item);
      }
    }
    return out.map((b) => (b.kind === "group" && !b.items.some((i) => i.kind === "tool") ? (b.items.length === 1 ? b.items[0] : b) : b));
  }

  async close() {
    if (this.pane && !this.other) { setShared(`herdr-chat:info:${this.pane}`, null); setShared(`herdr-chat:pane:${this.pane}`, null); }
    await this.ws?.close().catch(() => {});
  }

  // A pane mod isn't told its own pane id; it's the focused herdr-chat pane right after opening or a click.
  findPane() {
    const f = focused()?.pane;
    if (f && panes().find((x) => x.pane === f)?.mod === "herdr-chat") this.pane = f;
    if (this.visible()) this.unseen = false;
    this.publishPane();
    this.publish();
  }

  // Herdr's pane header can't see into a mod pane, so the header clone reads this.
  publishPane() {
    if (!this.pane || this.other) return;
    const status = this.pending() ? "blocked" : this.state.busy ? "working" : this.unseen ? "done" : null;
    const first = this.items.find((i) => i.kind === "user" && !i.text?.startsWith("This session is being continued"))?.text?.split("\n")[0] ?? null;
    const json = JSON.stringify({ folder: tilde(this.cwd, this.home), status, title: this.state.title ?? (first && first.slice(0, 80)), named: Boolean(this.state.title) });
    if (json === this.paneShared) return;
    this.paneShared = json;
    setShared(`herdr-chat:pane:${this.pane}`, JSON.parse(json));
  }

  // Names an unnamed tab that holds only this chat after its first message, like the desktop app's titles.
  nameTab(text) {
    if (this.named || !this.pane || !text) return;
    this.named = true;
    const me = panes().find((x) => x.pane === this.pane);
    const tab = spaces().flatMap((sp) => sp.tabs).find((tb) => tb.id === me?.tab);
    if (!tab || tab.named || tab.panes !== 1) return;
    const name = text.split("\n")[0].trim();
    run("tab.rename", { id: tab.id, name: name.length > 40 ? `${name.slice(0, 39)}…` : name });
  }

  async endpoint() {
    let url = props()?.engine ?? `ws://127.0.0.1:${PORT}`;
    if (this.machine && !props()?.engine) {
      const map = JSON.parse((await readTextFile(`${appHome()}/${DATA}/machines.json`).catch(() => null)) ?? "{}");
      if (map[this.machine]) url = map[this.machine];
      else {
        const r = await exec("ssh", ["-G", this.machine]);
        const host = r.stdout.match(/^hostname (\S+)/m)?.[1] ?? this.machine;
        url = `ws://${host}:${PORT}`;
      }
    }
    const r = await exec("sh", ["-c", "cat ~/.config/herdr-chat/token"], { on: this.machine });
    if (r.code !== 0) throw new Error(`no engine token on ${this.machine ?? "this computer"} (run scripts/install.sh there)`);
    return { url, token: r.stdout.trim() };
  }

  async connect(cx) {
    await fs.mkdir(`${appHome()}/${DATA}/img`, { recursive: true }).catch(() => {});
    this.home = this.machine ? null : home();
    exec("sh", ["-c", `printf '%s\\n' "$HOME"; git -C '${(this.cwd ?? "").replace(/'/g, "'\\''")}' branch --show-current 2>/dev/null`], { on: this.machine })
      .then((r) => { const [h, b] = r.stdout.split("\n"); this.home = h || this.home; this.branch = b || null; this.publish(); cx.notify(); })
      .catch(() => {});
    let delay = 1000;
    for (;;) {
      try {
        const { url, token } = await this.endpoint();
        this.ws = await WebSocket.connect(url);
        await this.ws.write(JSON.stringify({ type: "hello", v: PROTOCOL, token }));
        await this.ws.write(JSON.stringify({ type: "open", key: this.key, cwd: this.cwd }));
        this.conn = "connected";
        this.error = null;
        delay = 1000;
        cx.notify();
        for (;;) {
          const raw = await this.ws.read();
          if (typeof raw !== "string") continue;
          await this.receive(JSON.parse(raw), cx);
          cx.notify();
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.ws = null;
      this.conn = "offline";
      cx.notify();
      await new Promise((r) => cx.timer.after(delay, () => r(null)));
      delay = Math.min(delay * 2, 15000);
    }
  }

  send(o) {
    this.ws?.write(JSON.stringify(o)).catch(() => {});
  }

  async receive(m, cx) {
    if (m.type === "hello" && m.v !== PROTOCOL) this.error = `engine speaks protocol ${m.v}, this pane ${PROTOCOL}`;
    else if (m.type === "error") { this.error = m.message; this.remotePending = false; }
    else if (m.type === "auth") await this.openAuth(m.server, m.url);
    else if (m.type === "mcp" && this.mcpMenu) {
      this.mcpMenu = { servers: m.servers, busy: new Set() };
      if (m.servers.some((x) => x.status === "pending")) cx.timer.after(2000, () => { if (this.mcpMenu) this.send({ type: "mcp_list" }); });
    }
    else if (m.type === "state") this.setState(m.state);
    else if (m.type === "snapshot") {
      this.items = [];
      this.byId.clear();
      for (const item of m.items) await this.upsert(item, false);
      this.setState(m.state);
      this.stick = true;
      this.recent = null;
      if (!this.items.length) this.send({ type: "sessions" });
    } else if (m.type === "sessions") this.recent = m.sessions;
    else if (m.type === "upsert") await this.upsert(m.item, true);
  }

  setState(next) {
    const was = this.state.busy;
    if (next.remote !== this.state.remote) this.remotePending = false;
    if (this.mcpMenu && (!this.mcpMenu.servers || JSON.stringify(next.mcp) !== JSON.stringify(this.state.mcp))) this.send({ type: "mcp_list" });
    this.state = next;
    if (was && !next.busy && !this.visible()) this.unseen = true;
    this.publish();
    this.publishPane();
    if (was && !next.busy && !this.visible()) {
      notify({ title: "Claude finished", body: tilde(this.cwd, this.home), level: "success", action: this.focusAction() });
    }
  }

  async upsert(item, live) {
    const prev = this.byId.get(item.id);
    if (prev) this.items[this.items.indexOf(prev)] = item;
    else this.items.push(item);
    this.byId.set(item.id, item);
    const t = theme();
    if (item.kind === "text") this.codes.prepareText(item.id, item.text, t);
    if (item.kind === "permission") {
      if (item.detail) this.codes.prepare(`detail:${item.id}`, this.detailLang(item.tool), item.detail, t);
      if (item.plan) this.codes.prepareText(item.id, item.plan, t);
    }
    if (item.kind === "question" && item.state === "pending" && !this.otherInputs.has(item.id)) this.prepareQuestion(item);
    if (item.kind === "tool" && this.expanded.has(item.id) && item.detail) this.codes.prepare(`detail:${item.id}`, this.detailLang(item.name), item.detail, t);
    if (item.images?.length) await this.saveImages(item);
    if (live && !prev && (item.kind === "permission" || item.kind === "question") && item.state === "pending") this.alert(item);
    if (item.kind === "permission" || item.kind === "question") this.publishPane();
    if (item.kind === "user" && !prev && this.items.filter((i) => i.kind === "user").length === 1) this.nameTab(item.text);
    if (this.following) this.stick = true;
    if (live && item.kind === "tool" && item.status === "ok" && item.path) this.publish();
  }

  detailLang(tool) {
    return tool === "Bash" ? "bash" : ["Edit", "MultiEdit", "Write"].includes(tool) ? "diff" : "";
  }

  prepareQuestion(item) {
    const inputs = item.questions.map((q) => {
      const s = InputState.new({ placeholder: "Something else…" });
      s.on("submit", (_e, cx) => {
        if (item.questions.length === 1 && !q.multiSelect && s.value().trim()) this.answer({ item: item.id, answers: { [q.question]: s.value().trim() } }, cx);
        else this.submitQuestion(item, cx);
      });
      return s;
    });
    this.otherInputs.set(item.id, inputs);
  }

  async saveImages(item) {
    for (const [i, img] of item.images.entries()) {
      const key = `${item.id}:${i}`;
      if (this.images.has(key)) continue;
      const rel = `${DATA}/img/${safe(item.id)}-${i}.${IMAGE_EXT[img.type] ?? "png"}`;
      try {
        await fs.writeFile(`${appHome()}/${rel}`, Buffer.from(img.data, "base64"));
        this.images.set(key, rel);
      } catch {}
    }
  }

  imagePath(id, i) {
    return this.images.get(`${id}:${i}`) ?? null;
  }

  visible() {
    return Boolean(this.pane) && focused()?.pane === this.pane;
  }

  focusAction() {
    return this.pane ? { name: "pane.focus", args: { pane: this.pane } } : undefined;
  }

  alert(item) {
    if (this.visible()) return;
    const body = item.kind === "question" ? item.questions[0]?.question ?? "" : `${item.tool}${item.meta ? ` · ${item.meta}` : ""}`;
    notify({ title: item.kind === "question" ? "Claude has a question" : "Claude needs permission", body, level: "warning", action: this.focusAction() });
  }

  pending() {
    return this.items.find((i) => (i.kind === "permission" || i.kind === "question") && i.state === "pending") ?? null;
  }

  hasDraft() {
    return Boolean(this.input.value().trim() || this.attachments.length);
  }

  // Enter arrives as a submit after the textarea has inserted its newline; Shift-Enter keeps it.
  enter(e, cx) {
    if (e?.shift) return;
    const v = this.input.value();
    const at = this.input.selected_range().start;
    if (v[at - 1] === "\n") this.input.set_value(v.slice(0, at - 1) + v.slice(at));
    const pick = this.commandMatches()[this.commandAt];
    if (pick && !this.input.value().trim().includes(" ") && this.input.value().trim() !== `/${pick.name}`) return this.complete(pick, cx);
    this.submit(cx);
  }

  commandMatches() {
    const v = this.input.value();
    if (!v.startsWith("/") || /\s/.test(v.trimEnd()) || v.includes("\n")) return [];
    const q = v.slice(1).trim().toLowerCase();
    const list = [...(this.state.commands ?? []).filter((c) => c.name !== "mcp"), { name: "mcp", description: "Manage MCP servers", hint: "" }];
    const starts = list.filter((c) => c.name.toLowerCase().startsWith(q));
    const contains = list.filter((c) => !c.name.toLowerCase().startsWith(q) && (c.name + " " + c.description).toLowerCase().includes(q));
    return [...starts, ...contains].slice(0, 8);
  }

  setDraft(text) {
    this.input.set_value(text);
    this.input.set_selected_range({ start: text.length, end: text.length });
  }

  complete(cmd, cx) {
    this.setDraft(`/${cmd.name} `);
    this.commandAt = 0;
    cx.notify();
  }

  submit(cx) {
    const text = this.input.value().trim();
    if (text === "/mcp") {
      this.input.set_value("");
      return this.openMcp(cx);
    }
    if (!this.ws || (!text && !this.attachments.length)) return;
    const waiting = this.pending();
    if (waiting && text && !this.attachments.length) {
      if (waiting.kind === "permission") this.answer({ item: waiting.id, decision: "deny", message: text }, cx);
      else this.answer({ item: waiting.id, answers: null, message: `The user replied instead of picking: ${text}` }, cx);
    }
    const id = uuid();
    const images = this.attachments.map(({ type, data }) => ({ type, data }));
    // Shown right away; the engine's copy of the same id replaces it.
    if (!this.state.busy && !waiting) {
      this.upsert({ id, kind: "user", text, images }, true);
      this.state = { ...this.state, busy: true };
    }
    this.send({ type: "prompt", id, text, images });
    this.input.set_value("");
    this.attachments = [];
    this.following = true;
    this.stick = true;
    cx.notify();
  }

  answer(a, cx) {
    this.send({ type: "answer", ...a });
    cx.notify();
  }

  pick(item, q, label, single, cx) {
    if (single) return this.answer({ item: item.id, answers: { [q.question]: label } }, cx);
    const picks = this.picks.get(item.id) ?? {};
    const set = picks[q.question] ?? new Set();
    if (q.multiSelect) set.has(label) ? set.delete(label) : set.add(label);
    else { set.clear(); set.add(label); }
    picks[q.question] = set;
    this.picks.set(item.id, picks);
    cx.notify();
  }

  submitQuestion(item, cx) {
    const picks = this.picks.get(item.id) ?? {};
    const inputs = this.otherInputs.get(item.id) ?? [];
    const answers = {};
    item.questions.forEach((q, i) => {
      const parts = [...(picks[q.question] ?? [])];
      const other = inputs[i]?.value().trim();
      if (other) parts.push(other);
      if (parts.length) answers[q.question] = parts.join(", ");
    });
    if (Object.keys(answers).length < item.questions.length) return;
    this.answer({ item: item.id, answers }, cx);
  }

  // Servers needing sign-in that the reply talks about, so the button sits where Claude said it couldn't get in.
  authFor(endId) {
    const reply = this.replyFor(endId).toLowerCase();
    return (this.state.mcp ?? []).filter((m) => reply.includes(m.label.toLowerCase()));
  }

  signIn(server) {
    this.auth = { server, url: null, input: null };
    this.send({ type: "mcp_auth", server });
  }

  async openAuth(server, url) {
    if (!url) return (this.auth = null);
    await exec("open", [url]);
    const port = new URL(new URL(url).searchParams.get("redirect_uri") ?? "http://x").port;
    if (this.machine && port) {
      await exec("sh", ["-c", `(ssh -o ExitOnForwardFailure=yes -N -L ${port}:127.0.0.1:${port} ${this.machine} & p=$!; sleep 300; kill $p) >/dev/null 2>&1 &`]);
    }
    const input = this.machine ? InputState.new({ placeholder: "Browser showed an error? Paste its address here" }) : null;
    input?.on("enter", (_e, cx) => {
      const v = input.value().trim();
      if (v) this.send({ type: "mcp_callback", server, url: v });
      input.set_value("");
      cx.notify();
    });
    this.auth = { server, url, input };
  }

  replyFor(endId) {
    const end = this.items.findIndex((i) => i.id === endId);
    const texts = [];
    for (let i = end - 1; i >= 0 && this.items[i].kind !== "user" && this.items[i].kind !== "turn_end"; i--) {
      if (this.items[i].kind === "text") texts.unshift(this.items[i].text);
    }
    return texts.join("\n\n");
  }

  copyReply(endId, cx) {
    cx.write_to_clipboard(this.replyFor(endId));
    this.copied = endId;
    cx.notify();
    cx.timer.after(1500, (cx) => { if (this.copied === endId) this.copied = null; cx.notify(); });
  }

  interrupt(cx) {
    this.send({ type: "interrupt" });
    cx.notify();
  }

  unqueue(id, cx) {
    this.send({ type: "unqueue", id });
    cx.notify();
  }

  toggleRemoteMenu(cx) {
    this.remoteMenu = !this.remoteMenu;
    this.mcpMenu = null;
    this.modelMenu = false;
    cx.notify();
  }

  setRemote(on, cx) {
    this.remotePending = true;
    this.send({ type: "remote", enabled: on });
    cx.notify();
  }

  copyText(id, text, cx) {
    cx.write_to_clipboard(text);
    this.copied = id;
    cx.notify();
    cx.timer.after(1500, (cx) => { if (this.copied === id) this.copied = null; cx.notify(); });
  }

  openMcp(cx) {
    this.mcpMenu = { servers: this.mcpMenu?.servers ?? null, busy: new Set() };
    this.modelMenu = false;
    this.send({ type: "mcp_list" });
    cx?.notify();
  }

  mcpAction(server, action, cx) {
    if (!this.mcpMenu) return;
    this.mcpMenu.busy.add(server);
    if (action === "signin") this.signIn(server);
    else this.send({ type: "mcp_action", server, action });
    cx.notify();
  }

  toggleModels(cx) {
    this.modelMenu = !this.modelMenu;
    cx.notify();
  }

  pickModel(value, cx) {
    this.send({ type: "set", model: value });
    this.modelMenu = false;
    cx.notify();
  }

  cycleMode(cx) {
    const next = CYCLE[(CYCLE.indexOf(this.state.mode) + 1) % CYCLE.length];
    this.send({ type: "set", mode: next });
    this.state = { ...this.state, mode: next };
    cx.notify();
  }

  toggle(id, cx) {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else {
      this.expanded.add(id);
      const item = this.byId.get(id);
      if (item?.kind === "tool" && item.detail) this.codes.prepare(`detail:${id}`, this.detailLang(item.name), item.detail, theme());
    }
    cx.notify();
  }

  async pasteImage(cx) {
    const rel = `${DATA}/img/paste-${Date.now()}.png`;
    const abs = `${appHome()}/${rel}`;
    const r = await exec("osascript", [
      "-e", "set png_data to (the clipboard as «class PNGf»)",
      "-e", `set fp to open for access POSIX file "${abs}" with write permission`,
      "-e", "write png_data to fp",
      "-e", "close access fp",
    ]);
    if (r.code !== 0) return;
    const data = Buffer.from(await fs.readFile(abs)).toString("base64");
    this.attachments.push({ type: "image/png", data, path: rel });
    cx.notify();
  }

  async drop(paths, cx) {
    for (const path of paths) {
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      if (!MIME[ext]) {
        this.input.replace(`${path} `);
        continue;
      }
      try {
        const bytes = await fs.readFile(path);
        const rel = `${DATA}/img/drop-${Date.now()}.${ext}`;
        await fs.writeFile(`${appHome()}/${rel}`, bytes);
        this.attachments.push({ type: MIME[ext], data: Buffer.from(bytes).toString("base64"), path: rel });
      } catch {}
    }
    cx.notify();
  }

  removeAttachment(i, cx) {
    this.attachments.splice(i, 1);
    cx.notify();
  }

  key(e, cx) {
    const cmds = this.commandMatches();
    if (cmds.length && (e.keystroke === "up" || e.keystroke === "down")) {
      this.commandAt = (this.commandAt + (e.keystroke === "down" ? 1 : cmds.length - 1)) % cmds.length;
      cx.notify();
    } else if (cmds.length && e.keystroke === "tab") this.complete(cmds[this.commandAt] ?? cmds[0], cx);
    else if (cmds.length && e.keystroke === "escape") { this.input.set_value(""); cx.notify(); }
    else if (this.modelMenu && e.keystroke === "escape") { this.modelMenu = false; cx.notify(); }
    else if (this.mcpMenu && e.keystroke === "escape") { this.mcpMenu = null; cx.notify(); }
    else if (this.remoteMenu && e.keystroke === "escape") { this.remoteMenu = false; cx.notify(); }
    else if (e.keystroke === "escape" && this.state.busy) this.interrupt(cx);
    else if (e.keystroke === "shift-tab") this.cycleMode(cx);
    else return;
    cx.stop_propagation();
  }

  // GPUI doesn't report the scroll offset, so the distance from the bottom is tracked from wheel moves.
  wheel(e, cx) {
    const max = Math.max(0, (this.contentH ?? 0) + 18 - (this.viewH ?? 0));
    if (this.following) {
      if (e.delta.y <= 0 || !max) return;
      this.following = false;
      this.fromBottom = 0;
    }
    this.fromBottom = Math.min(max, Math.max(0, this.fromBottom + e.delta.y));
    if (this.fromBottom < 4) this.following = true;
    cx.notify();
  }

  grew(h) {
    if (!this.following && this.contentH) this.fromBottom += h - this.contentH;
    this.contentH = h;
  }

  jump(cx) {
    this.following = true;
    this.stick = true;
    cx.notify();
  }

  renderItem(item, t, children) {
    switch (item.kind) {
      case "user": return userRow(item, t, this);
      case "text": return textRow(item, t, this);
      case "thinking": return thinkingRow(item, t, this);
      case "tool": return toolRow(item, t, this, children.get(item.id) ?? []);
      case "permission": return permissionCard(item, t, this);
      case "question": return questionCard(item, t, this);
      case "notice": return noticeRow(item, t);
      case "turn_end": return endRow(item, t, this);
      case "group": return groupRow(item, t, this, children);
    }
    return div();
  }

  banner(t) {
    const offline = this.conn === "offline";
    return h_flex().px(16).py(6).gap(8).flex_none().items_center().text_size(12).border_b_1().border_color(t.border)
      .bg(offline ? t.surface : t.background).text_color(offline ? t.blocked : t.dim)
      .child(div().truncate().child(offline ? `Can't reach the engine on ${this.machine ?? "this computer"}${this.error ? `: ${this.error}` : ""} · retrying` : "Connecting…"));
  }

  empty(t) {
    const recent = (this.recent ?? []).slice(0, 6);
    return v_flex().flex_1().items_center().justify_center().gap(8).px(24)
      .child(div().text_size(20).text_color(t.foreground).child("What should we work on?"))
      .child(div().text_size(12.5).text_color(t.dim).child(tilde(this.cwd, this.home) || ""))
      .when(recent.length > 0, (el) => el.child(v_flex().mt(28).w_full().max_w(560).gap(2)
        .child(div().px(10).pb(4).text_size(11.5).text_color(t.dim).child("Pick up where you left off"))
        .children(recent.map((r) => h_flex().id(`resume-${r.id}`).gap(10).px(10).py(7).rounded(8).items_center().cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.resume(r.id, cx))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(r.title))
          .when(Boolean(r.branch) && r.branch !== "HEAD", (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(r.branch)))
          .child(div().flex_none().w(64).text_right().text_size(11.5).text_color(t.dim).child(ago(r.when)))))));
  }

  resume(id, cx) {
    this.send({ type: "resume", id });
    this.recent = null;
    cx.notify();
  }

  async attach(cx) {
    const r = await exec("osascript", ["-e", 'set fs to choose file with prompt "Attach to Claude" with multiple selections allowed', "-e",
      'set out to ""', "-e", "repeat with f in fs", "-e", 'set out to out & POSIX path of f & linefeed', "-e", "end repeat", "-e", "out"]);
    if (r.code !== 0) return;
    await this.drop(r.stdout.split("\n").filter(Boolean), cx);
    this.input.focus();
  }

  render() {
    if (this.other) return this.other.render();
    const t = theme();
    const children = new Map();
    for (const i of this.items) if (i.kind === "tool" && i.parent) children.set(i.parent, [...(children.get(i.parent) ?? []), i]);
    if (this.expandAll) for (const i of this.items) this.expanded.add(i.id);
    const shown = this.blocks(this.items.filter((i) => !(i.kind === "tool" && i.parent && this.byId.has(i.parent))));
    if (this.stick && shown.length) {
      this.scroll.scroll_to_item(1);
      this.stick = false;
    }
    const transcript = v_flex().id("transcript").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).pt(10)
      .on_scroll_wheel((e, cx) => this.wheel(e, cx))
      .on_size_change((size) => { this.viewH = size.height; })
      .child(v_flex().id("transcript-content").w_full().items_center()
        .on_size_change((size) => this.grew(size.height))
        .children(shown.map((i) => this.renderItem(i, t, children).max_w(880))))
      .child(div().h(8));
    return v_flex().id("root").track_focus(this.handle).size_full().bg(t.background).text_color(t.foreground)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_drop((e, cx) => cx.spawn(async (cx) => this.drop(e.paths, cx)))
      .on_click((_e, cx) => { this.findPane(); cx.notify(); })
      .when(this.conn !== "connected", (el) => el.child(this.banner(t)))
      .child(shown.length ? div().relative().flex_1().min_h(0).flex().flex_col()
        .child(transcript)
        .when(!this.following, (el) => el.child(div().absolute().bottom(10).w_full().flex().justify_center()
          .child(div().id("jump").px(12).py(5).rounded(14).bg(t.raised).border_1().border_color(t.border)
            .text_size(12).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.jump(cx)).child("↓ Latest"))))
        : this.empty(t))
      .child(h_flex().w_full().justify_center().flex_none().child(composer(this, t)));
  }
}
