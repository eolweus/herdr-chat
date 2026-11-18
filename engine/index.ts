import { query, type SDKUserMessage, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.HERDR_CHAT_PORT ?? 7777);
const CLAUDE = Bun.which("claude") ?? undefined;

type Session = {
  push: (m: SDKUserMessage) => void;
  pending: Map<string, (r: PermissionResult) => void>;
  q?: ReturnType<typeof query>;
};

function inbox() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  async function* iter() {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      await new Promise<void>((r) => (wake = r));
    }
  }
  return {
    iter: iter(),
    push(m: SDKUserMessage) {
      queue.push(m);
      wake?.();
      wake = null;
    },
  };
}

const send = (ws: ServerWebSocket<Session>, o: unknown) => ws.send(JSON.stringify(o));

function start(ws: ServerWebSocket<Session>, cwd: string, resume?: string) {
  const box = inbox();
  ws.data.push = box.push;
  const q = query({
    prompt: box.iter,
    options: {
      cwd,
      resume,
      pathToClaudeCodeExecutable: CLAUDE,
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      canUseTool: (toolName, input, { suggestions }) =>
        new Promise((resolve) => {
          const id = crypto.randomUUID();
          ws.data.pending.set(id, resolve);
          send(ws, { type: "permission_request", id, toolName, input, suggestions });
        }),
    },
  });
  ws.data.q = q;
  (async () => {
    try {
      for await (const msg of q) send(ws, { type: "sdk", msg });
    } catch (e) {
      send(ws, { type: "error", message: String(e) });
    }
  })();
}

Bun.serve<Session, undefined>({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req, { data: { push: () => {}, pending: new Map() } })) return;
    return new Response("herdr-chat engine\n");
  },
  websocket: {
    message(ws, raw) {
      const m = JSON.parse(String(raw));
      switch (m.type) {
        case "start":
          return start(ws, m.cwd, m.resume);
        case "prompt": {
          const content: any[] = [];
          for (const img of m.images ?? [])
            content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: img } });
          content.push({ type: "text", text: m.text });
          return ws.data.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
        }
        case "permission": {
          const resolve = ws.data.pending.get(m.id);
          ws.data.pending.delete(m.id);
          return resolve?.(m.allow ? { behavior: "allow", updatedInput: m.input } : { behavior: "deny", message: "User denied" });
        }
        case "interrupt":
          return void ws.data.q?.interrupt();
        case "echo_image":
          // spike: send a local PNG back as bytes to test the binary path
          return void Bun.file(m.path).bytes().then((b) => ws.send(b));
      }
    },
    close(ws) {
      for (const r of ws.data.pending.values()) r({ behavior: "deny", message: "Disconnected" });
      ws.data.q?.close?.();
    },
  },
});

console.log(`herdr-chat engine on ws://127.0.0.1:${PORT}`);
