import { getSessionInfo, getSessionMessages, query, type PermissionResult, type PermissionUpdate, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Image, Item, McpServer, State } from "./items";
import { Normalizer, commandsOf } from "./normalizer";
import { describe } from "./tools";

export type Client = { send(o: unknown): void };

export type Handoff = { id: string; title: string | null; from: string; result?: "done" | "failed" | null };

export type Answer = {
  item: string;
  decision?: "once" | "session" | "deny";
  message?: string;
  answers?: Record<string, string> | null;
};

type Pending = {
  resolve: (r: PermissionResult) => void;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  tool?: string;
};

const FLUSH_MS = 50;
const label = (name: string) => name.split(":").pop()!.replace(/^claude\.ai /, "");

let knownCommands: State["commands"] = [];
let knownModels: State["models"] = [];

export function userSettings(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(`${process.env.HOME}/.claude/settings.json`, "utf8"));
  } catch {
    return {};
  }
}

const defaultMode = (): string => userSettings().permissions?.defaultMode ?? "default";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAUDE = Bun.which("claude") ?? `${process.env.HOME}/.local/bin/claude`;
const RECORD = process.env.HERDR_CHAT_RECORD;

export function inbox<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  async function* iter() {
    while (!closed) {
      while (queue.length) yield queue.shift()!;
      if (!closed) await new Promise<void>((r) => (wake = r));
    }
  }
  return {
    iter: iter(),
    push(m: T) { queue.push(m); wake?.(); wake = null; },
    close() { closed = true; wake?.(); wake = null; },
  };
}

export class Session {
  n: Normalizer;
  clients = new Set<Client>();
  protected q: Query | null = null;
  protected box = inbox<SDKUserMessage>();
  protected pending = new Map<string, Pending>();
  private queued: { id: string; text: string; images: Image[] }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private options: { permissionMode?: string; model?: string; effort?: string; flags?: Record<string, unknown> } = {};
  private loaded = false;
  handoff: Handoff | null = null;

  constructor(public key: string, public cwd: string, sessionId: string | null, private onSession: (s: Session) => void) {
    this.n = new Normalizer(cwd);
    this.n.state.session = sessionId;
    this.n.state.commands = knownCommands;
    this.n.state.models = knownModels;
    this.n.state.mode = defaultMode();
    this.n.state.effort = userSettings().effortLevel ?? null;
  }

  get state(): State {
    return this.n.state;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    const id = this.state.session;
    if (!id) return;
    this.title();
    try {
      for (const m of await getSessionMessages(id, { dir: this.cwd, includeSystemMessages: true })) this.n.feed({ ...m, isReplay: true });
    } catch (e) {
      this.n.notice("error", `Couldn't load the earlier conversation: ${e}`);
    }
  }

  // Claude names a session (or /rename does) a moment after a turn; custom names win.
  protected async title() {
    const id = this.state.session;
    if (!id) return;
    const info = await getSessionInfo(id, { dir: this.cwd }).catch(() => undefined);
    const title = info?.customTitle ?? info?.summary ?? null;
    if (title && title !== this.state.title) this.n.setState({ title });
  }

  snapshot() {
    return { type: "snapshot", items: this.n.items, state: this.state, cwd: this.cwd, handoff: this.handoff };
  }

  get activity(): "blocked" | "working" | "idle" {
    return this.pending.size ? "blocked" : this.state.busy || this.queued.length ? "working" : "idle";
  }

  attach(c: Client) {
    this.clients.add(c);
    c.send(this.snapshot());
  }

  detach(c: Client) {
    this.clients.delete(c);
  }

  protected broadcast(o: unknown) {
    for (const c of this.clients) c.send(o);
  }

