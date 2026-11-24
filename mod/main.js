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
import { permissionCard, questionCard } from "./cards.js";
import { composer, RUN_TAG, isRunOutput } from "./composer.js";
import { handoffCard, handoffStrip, isHandoffPost } from "./handoff.js";
import { moveChat } from "./move.js";
import { McpDialog } from "./mcp.js";
import { PROTOCOL, endpoint, openAuth } from "./engine.js";
import { FileLinks, openFile } from "./filelinks.js";

const DATA = "data/herdr-chat";
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
const safe = (s) => s.replace(/[^A-Za-z0-9_-]/g, "_");
const tilde = (path, h) => (h && path?.startsWith(h) ? `~${path.slice(h.length)}` : path ?? "");

export default class HerdrChat extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.viewer) return void (this.other = new Viewer(p, cx));
    if (p.panel) return void (this.other = new Panel(cx));
    if (p.file) return void (this.other = new FileView(p, cx));
    if (p.mcp) return void (this.other = new McpDialog(p.mcp, cx));
    this.key = p.key ?? null;
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
    this.remoteMenu = Boolean(p.remote);
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
    this.following = true;
    this.stick = true;
    this.pane = null;
    this.scroll = ScrollHandle.new();
    this.input = TextareaState.new({ placeholder: "Ask Claude…" });
    this.input.set_auto_grow(1, 12);
    if (p.draft) this.setDraft(p.draft);
    this.pickId = null;
    this.resumeId = p.resume ?? null;
    this.input.on("submit", (e, cx) => this.enter(e, cx));
    this.input.on("paste_other", (_e, cx) => cx.spawn(async (cx) => this.pasteImage(cx)));
    this.input.on("change", (_e, cx) => {
      this.commandAt = 0;
      if (this.slashToken()?.start !== this.dismissed) this.dismissed = null;
      cx.notify();
    });
    this.commandAt = 0;
    this.input.on("focus", (_e, cx) => { this.focusedInput = true; this.findPane(); cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.focusedInput = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.input.focus();
    cx.timer.after(150, () => this.input.focus());
    cx.timer.after(400, () => this.findPane());
    if (checking()) return;
    // Herdr only sends "focus" for pane.go, not for clicks, tab switches or pane.focus.
    cx.timer.every(200, (cx) => {
      // A new chat's input takes focus before its pane exists, so the pane is looked up once it does.
      if (!this.pane) this.findPane();
      if (this.links.pending.size) cx.spawn(async (cx) => { if (await this.links.check(this.cwd, this.machine)) cx.notify(); });
      const shown = this.visible();
      if (shown && !this.shown) this.input.focus();
      this.shown = shown;
    });
    cx.spawn(async (cx) => this.connect(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus" && (!this.pane || this.visible())) this.input.focus();
        else if (c === "edit" && this.pane && focused()?.pane === this.pane) this.editDraft(cx).catch((e) => { this.editor = null; notify({ title: "Couldn't open the editor", body: String(e?.message ?? e), level: "error" }); });
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
      key: this.key, pane: this.pane, machine: this.machine, folder: tilde(this.cwd, this.home), branch: this.branch ?? null,
      model: s.model, mode: s.mode, usage: s.usage ?? null, context: s.context, outputs: this.outputs(), mcp: s.mcp ?? [], remote: s.remote ?? null, title: s.title ?? null,
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
    const first = this.state.first ?? this.items.find((i) => i.kind === "user" && !isRunOutput(i) && !i.text?.startsWith("This session is being continued"))?.text?.split("\n")[0] ?? null;
    const title = this.handoff?.title ?? this.state.title ?? (first && first.slice(0, 80));
    this.nameTab(this.handoff?.title ?? this.state.title ?? first, first);
    const json = JSON.stringify({ folder: tilde(this.cwd, this.home), cwd: this.cwd, status, title, named: Boolean(this.state.title) });
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
    else if (m.type === "state") this.setState(m.state);
    else if (m.type === "snapshot") {
      if (m.cwd && m.cwd !== this.cwd) { this.cwd = m.cwd; this.branch = null; this.links = new FileLinks(); this.readFolder(cx); }
      this.handoff = m.handoff ?? null;
      this.items = [];
      this.byId.clear();
      this.staged = null;
      this.restore = null;
      this.loadingOlder = false;
      this.olderAvailable = Boolean(m.older);
      this.asked.clear();
      for (const item of m.items) await this.upsert(item, false);
      this.setState(m.state);
      this.stick = true;
      this.recent = null;
      if (!this.items.length && this.resumeId) { this.send({ type: "resume", id: this.resumeId }); this.resumeId = null; }
      else if (!this.items.length) this.send({ type: "sessions" });
    } else if (m.type === "older") {
      this.loadingOlder = false;
      if (m.before !== this.items[0]?.id) return;
      this.olderAvailable = Boolean(m.older);
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
    else if (m.type === "forked" && this.forking?.id === m.id) {
      const draft = this.forking.text;
      this.forking = null;
      if (this.pane) run("pane.focus", { pane: this.pane });
      run("pane.split", { direction: "right", mod: "herdr-chat", props: { key: m.key, machine: this.machine, cwd: m.cwd, draft, ...(props()?.engine ? { engine: props().engine } : {}) } });
    }
    else if (m.type === "upsert") await this.upsert(m.item, true);
  }

  setState(next) {
    const was = this.state.busy;
    if (next.remote !== this.state.remote) this.remotePending = false;
    this.state = next;
    if (was && !next.busy && !this.visible()) this.unseen = true;
    this.publish();
    this.publishPane();
    if (was && !next.busy && !this.visible()) {
      notify({ title: "Claude finished", body: tilde(this.cwd, this.home), level: "success", action: this.focusAction() });
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

  prepareQuestion(item) {
    const inputs = item.questions.map((q) => {
      const s = InputState.new({ placeholder: "Something else…" });
      s.on("submit", (_e, cx) => {
        const qi = item.questions.indexOf(q);
        if (item.questions.length === 1 && !q.multiSelect && s.value().trim()) this.answer({ item: item.id, answers: { [q.question]: s.value().trim() } }, cx);
        else if (qi < item.questions.length - 1) this.goQuestion(item, qi + 1, cx);
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
      if (Math.abs(y - r.target) < 2 || ++r.tries > 10) { this.restore = null; this.loadingOlder = false; }
      cx.notify();
    }
    // Without a scroll since the last page, a page that failed to keep the view in place would pull in the next one.
    const asked = this.following || (this.wheeledAt ?? 0) > (this.committedAt ?? 0);
    if (this.olderAvailable && !this.loadingOlder && asked && this.items.length && y < viewH * 1.5) {
      this.loadingOlder = true;
      this.send({ type: "older", before: this.items[0].id });
    }
    const zoom = settings().zoom || 1;
    let top = 10;
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

  // An older page is drawn invisibly first; once its height is known it goes above, and the view moves down by as much.
  // The marker is laid out a frame before the page goes in, so a scroll request can find it whenever Herdr runs it.
  commitOlder(height, cx) {
    if (!this.staged || this.restore) return;
    const zoom = settings().zoom || 1, h = height / zoom;
    const y = this.scroll.offset().y, viewH = this.scroll.viewport_size().height;
    this.restore = { at: y + h + viewH, target: y + h, height, merged: false, tries: 0, n: (this.restores = (this.restores ?? 0) + 1) };
    cx.notify();
  }

  mergeOlder(cx) {
    const r = this.restore;
    if (!r || r.merged || !this.staged) return;
    this.items = [...this.staged, ...this.items];
    this.staged = null;
    r.merged = true;
    this.committedAt = Date.now();
    if (this.contentH) this.contentH += r.height;
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
    if (v[at - 1] === "\n") {
      this.input.set_value(v.slice(0, at - 1) + v.slice(at));
      this.input.set_selected_range({ start: at - 1, end: at - 1 });
    }
    // A picked command only fills in, so it can take arguments; the next Enter sends.
    const pick = this.commandMatches()[this.commandAt];
    if (pick) return this.complete(pick, cx);
    this.submit(cx);
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
    const list = [...(this.state.commands ?? []).filter((c) => c.name !== "mcp"), { name: "mcp", description: "Manage MCP servers", hint: "" }, { name: "restart-engine", description: "Restart a machine's chat engine, copying the code there first if it's remote (stops running turns)", hint: "[machine]" }, { name: "move", description: "Move this chat to another machine: the conversation continues there and this pane closes", hint: "<machine> [folder] [--force]" }];
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

  submit(cx) {
    const text = this.input.value().trim();
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
    const restart = text.match(/^\/restart-engine(?:\s+(\S+))?$/);
    if (restart) {
      this.input.set_value("");
      const m = restart[1];
      return this.restartEngine(m === undefined ? this.machine : ["mac", "local", "here"].includes(m) ? null : m, cx);
    }
    if (!this.ws || (!text && !this.attachments.length)) return;
    const encoding = this.attachments.filter((a) => a.data === null);
    if (encoding.length) return void cx.spawn(async (cx) => { await Promise.all(encoding.map((a) => a.ready)); this.submit(cx); });
    const waiting = this.pending();
    if (waiting && text && !this.attachments.length) {
      if (waiting.kind === "permission") this.answer({ item: waiting.id, decision: "deny", message: text }, cx);
      else this.answer({ item: waiting.id, answers: null, message: `The user replied instead of picking: ${text}` }, cx);
    }
    this.prompt(text, this.attachments.filter((a) => a.data).map(({ type, data }) => ({ type, data })));
    this.input.set_value("");
    this.attachments = [];
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

  prompt(text, images) {
    const id = uuid();
    // Shown right away; the engine's copy of the same id replaces it.
    if (!this.state.busy && !this.pending()) {
      this.local = id;
      this.upsert({ id, kind: "user", text, images }, true);
      this.state = { ...this.state, busy: true };
    }
    this.send({ type: "prompt", id, text, images });
    this.following = true;
    this.stick = true;
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
    const qi = item.questions.indexOf(q);
    if (!q.multiSelect && qi < item.questions.length - 1) return this.goQuestion(item, qi + 1, cx);
    cx.notify();
  }

  goQuestion(item, page, cx) {
    this.qPage.set(item.id, Math.max(0, Math.min(page, item.questions.length - 1)));
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
    const missing = item.questions.findIndex((q) => !answers[q.question]);
    if (missing >= 0) return this.goQuestion(item, missing, cx);
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

  toggleRemoteMenu(cx) {
    this.remoteMenu = !this.remoteMenu;
    this.modelMenu = false;
    cx.notify();
  }

  setRemote(on, cx) {
    this.remotePending = true;
    this.send({ type: "remote", enabled: on });
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
    if (c.edit) this.setDraft(c.text);
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

  pickModel(value, cx) {
    this.send({ type: "set", model: value });
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
    return Boolean(this.branch) && !this.state.session && !this.state.busy && !this.items.length;
  }

  toggleWorktree(cx) {
    const worktree = !this.state.worktree;
    this.send({ type: "set", worktree });
    this.state = { ...this.state, worktree };
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
    else if (cmds.length && e.keystroke === "escape") { this.dismissed = this.slashToken()?.start ?? null; cx.notify(); }
    else if (this.modelMenu && e.keystroke === "escape") { this.modelMenu = false; cx.notify(); }
    else if (this.remoteMenu && e.keystroke === "escape") { this.remoteMenu = false; cx.notify(); }
    else if (e.keystroke === "escape" && this.state.busy) this.interrupt(cx);
    else if (e.keystroke === "shift-tab") this.cycleMode(cx);
    else return;
    cx.stop_propagation();
  }

  // GPUI doesn't report the scroll offset, so the distance from the bottom is tracked from wheel moves.
  wheel(e, cx) {
    this.wheeledAt = Date.now();
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
    if (this.stick && shown.length && !restore) {
      this.scroll.scroll_to_item(1);
      this.stick = false;
    }
    const transcript = v_flex().id("transcript").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).pt(10)
      .on_scroll_wheel((e, cx) => this.wheel(e, cx))
      .on_size_change((size) => { this.viewH = size.height; })
      .child(v_flex().id("transcript-content").relative().w_full().items_center()
        .on_size_change((size) => this.grew(size.height))
        .children(shown.map((i) => v_flex().id(`row-${i.id}`).w_full().items_center()
          .on_size_change((size) => this.heights.set(i.id, size.height))
          .child(this.renderItem(i, t, children).max_w(880))))
        .when(Boolean(staged), (el) => el.child(v_flex().id("staged").absolute().top(0).left(0).right(0).items_center().invisible()
          .on_size_change((size, cx) => this.commitOlder(size.height, cx))
          .children((staged ?? []).map((i) => this.renderItem(i, t, children).max_w(880))))))
      .child(div().h(8))
      // Revealing this marker scrolls by exactly the height the older page added.
      .when(Boolean(restore), (el) => el.child(div().id(`restore-${restore.n}`).absolute().top(restore.at - 1).left(0).w(1).h(1)
        .on_size_change((_s, cx) => this.mergeOlder(cx))));
    return v_flex().id("root").track_focus(this.handle).size_full().bg(t.background).text_color(t.foreground)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_drop((e, cx) => cx.spawn(async (cx) => this.drop(e.paths, cx)))
      .on_click((_e, cx) => { this.findPane(); cx.notify(); })
      .when(this.conn !== "connected", (el) => el.child(this.banner(t)))
      .when(Boolean(this.handoff), (el) => el.child(handoffStrip(this, t)))
      .child(shown.length ? div().relative().flex_1().min_h(0).flex().flex_col()
        .child(transcript)
        .when(!this.following, (el) => el.child(div().absolute().bottom(10).w_full().flex().justify_center()
          .child(div().id("jump").px(12).py(5).rounded(14).bg(t.raised).border_1().border_color(t.border)
            .text_size(12).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.jump(cx)).child("↓ Latest"))))
        : this.empty(t))
      .child(h_flex().w_full().justify_center().flex_none().child(composer(this, t)));
  }
}
