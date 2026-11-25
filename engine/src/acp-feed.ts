import type { Item, ItemOf, Model, State, ToolStatus } from "./items";
import type { Normalizer } from "./normalizer";
import { describe } from "./tools";

type Msg = Record<string, any>;

const RESULT_LIMIT = 4000;
const HIDDEN = new Set(["ask_question"]);

// Antigravity's mode names, keyed by the Claude Code names the pane uses.
export const MODES: Record<string, string> = { default: "default", acceptEdits: "accept-edits", plan: "plan", auto: "auto" };
export const modeOf = (agy: string) => Object.entries(MODES).find(([, v]) => v === agy)?.[0] ?? agy;

const STATUS: Record<string, ToolStatus> = { pending: "running", in_progress: "running", completed: "ok", failed: "error" };

// agy tools as the Claude tools the pane already knows how to draw.
export function asClaudeTool(u: Msg): { name: string; input: Msg } {
  const a: Msg = u.args ?? u.rawInput ?? {};
  const path = a.Path ?? a.AbsolutePath ?? a.TargetFile ?? u.locations?.[0]?.path;
  const diff = (u.content ?? []).find((c: Msg) => c?.type === "diff");
  switch (u.name) {
    case "run_command": return { name: "Bash", input: { command: a.CommandLine ?? u.title, description: a.toolSummary } };
    case "read_file":
    case "view_file": return { name: "Read", input: { file_path: path } };
    case "write_file": return { name: "Write", input: { file_path: path, content: a.Content ?? diff?.newText ?? "" } };
    case "edit_file": return { name: "Edit", input: { file_path: path, old_string: diff?.oldText ?? a.Target ?? "", new_string: diff?.newText ?? a.Replacement ?? "" } };
    case "update_steps": return { name: "TodoWrite", input: { todos: (a.steps ?? []).map((s: Msg) => ({ content: s.title ?? s.description ?? "", status: s.status })) } };
  }
  switch (u.kind) {
    case "read": if (path) return { name: "Read", input: { file_path: path } }; break;
    case "edit": if (path) return diff?.oldText == null
      ? { name: "Write", input: { file_path: path, content: diff?.newText ?? "" } }
      : { name: "Edit", input: { file_path: path, old_string: diff.oldText, new_string: diff.newText ?? "" } };
      break;
    case "execute": return { name: "Bash", input: { command: a.CommandLine ?? u.title } };
    case "fetch": return { name: "WebFetch", input: { url: a.Url ?? a.url ?? u.title } };
    case "search": return { name: "Grep", input: { pattern: a.Query ?? a.Pattern ?? u.title, path } };
  }
  return { name: u.name ?? "tool", input: a };
}

function resultOf(u: Msg): string | undefined {
  const out = u.rawOutput?.output;
  const text = typeof out === "string" ? out
    : (u.content ?? []).filter((c: Msg) => c?.type === "content" && c.content?.type === "text").map((c: Msg) => c.content.text).join("\n");
  if (!text) return undefined;
  const at = text.indexOf("Command output:\n");
  return (at >= 0 ? text.slice(at + 16) : text).replace(/\r\n/g, "\n").trimEnd().slice(0, RESULT_LIMIT);
}

export function modelsOf(options: Msg[]): { models: Model[]; model?: string; effort?: string | null } {
  const model = options.find((o) => o.id === "model");
  const effort = options.find((o) => o.id === "thought_level");
  const efforts: string[] = (effort?.options ?? []).map((o: Msg) => o.value);
  const models = (model?.options ?? []).map((o: Msg) => ({ value: o.value, name: o.name, description: o.description ?? "", efforts, resolved: o.value, fast: false }));
  return { models, model: model?.currentValue, effort: effort?.currentValue ?? null };
}

// Turns `session/update`s into the pane's items, the way Normalizer does for the Agent SDK.
export class AcpFeed {
  private last: ItemOf<"text"> | ItemOf<"thinking"> | null = null;
  private user: ItemOf<"user"> | null = null;
  private n = 0;
  private thinkingStart = 0;

  constructor(private nz: Normalizer, private prefix: string, private others: () => Model[] = () => []) {}

  private id() {
    return `${this.prefix}:${++this.n}`;
  }

