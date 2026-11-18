import { readFileSync } from "node:fs";
import { Session } from "./session";

const STREAM_MS = 12;
const STEP_MS = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Plays a recorded session for every prompt, so UI work costs no usage.
export class ReplaySession extends Session {
  static fixture = "";
  private round = 0;

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
