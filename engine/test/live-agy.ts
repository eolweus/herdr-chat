// Drives a test engine like a pane would: bun test/live-agy.ts <port> <key> <cwd> [prompt...]
// Permission cards are allowed for the session; prints rows as they settle.
import { readFileSync } from "node:fs";

const [port, key, cwd, ...prompts] = process.argv.slice(2);
const token = readFileSync(`${process.env.HOME}/.config/herdr-chat/token`, "utf8").trim();
const ws = new WebSocket(`ws://127.0.0.1:${port}`);
const items = new Map<string, any>();
let state: any = {};
let idle: (() => void) | null = null;
const send = (o: unknown) => ws.send(JSON.stringify(o));
const line = (i: any) => {
  if (i.kind === "tool") return `tool ${i.name} [${i.status}] ${i.verb} ${i.meta}${i.result ? ` => ${String(i.result).split("\n")[0]!.slice(0, 60)}` : ""}`;
  if (i.kind === "text" || i.kind === "thinking") return `${i.kind}${i.streaming ? "…" : ""} ${i.text.replace(/\s+/g, " ").slice(0, 100)}`;
  if (i.kind === "permission") return `permission [${i.state}] ${i.verb} ${i.meta}`;
  if (i.kind === "user") return `user ${i.text.slice(0, 80)}`;
  if (i.kind === "turn_end") return `turn_end ${i.ms}ms${i.error ? ` error=${i.error}` : ""}`;
  return `${i.kind} ${i.text ?? ""}`;
};

ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.type === "snapshot") {
    for (const i of m.items) items.set(i.id, i);
    state = m.state;
    console.log(`snapshot: ${m.items.length} items, backend=${m.state.backend} session=${m.state.session} model=${m.state.model} effort=${m.state.effort} mode=${m.state.mode} models=${m.state.models.length}`);
    for (const i of m.items) console.log("  " + line(i));
  } else if (m.type === "upsert") {
    const i = m.item;
    items.set(i.id, i);
    if (i.kind === "permission" && i.state === "pending") {
      console.log("  " + line(i));
      send({ type: "answer", item: i.id, decision: "once" });
    } else if (!((i.kind === "text" || i.kind === "thinking") && i.streaming) && !(i.kind === "tool" && i.status === "running")) console.log("  " + line(i));
  } else if (m.type === "state") {
    const was = state.busy;
    state = m.state;
    if (was && !state.busy) idle?.();
  } else if (m.type === "sessions") console.log("sessions:", m.sessions.map((s: any) => `${s.title} (${s.id.slice(0, 8)})`).join(", "));
  else if (m.type === "error") console.log("ERROR:", m.message);
  else console.log(m.type);
};

await new Promise((r) => (ws.onopen = r));
send({ type: "hello", v: 3, token });
send({ type: "open", key, cwd, backend: "agy" });
await Bun.sleep(1500);
for (const p of prompts) {
  if (p.startsWith("!set ")) { const [k, v] = p.slice(5).split("="); send({ type: "set", [k!]: v }); await Bun.sleep(1500); console.log(`set ${k}=${v} -> model=${state.model} effort=${state.effort} mode=${state.mode}`); continue; }
  if (p === "!sessions") { send({ type: "sessions" }); await Bun.sleep(3000); continue; }
  console.log(`> ${p}`);
  const done = new Promise<void>((r) => (idle = r));
  if (p.startsWith("!stop ")) {
    send({ type: "prompt", text: p.slice(6), images: [] });
    await Bun.sleep(8000);
    send({ type: "interrupt" });
  } else if (p.startsWith("!queue ")) {
    const [first, second] = p.slice(7).split("|");
    send({ type: "prompt", text: first, images: [] });
    await Bun.sleep(500);
    send({ type: "prompt", text: second, images: [] });
    await Bun.sleep(500);
    console.log(`queue: ${state.queue.map((q: any) => q.text).join(", ")}`);
    await done;
    await new Promise<void>((r) => (idle = r));
  } else send({ type: "prompt", text: p, images: [] });
  await done;
  console.log(`context ${state.context.used}/${state.context.max} title=${state.title} model=${state.model} effort=${state.effort} mode=${state.mode}`);
}
ws.close();
process.exit(0);
