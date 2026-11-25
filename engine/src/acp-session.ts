import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Image, McpServer, McpTool } from "./items";
import { AcpClient } from "./acp";
import { AcpFeed, MODES, asClaudeTool, modelsOf } from "./acp-feed";
import { Session, type Answer, type Client } from "./session";
import { describe } from "./tools";

type Msg = Record<string, any>;
type Entry = { id: string; text: string; images: Image[] };

const IDLE_MS = 5 * 60_000;
const CACHE = `${process.env.HOME}/.local/state/herdr-chat/agy.json`;
const NO = (what: string) => new Error(`${what} isn't available for Antigravity chats`);

// agy's model list and commands, so a new chat can show them before agy starts, and the model and effort last picked.
function cached(): Msg {
  try { return JSON.parse(readFileSync(CACHE, "utf8")); } catch { return {}; }
}
function cache(patch: Msg) {
  try {
    mkdirSync(CACHE.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(CACHE, JSON.stringify({ ...cached(), ...patch }));
  } catch {}
}

// A chat run by Antigravity's `agy acp`; the pane sees the same items and state as for Claude.
export class AcpSession extends Session {
  override readonly backend = "agy";
  private c: AcpClient | null = null;
  private starting: Promise<AcpClient> | null = null;
  private feed: AcpFeed;
  // agy's session id; it becomes state.session with the first message, so the folder can still change before that.
  private sid: string | null;
  private replaying = false;
  private queue: Entry[] = [];
  private always = new Set<string>();
  private idle: ReturnType<typeof setTimeout> | null = null;
  private wantMode: string | null = null;
  private wantConfig: Record<string, string> = {};
  private stopped = false;

  constructor(key: string, cwd: string, sessionId: string | null, onSession: (s: Session) => void) {
    super(key, cwd, sessionId, onSession);
    this.sid = sessionId;
    this.feed = new AcpFeed(this.n, randomUUID().slice(0, 8));
    const c = cached();
    Object.assign(this.n.state, { backend: "agy", mode: "default", effort: c.effort ?? null, model: c.model ?? "", models: c.models ?? [], commands: c.commands ?? [] });
  }

  override async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.sid) return;
    try {
      await this.ensure();
    } catch (e: any) {
      this.n.notice("error", `Couldn't load the earlier conversation: ${e?.message ?? e}`);
    }
    this.n.dirty.clear();
  }

  private ensure(): Promise<AcpClient> {
    if (this.c && !this.c.exited) return Promise.resolve(this.c);
    this.starting ??= this.boot().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async boot(): Promise<AcpClient> {
    const c = new AcpClient(this.cwd, { ...process.env, HERDR_CHAT_KEY: this.key });
    c.onUpdate = (sid, u) => this.update(sid, u);
    c.onRequest = (method, params) => this.request(method, params);
    c.onExit = () => this.exited(c);
    this.pid = c.pid;
    await c.initialize();
    const first = !this.n.items.length;
    let r: Msg;
    if (this.sid) {
      // Replayed history only the first time; a restarted agy resumes without it.
      this.replaying = first;
      try {
        r = await c.request(first ? "session/load" : "session/resume", { sessionId: this.sid, cwd: this.cwd, mcpServers: [] }, 120_000);
      } finally {
        this.feed.settle();
        this.replaying = false;
      }
    } else {
      r = await c.request("session/new", { cwd: this.cwd, mcpServers: [] }, 60_000);
      this.sid = r.sessionId;
    }
    this.c = c;
    this.applyOptions(r);
    if (this.wantMode) await this.setMode(this.wantMode);
    const picked = cached();
    const want: Record<string, string> = { ...(picked.model && { model: picked.model }), ...(picked.effort && { thought_level: picked.effort }), ...this.wantConfig };
    if (want.model === this.state.model) delete want.model;
    if (want.thought_level === this.state.effort) delete want.thought_level;
    for (const [configId, value] of Object.entries(want)) await this.setConfig(configId, value);
    this.schedule();
    return c;
  }

  private applyOptions(r: Msg) {
    if (r.configOptions) this.feed.config(r.configOptions);
    if (r.modes?.currentModeId && !this.wantMode) this.n.setState({ mode: this.state.mode === "bypassPermissions" ? "bypassPermissions" : (Object.entries(MODES).find(([, v]) => v === r.modes.currentModeId)?.[0] ?? r.modes.currentModeId) });
    const { models } = modelsOf(r.configOptions ?? []);
    if (models.length) cache({ models });
  }

  private exited(c: AcpClient) {
    if (this.c !== c) return;
    this.c = null;
    this.pid = null;
    this.denyAll("Antigravity stopped");
    const was = this.state.busy;
    this.n.setState({ busy: false, status: null, memory: null });
    if (was) this.n.notice("error", `Antigravity stopped${c.stderr ? `: ${c.stderr.trim().split("\n").pop()}` : ""}`);
    this.schedule();
  }

  private update(sid: string, u: Msg) {
    if (sid && this.sid && sid !== this.sid) return;
    const title = this.state.title;
    this.feed.feed(u, this.replaying);
    if (u.sessionUpdate === "available_commands_update") cache({ commands: this.state.commands });
    if (this.state.title !== title) this.onSession(this);
    if (!this.replaying) this.schedule();
  }

  private async request(method: string, p: Msg): Promise<unknown> {
    if (method !== "session/request_permission") throw new Error(`${method} isn't supported`);
    const options: Msg[] = p.options ?? [];
    const pick = (...kinds: string[]) => kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean)?.optionId;
    if (this.state.mode === "bypassPermissions") return { outcome: { outcome: "selected", optionId: pick("allow_once", "allow_always") } };
    const call: Msg = p.toolCall ?? {};
    const toolId = call.toolCallId ?? randomUUID();
    const { name, input } = asClaudeTool(call);
    const d = describe(name, input, this.cwd);
    const id = `perm:${toolId}`;
    return new Promise((resolve) => {
      this.pending.set(id, {
        input: {}, tool: toolId,
        resolve: (r: any) => {
          if (r.behavior === "allow") resolve({ outcome: { outcome: "selected", optionId: this.always.delete(id) ? pick("allow_always", "allow_once") : pick("allow_once", "allow_always") } });
          else if (r.interrupt) resolve({ outcome: { outcome: "cancelled" } });
          else resolve({ outcome: { outcome: "selected", optionId: pick("reject_once", "reject_always") } });
        },
      });
      const row = this.n.get(toolId);
      if (row?.kind === "tool") { row.status = "waiting"; this.n.touch(row); }
      this.n.upsert({ id, kind: "permission", tool: name, verb: d.running, meta: d.meta, detail: d.detail, remember: Boolean(pick("allow_always")), state: "pending" });
      this.flush();
    });
  }

  // agy takes no reason with a denial, so what the person typed goes in as the next message.
  override answer(a: Answer) {
    if (a.decision === "session") this.always.add(a.item);
    const denied = a.decision === "deny" && a.message && this.pending.has(a.item);
    super.answer(a);
    if (denied) this.prompt(a.message!, []);
  }

  override prompt(text: string, images: Image[], id?: string) {
    const entry = { id: id && !this.n.get(id) ? id : randomUUID(), text, images };
    if (this.state.busy) {
      this.queue.push(entry);
      return this.queued();
    }
    this.run(entry);
  }

  private queued() {
    this.state.queue = this.queue.map((w) => ({ id: w.id, text: w.text, images: w.images.length, priority: "later" as const }));
    this.n.stateDirty = true;
    this.schedule();
  }

  // agy can't take a message mid-turn, so "send now" stops the turn and sends it next.
  override async sendNow(id: string) {
    const at = this.queue.findIndex((w) => w.id === id);
    if (at < 0) return;
    this.queue.unshift(...this.queue.splice(at, 1));
    this.queued();
    this.cancel();
  }

  override async unqueue(id: string) {
    this.queue = this.queue.filter((w) => w.id !== id);
    this.queued();
  }

  private async run({ id, text, images }: Entry) {
    this.lastUsed = Date.now();
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    this.n.upsert({ id, kind: "user", text, images });
    this.n.setState({ busy: true });
    this.schedule();
    const said = this.preamble ? `${this.preamble}\n\n${text}` : text;
    if (this.preamble) { this.preamble = null; this.onSession(this); }
    const started = Date.now();
    this.stopped = false;
    try {
      const c = await this.ensure();
      if (this.stopped) throw Object.assign(new Error("stopped"), { stopReason: "cancelled" });
      if (!this.state.session) { this.n.setState({ session: this.sid }); this.onSession(this); }
      this.feed.settle();
      const prompt = [
        ...images.map((i) => ({ type: "image", mimeType: i.type, data: i.data })),
        ...(said ? [{ type: "text", text: said }] : []),
      ];
      const r = await c.request("session/prompt", { sessionId: this.sid, prompt });
      this.feed.end(Date.now() - started, r?.stopReason);
    } catch (e: any) {
      if (e?.stopReason) this.feed.end(Date.now() - started, e.stopReason);
      else this.feed.end(Date.now() - started, "error", e?.message ?? String(e));
    }
    this.n.setState({ busy: false, status: null });
    this.lastUsed = Date.now();
    this.schedule();
    const next = this.queue.shift();
    if (next) { this.queued(); this.run(next); }
    else this.restLater();
  }

  // agy keeps the conversation on disk, so an idle chat needn't keep it running.
  private restLater() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.idle = null;
      if (!this.held()) this.c?.kill();
    }, IDLE_MS);
  }

  private cancel() {
    this.stopped = true;
    this.denyAll("Interrupted by the user");
    if (this.c && this.sid) this.c.notify("session/cancel", { sessionId: this.sid });
  }

  override async interrupt() {
    this.queue = [];
    this.queued();
    this.cancel();
  }

  private async setMode(mode: string) {
    await this.c?.request("session/set_mode", { sessionId: this.sid, modeId: MODES[mode] ?? mode }, 15_000).catch((e) => this.n.notice("warning", `Couldn't change the mode: ${e?.message ?? e}`));
  }

  private async setConfig(configId: string, value: string) {
    const r = await this.c?.request("session/set_config_option", { sessionId: this.sid, configId, value }, 15_000).catch((e) => { this.n.notice("warning", `Couldn't change ${configId}: ${e?.message ?? e}`); return null; });
    if (r?.configOptions) this.feed.config(r.configOptions);
  }

  override async set(s: { mode?: string; model?: string; effort?: string }) {
    if (s.mode) {
      this.wantMode = s.mode;
      this.n.setState({ mode: s.mode });
      await this.setMode(s.mode);
    }
    if (s.model) {
      this.wantConfig.model = s.model;
      this.n.setState({ model: s.model });
      cache({ model: s.model });
      await this.setConfig("model", s.model);
    }
    if (s.effort) {
      this.wantConfig.thought_level = s.effort;
      this.n.setState({ effort: s.effort });
      cache({ effort: s.effort });
      await this.setConfig("thought_level", s.effort);
    }
    this.schedule();
  }

  override async list(limit = 12) {
    const c = await this.ensure();
    const r = await c.request("session/list", { cwd: this.cwd }, 30_000);
    return (r?.sessions ?? [])
      .filter((x: Msg) => x.cwd === this.cwd && x.sessionId !== this.sid)
      .slice(0, limit)
      .map((x: Msg) => ({ id: x.sessionId, title: x.title || "Untitled", when: Date.parse(x.updatedAt) || 0, branch: null }));
  }

  override view(_c: Client, on: boolean) {
    this.lastUsed = Date.now();
    if (!on && !this.clients.size) this.restLater();
  }

  protected override async warm() {}
  protected override async title() {}
  protected override async usage() {}
  protected override async mcp() {}
  override async remote(enabled: boolean) { if (enabled) throw NO("Remote Control"); }
  override async servers(): Promise<McpServer[]> { return []; }
  override async tools(): Promise<McpTool[]> { return []; }
  override async mcpAction() { throw NO("Managing MCP servers"); }
  override async signIn(): Promise<string | null> { throw NO("MCP sign-in"); }
  override async signInCallback() {}
  override async branch(): Promise<string | null> { throw NO("Rewinding and forking"); }
  override async restoreFiles(): Promise<any> { return { canRewind: false }; }
  override askSide() { throw NO("Side questions"); }

  override close() {
    this.queue = [];
    if (this.idle) clearTimeout(this.idle);
    this.denyAll("Session closed");
    this.c?.kill();
  }
}
