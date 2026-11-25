import { forkSession, getSessionInfo, getSessionMessages, query, type Options, type PermissionResult, type PermissionUpdate, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { totalmem } from "node:os";
import { randomUUID } from "node:crypto";
import type { Image, Item, McpServer, McpTool, Output, State } from "./items";
import { Normalizer, commandsOf } from "./normalizer";
import { beforeCompacts, prLinks, savedImages } from "./history";
import { describe } from "./tools";
import { refreshLimits } from "./limits";
import { prsOf, reposOf } from "./changes";
import { memoryOf, type Proc, type Server } from "./memory";
import { SideChat } from "./side";

export type Client = { send(o: unknown): void };

export type HandoffKind = "once" | "orchestrated" | "standalone";
export type Report = { status: "update" | "blocked" | "done" | "failed"; note: string; at: string };
export type Handoff = { id: string; title: string | null; from: string; kind?: HandoffKind; result?: "done" | "failed" | null; report?: Report | null };

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
const IDLE_MS = 5 * 60_000, WARM_MS = 60_000;
// Like the Claude app: a CLI per 3 GB of memory, at least 6; past it, starting one stops the longest-unused idle one.
const CAP = Number(process.env.HERDR_CHAT_CAP) || Math.max(6, Math.floor(totalmem() / 3 / 1024 ** 3));
const EVICT_IDLE_MS = 60_000;
const running = new Set<Session>();
const label = (name: string) => name.split(":").pop()!.replace(/^claude\.ai /, "");

let knownCommands: State["commands"] = [];
let knownModels: State["models"] = [];
// One CLI fetches the models for every chat; after an engine restart they all load at once.
let fetchingModels = false;

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
const PAGE_ITEMS = 80, PAGE_BYTES = 1_500_000;

const EDITS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const edited = (i: Item) => i.kind === "tool" && i.status === "ok" && Boolean(i.path) && EDITS.includes(i.name);

const changesOf = (items: Item[], linked: string[]) => {
  const outputs = outputsOf(items);
  return { outputs, repos: reposOf(outputs), prs: [...new Set([...linked, ...prsOf(items)])] };
};
const ghPr = (i: Item | undefined) => i?.kind === "tool" && i.name === "Bash" && /\bgh\s+pr\b/.test(i.detail ?? "");

function outputsOf(items: Item[]): Output[] {
  const files = new Map<string, Output>();
  for (const i of items) {
    if (i.kind !== "tool" || !edited(i)) continue;
    const f = files.get(i.path!) ?? { path: i.path!, name: i.meta ?? i.path!, created: i.name === "Write", add: 0, del: 0 };
    for (const l of (i.detail ?? "").split("\n")) {
      if (l.startsWith("+")) f.add++;
      else if (l.startsWith("-")) f.del++;
    }
    files.delete(i.path!);
    files.set(i.path!, f);
  }
  return [...files.values()].reverse();
}

// A message that starts with quotes (the desktop app's reply format) is named by what follows them.
const unquoted = (text: string) => {
  if (!text.startsWith("<!-- reply")) return text;
  const at = text.indexOf("\n\n\n");
  return at >= 0 ? text.slice(at + 3) : text.split("\n").find((l) => l.startsWith(">"))?.replace(/^> ?/, "") ?? text;
};

const firstOf = (items: Item[]) => {
  const u = items.find((i) => i.kind === "user" && !/^(<!-- herdr-chat:run -->|I ran:\n```sh\n)/.test(i.text ?? "") && !(i.text ?? "").slice(0, 300).includes("This session is being continued"));
  return u?.kind === "user" ? unquoted(u.text).split("\n")[0]!.slice(0, 200) : null;
};

const KEEP_IMAGES = 20;

// Image data stays here; panes ask for it with { type: "image" } when it's on screen.
const wire = (item: Item): Item => {
  const images = (item as { images?: Image[] }).images;
  return images?.length ? { ...item, images: images.map((img) => ({ type: img.type, data: "" })) } as Item : item;
};

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
  private holding: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private options: { permissionMode?: string; model?: string; effort?: string; flags?: Record<string, unknown> } = {};
  private loaded = false;
  handoff: Handoff | null = null;
  // Told to Claude with the next message, e.g. that the session moved machines.
  preamble: string | null = null;

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
    if (!id) {
      if (this.needsModels()) this.warm();
      return;
    }
    this.title();
    try {
      const later = await getSessionMessages(id, { dir: this.cwd, includeSystemMessages: true });
      for (const m of [...await beforeCompacts(id, later).catch(() => []), ...later]) this.n.feed({ ...m, isReplay: true });
      this.n.setState({ ...changesOf(this.n.items, this.linked), first: firstOf(this.n.items) });
      this.linkPrs();
      this.dropImages(this.n.items.map((i) => i.id));
      // Panes get these in the snapshot; sent as updates too, each would be drawn on its own.
      this.n.dirty.clear();
    } catch (e) {
      this.n.notice("error", `Couldn't load the earlier conversation: ${e}`);
    }
    if (this.needsModels() || this.viewers.size) this.warm();
  }

  // A reopened session (after an engine restart, say) would otherwise wait for its next message to start
  // the CLI, and until then has no models, commands or context to show.
  protected async warm() {
    if (this.q) return;
    this.start();
    await this.loadCommands();
    fetchingModels = false;
    await this.usage();
    await this.mcp();
    this.rest(WARM_MS);
  }

  private resting: ReturnType<typeof setTimeout> | null = null;
  private rested: Query | null = null;

  // A resumed CLI picks up where this one stopped, so an idle chat needn't keep its CLI and MCP servers running.
  protected rest(ms = IDLE_MS) {
    if (this.resting) clearTimeout(this.resting);
    this.resting = setTimeout(() => {
      this.resting = null;
      if (!this.held()) this.stop();
    }, ms);
  }

  // What keeps a CLI running past the idle timer and the cap.
  held() {
    return this.state.busy || this.pending.size > 0 || this.queued.length > 0 || this.wantRemote || this.state.tasks.length > 0 || this.viewers.size > 0;
  }

  private stop() {
    if (!this.q) return;
    this.rested = this.q;
    this.q.close();
  }

  private needsModels() {
    if (knownModels.length || fetchingModels) return false;
    fetchingModels = true;
    return true;
  }

  lastUsed = Date.now();
  private viewers = new Set<Client>();

  view(c: Client, on: boolean) {
    this.lastUsed = Date.now();
    if (on === this.viewers.has(c)) return;
    if (on) this.viewers.add(c);
    else this.viewers.delete(c);
    if (on && !this.q && this.loaded) this.warm();
    if (!this.viewers.size) this.rest();
  }

  private makeRoom() {
    if (running.size < CAP) return;
    const idle = [...running].filter((s) => s !== this && !s.held() && Date.now() - s.lastUsed >= EVICT_IDLE_MS);
    const victim = idle.sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim) return;
    console.log(`${running.size} CLIs running (cap ${CAP}); stopping ${victim.key}, unused for ${Math.round((Date.now() - victim.lastUsed) / 1000)}s`);
    victim.stop();
  }

  // summary falls back to the latest prompt, and a long transcript's name can be beyond the SDK's read, so keep the last name.
  protected async title() {
    const id = this.state.session;
    if (!id) return;
    const info = await getSessionInfo(id, { dir: this.cwd }).catch(() => undefined);
    const title = info?.customTitle ?? null;
    if (title && title !== this.state.title) { this.n.setState({ title }); this.onSession(this); }
  }

  // Panes get the newest items and page in older ones as they scroll, and images only when shown:
  // Herdr's websocket drops messages over about 8 MB, and Read screenshots make long chats bigger than that.
  snapshot() {
    const { items, older } = this.page(this.n.items.length);
    return { type: "snapshot", items, older, state: this.state, cwd: this.cwd, handoff: this.handoff, side: this.side?.snapshot() ?? null };
  }

  page(end: number) {
    const items: Item[] = [];
    let size = 0, i = end;
    while (i > 0 && items.length < PAGE_ITEMS) {
      const item = wire(this.n.items[i - 1]!);
      size += JSON.stringify(item).length;
      if (size > PAGE_BYTES && items.length) break;
      items.unshift(item);
      i--;
    }
    return { items, older: i };
  }

  older(before: string) {
    const end = this.n.items.findIndex((i) => i.id === before);
    return { type: "older", before, ...(end < 0 ? { items: [], older: false } : this.page(end)) };
  }

  async image(id: string, i: number) {
    let img = (this.n.get(id) as { images?: Image[] } | undefined)?.images?.[i];
    if (img && !img.data && this.state.session) img = (await savedImages(this.state.session, id).catch(() => null))?.[i] ?? img;
    return { type: "image", item: id, i, mime: img?.type ?? null, data: img?.data || null };
  }

  // Image data is the bulk of a long chat; the transcript keeps it, so only the newest stay in memory.
  private dropImages(ids: Iterable<string>) {
    for (const id of ids) {
      const images = (this.n.get(id) as { images?: Image[] } | undefined)?.images;
      if (!images?.some((img) => img.data)) continue;
      this.holding = this.holding.filter((x) => x !== id);
      this.holding.push(id);
    }
    while (this.holding.length > KEEP_IMAGES) {
      const images = (this.n.get(this.holding.shift()!) as { images?: Image[] } | undefined)?.images;
      for (const img of images ?? []) img.data = "";
    }
  }

  sendSnapshot(c: Client) {
    c.send(this.snapshot());
  }

  get activity(): "blocked" | "working" | "idle" {
    return this.pending.size ? "blocked" : this.state.busy || this.queued.length ? "working" : "idle";
  }

  attach(c: Client) {
    this.clients.add(c);
    this.sendSnapshot(c);
  }

  detach(c: Client) {
    this.clients.delete(c);
    if (!this.clients.size) this.closeSide();
    if (this.viewers.delete(c) && !this.viewers.size) this.rest();
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
    const changed = ids.map((id) => this.n.get(id));
    if (changed.some((i) => i && (edited(i) || ghPr(i)))) this.n.setState(changesOf(this.n.items, this.linked));
    if (!this.state.first && changed.some((i) => i?.kind === "user")) this.n.setState({ first: firstOf(this.n.items) });
    for (const id of ids) {
      const item = this.n.get(id);
      if (item) this.broadcast({ type: "upsert", item: wire(item) });
    }
    this.dropImages(ids);
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

  // Stops the running turn; the turn's result then sends the queue's front, which this one now is.
  async sendNow(id: string) {
    const entry = this.queued.find((q) => q.id === id);
    if (!entry) return;
    this.queued = [entry, ...this.queued.filter((q) => q !== entry)];
    this.changed();
    if (!this.state.busy || !this.q) {
      this.queued.shift();
      this.send(entry);
      return this.changed();
    }
    this.denyAll("Interrupted by the user");
    await this.q.interrupt().catch(() => {});
  }

  unqueue(id: string) {
    this.queued = this.queued.filter((q) => q.id !== id);
    this.changed();
  }

  protected send({ id, text, images }: { id: string; text: string; images: Image[] }) {
    this.lastUsed = Date.now();
    this.n.upsert({ id, kind: "user", text, images });
    this.n.setState({ busy: true });
    const said = this.preamble ? `${this.preamble}\n\n${text}` : text;
    if (this.preamble) { this.preamble = null; this.onSession(this); }
    const content = [
      ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.type as "image/png", data: i.data } })),
      ...(said ? [{ type: "text" as const, text: said }] : []),
    ];
    this.box.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid: id as `${string}-${string}-${string}-${string}-${string}` });
    if (!this.q) this.start();
  }

  protected start() {
    this.makeRoom();
    running.add(this);
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
        extraArgs: { "replay-user-messages": null, chrome: null, ...(this.state.worktree && !this.state.session ? { worktree: null } : {}) },
        effort: this.options.effort as any,
        permissionMode: this.options.permissionMode as any,
        model: this.options.model,
        enableFileCheckpointing: true,
        canUseTool: (tool, input, opts) => this.ask(tool, input, opts.toolUseID, opts.suggestions, opts.signal),
        // Not in the SDK's types, but its local spawn calls it.
        onProcessSpawned: (pid: number) => { this.pid = pid; },
      } as Options,
    });
    this.q = q;
    if (this.options.flags) q.applyFlagSettings(this.options.flags as any).catch(() => {});
    (async () => {
      try {
        for await (const msg of q) this.receive(msg);
      } catch (e) {
        if (this.rested !== q) this.n.notice("error", String(e instanceof Error ? e.message : e));
      } finally {
        if (this.q === q) { this.q = null; running.delete(this); }
        this.box.close();
        this.box = inbox();
        this.denyAll("Claude stopped");
        this.pid = null;
        this.n.setState({ busy: false, status: null, remote: null, tasks: [], memory: null });
        this.schedule();
      }
    })();
  }

  private linked: string[] = [];

  private async linkPrs() {
    const id = this.state.session;
    if (!id) return;
    const linked = await prLinks(id).catch(() => [] as string[]);
    if (linked.join() === this.linked.join()) return;
    this.linked = linked;
    this.n.setState(changesOf(this.n.items, linked));
    this.changed();
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
      for (const c of this.clients) this.sendSnapshot(c);
    }
    if (msg.type === "system" && msg.subtype === "init") {
      this.loadCommands();
      this.mcp();
      if (this.wantRemote && !this.state.remote) this.remote(true).catch(() => {});
    }
    if (msg.type === "system" && msg.subtype === "commands_changed") knownCommands = this.state.commands;
    if (msg.type === "system" && msg.subtype === "background_tasks_changed") this.rest();
    if (this.state.session !== before) this.onSession(this);
    if (msg.type === "result") {
      this.usage();
      if (this.q) refreshLimits(this.q);
      this.mcp();
      this.title();
      setTimeout(() => this.title(), 8000);
      this.linkPrs();
      this.lastUsed = Date.now();
      this.rest();
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
    this.launched = list.map((m) => {
      const c = (m.config ?? {}) as { command?: string; args?: string[] };
      return { name: label(m.name), command: c.command ?? "", args: c.args ?? [] };
    }).filter((s) => s.command);
    this.n.setState({ mcp: list.filter((m) => m.status === "needs-auth").map((m) => ({ name: m.name, label: label(m.name) })) });
    this.schedule();
  }

  pid: number | null = null;
  private launched: Server[] = [];

  measure(procs: Proc[]) {
    const memory = this.pid ? memoryOf(this.pid, procs, this.launched) : null;
    if (JSON.stringify(memory) === JSON.stringify(this.state.memory)) return;
    this.n.setState({ memory });
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
    if (!enabled) this.rest();
  }

  protected async ready() {
    if (!this.q) this.start();
    this.rest();
    await this.q!.initializationResult();
  }

  async servers(): Promise<McpServer[]> {
    await this.ready();
    const list = await this.q!.mcpServerStatus();
    this.n.setState({ mcp: list.filter((m) => m.status === "needs-auth").map((m) => ({ name: m.name, label: label(m.name) })) });
    this.schedule();
    return list.map((m) => {
      const c = (m.config ?? {}) as { type?: string; url?: string; command?: string; args?: string[] };
      return {
        name: m.name, label: label(m.name), status: m.status, error: m.error ?? null, tools: m.tools?.length ?? 0, scope: m.scope ?? null,
        source: m.source ?? null, version: m.serverInfo?.version ?? null,
        transport: c.type ?? (c.command ? "stdio" : null), target: c.url ?? (c.command ? [c.command, ...(c.args ?? [])].join(" ") : null),
      };
    });
  }

  async tools(server: string): Promise<McpTool[]> {
    await this.ready();
    const m = (await this.q!.mcpServerStatus()).find((x) => x.name === server);
    return (m?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "", readOnly: Boolean(t.annotations?.readOnly), destructive: Boolean(t.annotations?.destructive) }));
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
      if (!this.state.model && u.model) this.n.setState({ model: u.model });
      this.n.setState({
        usage: { total: u.totalTokens, max: u.maxTokens, categories: u.categories.map(({ id, name, tokens, kind }) => ({ id, name, tokens, kind })) },
        context: { used: u.totalTokens, max: u.maxTokens },
      });
      this.schedule();
    } catch {}
  }

  protected ask(tool: string, input: Record<string, unknown>, toolUseID: string, suggestions?: PermissionUpdate[], signal?: AbortSignal): Promise<PermissionResult> {
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
      // Claude withdraws a prompt it settled itself (e.g. auto mode's check approving it).
      signal?.addEventListener("abort", () => this.withdraw(item.id), { once: true });
    });
  }

  private withdraw(id: string) {
    const p = this.pending.get(id);
    const item = this.n.get(id);
    if (!p || (item?.kind !== "permission" && item?.kind !== "question")) return;
    this.pending.delete(id);
    item.state = "withdrawn";
    this.n.touch(item);
    const row = p.tool ? this.n.get(p.tool) : undefined;
    if (row?.kind === "tool" && row.status === "waiting") { row.status = "running"; this.n.touch(row); }
    p.resolve({ behavior: "deny", message: "Withdrawn" });
    this.schedule();
  }

  answer(a: Answer) {
    const p = this.pending.get(a.item);
    const item = this.n.get(a.item);
    // Nothing waits on a question from an ended turn: skipping clears it, and answers go to Claude as a message.
    if (!p && (item?.kind === "question" || item?.kind === "permission") && item.state === "pending") {
      if (item.kind === "question" && a.answers) {
        Object.assign(item, { state: "answered", answers: a.answers });
        this.prompt(["My answers to your earlier questions:", ...Object.entries(a.answers).map(([q, v]) => `"${q}" = "${v}"`)].join("\n"), []);
      } else item.state = "withdrawn";
      this.n.touch(item);
      this.schedule();
      return;
    }
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

  // A copy of the conversation that ends just before message `id`, or null when that was the first message.
  async branch(id: string, sameTitle: boolean): Promise<string | null> {
    const sid = this.state.session;
    const msgs = sid ? await getSessionMessages(sid, { dir: this.cwd, includeSystemMessages: true }) : [];
    const i = msgs.findIndex((m) => m.uuid === id);
    if (i < 0) throw new Error("That message isn't in the saved conversation");
    if (i === 0) return null;
    return (await forkSession(sid!, { dir: this.cwd, upToMessageId: msgs[i - 1]!.uuid, title: sameTitle ? (this.state.title ?? undefined) : undefined })).sessionId;
  }

  // Files as they were before message `id`; only edits made while checkpointing was on can be undone.
  async restoreFiles(id: string, dryRun = false) {
    await this.ready();
    return this.q!.rewindFiles(id, { dryRun });
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

  side: SideChat | null = null;

  // A throwaway read-only fork for questions on the side; it's never saved, so nothing lists it.
  askSide(text: string) {
    if (!this.side) {
      const session = this.state.session;
      if (!session) throw new Error("Send a message in this chat first, so there's a conversation to fork");
      this.side = new SideChat({ session, cwd: this.cwd, model: this.options.model ?? (this.state.model || undefined), effort: this.options.effort ?? this.state.effort ?? undefined }, (o) => this.broadcast(o));
    }
    this.side.ask(text);
  }

  closeSide() {
    if (!this.side) return;
    this.side.close();
    this.side = null;
    this.broadcast({ type: "side_closed" });
  }

  close() {
    this.closeSide();
    this.denyAll("Session closed");
    this.box.close();
    this.q?.close();
  }
}