  // Ends streaming rows; the next chunk of any kind starts a new one.
  settle() {
    if (this.last) {
      this.last.streaming = false;
      if (this.last.kind === "thinking") this.last.ms = Date.now() - this.thinkingStart;
      this.nz.touch(this.last);
    }
    this.last = null;
    this.user = null;
  }

  feed(u: Msg, replay = false) {
    switch (u.sessionUpdate) {
      case "user_message_chunk": {
        if (!replay) return;
        this.settle();
        const text = u.content?.type === "text" ? u.content.text : "";
        const images = u.content?.type === "image" ? [{ type: u.content.mimeType, data: u.content.data }] : [];
        if (this.user) {
          this.user.text += text;
          this.user.images.push(...images);
          this.nz.touch(this.user);
        } else this.user = this.nz.upsert({ id: this.id(), kind: "user", text, images }) as ItemOf<"user">;
        return;
      }
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        this.user = null;
        const kind = u.sessionUpdate === "agent_message_chunk" ? "text" : "thinking";
        const text = u.content?.type === "text" ? u.content.text : "";
        if (this.last?.kind !== kind) {
          this.settle();
          if (kind === "thinking") this.thinkingStart = Date.now();
          this.last = this.nz.upsert({ id: this.id(), kind, text: "", streaming: !replay } as Item) as ItemOf<"text"> | ItemOf<"thinking">;
        }
        this.last.text += text;
        this.nz.touch(this.last);
        return;
      }
      case "tool_call":
      case "tool_call_update":
        return this.tool(u);
      case "usage_update":
        if (!replay) this.nz.setState({ context: { used: u.used ?? 0, max: u.size ?? this.nz.state.context.max } });
        return;
      case "session_info_update":
        if (u.title) this.nz.setState({ title: u.title });
        return;
      case "available_commands_update":
        return this.nz.setState({ commands: (u.availableCommands ?? []).map((c: Msg) => ({ name: c.name, description: c.description ?? "", hint: c.input?.hint ?? "" })) });
      case "current_mode_update":
        return this.nz.setState({ mode: modeOf(u.currentModeId) });
      case "config_option_update":
        return this.config(u.configOptions ?? []);
    }
  }

  config(options: Msg[]) {
    const { models, model, effort } = modelsOf(options);
    const patch: Partial<State> = {};
    if (models.length) patch.models = [...models.map((m) => ({ ...m, backend: "agy" })), ...this.others()];
    if (model) patch.model = model;
    if (effort !== undefined) patch.effort = effort;
    this.nz.setState(patch);
  }

  private tool(u: Msg) {
    const id = u.toolCallId;
    if (!id) return;
    if (HIDDEN.has(u.name)) return;
    this.settle();
    const { name, input } = asClaudeTool(u);
    const d = describe(name, input, this.nz.cwd);
    const status = STATUS[u.status] ?? "running";
    const old = this.nz.get(id);
    const done = status === "ok" || status === "error";
    const item: ItemOf<"tool"> = old?.kind === "tool" ? old : { id, kind: "tool", name, verb: d.running, meta: d.meta, status };
    Object.assign(item, { name, meta: d.meta, detail: d.detail, path: d.path, verb: done ? d.done : d.running });
    // A row waiting on a permission card keeps its status until the card is answered.
    if (item.status !== "waiting" || done) item.status = status;
    const exit = u.rawOutput?.exit_code;
    if (status === "ok" && typeof exit === "number" && exit !== 0) item.status = "error";
    const result = resultOf(u);
    if (result !== undefined) item.result = result;
    this.nz.upsert(item);
  }

  // A turn's end: anything still running finished with it.
  end(ms: number, stopReason: string | undefined, error?: string) {
    this.settle();
    for (const item of this.nz.items) {
      if (item.kind === "tool" && (item.status === "running" || item.status === "waiting")) {
        item.status = stopReason === "end_turn" ? "ok" : "error";
        this.nz.touch(item);
      }
    }
    if (stopReason === "cancelled") this.nz.notice("info", "Interrupted");
    const reason = error ?? (stopReason && !["end_turn", "cancelled"].includes(stopReason) ? stopReason.replace(/_/g, " ") : undefined);
    this.nz.upsert({ id: this.id(), kind: "turn_end", ms, error: reason });
  }
}