  protected schedule() {
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush() {
    this.timer = null;
    const ids = [...this.n.dirty];
    this.n.dirty.clear();
    for (const id of ids) {
      const item = this.n.get(id);
      if (item) this.broadcast({ type: "upsert", item });
    }
    if (this.n.stateDirty) {
      this.n.stateDirty = false;
      this.broadcast({ type: "state", state: this.state });
    }
  }

  private changed() {
    this.state.queue = this.queued.map((q) => ({ id: q.id, text: q.text, images: q.images.length }));
    this.n.stateDirty = true;
    this.schedule();
  }

  prompt(text: string, images: Image[], id?: string) {
    const entry = { id: id && UUID.test(id) && !this.n.get(id) ? id : randomUUID(), text, images };
    if (this.state.busy) this.queued.push(entry);
    else this.send(entry);
    this.changed();
  }

  unqueue(id: string) {
    this.queued = this.queued.filter((q) => q.id !== id);
    this.changed();
  }

  protected send({ id, text, images }: { id: string; text: string; images: Image[] }) {
    this.n.upsert({ id, kind: "user", text, images });
    this.n.setState({ busy: true });
    const content = [
      ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.type as "image/png", data: i.data } })),
      ...(text ? [{ type: "text" as const, text }] : []),
    ];
    this.box.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: id as `${string}-${string}-${string}-${string}-${string}` });
    if (!this.q) this.start();
  }

  protected start() {
    const q = query({
      prompt: this.box.iter,
      options: {
        cwd: this.cwd,
        env: { ...process.env, HERDR_CHAT_KEY: this.key },
        resume: this.state.session ?? undefined,
        pathToClaudeCodeExecutable: CLAUDE,
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        extraArgs: { "replay-user-messages": null, ...(this.state.worktree && !this.state.session ? { worktree: null } : {}) },
        effort: this.options.effort as any,
        permissionMode: this.options.permissionMode as any,
        model: this.options.model,
        canUseTool: (tool, input, opts) => this.ask(tool, input, opts.toolUseID, opts.suggestions),
      },
    });
    this.q = q;
    if (this.options.flags) q.applyFlagSettings(this.options.flags as any).catch(() => {});
    (async () => {
      try {
        for await (const msg of q) this.receive(msg);
      } catch (e) {
        this.n.notice("error", String(e instanceof Error ? e.message : e));
      } finally {
        if (this.q === q) this.q = null;
        this.box.close();
        this.box = inbox();
        this.denyAll("Claude stopped");
        this.n.setState({ busy: false, status: null, remote: null });
        this.schedule();
      }
    })();
  }

  protected receive(msg: Record<string, any>) {
    if (RECORD) {
      mkdirSync(RECORD, { recursive: true });
      appendFileSync(`${RECORD}/${this.key}.jsonl`, JSON.stringify(msg) + "\n");
    }
    const before = this.state.session;
    this.n.feed(msg);
    // --worktree moves the session into the new worktree; later resumes must look for it there.
    if (msg.type === "system" && msg.subtype === "init" && msg.cwd && msg.cwd !== this.cwd) {
      this.cwd = msg.cwd;
      this.n.setState({ worktree: false });
      this.broadcast(this.snapshot());
    }
    if (msg.type === "system" && msg.subtype === "init") {
      this.loadCommands();
      this.mcp();
      if (this.wantRemote && !this.state.remote) this.remote(true).catch(() => {});
    }
    if (msg.type === "system" && msg.subtype === "commands_changed") knownCommands = this.state.commands;
    if (this.state.session !== before) this.onSession(this);
    if (msg.type === "result") {
      this.usage();
      this.mcp();
      this.title();
      setTimeout(() => this.title(), 8000);
      const next = this.queued.shift();
      if (next) { this.send(next); this.changed(); }
    }
    this.schedule();
  }

  private async loadCommands() {
    try {
      const list = await this.q?.supportedCommands();
      if (!list) return;
      knownCommands = commandsOf(list);
      const models = await this.q?.supportedModels().catch(() => null);
      if (models) knownModels = models.map((m) => ({ value: m.value, name: m.displayName, description: m.description, efforts: m.supportedEffortLevels ?? [], resolved: m.resolvedModel ?? m.value, fast: Boolean(m.supportsFastMode) }));
      this.n.setState({ commands: knownCommands, models: knownModels });
      this.schedule();
    } catch {}
  }

  protected async mcp() {
    const list = await this.q?.mcpServerStatus().catch(() => null);
    if (!list) return;
    this.n.setState({ mcp: list.filter((m) => m.status === "needs-auth").map((m) => ({ name: m.name, label: label(m.name) })) });
    this.schedule();
  }

  wantRemote = false;

  async remote(enabled: boolean) {
    this.wantRemote = enabled;
    await this.ready();
    const name = `${this.cwd.split("/").pop() || "herdr"} (herdr)`;
    const r = await (this.q as any).enableRemoteControl(enabled, enabled ? name : undefined);
    this.n.setState({ remote: enabled ? (r?.session_url ?? null) : null });
    this.schedule();
  }

  protected async ready() {
    if (!this.q) this.start();
    await this.q!.initializationResult();
  }

  async servers(): Promise<McpServer[]> {
    await this.ready();
    const list = await this.q!.mcpServerStatus();
    this.n.setState({ mcp: list.filter((m) => m.status === "needs-auth").map((m) => ({ name: m.name, label: label(m.name) })) });
    this.schedule();
    return list.map((m) => ({ name: m.name, label: label(m.name), status: m.status, error: m.error ?? null, tools: m.tools?.length ?? 0, scope: m.scope ?? null }));
  }

  async mcpAction(server: string, action: string) {
    await this.ready();
    const q = this.q as any;
    if (action === "reconnect") await q.reconnectMcpServer(server);
    else if (action === "enable" || action === "disable") await q.toggleMcpServer(server, action === "enable");
    else if (action === "signout") await q.mcpClearAuth(server);
  }

  async signIn(server: string): Promise<string | null> {
    await this.ready();
    const r = await (this.q as any).mcpAuthenticate(server);
    this.watchSignIn(server);
    return r?.authUrl ?? null;
  }

  async signInCallback(server: string, url: string) {
    await (this.q as any)?.mcpSubmitOAuthCallbackUrl(server, url);
  }

  private watching = new Set<string>();

  private async watchSignIn(server: string) {
    if (this.watching.has(server)) return;
    this.watching.add(server);
    try {
      await this.waitSignIn(server);
    } finally {
      this.watching.delete(server);
    }
  }

  private async waitSignIn(server: string) {
    for (let i = 0; i < 150 && this.q; i++) {
      await Bun.sleep(2000);
      const s = (await this.q?.mcpServerStatus().catch(() => null))?.find((m) => m.name === server);
      if (s?.status !== "connected") continue;
      this.n.notice("info", `Signed in to ${label(server)}`);
      return this.mcp();
    }
  }

  protected async usage() {
    try {
      const u = await this.q?.getContextUsage({ detail: "summary" });
      if (!u) return;
      this.n.setState({
        usage: { total: u.totalTokens, max: u.maxTokens, categories: u.categories.map(({ id, name, tokens, kind }) => ({ id, name, tokens, kind })) },
        context: { used: u.totalTokens, max: u.maxTokens },
      });
      this.schedule();
    } catch {}
  }

  protected ask(tool: string, input: Record<string, unknown>, toolUseID: string, suggestions?: PermissionUpdate[]): Promise<PermissionResult> {
    if (RECORD) appendFileSync(`${RECORD}/${this.key}.jsonl`, JSON.stringify({ type: "_ask", tool, input, toolUseID, suggestions }) + "\n");
    return new Promise((resolve) => {
      let item: Item;
      if (tool === "AskUserQuestion") {
        item = { id: `q:${toolUseID}`, kind: "question", questions: (input.questions as any[]) ?? [], state: "pending" };
      } else {
        const d = describe(tool, input, this.cwd);
        item = {
          id: `perm:${toolUseID}`, kind: "permission", tool, verb: d.running, meta: d.meta, detail: d.detail,
          plan: tool === "ExitPlanMode" ? String(input.plan ?? "") : undefined,
          remember: Boolean(suggestions?.length), state: "pending",
        };
        const row = this.n.get(toolUseID);
        if (row?.kind === "tool") { row.status = "waiting"; this.n.touch(row); }
      }
      this.pending.set(item.id, { resolve, input, suggestions, tool: toolUseID });
      this.n.upsert(item);
      this.flush();
    });
  }

  answer(a: Answer) {
    const p = this.pending.get(a.item);
    const item = this.n.get(a.item);
    if (!p || !item) return;
    this.pending.delete(a.item);
    if (item.kind === "question") {
      if (a.answers) {
        Object.assign(item, { state: "answered", answers: a.answers });
        p.resolve({ behavior: "allow", updatedInput: { ...p.input, answers: a.answers } });
      } else {
        item.state = "skipped";
        p.resolve({ behavior: "deny", message: a.message || "The user skipped the question." });
      }
    } else if (item.kind === "permission") {
      const allow = a.decision !== "deny";
      item.state = allow ? "allowed" : "denied";
      const row = p.tool ? this.n.get(p.tool) : undefined;
      if (row?.kind === "tool") { row.status = allow ? "running" : "error"; this.n.touch(row); }
      p.resolve(allow
        ? { behavior: "allow", updatedInput: p.input, updatedPermissions: a.decision === "session" ? p.suggestions?.map((s) => ({ ...s, destination: "session" as const })) : undefined }
        : { behavior: "deny", message: a.message || "The user denied this." });
    }
    this.n.touch(item);
    this.schedule();
  }

  private denyAll(message: string) {
    for (const [id, p] of this.pending) {
      const item = this.n.get(id);
      if (item?.kind === "permission") item.state = "denied";
      if (item?.kind === "question") item.state = "skipped";
      if (item) this.n.touch(item);
      p.resolve({ behavior: "deny", message, interrupt: true });
    }
    this.pending.clear();
  }

  async interrupt() {
    this.queued = [];
    this.changed();
    this.denyAll("Interrupted by the user");
    await this.q?.interrupt().catch(() => {});
  }

  // Flag settings reach a running CLI now and a later one at its start.
  private async flag(settings: Record<string, unknown>) {
    this.options.flags = { ...this.options.flags, ...settings };
    await this.q?.applyFlagSettings(settings as any).catch(() => {});
  }

  async set(s: { mode?: string; model?: string; effort?: string; worktree?: boolean; ultracode?: boolean; fast?: boolean }) {
    if (s.mode) {
      this.options.permissionMode = s.mode;
      await this.q?.setPermissionMode(s.mode as any).catch(() => {});
      this.n.setState({ mode: s.mode });
    }
    if (s.model) {
      this.options.model = s.model;
      await this.q?.setModel(s.model).catch(() => {});
      this.n.setState({ model: s.model });
    }
    if (s.effort) {
      this.options.effort = s.effort;
      // Without the ultracode key, changing the level would turn ultracode off.
      await this.flag({ effortLevel: s.effort, ultracode: this.state.ultracode });
      this.n.setState({ effort: s.effort });
    }
    if (typeof s.ultracode === "boolean") {
      await this.flag({ ultracode: s.ultracode });
      this.n.setState({ ultracode: s.ultracode });
    }
    if (typeof s.fast === "boolean") {
      await this.flag({ fastMode: s.fast });
      this.n.setState({ fast: s.fast });
    }
    if (typeof s.worktree === "boolean" && !this.q && !this.state.session) this.n.setState({ worktree: s.worktree });
    this.schedule();
  }

  close() {
    this.denyAll("Session closed");
    this.box.close();
    this.q?.close();
  }
}

