import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import type { ServerWebSocket } from "bun";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { Session, type Client } from "./src/session";
import { ReplaySession } from "./src/replay";

const PROTOCOL = 1;
const HOME = process.env.HOME!;
const PORT = Number(process.env.HERDR_CHAT_PORT ?? 7777);
const HOSTS = (process.env.HERDR_CHAT_HOSTS ?? "127.0.0.1").split(",").filter(Boolean);
const TOKEN_FILE = `${HOME}/.config/herdr-chat/token`;
const PANES_FILE = `${HOME}/.local/state/herdr-chat/panes.json`;

const replay = process.argv.indexOf("--replay");
if (replay >= 0) ReplaySession.fixture = process.argv[replay + 1]!;

function token(): string {
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  const t = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
  return t;
}

const TOKEN = Buffer.from(token());

type Pane = { session: string | null; cwd: string };
const panes: Record<string, Pane> = existsSync(PANES_FILE) ? JSON.parse(readFileSync(PANES_FILE, "utf8")) : {};
function savePanes() {
  mkdirSync(dirname(PANES_FILE), { recursive: true });
  writeFileSync(PANES_FILE, JSON.stringify(panes, null, 2));
}

const sessions = new Map<string, Session>();

function open(key: string, cwd: string): Session {
  const live = sessions.get(key);
  if (live) return live;
  const known = replay < 0 ? panes[key] : undefined;
  const Kind = replay >= 0 ? ReplaySession : Session;
  const s = new Kind(key, known?.cwd ?? cwd, known?.session ?? null, (s) => {
    panes[s.key] = { session: s.state.session, cwd: s.cwd };
    if (replay < 0) savePanes();
  });
  sessions.set(key, s);
  return s;
}

type Data = { authed: boolean; session: Session | null; client: Client };

function authed(t: unknown) {
  const b = Buffer.from(String(t ?? ""));
  return b.length === TOKEN.length && timingSafeEqual(b, TOKEN);
}

async function handle(ws: ServerWebSocket<Data>, m: Record<string, any>) {
  const d = ws.data;
  if (m.type === "hello") {
    if (!authed(m.token)) {
      ws.send(JSON.stringify({ type: "error", fatal: true, message: "Wrong token" }));
      return ws.close(4001, "unauthorized");
    }
    d.authed = true;
    return ws.send(JSON.stringify({ type: "hello", v: PROTOCOL, replay: replay >= 0 }));
  }
  if (!d.authed) return ws.close(4001, "unauthorized");
  if (m.type === "open") {
    d.session?.detach(d.client);
    const s = open(String(m.key || crypto.randomUUID()), String(m.cwd || HOME));
    d.session = s;
    await s.load();
    return s.attach(d.client);
  }
  const s = d.session;
  if (!s) return;
  if (m.type === "sessions") {
    const list = replay >= 0 ? [] : await listSessions({ dir: s.cwd, limit: 12 }).catch(() => []);
    const sessions = list.filter((x) => x.sessionId !== s.state.session && !x.archived).map((x) => ({
      id: x.sessionId, title: x.customTitle || x.summary || x.firstPrompt || "Untitled", when: x.lastModified, branch: x.gitBranch ?? null,
    }));
    return ws.send(JSON.stringify({ type: "sessions", sessions }));
  }
  if (m.type === "resume") {
    if (s.state.busy) return ws.send(JSON.stringify({ type: "error", message: "Stop the current turn first" }));
    s.close();
    sessions.delete(s.key);
    panes[s.key] = { session: String(m.id), cwd: s.cwd };
    if (replay < 0) savePanes();
    const next = open(s.key, s.cwd);
    d.session = next;
    for (const c of s.clients) if (c !== d.client) next.clients.add(c);
    await next.load();
    next.attach(d.client);
    for (const c of next.clients) if (c !== d.client) c.send(next.snapshot());
    return;
  }
  switch (m.type) {
    case "prompt": return s.prompt(String(m.text ?? ""), Array.isArray(m.images) ? m.images : []);
    case "unqueue": return s.unqueue(String(m.id));
    case "interrupt": return s.interrupt();
    case "answer": return s.answer(m as any);
    case "set": return s.set(m);
  }
}

for (const hostname of HOSTS) {
  Bun.serve<Data>({
    hostname,
    port: PORT,
    fetch(req, server) {
      if (server.upgrade(req, { data: { authed: false, session: null, client: null as unknown as Client } })) return;
      return new Response("herdr-chat engine\n");
    },
    websocket: {
      idleTimeout: 0,
      open(ws) {
        ws.data.client = { send: (o) => ws.send(JSON.stringify(o)) };
      },
      async message(ws, raw) {
        try {
          await handle(ws, JSON.parse(String(raw)));
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: String(e) }));
        }
      },
      close(ws) {
        ws.data.session?.detach(ws.data.client);
      },
    },
  });
}

console.log(`herdr-chat engine on ${HOSTS.map((h) => `${h}:${PORT}`).join(", ")}${replay >= 0 ? ` replaying ${ReplaySession.fixture}` : ""}`);
