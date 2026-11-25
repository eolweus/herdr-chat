import { query, type HookCallback, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { Normalizer } from "./normalizer";
import { inbox } from "./session";

const READ = new Set(["Read", "Grep", "Glob", "ToolSearch"]);
const CLAUDE = Bun.which("claude") ?? `${process.env.HOME}/.local/bin/claude`;
const FLUSH_MS = 50;

const REMINDER = `<system-reminder>
You are running in a side chat — a lightweight fork of the main conversation. The main agent continues independently; nothing you say here lands in the main transcript. The main conversation's tools are still listed, but here only Read, Grep, Glob and ToolSearch run; any other call is refused, so don't make one. Answer questions, don't take actions. The user may ask follow-ups.
</system-reminder>`;

const refuse: HookCallback = async (input) => {
  const tool = (input as { tool_name?: string }).tool_name ?? "";
  if (READ.has(tool)) return { continue: true };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${tool} isn't available in a side chat; only Read, Grep and Glob are.` } };
};

// The parent's id, model and effort; nothing of the side chat is saved or reported to the sidebar.
export type Parent = { session: string; cwd: string; model?: string; effort?: string };

export class SideChat {
  n: Normalizer;
  private q: Query | null = null;
  private box = inbox<SDKUserMessage>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private parent: Parent, private emit: (o: unknown) => void) {
    this.n = new Normalizer(parent.cwd);
  }

  snapshot() {
    return { items: this.n.items, busy: this.n.state.busy, status: this.n.state.status };
  }

  ask(text: string) {
    const id = randomUUID();
    this.n.upsert({ id, kind: "user", text, images: [] });
    this.n.setState({ busy: true });
    this.box.push({ type: "user", message: { role: "user", content: `${REMINDER}\n\n${text}` }, parent_tool_use_id: null, uuid: id as `${string}-${string}-${string}-${string}-${string}` });
    if (!this.q) this.start();
    this.schedule();
  }

  // The same settings, tools and history as the parent, so the fork reads the parent's prompt cache.
  private start() {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("HERDR_")) delete env[k];
    const q = query({
      prompt: this.box.iter,
      options: {
        cwd: this.parent.cwd,
        env,
        resume: this.parent.session,
        forkSession: true,
        persistSession: false,
        pathToClaudeCodeExecutable: CLAUDE,
        includePartialMessages: true,
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code" },
        extraArgs: { chrome: null },
        model: this.parent.model || undefined,
        effort: this.parent.effort as any,
        permissionMode: "default",
        hooks: { PreToolUse: [{ hooks: [refuse] }] },
        canUseTool: async (tool, input) => READ.has(tool) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: `${tool} isn't available in a side chat.` },
      } as Options,
    });
    this.q = q;
    (async () => {
      try {
        for await (const msg of q) {
          // Only this turn's messages: the resumed history is the parent's.
          if (msg.type === "user" && (msg as { isReplay?: boolean }).isReplay) continue;
          this.n.feed(msg);
          this.schedule();
        }
      } catch (e) {
        if (this.q === q) this.n.notice("error", String(e instanceof Error ? e.message : e));
      } finally {
        if (this.q === q) this.q = null;
        this.box.close();
        this.box = inbox();
        this.n.setState({ busy: false, status: null });
        this.schedule();
      }
    })();
  }

  private schedule() {
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush() {
    this.timer = null;
    for (const id of this.n.dirty) {
      const item = this.n.get(id);
      if (item) this.emit({ type: "side_upsert", item });
    }
    this.n.dirty.clear();
    if (this.n.stateDirty) {
      this.n.stateDirty = false;
      this.emit({ type: "side_state", busy: this.n.state.busy, status: this.n.state.status });
    }
  }

  async interrupt() {
    await this.q?.interrupt().catch(() => {});
  }

  close() {
    const q = this.q;
    this.q = null;
    this.box.close();
    q?.close();
    if (this.timer) clearTimeout(this.timer);
  }
}
