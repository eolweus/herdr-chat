import { spawn, type Subprocess } from "bun";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(homedir(), ".local/state/herdr-chat/acp-probe");
const WORK = join(ROOT, "work");
const FIXTURE = join(import.meta.dir, "test/fixtures/acp-agy.jsonl");
const TURN_TIMEOUT = 180_000;

mkdirSync(WORK, { recursive: true });
if (!existsSync(join(WORK, ".git"))) Bun.spawnSync(["git", "init", "-q"], { cwd: WORK });
writeFileSync(join(WORK, "hello.txt"), "The secret word is pelican.\n");
writeFileSync(FIXTURE, "");

const t0 = Date.now();
const record = (dir: string, msg: unknown) => appendFileSync(FIXTURE, JSON.stringify({ t: Date.now() - t0, dir, msg }) + "\n");
const say = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

type Pending = { resolve: (v: any) => void; reject: (e: any) => void };
const updates: Record<string, number> = {};
const seenKeys = new Set<string>();
let permissionAnswer: "allow" | "reject" = "allow";

class Agent {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  nextId = 1;
  pending = new Map<number, Pending>();
  onUpdate: ((u: any) => void) | null = null;

  constructor() {
    this.proc = spawn(["agy", "acp"], { cwd: WORK, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.read();
    this.readErr();
  }

  async read() {
    let buf = "";
    for await (const chunk of this.proc.stdout) {
      buf += new TextDecoder().decode(chunk);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { say("non-json:", line.slice(0, 200)); continue; }
        record("in", msg);
        this.handle(msg);
      }
    }
  }

  async readErr() {
    for await (const chunk of this.proc.stderr) appendFileSync(join(ROOT, "stderr.log"), chunk);
  }

  send(msg: any) {
    record("out", msg);
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    this.proc.stdin.flush();
  }

  request(method: string, params: any, timeout = 30_000): Promise<any> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  notify(method: string, params: any) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  handle(msg: any) {
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(msg.error) : p.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      const u = msg.params?.update ?? {};
      const kind = u.sessionUpdate ?? "?";
      updates[kind] = (updates[kind] ?? 0) + 1;
      for (const k of Object.keys(u)) seenKeys.add(`${kind}.${k}`);
      this.onUpdate?.(u);
      return;
    }
    if (msg.method === "session/request_permission") {
      const opts: any[] = msg.params?.options ?? [];
      say("permission request:", msg.params?.toolCall?.title ?? msg.params?.toolCall?.toolCallId, "options:", opts.map((o) => `${o.optionId}(${o.kind})`).join(", "));
      const want = permissionAnswer === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
      const pick = opts.find((o) => o.kind === want[0]) ?? opts.find((o) => o.kind === want[1]) ?? opts[0];
      this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } } });
      return;
    }
    if (msg.id != null) {
      say("unhandled agent request:", msg.method);
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `client does not support ${msg.method}` } });
      return;
    }
    say("notification:", msg.method);
  }

  kill() {
    this.proc.kill();
  }
}

function printer() {
  let line = "";
  return (u: any) => {
    const kind = u.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const tag = kind === "agent_thought_chunk" ? "~" : ">";
      const text = u.content?.text ?? "";
      if (!line.startsWith(tag)) { if (line) console.log(line); line = tag + " "; }
      line += text.replace(/\n/g, " ");
      return;
    }
    if (line) { console.log(line.slice(0, 300)); line = ""; }
    if (kind === "tool_call") say("tool_call", u.kind ?? "", u.title ?? "", u.status ?? "");
    else if (kind === "tool_call_update") say("tool_call_update", u.toolCallId, u.status ?? "");
    else say(kind, JSON.stringify(u).slice(0, 200));
  };
}

async function prompt(agent: Agent, sessionId: string, text: string) {
  say("PROMPT:", text);
  agent.onUpdate = printer();
  const r = await agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, TURN_TIMEOUT);
  agent.onUpdate = null;
  say("prompt result:", JSON.stringify(r));
  return r;
}

async function step(name: string, fn: () => Promise<unknown>) {
  console.log(`\n=== ${name}`);
  try { await fn(); } catch (e: any) { say("FAILED:", e?.message ?? JSON.stringify(e)); }
}

const a = new Agent();
let sessionId = "";
let init: any;

await step("initialize", async () => {
  init = await a.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "herdr-chat-probe", version: "0" },
  });
  say(JSON.stringify(init, null, 1));
});

await step("session/new", async () => {
  const r = await a.request("session/new", { cwd: WORK, mcpServers: [] });
  sessionId = r.sessionId;
  say(JSON.stringify(r, null, 1).slice(0, 3000));
});

await step("set mode to default (so edits ask)", async () => {
  say(JSON.stringify(await a.request("session/set_mode", { sessionId, modeId: "default" })));
});

await step("read-only tool turn", () => prompt(a, sessionId, "Read hello.txt in the current folder and tell me the secret word. Be brief."));

await step("edit that needs approval (allowed)", () => prompt(a, sessionId, "Append the line 'probe was here' to hello.txt. Do nothing else."));

await step("edit that needs approval (rejected)", async () => {
  permissionAnswer = "reject";
  await prompt(a, sessionId, "Now delete hello.txt. If you are not allowed, just say so.");
  permissionAnswer = "allow";
});

await step("cancel mid-turn", async () => {
  const p = prompt(a, sessionId, "Run the shell command `sleep 30 && echo done` and report its output.");
  await Bun.sleep(8000);
  say("sending session/cancel");
  a.notify("session/cancel", { sessionId });
  await p;
});

await step("session/list", async () => {
  const r = await a.request("session/list", { cwd: WORK });
  say(JSON.stringify(r).slice(0, 1500));
});

a.kill();
await Bun.sleep(500);

await step("session/load in a fresh process", async () => {
  const b = new Agent();
  await b.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  let replayed = 0;
  b.onUpdate = () => replayed++;
  const r = await b.request("session/load", { sessionId, cwd: WORK, mcpServers: [] }, 60_000);
  say("load result:", JSON.stringify(r).slice(0, 1500));
  say("replayed updates:", replayed);
  b.onUpdate = null;
  await prompt(b, sessionId, "What was the secret word again? One word.");
  b.kill();
});

console.log("\n=== update kinds seen");
console.log(updates);
console.log("\n=== update fields seen");
console.log([...seenKeys].sort().join("\n"));
console.log(`\nfixture: ${FIXTURE}\nstderr: ${join(ROOT, "stderr.log")}`);
process.exit(0);
