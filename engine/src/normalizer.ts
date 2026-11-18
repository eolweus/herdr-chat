import type { Image, Item, ItemOf, State } from "./items";
import { describe } from "./tools";

type Msg = Record<string, any>;

const RESULT_LIMIT = 4000;
const HIDDEN_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

export function commandsOf(list: Msg[] | undefined) {
  return (list ?? []).map((c) => ({ name: c.name, description: c.description ?? "", hint: c.argumentHint ?? "" }));
}

export function newState(): State {
  return { busy: false, status: null, mode: "default", model: "", context: { used: 0, max: 0 }, queue: [], session: null, usage: null, commands: [], models: [], mcp: [] };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
}

function imagesOf(content: unknown): Image[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c?.type === "image" && c.source?.type === "base64")
    .map((c) => ({ type: c.source.media_type, data: c.source.data }));
}

// Turns the wrappers Claude Code stores around slash commands and reminders into what the user typed.
export function cleanUserText(text: string): string | null {
  const cmd = text.match(/<command-name>(.*?)<\/command-name>/s);
  if (cmd) {
    const args = text.match(/<command-args>(.*?)<\/command-args>/s)?.[1]?.trim();
    return `${cmd[1]!.trim()}${args ? " " + args : ""}`;
  }
  if (/^\s*<(local-command-|command-message|bash-|task-notification)/.test(text)) return null;
  const clean = text.replace(/<system-reminder>.*?<\/system-reminder>/gs, "").trim();
  return clean || null;
}

export class Normalizer {
  items: Item[] = [];
  state: State = newState();
  dirty = new Set<string>();
  stateDirty = false;
  private byId = new Map<string, Item>();
  private msgId = "";
  private blocks = new Map<number, Item>();
  private inputs = new Map<string, string>();
  private streamed = new Map<string, Item[]>();
  private thinkingStart = new Map<string, number>();
  private hidden = new Set<string>();
  private n = 0;

  constructor(public cwd: string) {}

  get(id: string) {
    return this.byId.get(id);
  }

  upsert(item: Item) {
    if (!this.byId.has(item.id)) this.items.push(item);
    this.byId.set(item.id, item);
    this.dirty.add(item.id);
    return item;
  }

  touch(item: Item) {
    this.dirty.add(item.id);
  }

  setState(patch: Partial<State>) {
    Object.assign(this.state, patch);
    this.stateDirty = true;
  }

  notice(level: ItemOf<"notice">["level"], text: string) {
    this.upsert({ id: `notice:${++this.n}`, kind: "notice", level, text });
  }

  feed(msg: Msg) {
    switch (msg.type) {
      case "system": return this.system(msg);
      case "stream_event": if (!msg.parent_tool_use_id) this.stream(msg.event); return;
      case "assistant": return this.assistant(msg);
      case "user": return this.user(msg);
      case "result": return this.result(msg);
    }
  }

  private system(msg: Msg) {
    switch (msg.subtype) {
      case "init":
        return this.setState({ model: msg.model, mode: msg.permissionMode, session: msg.session_id });
      case "status":
        return this.setState({ status: msg.status === "compacting" ? "Compacting" : null });
      case "commands_changed":
        return this.setState({ commands: commandsOf(msg.commands) });
      case "compact_boundary":
        return this.notice("info", "Compacted the conversation");
      case "api_retry":
        return this.notice("warning", `API error, retrying (attempt ${msg.attempt ?? "?"})`);
    }
  }

  private context(usage: Msg | undefined) {
    if (!usage) return;
    const used = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    if (used) this.setState({ context: { ...this.state.context, used } });
  }

  private stream(ev: Msg) {
    switch (ev.type) {
      case "message_start":
        this.msgId = ev.message.id;
        this.blocks.clear();
        this.context(ev.message.usage);
        return;
      case "content_block_start": {
        const b = ev.content_block;
        const id = `${this.msgId}:${ev.index}`;
        let item: Item | null = null;
        if (b.type === "text") item = { id, kind: "text", text: "", streaming: true };
        else if (b.type === "thinking") {
          item = { id, kind: "thinking", text: "", streaming: true };
          this.thinkingStart.set(id, Date.now());
        } else if (b.type === "tool_use") {
          this.inputs.set(b.id, "");
          if (HIDDEN_TOOLS.has(b.name)) this.hidden.add(b.id);
          else item = this.tool(b.id, b.name, {});
        }
        if (!item) return;
        this.blocks.set(ev.index, item);
        if (item.kind !== "tool") this.upsert(item);
        const list = this.streamed.get(this.msgId) ?? [];
        list.push(item);
        this.streamed.set(this.msgId, list);
        return;
      }
      case "content_block_delta": {
        const item = this.blocks.get(ev.index);
        const d = ev.delta;
        if (d.type === "input_json_delta") {
          const toolId = item?.kind === "tool" ? item.id : undefined;
          if (toolId) this.inputs.set(toolId, (this.inputs.get(toolId) ?? "") + d.partial_json);
          return;
        }
        if (item?.kind === "text" && d.type === "text_delta") item.text += d.text;
        else if (item?.kind === "thinking" && d.type === "thinking_delta") item.text += d.thinking;
        else return;
        this.touch(item);
        return;
      }
      case "content_block_stop": {
        const item = this.blocks.get(ev.index);
        if (!item) return;
        if (item.kind === "text") item.streaming = false;
        else if (item.kind === "thinking") {
          item.streaming = false;
          item.ms = Date.now() - (this.thinkingStart.get(item.id) ?? Date.now());
        } else if (item.kind === "tool") {
          let input = {};
          try { input = JSON.parse(this.inputs.get(item.id) || "{}"); } catch {}
          this.tool(item.id, item.name, input);
        }
        this.touch(item);
        return;
      }
    }
  }

