import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, InputState, Input, ScrollHandle } from "gpui-base";
import { appHome, checking, exec, focused, home, nextCommand, notify, openOverlay, panes, props, readTextFile, run, settings, setShared, shared, spaces, theme } from "herdr";
import { WebSocket } from "websocket";
import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { CodeCache } from "./markdown.js";
import { userRow, textRow, thinkingRow, toolRow, noticeRow, endRow, groupRow } from "./rows.js";
import { Viewer } from "./viewer.js";
import { Panel } from "./panel.js";
import { FileView } from "./fileview.js";
import { permissionCard, questionCard, questionMethods } from "./cards.js";
import { composer, RUN_TAG, isRunOutput } from "./composer.js";
import { handoffCard, handoffStrip, isHandoffPost } from "./handoff.js";
import { moveChat } from "./move.js";
import { McpDialog } from "./mcp.js";
import { AGENTS, agentIcon, availableModes, modelLabel } from "./composer.js";
import { PROTOCOL, endpoint, openAuth } from "./engine.js";
import { FileLinks, openFile } from "./filelinks.js";
import { SidePanel } from "./side.js";
import { bodyOf, splitQuotes, withQuotes } from "./quote.js";
import { Find } from "./find.js";
import { Since, sinceCard } from "./since.js";
import { Inbox } from "./inbox.js";
import { Vim } from "./vim.js";

const DATA = "data/herdr-chat";
const VIEW_MS = 800;
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const imageRel = (id, i, type) => `${DATA}/img/${safe(id)}-${i}.${IMAGE_EXT[type] ?? "png"}`;
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const PASTE = `ObjC.import("AppKit");
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  let d = pb.dataForType($.NSPasteboardTypePNG);
  const tiff = d.isNil() ? pb.dataForType($.NSPasteboardTypeTIFF) : null;
  if (tiff && !tiff.isNil()) d = $.NSBitmapImageRep.imageRepWithData(tiff).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  return !d.isNil() && d.writeToFileAtomically(argv[0], true);
}`;
const CYCLE = ["default", "acceptEdits", "plan", "auto"];

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
  const r = Math.floor(Math.random() * 16);
  return (c === "x" ? r : 8 + (r % 4)).toString(16);
});
// Space kept above per message not yet loaded, until real row heights are known.
const ROW_GUESS = 60;
const windowActive = () => { try { return window.is_window_active(); } catch { return true; } };
const olderCount = (older) => (typeof older === "number" ? older : older ? 100 : 0);
const safe = (s) => s.replace(/[^A-Za-z0-9_-]/g, "_");
const tilde = (path, h) => (h && path?.startsWith(h) ? `~${path.slice(h.length)}` : path ?? "");

