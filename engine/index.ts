import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import type { ServerWebSocket } from "bun";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { Session, userSettings, type Client, type Handoff } from "./src/session";
import { ReplaySession } from "./src/replay";

const PROTOCOL = 1;
const HOME = process.env.HOME!;
const PORT = Number(process.env.HERDR_CHAT_PORT ?? 7777);
const HOSTS = (process.env.HERDR_CHAT_HOSTS ?? "127.0.0.1").split(",").filter(Boolean);
const TOKEN_FILE = `${HOME}/.config/herdr-chat/token`;
const PANES_FILE = process.env.HERDR_CHAT_PANES ?? `${HOME}/.local/state/herdr-chat/panes.json`;

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

type Pane = { session: string | null; cwd: string; remote?: boolean; handoff?: Handoff; closed?: string };
const panes: Record<string, Pane> = existsSync(PANES_FILE) ? JSON.parse(readFileSync(PANES_FILE, "utf8")) : {};
function savePanes() {
  mkdirSync(dirname(PANES_FILE), { recursive: true });
  writeFileSync(PANES_FILE, JSON.stringify(panes, null, 2));
}

const sessions = new Map<string, Session>();

function remember(s: Session) {
  const was = panes[s.key];
  panes[s.key] = { session: s.state.session, cwd: s.cwd, remote: s.wantRemote, handoff: s.handoff ?? undefined, closed: was?.closed };
  if (replay < 0) savePanes();
}

function open(key: string, cwd: string): Session {
  const live = sessions.get(key);
  if (live) return live;
  const known = replay < 0 ? panes[key] : undefined;
  const Kind = replay >= 0 ? ReplaySession : Session;
  const s = new Kind(key, known?.cwd ?? cwd, known?.session ?? null, remember);
  s.handoff = known?.handoff ?? null;
  sessions.set(key, s);
  if (replay < 0 && (known?.remote ?? userSettings().remoteControlAtStartup === true) && existsSync(s.cwd)) s.remote(true).catch(() => {});
  return s;
}

async function reopen(d: Data, s: Session, session: string | null, cwd: string) {
  s.close();
  sessions.delete(s.key);
  panes[s.key] = { ...panes[s.key], session, cwd, remote: s.wantRemote };
  if (replay < 0) savePanes();
  const next = open(s.key, cwd);
  d.session = next;
  for (const c of s.clients) if (c !== d.client) next.clients.add(c);
  await next.load();
  next.attach(d.client);
  for (const c of next.clients) if (c !== d.client) c.send(next.snapshot());
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
    s.attach(d.client);
    if (!existsSync(s.cwd)) ws.send(JSON.stringify({ type: "error", message: `${s.cwd} doesn't exist on this machine` }));
    return;
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
    return reopen(d, s, String(m.id), s.cwd);
  }
  if (m.type === "cwd") {
    if (s.state.session || s.n.items.length) return ws.send(JSON.stringify({ type: "error", message: "The folder can only change before the first message" }));
    const cwd = String(m.cwd);
    if (!existsSync(cwd)) return ws.send(JSON.stringify({ type: "error", message: `${cwd} doesn't exist on this machine` }));
    return reopen(d, s, null, cwd);
  }
  switch (m.type) {
    case "prompt": return s.prompt(String(m.text ?? ""), Array.isArray(m.images) ? m.images : [], typeof m.id === "string" ? m.id : undefined);
    case "unqueue": return s.unqueue(String(m.id));
    case "interrupt": return s.interrupt();
    case "answer": return s.answer(m as any);
    case "set": return s.set(m);
    case "mcp_auth": {
      const server = String(m.server);
      const url = await s.signIn(server).catch((e) => { ws.send(JSON.stringify({ type: "error", message: `Sign-in to ${server} failed: ${e?.message ?? e}` })); return undefined; });
      if (url !== undefined) ws.send(JSON.stringify({ type: "auth", server, url }));
      return;
    }
    case "remote":
      try {
        await s.remote(Boolean(m.enabled));
        remember(s);
      } catch (e: any) {
        ws.send(JSON.stringify({ type: "error", message: `Remote Control: ${e?.message ?? e}` }));
      }
      return;
    case "mcp_list": return ws.send(JSON.stringify({ type: "mcp", servers: await s.servers() }));
    case "mcp_action":
      try {
        await s.mcpAction(String(m.server), String(m.action));
      } catch (e: any) {
        ws.send(JSON.stringify({ type: "error", message: `${m.action} ${m.server}: ${e?.message ?? e}` }));
      }
      return ws.send(JSON.stringify({ type: "mcp", servers: await s.servers() }));
    case "mcp_callback": return s.signInCallback(String(m.server), String(m.url)).catch(() => {});
  }
}

// For `board` and the sidebar: handoff sessions run here with no pane attached.
const json = (o: unknown, status = 200) => Response.json(o, { status });

function handoffs() {
  return Object.entries(panes).filter(([, p]) => p.handoff && !p.closed).map(([key, p]) => {
    const s = sessions.get(key);
    return {
      key, cwd: p.cwd, session: p.session, ...p.handoff!,
      status: s?.activity ?? "idle", title: p.handoff!.title, name: s?.state.title ?? null,
    };
  });
}

async function api(req: Request, path: string): Promise<Response> {
  if (!authed(req.headers.get("authorization")?.replace(/^Bearer /, ""))) return json({ error: "unauthorized" }, 401);
  if (req.method === "GET" && path === "/api/handoffs") return json({ handoffs: handoffs() });
  const url = new URL(req.url);
  if (req.method === "GET" && path === "/api/status") {
    const key = url.searchParams.get("key") ?? "";
    const s = sessions.get(key);
    const p = panes[key];
    if (!s && !p) return json({ exists: false });
    return json({ exists: true, live: Boolean(s), closed: p?.closed ?? null, status: s?.activity ?? "idle" });
  }
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  const b = (await req.json().catch(() => ({}))) as Record<string, any>;
  const key = String(b.key ?? "");
  if (!key) return json({ error: "key needed" }, 400);
  if (path === "/api/handoff") {
    const cwd = String(b.cwd || HOME);
    if (!existsSync(cwd)) return json({ error: `${cwd} doesn't exist on this machine` }, 400);
    const s = open(key, cwd);
    await s.load();
    s.handoff = { id: String(b.id), title: b.title ? String(b.title) : null, from: String(b.from ?? ""), result: null };
    delete panes[key]?.closed;
    remember(s);
    if (b.mode) await s.set({ mode: String(b.mode) });
    if (b.text) s.prompt(String(b.text), []);
    return json({ key });
  }
  const s = sessions.get(key) ?? (panes[key] && !panes[key]!.closed ? open(key, panes[key]!.cwd) : undefined);
  if (!s) return json({ error: `no session ${key}` }, 404);
  if (path === "/api/prompt") {
    await s.load();
    s.prompt(String(b.text ?? ""), []);
    return json({ ok: true });
  }
  if (path === "/api/result") {
    if (s.handoff) s.handoff.result = b.result === "failed" ? "failed" : "done";
    remember(s);
    return json({ ok: true });
  }
  if (path === "/api/close") {
    s.close();
    sessions.delete(key);
    for (const c of s.clients) c.send({ type: "error", message: "This handoff was closed" });
    panes[key] = { ...panes[key]!, closed: new Date().toISOString() };
    if (replay < 0) savePanes();
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}

for (const hostname of HOSTS) {
  Bun.serve<Data>({
    hostname,
    port: PORT,
    fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/api/")) return api(req, path).catch((e) => json({ error: String(e) }, 500));
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