  private tool(id: string, name: string, input: Msg, parent?: string): ItemOf<"tool"> {
    const d = describe(name, input, this.cwd);
    const existing = this.byId.get(id);
    if (existing?.kind === "tool") {
      Object.assign(existing, { meta: d.meta, detail: d.detail, path: d.path, verb: existing.status === "ok" || existing.status === "error" ? d.done : d.running });
      this.touch(existing);
      return existing;
    }
    const item: ItemOf<"tool"> = { id, kind: "tool", name, verb: d.running, meta: d.meta, detail: d.detail, path: d.path, status: "running", parent };
    if (parent) {
      const p = this.byId.get(parent);
      if (p?.kind === "tool") { p.children = (p.children ?? 0) + 1; this.touch(p); }
    }
    return this.upsert(item) as ItemOf<"tool">;
  }

  private assistant(msg: Msg) {
    const m = msg.message;
    const parent = msg.parent_tool_use_id;
    if (parent) {
      for (const b of m.content ?? []) if (b.type === "tool_use") this.tool(b.id, b.name, b.input, parent);
      return;
    }
    if (!msg.isReplay) this.context(m.usage);
    const list = this.streamed.get(m.id) ?? [];
    for (const b of m.content ?? []) {
      if (b.type === "tool_use") {
        if (b.name === "AskUserQuestion" && !this.byId.has(`q:${b.id}`)) {
          this.upsert({ id: `q:${b.id}`, kind: "question", questions: b.input?.questions ?? [], state: "pending" });
        }
        if (b.name === "ExitPlanMode" && !this.byId.has(`perm:${b.id}`)) {
          this.upsert({ id: `perm:${b.id}`, kind: "permission", tool: "ExitPlanMode", verb: "Plan", meta: "", plan: String(b.input?.plan ?? ""), remember: false, state: "pending" });
        }
        if (HIDDEN_TOOLS.has(b.name)) this.hidden.add(b.id);
        else this.tool(b.id, b.name, b.input);
        continue;
      }
      const kind = b.type === "text" ? "text" : b.type === "thinking" ? "thinking" : null;
      if (!kind) continue;
      const at = list.findIndex((i) => i.kind === kind);
      const prior = at >= 0 ? list.splice(at, 1)[0] : null;
      const text = kind === "text" ? b.text : b.thinking;
      if (prior && (prior.kind === "text" || prior.kind === "thinking")) {
        prior.text = text;
        prior.streaming = false;
        this.touch(prior);
      } else if (text || kind === "thinking") {
        this.upsert({ id: `${m.id}:h${++this.n}`, kind, text, streaming: false } as Item);
      }
    }
  }

  private user(msg: Msg) {
    if (msg.isSynthetic) return;
    const content = msg.message?.content;
    const results = Array.isArray(content) ? content.filter((c) => c?.type === "tool_result") : [];
    for (const r of results) {
      const q = this.byId.get(`q:${r.tool_use_id}`);
      if (q?.kind === "question" && q.state === "pending") {
        const answers = msg.tool_use_result?.answers;
        Object.assign(q, r.is_error || !answers ? { state: "skipped" } : { state: "answered", answers });
        this.touch(q);
      }
      const plan = this.byId.get(`perm:${r.tool_use_id}`);
      if (plan?.kind === "permission" && plan.state === "pending") {
        plan.state = r.is_error ? "denied" : "allowed";
        this.touch(plan);
      }
      if (this.hidden.has(r.tool_use_id)) continue;
      const t = this.byId.get(r.tool_use_id);
      if (t?.kind !== "tool") continue;
      const d = describe(t.name, {}, this.cwd);
      t.status = r.is_error ? "error" : "ok";
      t.verb = d.done;
      t.result = textOf(r.content).slice(0, RESULT_LIMIT);
      const images = imagesOf(r.content);
      if (images.length) t.images = images;
      this.touch(t);
    }
    if (results.length || msg.parent_tool_use_id) return;
    const raw = textOf(content);
    if (raw.startsWith("[Request interrupted by user")) return this.notice("info", "Interrupted");
    const text = cleanUserText(raw);
    const images = imagesOf(content);
    if (text === null && !images.length) return;
    this.upsert({ id: msg.uuid ?? `user:${++this.n}`, kind: "user", text: text ?? "", images });
  }

  private result(msg: Msg) {
    const max = Object.values(msg.modelUsage ?? {}).map((u: any) => u.contextWindow ?? 0).reduce((a, b) => Math.max(a, b), 0);
    this.setState({ busy: false, status: null, context: { ...this.state.context, max: max || this.state.context.max } });
    for (const item of this.items) {
      if (item.kind === "tool" && (item.status === "running" || item.status === "waiting")) {
        item.status = msg.subtype === "success" ? "ok" : "error";
        this.touch(item);
      }
    }
    const error = msg.subtype === "success" ? (msg.is_error ? textOf(msg.result) || "Error" : undefined) : msg.subtype.replace(/_/g, " ");
    this.upsert({ id: `end:${msg.uuid ?? ++this.n}`, kind: "turn_end", ms: msg.duration_ms ?? 0, error });
  }
}
