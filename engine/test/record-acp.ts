// Records raw `agy acp` traffic for a list of prompts: bun test/record-acp.ts <out.jsonl> <cwd> [mode] < prompts.txt
// Prompts are separated by lines of "---". Permissions are allowed; questions get their first option.
import { appendFileSync, writeFileSync } from "node:fs";
import { AcpClient } from "../src/acp";

const [out, cwd, mode = "default"] = process.argv.slice(2);
if (!out || !cwd) throw new Error("usage: record-acp.ts <out.jsonl> <cwd> [mode]");
const prompts = (await Bun.stdin.text()).split(/^---$/m).map((p) => p.trim()).filter(Boolean);

writeFileSync(out, "");
const t0 = Date.now();
const c = new AcpClient(cwd, process.env);
c.onRaw = (dir, msg) => appendFileSync(out, JSON.stringify({ t: Date.now() - t0, dir, msg }) + "\n");
c.onUpdate = (_, u) => {
  const k = u.sessionUpdate;
  if (k === "tool_call") console.log(`  tool ${u.name} (${u.kind}) ${u.title}`);
  else if (k !== "agent_message_chunk" && k !== "agent_thought_chunk" && k !== "usage_update" && k !== "tool_call_update") console.log(`  ${k}`);
};
c.onRequest = async (method, params) => {
  console.log(`  request ${method} ${JSON.stringify(params).slice(0, 1500)}`);
  if (method === "session/request_permission") {
    const o = (params.options ?? []).find((x: any) => x.kind?.startsWith("allow")) ?? params.options?.[0];
    return { outcome: { outcome: "selected", optionId: o.optionId } };
  }
  throw new Error(`unsupported ${method}`);
};

await c.initialize();
const { sessionId } = await c.request("session/new", { cwd, mcpServers: [] });
await c.request("session/set_mode", { sessionId, modeId: mode });
for (const text of prompts) {
  console.log(`> ${text.split("\n")[0]}`);
  const r = await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  console.log(`  -> ${r.stopReason}`);
}
console.log(`session ${sessionId}`);
c.kill();
process.exit(0);