export default class HerdrChat extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.viewer) return void (this.other = new Viewer(p, cx));
    if (p.panel) return void (this.other = new Panel(cx));
    if (p.inbox) return void (this.other = new Inbox(cx));
    if (p.file) return void (this.other = new FileView(p, cx));
    if (p.mcp) return void (this.other = new McpDialog(p.mcp, cx));
    this.key = p.key ?? null;
    this.backend = p.backend ?? null;
    // The input's own up/down bindings sit deeper than this view, so the list's keys are bound inside it too.
    cx.bind_keys([["tab", "herdr-chat-complete"], ["enter", "herdr-chat-complete"], ["up", "herdr-chat-up"], ["down", "herdr-chat-down"], ["ctrl-k", "herdr-chat-up"], ["ctrl-j", "herdr-chat-down"]]
      .flatMap(([keystroke, action]) => ["HerdrChatCommands", "HerdrChatCommands > Input"].map((context) => ({ keystroke, action, context }))));
    this.machine = p.machine || null;
    this.cwd = p.cwd ?? focused()?.cwd ?? null;
    this.items = [];
    this.byId = new Map();
    this.state = { busy: false, status: null, mode: "default", model: "", context: { used: 0, max: 0 }, queue: [], session: null };
    this.conn = "connecting";
    this.error = null;
    this.codes = new CodeCache();
    this.links = new FileLinks();
    this.expanded = new Set();
    this.expandAll = Boolean(p.expand);
    this.mono = settings().font_family;
    this.modelMenu = Boolean(p.models);
    this.modelSub = typeof p.models === "string" ? p.models : null;
    this.remotePending = false;
    this.picks = new Map();
    this.qPage = new Map();
    this.otherInputs = new Map();
    this.images = new Map();
    this.asked = new Set();
    this.heights = new Map();
    this.originals = new Set();
    this.runs = new Map();
    this.attachments = [];
    this.quotes = [];
    this.selection = null;
    this.origin = { x: 0, y: 0 };
    this.ensure();
    this.following = true;
    this.stick = true;
    this.pane = null;
    this.scroll = ScrollHandle.new();
    this.makeInput(`Ask ${p.backend === "agy" ? "Antigravity" : "Claude"}…`);
    if (p.draft) this.setDraft(p.draft);
    this.pickId = null;
    this.resumeId = p.resume ?? null;
    this.since = new Since();
    this.vim = new Vim({ read: () => this.cx?.read_from_clipboard(), write: (s) => this.cx?.write_to_clipboard(s) });
    this.fakeAway = typeof p.since === "number" ? p.since : null;
    this.commandAt = 0;
    this.handle = cx.focus_handle();
    this.input.focus();
    cx.timer.after(150, () => this.input.focus());
    // Closing the pane it replaced takes the keyboard after the focus above.
    if (p.reloaded) cx.timer.after(600, () => {
      this.findPane();
      if (this.pane) run("pane.focus", { pane: this.pane });
      this.input.focus();
    });
    cx.timer.after(400, () => this.findPane());
    if (checking()) return;
    // Herdr only sends "focus" for pane.go, not for clicks, tab switches or pane.focus.
    cx.timer.every(200, (cx) => {
      // A new chat's input takes focus before its pane exists, so the pane is looked up once it does.
      if (!this.pane) this.findPane();
      if (this.links.pending.size) cx.spawn(async (cx) => { if (await this.links.check(this.cwd, this.machine)) cx.notify(); });
      const shown = this.visible();
      this.shownSince = shown ? this.shownSince ?? Date.now() : null;
      if (shown && !this.shown) this.claimUntil = Date.now() + 1000;
      if (shown && (this.handle.is_focused() || (Date.now() < this.claimUntil && !this.side.focused && !this.quoteFocused))) this.input.focus();
      this.shown = shown;
      if (this.fakeAway && this.items.length > 2 && !this.state.busy) {
        const at = this.items.findLastIndex((i) => i.kind === "user");
        this.since.left = { at: Date.now() - this.fakeAway, ids: new Set(this.items.slice(0, Math.max(1, at + 1)).map((i) => i.id)) };
        this.since.here = false;
        this.fakeAway = null;
      }
      const back = this.since.tick(shown && windowActive(), this.items);
      if (back) {
        back.asked = uuid();
        this.send({ type: "summarize", id: back.asked, from: back.from });
        cx.notify();
      }
      // The engine starts a stopped chat's CLI once it has been looked at for a moment, and keeps it while it is.
      const viewing = shown && Date.now() - this.shownSince >= VIEW_MS;
      if (viewing !== this.viewing) { this.viewing = viewing; this.send({ type: "view", on: viewing }); }
      this.pageAndImages(cx);
    });
    cx.spawn(async (cx) => this.connect(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        // Herdr says "focus" (popup closed, pane.go) and hands over the pane before the keyboard, so keep claiming it briefly.
        if (c === "focus" && (!this.pane || this.visible())) { this.input.focus(); this.claimUntil = Date.now() + 1000; }
        else if (c === "edit" && this.pane && focused()?.pane === this.pane) this.editDraft(cx).catch((e) => { this.editor = null; notify({ title: "Couldn't open the editor", body: String(e?.message ?? e), level: "error" }); });
        else if (c === "remote" && this.active()) this.setRemote(!this.state.remote, cx);
        else if (c === "compact" && this.active()) this.send({ type: "prompt", text: "/compact", images: [] });
        else if (c === "mcp" && this.active() && this.claudeOnly()) this.openMcp(null);
        else if (c === "reload" && (this.findPane(), this.pane && focused()?.pane === this.pane)) this.reload();
        else if (c === "find" && (this.findPane(), this.pane && focused()?.pane === this.pane)) this.find.show(cx);
        else if (c === "signin" && shared("herdr-chat:signin")?.key === this.key) this.signIn(shared("herdr-chat:signin").server);
        cx.notify();
      }
    });
  }

  active() {
    return shared("herdr-chat:target") === this.key;
  }

  // A textarea's placeholder is fixed when it's made, so naming the current model means making a new one.
  makeInput(placeholder) {
    const old = this.input;
    this.placeholder = placeholder;
    this.input = TextareaState.new({ placeholder });
    this.input.set_auto_grow(1, 12);
    this.input.on("submit", (e, cx) => this.enter(e, cx));
    this.input.on("paste_other", (_e, cx) => cx.spawn(async (cx) => this.pasteImage(cx)));
    this.input.on("change", (_e, cx) => {
      if (!this.input.value()) this.vim.reset();
      this.commandAt = 0;
      if (this.slashToken()?.start !== this.dismissed) this.dismissed = null;
      this.renameInput();
      cx.notify();
    });
    this.input.on("focus", (_e, cx) => { this.bindVim(cx); this.focusedInput = true; this.findPane(); cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.focusedInput = false; cx.notify(); });
    if (old) {
      if (this.focusedInput) this.input.focus();
      old.release();
    }
  }

  // Only while the box is empty, where the placeholder shows; a draft keeps its box until it's cleared.
  renameInput() {
    const name = modelLabel(this.state) || this.agent();
    const placeholder = `Ask ${name}…`;
    if (placeholder !== this.placeholder && !this.input.value()) this.makeInput(placeholder);
  }

  agent() {
    return AGENTS[this.state.backend ?? "claude"] ?? "Claude";
  }

  // The agent can only change before the first message.
  started() {
    return Boolean(this.state.session) || this.items.length > 0;
  }

  // Antigravity chats run over ACP, which has no MCP management, rewind, fork or side chat.
  claudeOnly() {
    return this.state.backend !== "agy";
  }

  outputs() {
    if (this.state.outputs) return this.state.outputs;
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
      key: this.key, pane: this.pane, machine: this.machine, backend: s.backend ?? "claude", session: this.state.session ?? null, folder: tilde(this.cwd, this.home), branch: this.branch ?? null,
      model: s.model, mode: s.mode, usage: s.usage ?? null, context: s.context, outputs: this.outputs(), mcp: s.mcp ?? [], remote: s.remote ?? null, remotePending: this.remotePending, tasks: s.tasks ?? [], prs: s.prs ?? [], repos: s.repos ?? [], memory: s.memory ?? null, title: s.title ?? null,
    };
    const json = JSON.stringify(data);
    if (json === this.published && shared(`herdr-chat:info:${this.pane}`)) return;
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

  // A command from a reply runs out of sight with its output under the block, then goes to Claude; Shift opens a terminal
  // beside the chat instead, left open afterwards. A null code dismisses the output.
  runCommand(id, code, terminal, cx) {
    if (code === null) return void (this.runs.delete(id), cx.notify());
    if (!code.trim() || this.runs.get(id)?.status === "running") return;
    if (terminal) {
      if (this.pane) run("pane.focus", { pane: this.pane });
      return run("terminal.open", { folder: this.cwd ?? undefined, place: "right", argv: ["sh", "-c", 'eval "$1"; exec "${SHELL:-sh}" -l', "sh", code] });
    }
    const r = { status: "running", output: "", code: null };
    this.runs.set(id, r);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await exec("sh", ["-c", 'cd "$1" 2>/dev/null; exec "${SHELL:-sh}" -lc "$2" 2>&1', "sh", this.cwd ?? "", code], { on: this.machine, timeout: 300000 });
        Object.assign(r, { status: "done", output: (res.stdout + res.stderr).slice(-6000), code: res.code });
      } catch (e) {
        Object.assign(r, { status: "done", output: String(e?.message ?? e), code: -1 });
      }
      const fence = "```";
      if (this.ws) this.prompt(`${RUN_TAG}\nI ran:\n${fence}sh\n${code.trim()}\n${fence}\nOutput${r.code ? ` (exit ${r.code})` : ""}:\n${fence}\n${r.output.trimEnd() || "(no output)"}\n${fence}`, []);
      cx.notify();
    });
  }

  viewImages(paths, index) {
    openOverlay({ mod: "herdr-chat", props: { viewer: { paths, index } }, kind: "dialog", frame: "none", width: 0.92, height: 0.92 });
  }

  // Tools and thinking between two messages collapse into one summary line.
  blocks(shown) {
    const out = [];
    let group = null;
    for (const item of shown) {
      if ((item.kind === "permission" || item.kind === "question") && item.state === "withdrawn") continue;
      if (item.kind === "permission" && item.state === "allowed" && !item.plan) continue;
      if (isHandoffPost(item)) {
        group = null;
        out.push({ kind: "handoff", id: `ho:${item.id}`, item });
      } else if (item.kind === "tool" || item.kind === "thinking") {
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
    this.other?.dispose?.();
    if (this.pane && !this.other) { setShared(`herdr-chat:info:${this.pane}`, null); setShared(`herdr-chat:pane:${this.pane}`, null); }
    await this.ws?.close().catch(() => {});
  }

  // A pane mod isn't told its own pane id; it's the focused herdr-chat pane right after opening or a click.
  findPane() {
    const f = focused()?.pane;
    const owner = f && shared(`herdr-chat:info:${f}`)?.key;
    if (f && (!owner || owner === this.key) && panes().find((x) => x.pane === f)?.mod === "herdr-chat") this.pane = f;
    if (this.visible()) this.unseen = false;
    this.publishPane();
    this.publish();
  }

  // Herdr's pane header can't see into a mod pane, so the header clone reads this.
  publishPane() {
    if (!this.pane || this.other) return;
    const status = this.pending() ? "blocked" : this.state.busy ? "working" : this.unseen ? "done" : null;
    const firstText = this.state.first ?? this.items.find((i) => i.kind === "user" && !isRunOutput(i) && !i.text?.startsWith("This session is being continued"))?.text;
    const first = firstText && bodyOf(firstText).split("\n")[0];
    const title = this.handoff?.title ?? this.state.title ?? (first && first.slice(0, 80));
    this.nameTab(this.handoff?.title ?? this.state.title ?? first, first);
    const json = JSON.stringify({ folder: tilde(this.cwd, this.home), cwd: this.cwd, status, title, named: Boolean(this.state.title), backend: this.state.backend ?? "claude" });
    if (json === this.paneShared && shared(`herdr-chat:pane:${this.pane}`)) return;
    this.paneShared = json;
    setShared(`herdr-chat:pane:${this.pane}`, JSON.parse(json));
  }

  // A tab holding only this chat follows the session's title (its first message until Claude or /rename names it),
  // like the sidebar. A name the person gave the tab stays: only unnamed tabs and names this chat set are replaced.
  nameTab(text, first) {
    if (!this.pane || !text) return;
    const short = (s) => { const n = (s ?? "").split("\n")[0].trim(); return n.length > 40 ? `${n.slice(0, 39)}…` : n; };
    const name = short(text);
    if (!name || name === this.tabName) return;
    const me = panes().find((x) => x.pane === this.pane);
    const tab = spaces().flatMap((sp) => sp.tabs).find((tb) => tb.id === me?.tab);
    if (!tab || tab.panes !== 1) return;
    const ours = this.tabName ?? shared(`herdr-chat:tab:${tab.id}`);
    if (tab.named && tab.name !== ours && tab.name !== short(first) && tab.name !== name) return;
    this.tabName = name;
    setShared(`herdr-chat:tab:${tab.id}`, name);
    if (tab.name !== name) run("tab.rename", { id: tab.id, name });
  }

  readFolder(cx) {
    exec("sh", ["-c", `printf '%s\\n' "$HOME"; git -C '${(this.cwd ?? "").replace(/'/g, "'\\''")}' branch --show-current 2>/dev/null`], { on: this.machine })
      .then((r) => { const [h, b] = r.stdout.split("\n"); this.home = h || this.home; this.branch = b || null; this.publish(); this.publishPane(); cx.notify(); })
      .catch(() => {});
  }

  openFolders() {
    this.pickId = `chat-${this.key}-${Date.now().toString(36)}`;
    openOverlay({ mod: "folder-picker", kind: "popup", width: 280, props: { id: this.pickId, machine: this.machine, folder: this.cwd } });
  }

  // The folder picker answers through shared state; only our own request counts.
  takePick() {
    const r = shared("folder-picker.result");
    if (!this.pickId || r?.id !== this.pickId) return;
    this.pickId = null;
    this.input.focus();
    if (r.folder && r.folder !== this.cwd) this.send({ type: "cwd", cwd: r.folder });
  }

  async connect(cx) {
    await fs.mkdir(`${appHome()}/${DATA}/img`, { recursive: true }).catch(() => {});
    this.home = this.machine ? null : home();
    this.readFolder(cx);
    let delay = 1000;
    for (;;) {
      try {
        const { url, token } = await endpoint(this.machine);
        this.ws = await WebSocket.connect(url);
        await this.ws.write(JSON.stringify({ type: "hello", v: PROTOCOL, token }));
        await this.ws.write(JSON.stringify({ type: "open", key: this.key, cwd: this.cwd, ...(this.backend ? { backend: this.backend } : {}) }));
        if (this.viewing) this.send({ type: "view", on: true });
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
    this.ensure();
    if (this.side.receive(m)) return;
    if (m.type === "hello" && m.v !== PROTOCOL) this.error = `engine speaks protocol ${m.v}, this pane ${PROTOCOL}`;
    else if (m.type === "error") { this.error = m.message; this.remotePending = false; this.publish(); }
    else if (m.type === "auth") await this.openAuth(m.server, m.url);
    else if (m.type === "state") this.setState(m.state);
    else if (m.type === "snapshot") {
      if (m.cwd && m.cwd !== this.cwd) { this.cwd = m.cwd; this.branch = null; this.links = new FileLinks(); this.readFolder(cx); }
      this.handoff = m.handoff ?? null;
      this.side.restore(m.side);
      this.items = [];
      this.byId.clear();
      this.staged = null;
      this.restore = null;
      this.loadingOlder = false;
      this.olderAvailable = Boolean(m.older);
      this.left = olderCount(m.older);
      this.spacer = this.left * ROW_GUESS;
      this.asked.clear();
      for (const item of m.items) await this.upsert(item, false);
      this.setState(m.state);
      this.stick = true;
      this.recent = null;
      if (!this.items.length && this.resumeId) { this.send({ type: "resume", id: this.resumeId, ...(this.backend ? { backend: this.backend } : {}) }); this.resumeId = null; }
      else if (!this.items.length) this.send({ type: "sessions" });
    } else if (m.type === "older") {
      this.loadingOlder = false;
      if (m.before !== this.items[0]?.id) return;
      this.olderAvailable = Boolean(m.older);
      this.left = olderCount(m.older);
      const n = this.items.length;
      for (const item of m.items) await this.upsert(item, false);
      const older = this.items.splice(n);
      if (older.length) { this.staged = older; this.loadingOlder = true; }
    } else if (m.type === "image") {
      if (!m.data) return;
      const rel = imageRel(m.item, m.i, m.mime);
      await fs.writeFile(`${appHome()}/${rel}`, Buffer.from(m.data, "base64")).then(() => this.images.set(`${m.item}:${m.i}`, rel), () => {});
    } else if (m.type === "sessions") this.recent = m.sessions;
    else if (m.type === "rewind_check" && this.confirm?.id === m.id) this.confirm.files = m.files;
    else if (m.type === "summary" && this.since.card?.asked === m.id) Object.assign(this.since.card, m.error ? { error: m.error } : { summary: m.text || null });
    else if (m.type === "forked" && this.forking?.id === m.id) {
      const draft = this.forking.text;
      this.forking = null;
      if (this.pane) run("pane.focus", { pane: this.pane });
      run("pane.split", { direction: "right", mod: "herdr-chat", props: { key: m.key, machine: this.machine, cwd: m.cwd, draft, ...(props()?.engine ? { engine: props().engine } : {}) } });
    }
    else if (m.type === "upsert") { this.liveAt = Date.now(); await this.upsert(m.item, true); }
  }

  // A saved mod file reloads panes in place but skips init and keeps the old snapshot; a fresh pane runs both.
  reload() {
    const pane = this.pane ?? panes().find((x) => x.mod === "herdr-chat" && x.focused)?.pane;
    if (!pane) return notify({ title: "Couldn't reload this chat", body: "Its pane wasn't found", level: "error" });
    const draft = this.input.value();
    run("pane.split", { direction: "right", pane, mod: "herdr-chat", props: { ...props(), key: this.key, machine: this.machine, cwd: this.cwd, draft, reloaded: true } });
    run("pane.close", { pane });
  }

  setState(next) {
    const was = this.state.busy;
    if (next.remote !== this.state.remote) this.remotePending = false;
    this.state = next;
    this.renameInput();
    if (was && !next.busy && !this.visible()) this.unseen = true;
    this.publish();
    this.publishPane();
    if (was && !next.busy && !this.visible()) {
      notify({ title: `${this.agent()} finished`, body: tilde(this.cwd, this.home), level: "success", action: this.focusAction() });
    }
  }

  async upsert(item, live) {
    if (item.kind === "user" && this.local) {
      // An engine older than the client ids sends its own id for the same message.
      const mine = item.id !== this.local && this.byId.get(this.local);
      if (mine) { this.items.splice(this.items.indexOf(mine), 1); this.byId.delete(this.local); }
      this.local = null;
    }
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
    if (item.images?.some((img) => img.data)) await this.saveImages(item);
    if (live && !prev && (item.kind === "permission" || item.kind === "question") && item.state === "pending") this.alert(item);
    if (item.kind === "permission" || item.kind === "question") this.publishPane();
    if (this.following) this.stick = true;
    if (live && item.kind === "tool" && item.status === "ok" && item.path) this.publish();
  }

  detailLang(tool) {
    return tool === "Bash" ? "bash" : ["Edit", "MultiEdit", "Write"].includes(tool) ? "diff" : "";
  }

  async saveImages(item) {
    for (const [i, img] of item.images.entries()) {
      const key = `${item.id}:${i}`;
      if (this.images.has(key)) continue;
      if (!img.data) continue;
      const rel = imageRel(item.id, i, img.type);
      try {
        await fs.writeFile(`${appHome()}/${rel}`, Buffer.from(img.data, "base64"));
        this.images.set(key, rel);
      } catch {}
    }
  }

  // The engine sends a page of older items when the top comes near, and image data only when asked.
  pageAndImages(cx) {
    const y = this.scroll.offset().y, viewH = this.scroll.viewport_size().height;
    if (!viewH) return;
    const r = this.restore;
    if (this.following && !r && y + viewH < this.scroll.content_size().height - 2) { this.stick = true; cx.notify(); }
    if (r?.merged) {
      // Once the person scrolls again, correcting the position would fight them.
      if (Math.abs(y - r.target) < 2 || (this.wheeledAt ?? 0) > this.committedAt || ++r.tries > 5) { this.restore = null; this.loadingOlder = false; }
      cx.notify();
    }
    // Without a scroll since the last page, a page that failed to keep the view in place would pull in the next one.
    const asked = this.following || (this.wheeledAt ?? 0) > (this.committedAt ?? 0);
    if (this.following && !r && this.olderAvailable && this.items.length) {
      // Nothing above is in view at the bottom, so the space kept for unloaded history can be resized there.
      const zoom = settings().zoom || 1, shown = this.lastShown ?? [];
      let sum = 0;
      for (const blk of shown) sum += (this.heights.get(blk.id) ?? 0) / zoom;
      const want = Math.round(this.left * Math.max(20, sum / Math.max(1, this.items.length)) * 1.1);
      if (sum && Math.abs(want - this.spacer) > Math.max(viewH, this.spacer * 0.2)) { this.spacer = want; this.stick = true; cx.notify(); }
    }
    if (this.olderAvailable && !this.loadingOlder && asked && this.items.length && y < this.spacer + viewH * 3) {
      this.loadingOlder = true;
      this.send({ type: "older", before: this.items[0].id });
    }
    const zoom = settings().zoom || 1;
    let top = 10 + this.spacer;
    for (const b of this.lastShown ?? []) {
      const h = (this.heights.get(b.id) ?? 0) / zoom;
      if (top > y + 2 * viewH) break;
      if (top + h >= y - viewH) for (const item of this.blockItems(b)) this.fetchImages(item, cx);
      top += h;
    }
  }

  blockItems(b) {
    const own = b.kind === "group" ? b.items : b.kind === "handoff" ? [b.item] : [b];
    return own.flatMap((i) => [i, ...(this.childMap?.get(i.id) ?? [])]);
  }

  fetchImages(item, cx) {
    for (const [i, img] of (item.images ?? []).entries()) {
      const key = `${item.id}:${i}`;
      if (this.images.has(key) || this.asked.has(key)) continue;
      this.asked.add(key);
      const rel = imageRel(item.id, i, img.type);
      cx.spawn(async (cx) => {
        if (await fs.exists(`${appHome()}/${rel}`).catch(() => false)) { this.images.set(key, rel); cx.notify(); }
        else this.send({ type: "image", item: item.id, i });
      });
    }
  }

  // A measured page replaces as much of the space kept above, so nothing below moves; only a shortfall or leftover needs a scroll.
  commitOlder(height, cx) {
    if (!this.staged || this.restore) return;
    const zoom = settings().zoom || 1, h = height / zoom;
    const spacer = this.olderAvailable ? Math.max(0, this.spacer - h) : 0;
    const shift = h + spacer - this.spacer;
    if (Math.abs(shift) < 1 || this.following) {
      this.spacer = spacer;
      if (this.following) this.stick = true;
      return this.mergeOlder(cx);
    }
    const y = this.scroll.offset().y, viewH = this.scroll.viewport_size().height, target = Math.max(0, y + shift);
    this.restore = { at: shift > 0 ? target + viewH : target + 1, target, spacer, merged: false, tries: 0, n: (this.restores = (this.restores ?? 0) + 1) };
    cx.notify();
  }

  mergeOlder(cx) {
    const r = this.restore;
    if (r?.merged || !this.staged) return;
    this.items = [...this.staged, ...this.items];
    this.staged = null;
    this.committedAt = Date.now();
    if (r) { r.merged = true; this.spacer = r.spacer; }
    else { this.loadingOlder = false; this.settle = { until: Date.now() + 1500, h: this.contentH }; }
    cx.notify();
  }

  imagePath(id, i) {
    return this.images.get(`${id}:${i}`) ?? null;
  }

  openLink(href, cx) {
    const target = this.links.target(href, this.cwd);
    if (target) openFile(cx, target.path, this.machine, { line: target.line, beside: this.pane });
    else if (/^https?:\/\//.test(href)) cx.open_url(href);
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
    notify({ title: item.kind === "question" ? `${this.agent()} has a question` : `${this.agent()} needs permission`, body, level: "warning", action: this.focusAction() });
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
    if (v[at - 1] === "\n") {
      this.input.set_value(v.slice(0, at - 1) + v.slice(at));
      this.input.set_selected_range({ start: at - 1, end: at - 1 });
    }
    this.sendInput(cx, e?.secondary);
  }

  sendInput(cx, later) {
    // A picked command only fills in, so it can take arguments; the next Enter sends.
    const pick = this.commandMatches()[this.commandAt];
    if (pick) return this.complete(pick, cx);
    this.submit(cx, later ? "later" : undefined);
  }

  // The "/word" being typed at the cursor, at the start or after a space.
  slashToken() {
    const at = this.input.selected_range().start;
    const m = this.input.value().slice(0, at).match(/(?:^| )\/(\S*)$/);
    return m ? { start: at - m[1].length - 1, end: at, q: m[1] } : null;
  }

  commandMatches() {
    const tok = this.slashToken();
    if (!tok || tok.start === this.dismissed) return [];
    const q = tok.q.toLowerCase();
    const all = [...(this.state.commands ?? []).filter((c) => c.name !== "mcp" && c.name !== "btw" && c.name !== "model"), { name: "model", description: "Switch model, or agent (Claude or Antigravity) before the first message", hint: "[model]" }, { name: "btw", description: "Ask on the side, in a read-only copy of this chat that doesn't interrupt it or end up in it (Cmd-;)", hint: "[question]" }, { name: "mcp", description: "Manage MCP servers", hint: "" }, { name: "restart-engine", description: "Restart a machine's chat engine, copying the code there first if it's remote (stops running turns)", hint: "[machine]" }, { name: "vim", description: `Turn vim keys in this box ${this.vimOn() ? "off" : "on"}`, hint: "" }, { name: "reload", description: "Reopen this chat in the same pane so it picks up new herdr-chat code", hint: "" }, { name: "move", description: "Move this chat to another machine: the conversation continues there and this pane closes", hint: "<machine> [folder] [--force]" }];
    const ours = ["btw", "mcp", "move"];
    const list = this.claudeOnly() ? all : all.filter((c) => !ours.includes(c.name) || (this.state.commands ?? []).some((x) => x.name === c.name));
    const starts = list.filter((c) => c.name.toLowerCase().startsWith(q));
    const contains = list.filter((c) => !c.name.toLowerCase().startsWith(q) && (c.name + " " + c.description).toLowerCase().includes(q));
    return [...starts, ...contains].slice(0, 8);
  }

  setDraft(text) {
    this.input.set_value(text);
    this.input.set_selected_range({ start: text.length, end: text.length });
  }

  complete(cmd, cx) {
    const tok = this.slashToken();
    const v = this.input.value();
    const head = (tok ? v.slice(0, tok.start) : "") + `/${cmd.name} `;
    this.input.set_value(head + (tok ? v.slice(tok.end) : ""));
    this.input.set_selected_range({ start: head.length, end: head.length });
    this.commandAt = 0;
    cx.notify();
  }

  submit(cx, priority) {
    const text = this.input.value().trim();
    if (!this.claudeOnly() && /^\/(mcp|move|btw)\b/.test(text) && !(this.state.commands ?? []).some((c) => text.startsWith(`/${c.name}`))) {
      return notify({ title: `${text.split(/\s/)[0]} isn't available in Antigravity chats`, level: "warning" });
    }
    const model = text.match(/^\/model(?:\s+(.+))?$/);
    if (model) {
      this.input.set_value("");
      const q = model[1]?.trim().toLowerCase();
      if (!q) { this.modelMenu = true; return cx.notify(); }
      const m = (this.state.models ?? []).find((x) => x.value.toLowerCase() === q || x.name.toLowerCase() === q)
        ?? (this.state.models ?? []).find((x) => x.value.toLowerCase().startsWith(q) || x.name.toLowerCase().startsWith(q));
      if (!m) return notify({ title: `No model called ${model[1].trim()}`, level: "warning" });
      if ((m.backend ?? "claude") !== (this.state.backend ?? "claude") && this.started()) return notify({ title: `Start a new chat to use ${AGENTS[m.backend ?? "claude"]}`, level: "warning" });
      return this.pickModel(m.value, cx, m.backend);
    }
    if (text === "/mcp") {
      this.input.set_value("");
      return this.openMcp(cx);
    }
    const move = text.match(/^\/move(?:\s+(.*))?$/);
    if (move) {
      this.input.set_value("");
      cx.spawn(async (cx) => {
        try { await moveChat(this, move[1] ?? ""); } catch (e) { notify({ title: "Couldn't move this chat", body: String(e?.message ?? e), level: "error" }); }
        cx.notify();
      });
      return;
    }
    if (text === "/reload") {
      this.input.set_value("");
      return this.reload();
    }
    const btw = text.match(/^\/btw(?:\s+([\s\S]*))?$/);
    if (btw) {
      this.input.set_value("");
      return btw[1]?.trim() ? this.side.ask(btw[1], cx) : this.side.show(cx);
    }
    if (text === "/vim") {
      this.input.set_value("");
      const on = !this.vimOn();
      setShared("herdr-chat:vim", on);
      this.vim.reset();
      return notify({ title: on ? "Vim mode on" : "Vim mode off", body: on ? "Esc for normal mode, i to type again. /vim turns it off." : "" });
    }
    const restart = text.match(/^\/restart-engine(?:\s+(\S+))?$/);
    if (restart) {
      this.input.set_value("");
      const m = restart[1];
      return this.restartEngine(m === undefined ? this.machine : ["mac", "local", "here"].includes(m) ? null : m, cx);
    }
    if (!this.ws || (!text && !this.attachments.length && !this.quotes.length)) return;
    const encoding = this.attachments.filter((a) => a.data === null);
    if (encoding.length) return void cx.spawn(async (cx) => { await Promise.all(encoding.map((a) => a.ready)); this.submit(cx, priority); });
    const waiting = this.pending();
    if (waiting && text && !this.attachments.length) {
      if (waiting.kind === "permission") this.answer({ item: waiting.id, decision: "deny", message: text }, cx);
      else this.answer({ item: waiting.id, answers: null, message: `The user replied instead of picking: ${text}` }, cx);
    }
    this.prompt(withQuotes(this.quotesOut(), text), this.attachments.filter((a) => a.data).map(({ type, data }) => ({ type, data })), priority);
    this.input.set_value("");
    this.attachments = [];
    this.quotes = [];
    cx.notify();
  }

  // Chats reconnect by themselves and the engine resumes their sessions. A remote engine runs a
  // copy of the code, so sync.sh (run here, from the repo this mod is linked from) copies it over and restarts it.
  restartEngine(machine, cx) {
    const where = machine ?? "this computer";
    const sh = machine
      ? 'cd "$HOME/.config/herdr-app/mods/herdr-chat" && cd "$(pwd -P)/.." && exec zsh -l scripts/sync.sh "$1"'
      : 'launchctl kickstart -k "gui/$(id -u)/com.herdr-chat.engine"';
    notify({ title: `Restarting the chat engine on ${where}`, level: "info" });
    cx.spawn(async (cx) => {
      const r = await exec("zsh", ["-lc", sh, "zsh", machine ?? ""], { timeout: 300000 }).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
      if (r.code) notify({ title: `Engine restart on ${where} failed`, body: `${r.stderr || r.stdout}`.trim().slice(-400), level: "error" });
      else notify({ title: `Chat engine restarted on ${where}`, level: "success" });
      cx.notify();
    });
  }

  prompt(text, images, priority) {
    const id = uuid();
    // Shown right away; the engine's copy of the same id replaces it.
    if (!this.state.busy && !this.pending()) {
      this.local = id;
      this.upsert({ id, kind: "user", text, images }, true);
      this.state = { ...this.state, busy: true };
    }
    this.send({ type: "prompt", id, text, images, priority });
    this.since.hide();
    this.following = true;
    this.stick = true;
  }

  answer(a, cx) {
    this.send({ type: "answer", ...a });
    cx.notify();
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
    this.auth = await openAuth(this.machine, server, url, (o) => this.send(o));
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

  sendNow(id, cx) {
    this.send({ type: "send_now", id });
    cx.notify();
  }

  unqueue(id, cx) {
    this.send({ type: "unqueue", id });
    cx.notify();
  }

  setRemote(on, cx) {
    this.remotePending = true;
    this.send({ type: "remote", enabled: on });
    this.publish();
    cx.notify();
  }

  hoverRow(id, hovered, cx) {
    if (hovered && this.hoverUser !== id) this.hoverUser = id;
    else if (!hovered && this.hoverUser === id) this.hoverUser = null;
    else return;
    cx.notify();
  }

  fork(item, cx) {
    this.forking = { id: item.id, text: item.text };
    this.send({ type: "fork", id: item.id });
    cx.notify();
  }

  askRewind(item, edit, cx) {
    this.confirm = { id: item.id, text: item.text, edit, files: undefined, restore: true };
    this.send({ type: "rewind_check", id: item.id });
    cx.notify();
  }

  rewind(cx) {
    const c = this.confirm;
    if (!c) return;
    this.confirm = null;
    this.send({ type: "rewind", id: c.id, files: Boolean(c.restore && c.files?.length) });
    if (c.edit) {
      const { quotes, body } = splitQuotes(c.text);
      this.quotes = quotes.map((q) => ({ text: q.text, input: this.quoteInput(q.comment) }));
      this.setDraft(body);
    }
    cx.notify();
  }

  copyText(id, text, cx) {
    cx.write_to_clipboard(text);
    this.copied = id;
    cx.notify();
    cx.timer.after(1500, (cx) => { if (this.copied === id) this.copied = null; cx.notify(); });
  }

  openMcp(cx) {
    this.modelMenu = false;
    openOverlay({ mod: "herdr-chat", kind: "dialog", frame: "none", width: 560, height: 560, props: { mcp: { key: this.key, machine: this.machine, cwd: this.cwd, engine: props()?.engine ?? null } } });
    cx?.notify();
  }

  toggleModels(cx) {
    this.modelMenu = !this.modelMenu;
    cx.notify();
  }

  pickModel(value, cx, backend) {
    this.send({ type: "set", model: value, ...(backend && backend !== (this.state.backend ?? "claude") ? { backend } : {}) });
    this.modelMenu = false;
    cx.notify();
  }

  pickEffort(effort, cx) {
    this.send({ type: "set", effort });
    this.state = { ...this.state, effort };
    cx.notify();
  }

  setFlag(name, value, cx) {
    this.send({ type: "set", [name]: value });
    this.state = { ...this.state, [name]: value };
    cx.notify();
  }

  // A worktree can only be chosen before the session starts, in a git repo.
  canWorktree() {
    return this.claudeOnly() && Boolean(this.branch) && !this.state.session && !this.state.busy && !this.items.length;
  }

  toggleWorktree(cx) {
    const worktree = !this.state.worktree;
    this.send({ type: "set", worktree });
    this.state = { ...this.state, worktree };
    cx.notify();
  }

  cycleMode(cx) {
    const cycle = CYCLE.filter((m) => availableModes(this.state).some(([v]) => v === m));
    this.pickMode(cycle[(cycle.indexOf(this.state.mode) + 1) % cycle.length], cx);
  }

  pickMode(mode, cx) {
    if (!mode) return;
    this.send({ type: "set", mode });
    this.state = { ...this.state, mode };
    this.modeMenu = false;
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
    // AppleScript's «class PNGf» converts the clipboard first and is several times slower than reading the PNG as is.
    const r = await exec("osascript", ["-l", "JavaScript", "-e", PASTE, abs]);
    if (r.stdout.trim() !== "true") return;
    this.attachments.push(this.encode({ type: "image/png", path: rel }));
    cx.notify();
  }

  // The shell encodes faster than the mod's JavaScript, and meanwhile the thumbnail already shows.
  encode(a) {
    a.data = null;
    a.ready = exec("base64", ["-i", `${appHome()}/${a.path}`]).then((r) => { a.data = r.code === 0 ? r.stdout.replace(/\s/g, "") : ""; });
    return a;
  }

  async drop(paths, cx) {
    for (const path of paths) {
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      if (!MIME[ext]) {
        this.input.replace(`${path} `);
        continue;
      }
      try {
        const rel = `${DATA}/img/drop-${Date.now()}.${ext}`;
        await fs.writeFile(`${appHome()}/${rel}`, await fs.readFile(path));
        this.attachments.push(this.encode({ type: MIME[ext], path: rel }));
      } catch {}
    }
    cx.notify();
  }

  // Opens the draft in $EDITOR beside the chat; saves flow back into the composer, and quitting returns here.
  async editDraft(cx) {
    const open = this.editor && panes().find((p) => p.pane === this.editor.pane);
    if (open) return run("pane.focus", { pane: open.pane });
    if (this.editor) return;
    const file = `${appHome()}/${DATA}/drafts/${(this.key ?? "draft").replace(/[^\w.-]/g, "_")}.md`;
    const done = `${file}.done`;
    const ed = { pane: null, file };
    this.editor = ed;
    await fs.mkdir(`${appHome()}/${DATA}/drafts`, { recursive: true }).catch(() => {});
    await fs.unlink(done).catch(() => {});
    let last = this.input.value();
    await fs.writeFile(file, last);
    const before = new Set(panes().map((p) => p.pane));
    const tab = panes().find((p) => p.pane === this.pane)?.tab;
    run("pane.split", { direction: "right", ...(this.pane ? { pane: this.pane } : {}), argv: ["zsh", "-lc", 'cd "$2" 2>/dev/null; ${EDITOR:-nvim} "$1"; touch "$1.done"', "zsh", file, this.machine ? home() : this.cwd ?? home()] });
    const sync = async () => {
      const text = (await fs.readFile(file, "utf8").catch(() => null))?.replace(/\n$/, "");
      if (text == null || text === last) return;
      last = text;
      this.input.set_value(text);
      this.input.set_selected_range({ start: text.length, end: text.length });
      cx.notify();
    };
    for (let i = 0; this.editor === ed; i++) {
      await new Promise((r) => cx.timer.after(300, r));
      ed.pane ??= panes().find((p) => !before.has(p.pane) && p.terminal && (!tab || p.tab === tab))?.pane ?? null;
      await sync();
      const finished = await fs.exists(done).catch(() => false);
      const gone = ed.pane && !panes().some((p) => p.pane === ed.pane);
      if (finished || gone || (!ed.pane && i > 30)) {
        if (finished && ed.pane && !gone) run("pane.close", { pane: ed.pane });
        if (this.pane) run("pane.focus", { pane: this.pane });
        this.input.focus();
        this.editor = null;
        cx.notify();
      }
    }
  }

  // A saved mod file reloads open panes without running init, so state added since then is made here.
  ensure(render = false) {
    this.quotes ??= [];
    this.origin ??= { x: 0, y: 0 };
    this.find ??= new Find(this);
    if (render) return;
    this.side ??= new SidePanel(this);
  }

  // Each quote gets its own reply box in the message box, like the desktop app; made in a click, never in render.
  quoteInput(comment = "") {
    const input = InputState.new({ placeholder: "Reply to this quote…" });
    if (comment) input.set_value(comment);
    input.on("focus", () => { this.quoteFocused = true; });
    input.on("blur", () => { this.quoteFocused = false; });
    input.on("submit", (_e, cx) => { this.input.focus(); cx.notify(); });
    return input;
  }


  addQuote(text, cx) {
    this.ensure();
    if (!text?.trim()) return;
    const input = this.quoteInput();
    this.quotes.push({ text: text.trim(), input });
    this.selection = null;
    input.focus();
    cx.notify();
  }

  quotesOut() {
    return this.quotes.map((q) => ({ text: q.text, comment: q.input?.value() ?? q.comment ?? "" }));
  }

  removeQuote(i, cx) {
    this.quotes.splice(i, 1);
    cx.notify();
  }

  // A settled selection in a reply offers to quote it; a selection cleared elsewhere doesn't hide another's bar.
  // Pressing the bar clears the text's selection first, so the bar outlives it briefly, and for good once pressed.
  selected(key, sel, cx) {
    this.ensure();
    if (sel?.text && sel.position) {
      this.selection = { key, text: sel.text, x: sel.position.x - this.origin.x, y: sel.position.y - this.origin.y };
    }
    else if (this.selection?.key === key && !this.selection.pressed) {
      const s = this.selection;
      return cx.timer.after(350, (cx) => { if (this.selection === s && !s.pressed) { this.selection = null; cx.notify(); } });
    } else return;
    cx.notify();
  }

  dismissSelection(cx) {
    this.selection = null;
    this.input.focus();
    cx.notify();
  }

  selectionBar(t) {
    const s = this.selection;
    const btn = (id, label, tip, fn) => div().id(id).px(9).py(4).rounded(6).cursor_pointer().text_size(12).text_color(t.foreground)
      .hover((st) => st.bg(t.hover)).tooltip(tip).on_click((_e, cx) => { cx.stop_propagation(); fn(cx); }).child(label);
    const left = Math.max(8, Math.min(s.x - 90, (this.width ?? 0) - 220));
    return h_flex().id("selection-bar").absolute().left(left).top(s.y + 10).p(3).gap(2).rounded(8).border_1().border_color(t.border).bg(t.surface).shadow_lg()
      .on_mouse_down("left", (_e, cx) => { s.pressed = true; cx.stop_propagation(); })
      .on_mouse_down_out((_e, cx) => { if (this.selection === s && s.pressed) { this.selection = null; cx.notify(); } })
      .child(btn("sel-quote", "Quote", "Quote this in your message, with a reply of its own", (cx) => this.addQuote(s.text, cx)))
      .when(this.claudeOnly(), (el) => el.child(btn("sel-side", "Ask aside", "Ask about this in the side chat", (cx) => { this.selection = null; this.side.quote(s.text, cx); })));
  }



  removeAttachment(i, cx) {
    this.attachments.splice(i, 1);
    cx.notify();
  }

  moveCommand(by, cx) {
    const n = this.commandMatches().length;
    if (!n) return;
    this.commandAt = (this.commandAt + by + n) % n;
    cx.notify();
  }

  onKey(e, cx) {
    this.ensure();
    const cmds = this.commandMatches();
    if (cmds.length && (e.keystroke === "up" || e.keystroke === "down")) this.moveCommand(e.keystroke === "down" ? 1 : -1, cx);
    else if (cmds.length && e.keystroke === "tab") this.complete(cmds[this.commandAt] ?? cmds[0], cx);
    else if (cmds.length && e.keystroke === "escape") { this.dismissed = this.slashToken()?.start ?? null; cx.notify(); }
    else if (this.modelMenu && e.keystroke === "escape") { this.modelMenu = false; cx.notify(); }
    else if (this.modeMenu && e.keystroke === "escape") { this.modeMenu = false; cx.notify(); }
    else if (e.keystroke === "cmd-;") this.side.toggle(cx);
    else if (e.keystroke === "escape" && this.selection) this.dismissSelection(cx);
    else if (this.vimKey(e, cx)) return;
    else if (e.keystroke === "escape" && this.side.focused) { if (this.side.busy) this.side.interrupt(cx); else this.side.close(cx); }
    else if (e.keystroke === "escape" && this.state.busy) this.interrupt(cx);
    else if (e.keystroke === "shift-tab") this.cycleMode(cx);
    else return;
    cx.stop_propagation();
  }

  // The textarea's own bindings run before key_down, and the newest binding wins, so these go in once it exists.
  bindVim(cx) {
    if (this.vimBound === this.input) return;
    this.vimBound = this.input;
    cx.bind_keys([
      ...["HerdrChatVim", "HerdrChatVimNormal"].map((c) => ({ keystroke: "escape", action: "herdr-chat-vim-escape", context: `${c} > Input` })),
      ...["backspace", "left", "right", "up", "down", "enter", "cmd-enter"].map((k) => ({ keystroke: k, action: `herdr-chat-vim-${k}`, context: "HerdrChatVimNormal > Input" })),
    ]);
  }

  vimOn() {
    return shared("herdr-chat:vim") === true;
  }

  // True when vim took the key; normal mode swallows the keys it doesn't know so they don't type.
  vimKey(e, cx) {
    if (!this.vimOn() || !this.focusedInput) return false;
    const k = /^(ctrl|cmd|alt)-/.test(e.keystroke) ? e.keystroke : e.key_char?.length === 1 && e.key_char > " " ? e.key_char : e.key;
    const text = this.input.value();
    const at = this.input.selected_range().start;
    this.cx = cx;
    const r = this.vim.key(k, text, at);
    if (!r) {
      if (this.vim.mode === "normal") this.input.set_selected_range({ start: at, end: at });
      return false;
    }
    if (r.text !== text) {
      let a = 0, b = 0;
      while (a < text.length && a < r.text.length && text[a] === r.text[a]) a++;
      while (b < text.length - a && b < r.text.length - a && text[text.length - 1 - b] === r.text[r.text.length - 1 - b]) b++;
      this.input.set_selected_range({ start: a, end: text.length - b });
      this.input.replace(r.text.slice(a, r.text.length - b));
    }
    // A one-character selection stands in for vim's block cursor.
    const block = this.vim.mode === "normal" && r.at < r.text.length && r.text[r.at] !== "\n";
    this.input.set_selected_range(r.sel ?? { start: r.at, end: block ? r.at + 1 : r.at });
    cx.stop_propagation();
    cx.notify();
    return true;
  }

  vimAction(k, cx) {
    if (k === "escape") return this.onKey({ keystroke: "escape", key: "escape", modifiers: {} }, cx);
    if (k === "enter" || k === "cmd-enter") {
      const at = this.input.selected_range().start;
      this.input.set_selected_range({ start: at, end: at });
      return this.sendInput(cx, k === "cmd-enter");
    }
    this.vimKey({ keystroke: k, key: k, modifiers: {} }, cx);
  }

  vimContext() {
    if (!this.vimOn() || this.commandMatches().length) return null;
    return this.vim.mode === "insert" ? "HerdrChatVim" : "HerdrChatVimNormal";
  }

  // GPUI doesn't report the scroll offset, so the distance from the bottom is tracked from wheel moves.
  wheel(e, cx) {
    this.wheeledAt = Date.now();
    if (this.selection) { this.selection = null; cx.notify(); }
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

  grew(h, cx) {
    // A page measured alone can lay out a little differently once joined to the rows below; the kept space absorbs that.
    const s = this.settle;
    if (s?.h && s.until > Date.now() && !this.following && (this.liveAt ?? 0) < this.committedAt) {
      const d = (h - s.h) / (settings().zoom || 1);
      if (Math.abs(d) >= 1 && this.spacer >= d) { this.spacer -= d; cx.notify(); return; }
    }
    if (!this.following && this.contentH) this.fromBottom += h - this.contentH;
    this.contentH = h;
  }

  // Scrolls a row near the top: a viewport-tall marker placed there is revealed exactly.
  scrollToRow(id) {
    const zoom = settings().zoom || 1;
    let top = 10 + this.spacer;
    for (const b of this.lastShown ?? []) {
      if (b.id === id) break;
      top += (this.heights.get(b.id) ?? 0) / zoom;
    }
    this.following = false;
    this.stick = false;
    this.findMark = { top: Math.max(0, top - 80), h: Math.max(100, (this.viewH ?? 600) / zoom), n: (this.findMark?.n ?? 0) + 1, ready: false, done: false };
  }

  jumpBack(cx) {
    const ids = this.since.card?.ids;
    const has = (b) => ids?.has(b.id) || ids?.has(b.item?.id) || b.items?.some((i) => ids?.has(i.id));
    const block = (this.lastShown ?? []).find(has);
    if (block) this.scrollToRow(block.id);
    this.since.hide();
    cx.notify();
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
      case "handoff": return handoffCard(item.item, t, this);
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
      .child(h_flex().id("folder").gap(5).px(8).py(3).rounded(6).items_center().cursor_pointer()
        .text_size(12.5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.muted))
        .tooltip("Change folder")
        .on_click(() => this.openFolders())
        .child(tilde(this.cwd, this.home) || "Pick a folder")
        .child(div().text_size(10).child("▾")))
      .when(recent.length > 0, (el) => el.child(v_flex().mt(28).w_full().max_w(560).gap(2)
        .child(div().px(10).pb(4).text_size(11.5).text_color(t.dim).child("Pick up where you left off"))
        .children(recent.map((r) => h_flex().id(`resume-${r.id}`).gap(10).px(10).py(7).rounded(8).items_center().cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.resume(r, cx))
          .tooltip(AGENTS[r.backend] ?? r.backend)
          .child(agentIcon(r.backend, 14, t.dim))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(r.title))
          .when(Boolean(r.branch) && r.branch !== "HEAD", (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(r.branch)))
          .child(div().flex_none().w(64).text_right().text_size(11.5).text_color(t.dim).child(ago(r.when)))))));
  }

  resume(r, cx) {
    this.send({ type: "resume", id: r.id, backend: r.backend });
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
    this.ensure(true);
    this.takePick();
    const t = theme();
    const children = new Map();
    for (const i of this.staged ? [...this.staged, ...this.items] : this.items) if (i.kind === "tool" && i.parent) children.set(i.parent, [...(children.get(i.parent) ?? []), i]);
    this.childMap = children;
    if (this.expandAll) for (const i of this.items) this.expanded.add(i.id);
    const visible = (list) => this.blocks(list.filter((i) => !isRunOutput(i) && !(i.kind === "tool" && i.parent && this.byId.has(i.parent))));
    const shown = visible(this.items);
    this.lastShown = shown;
    const staged = this.staged ? visible(this.staged) : null;
    const restore = this.restore;
    if (restore?.merged) this.scroll.scroll_to_item(2);
    if (this.find.open) this.find.refresh();
    const mark = restore ? null : this.findMark;
    if (mark?.ready && !mark.done) { mark.done = true; this.scroll.scroll_to_item(2); }
    if (this.stick && shown.length && !restore) {
      this.scroll.scroll_to_item(1);
      this.stick = false;
    }
    const transcript = v_flex().id("transcript").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).pt(10)
      .on_scroll_wheel((e, cx) => this.wheel(e, cx))
      .on_size_change((size) => { this.viewH = size.height; })
      .child(v_flex().id("transcript-content").relative().w_full().items_center()
        .on_size_change((size, cx) => this.grew(size.height, cx))
        .when(this.spacer > 0, (el) => el.child(div().flex_none().h(this.spacer)))
        .children(shown.map((i) => v_flex().id(`row-${i.id}`).w_full().items_center()
          .on_size_change((size) => this.heights.set(i.id, size.height))
          .child(this.renderItem(i, t, children).max_w(880))))
        .when(Boolean(staged), (el) => el.child(v_flex().id("staged").absolute().top(0).left(0).right(0).items_center().invisible()
          .on_size_change((size, cx) => this.commitOlder(size.height, cx))
          .children((staged ?? []).map((i) => this.renderItem(i, t, children).max_w(880))))))
      .child(div().h(8))
      .when(Boolean(mark), (el) => el.child(div().id(`find-mark-${mark.n}`).absolute().top(mark.top).left(0).w(1).h(mark.h)
        .on_size_change((_s, cx) => { if (!mark.ready) { mark.ready = true; cx.notify(); } })))
      // Revealing this marker scrolls by exactly the height the content above changed by.
      .when(Boolean(restore), (el) => el.child(div().id(`restore-${restore.n}`).absolute().top(restore.at - 1).left(0).w(1).h(1)
        .on_size_change((_s, cx) => this.mergeOlder(cx))));
    return h_flex().id("root").track_focus(this.handle).size_full().relative().bg(t.background).text_color(t.foreground)
      .on_mouse_move((e) => { this.origin = { x: e.position.x - e.local_position.x, y: e.position.y - e.local_position.y }; })
      .on_size_change((size) => { this.width = size.width; })
      .when(this.commandMatches().length > 0, (el) => el.key_context("HerdrChatCommands"))
      .when(Boolean(this.vimContext()), (el) => el.key_context(this.vimContext()))
      .on_action("herdr-chat-vim-escape", (_e, cx) => this.vimAction("escape", cx))
      .on_action("herdr-chat-vim-backspace", (_e, cx) => this.vimAction("backspace", cx))
      .on_action("herdr-chat-vim-left", (_e, cx) => this.vimAction("left", cx))
      .on_action("herdr-chat-vim-right", (_e, cx) => this.vimAction("right", cx))
      .on_action("herdr-chat-vim-up", (_e, cx) => this.vimAction("up", cx))
      .on_action("herdr-chat-vim-down", (_e, cx) => this.vimAction("down", cx))
      .on_action("herdr-chat-vim-enter", (_e, cx) => this.vimAction("enter", cx))
      .on_action("herdr-chat-vim-cmd-enter", (_e, cx) => this.vimAction("cmd-enter", cx))
      .on_action("herdr-chat-complete", (_e, cx) => { const cmds = this.commandMatches(); if (cmds.length) this.complete(cmds[this.commandAt] ?? cmds[0], cx); })
      .on_action("herdr-chat-up", (_e, cx) => this.moveCommand(-1, cx))
      .on_action("herdr-chat-down", (_e, cx) => this.moveCommand(1, cx))
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_drop((e, cx) => cx.spawn(async (cx) => this.drop(e.paths, cx)))
      .on_click((_e, cx) => { this.findPane(); cx.notify(); })
      .child(v_flex().flex_1().min_w(0).h_full()
        .when(this.conn !== "connected", (el) => el.child(this.banner(t)))
        .when(Boolean(this.handoff), (el) => el.child(handoffStrip(this, t)))
        .child(shown.length ? div().relative().flex_1().min_h(0).flex().flex_col()
          .child(transcript)
          .when(this.find.open, (el) => el.child(this.find.render(t)))
          .when(!this.following || Boolean(this.since.card), (el) => el.child(v_flex().absolute().bottom(10).w_full().px(16).gap(8).items_center()
            .when(!this.following, (el) => el.child(div().id("jump").px(12).py(5).rounded(14).bg(t.raised).border_1().border_color(t.border)
              .text_size(12).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.jump(cx)).child("↓ Latest")))
            .when(Boolean(this.since.card), (el) => el.child(sinceCard(this.since.card, this.items, this.state.busy, t, {
              onJump: (cx) => this.jumpBack(cx),
              onHide: (cx) => { this.since.hide(); cx.notify(); },
            })))))
          : this.empty(t))
        .child(h_flex().w_full().justify_center().flex_none().child(composer(this, t))))
      .when(Boolean(this.side?.open), (el) => el.child(this.side.render(t)))
      .when(Boolean(this.selection && this.side), (el) => el.child(this.selectionBar(t)));
  }
}

Object.assign(HerdrChat.prototype, questionMethods);
