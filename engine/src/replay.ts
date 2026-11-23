import { readFileSync } from "node:fs";
import { Session } from "./session";
import type { McpServer } from "./items";

const STREAM_MS = 12;
const STEP_MS = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Plays a recorded session for every prompt, so UI work costs no usage.
export class ReplaySession extends Session {
  static fixture = "";
  private round = 0;

  override async load() {
    this.n.state.commands = [
      { name: "compact", description: "Clear history but keep a summary in context", hint: "<instructions>" },
      { name: "context", description: "Show current context usage", hint: "" },
      { name: "review", description: "Review a pull request", hint: "<pr>" },
      { name: "init", description: "Initialize a CLAUDE.md file", hint: "" },
      { name: "model", description: "Set the AI model", hint: "<model>" },
      { name: "commit", description: "Create a git commit", hint: "" },
    ];
    this.n.state.models = [
      { value: "default", name: "Default (recommended)", description: "Opus 5.5 for complex work", efforts: ["low", "medium", "high", "xhigh", "max"], resolved: "claude-opus-5-5", fast: true },
      { value: "opus", name: "Opus 5.5", description: "For complex work and everyday tasks", efforts: ["low", "medium", "high", "xhigh", "max"], resolved: "claude-opus-5-5", fast: true },
      { value: "fable", name: "Fable 5.2", description: "For your toughest challenges", efforts: ["low", "medium", "high", "xhigh", "max"], resolved: "claude-fable-5-2", fast: true },
      { value: "sonnet", name: "Sonnet 5.5", description: "Most efficient for simpler tasks", efforts: ["low", "medium", "high", "xhigh", "max"], resolved: "claude-sonnet-5-5", fast: false },
      { value: "haiku", name: "Haiku 5.5", description: "Fastest for quick answers", efforts: ["low", "medium", "high", "xhigh", "max"], resolved: "claude-haiku-5-5", fast: false },
      { value: "claude-opus-4-8", name: "Opus 4.8", description: "Best for everyday, complex tasks", efforts: ["low", "medium", "high", "xhigh", "max"], resolved: "claude-opus-4-8", fast: true },
      { value: "claude-haiku-4-5-20251001", name: "Haiku 4.5", description: "Fastest for quick answers", efforts: [], resolved: "claude-haiku-4-5-20251001", fast: false },
    ];
    await super.load();
  }

  protected override async usage() {
    const categories = [
      { id: "messages", name: "Messages", tokens: 41200, kind: "used" },
      { id: "mcp_tools", name: "MCP tools", tokens: 9800, kind: "used" },
      { id: "system_tools", name: "System tools", tokens: 17800, kind: "used" },
      { id: "skills", name: "Skills", tokens: 4100, kind: "used" },
      { id: "system_prompt", name: "System prompt", tokens: 9200, kind: "used" },
      { id: "memory_files", name: "Memory files", tokens: 4600, kind: "used" },
      { id: "autocompact_buffer", name: "Autocompact buffer", tokens: 33000, kind: "buffer" },
      { id: "free_space", name: "Free space", tokens: 280300, kind: "free" },
    ];
    this.n.setState({ usage: { total: 86700, max: 400000, categories }, context: { used: 86700, max: 400000 } });
    this.schedule();
  }

  private fake: McpServer[] = [
    { name: "logfire", label: "logfire", status: "connected", error: null, tools: 3, scope: "user", source: "user", version: "1.4.0", transport: "http", target: "https://logfire-eu.pydantic.dev/mcp" },
    { name: "claude.ai Slack", label: "Slack", status: "connected", error: null, tools: 27, scope: "claudeai" },
    { name: "claude.ai Gmail", label: "Gmail", status: "needs-auth", error: null, tools: 0, scope: "claudeai" },
    { name: "plugin:data:hex", label: "hex", status: "needs-auth", error: null, tools: 0, scope: "dynamic" },
    { name: "plugin:data:definite", label: "definite", status: "failed", error: "MCP endpoint not found at https://api.definite.app", tools: 0, scope: "dynamic" },
    { name: "pencil", label: "pencil", status: "disabled", error: null, tools: 0, scope: "user", source: "user", version: null, transport: "stdio", target: "pencil mcp --stdio" },
  ];

  override async remote(enabled: boolean) {
    this.wantRemote = enabled;
    this.n.setState({ remote: enabled ? "https://claude.ai/code/session_replay" : null });
    this.schedule();
  }

  override async servers() {
    return this.fake;
  }

  override async tools(server: string) {
    return server === "logfire" ? [
      { name: "query_run", description: "Run SQL against your telemetry data.", readOnly: true, destructive: false },
      { name: "alert_create", description: "Create an SQL-based alert.", readOnly: false, destructive: false },
      { name: "dashboard_delete", description: "Delete a dashboard.", readOnly: false, destructive: true },
    ] : [];
  }

  override async mcpAction(server: string, action: string) {
    const m = this.fake.find((x) => x.name === server);
    if (!m) return;
    m.status = action === "disable" ? "disabled" : action === "signout" ? "needs-auth" : "connected";
    m.tools = m.status === "connected" ? 12 : 0;
    m.error = null;
  }

  protected override async warm() {}

  protected override start() {
    const lines = readFileSync(ReplaySession.fixture, "utf8").split("\n").filter(Boolean);
    const r = ++this.round;
    (async () => {
      for (const line of lines) {
        const msg = JSON.parse(line.replace(/"((?:toolu|msg|call)_[A-Za-z0-9]+)"/g, `"$1_r${r}"`).replace(/"uuid":"([^"]+)"/g, `"uuid":"$1-r${r}"`));
        if (msg.type === "_ask") {
          await this.ask(msg.tool, msg.input, msg.toolUseID, msg.suggestions);
          continue;
        }
        if (msg.type === "system" && msg.subtype === "init") msg.session_id = this.state.session ?? `replay-${this.key}`;
        await sleep(msg.type === "stream_event" ? STREAM_MS : STEP_MS);
        this.receive(msg);
      }
      this.n.setState({ busy: false });
      this.schedule();
    })();
  }
}
