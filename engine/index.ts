import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import type { ServerWebSocket } from "bun";
import { Session, userSettings, type Client, type Handoff } from "./src/session";
import { ReplaySession } from "./src/replay";
import { agentFor, pastChats, searchChats } from "./src/agents";
import { refreshLimits } from "./src/limits";
import { refreshGemini } from "./src/agy-cache";
import { projectServers } from "./src/projects";
import { processes } from "./src/memory";
import { summarize } from "./src/summary";

const PROTOCOL = 3;
const HOME = process.env.HOME!;
const PORT = Number(process.env.HERDR_CHAT_PORT ?? 7777);
const HOSTS = (process.env.HERDR_CHAT_HOSTS ?? "127.0.0.1").split(",").filter(Boolean);
const TOKEN_FILE = `${HOME}/.config/herdr-chat/token`;
const PANES_FILE = process.env.HERDR_CHAT_PANES ?? `${HOME}/.local/state/herdr-chat/panes.json`;

for (const level of ["log", "warn", "error"] as const) {
  const out = console[level].bind(console);
  console[level] = (...args: unknown[]) => out(new Date().toLocaleString("sv-SE"), ...args);
}
process.on("uncaughtException", (e) => console.error("uncaught:", e));
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));
process.on("SIGTERM", () => { console.log("stopping (SIGTERM)"); process.exit(0); });

const replay = process.argv.indexOf("--replay");
if (replay >= 0) ReplaySession.fixture = process.argv[replay + 1]!;
else {
  refreshLimits();
  setInterval(() => refreshLimits(), 5 * 60_000);
  refreshGemini(true);
  setInterval(() => refreshGemini(), 5 * 60_000);
}

function token(): string {
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, "utf8").trim();
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  const t = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
  return t;
}

const TOKEN = Buffer.from(token());

type Pane = { session: string | null; cwd: string; backend?: string; remote?: boolean; handoff?: Handoff; closed?: string; preamble?: string; title?: string };
const panes: Record<string, Pane> = existsSync(PANES_FILE) ? JSON.parse(readFileSync(PANES_FILE, "utf8")) : {};
function savePanes() {
  mkdirSync(dirname(PANES_FILE), { recursive: true });
  writeFileSync(PANES_FILE, JSON.stringify(panes, null, 2));
}

const sessions = new Map<string, Session>();

function remember(s: Session) {
  const was = panes[s.key];
  panes[s.key] = { session: s.state.session, cwd: s.cwd, backend: s.backend === "claude" ? undefined : s.backend, remote: s.wantRemote, handoff: s.handoff ?? undefined, closed: was?.closed, preamble: s.preamble ?? undefined, title: s.state.title ?? undefined };
  if (replay < 0) savePanes();
}

function open(key: string, cwd: string, backend?: string): Session {
  const live = sessions.get(key);
  if (live) return live;
  const known = replay < 0 ? panes[key] : undefined;
  const Kind = replay >= 0 ? ReplaySession : agentFor(known?.backend ?? backend).Session;
  const s = new Kind(key, known?.cwd ?? cwd, known?.session ?? null, remember);
  s.handoff = known?.handoff ?? null;
  s.preamble = known?.preamble ?? null;
  if (known?.title && known.session) s.n.setState({ title: known.title });
  sessions.set(key, s);
  if (replay < 0 && (known?.remote ?? userSettings().remoteControlAtStartup === true) && existsSync(s.cwd)) s.remote(true).catch(() => {});
  return s;
}

async function reopen(d: Data, s: Session, session: string | null, cwd: string, backend = s.backend) {
  s.close();
  sessions.delete(s.key);
  panes[s.key] = { ...panes[s.key], session, cwd, backend: backend === "claude" ? undefined : backend, remote: s.wantRemote, title: undefined };
  if (replay < 0) savePanes();
  const next = open(s.key, cwd, backend);
  d.session = next;
  for (const c of s.clients) if (c !== d.client) next.clients.add(c);
  s.clients.clear();
  await next.load();
  next.attach(d.client);
  for (const c of next.clients) if (c !== d.client) next.sendSnapshot(c);
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
    const s = open(String(m.key || crypto.randomUUID()), String(m.cwd || HOME), m.backend ? String(m.backend) : undefined);
    d.session = s;
    console.log(`open ${s.key}`);
    await s.load();
    s.attach(d.client);
    if (!existsSync(s.cwd)) ws.send(JSON.stringify({ type: "error", message: `${s.cwd} doesn't exist on this machine` }));
    return;
  }
  if (m.type === "history") return ws.send(JSON.stringify({ type: "history", id: m.id ?? null, chats: replay >= 0 ? [] : await searchChats(String(m.q ?? "")) }));
  const s = d.session;
  if (!s) return;
  if (m.type === "older") return ws.send(JSON.stringify(s.older(String(m.before))));
  if (m.type === "image") return void s.image(String(m.item), Number(m.i)).then((r) => ws.send(JSON.stringify(r)));
  if (m.type === "sessions") {
    const sessions = replay >= 0 ? [] : await pastChats(s);
    return ws.send(JSON.stringify({ type: "sessions", sessions }));
  }
  if (m.type === "resume") {
    if (s.state.busy) return ws.send(JSON.stringify({ type: "error", message: "Stop the current turn first" }));
    return reopen(d, s, String(m.id), s.cwd, m.backend ? String(m.backend) : s.backend);
  }
  if (m.type === "rewind_check") {
    const r = await s.restoreFiles(String(m.id), true).catch(() => null);
    return ws.send(JSON.stringify({ type: "rewind_check", id: m.id, files: r?.canRewind ? (r.filesChanged ?? []) : null }));
  }
  if (m.type === "rewind") {
    if (s.state.busy) return ws.send(JSON.stringify({ type: "error", message: "Stop the current turn first" }));
    try {
      if (m.files) {
        const r = await s.restoreFiles(String(m.id));
        if (!r.canRewind) throw new Error(`Couldn't put the files back: ${r.error ?? "no checkpoint"}`);
      }
      return await reopen(d, s, await s.branch(String(m.id), true), s.cwd);
    } catch (e: any) {
      return ws.send(JSON.stringify({ type: "error", message: e?.message ?? String(e) }));
    }
  }
  if (m.type === "fork") {
    try {
      const key = crypto.randomUUID();
      panes[key] = { session: await s.branch(String(m.id), false), cwd: s.cwd };
      if (replay < 0) savePanes();
      return ws.send(JSON.stringify({ type: "forked", id: m.id, key, cwd: s.cwd }));
    } catch (e: any) {
      return ws.send(JSON.stringify({ type: "error", message: e?.message ?? String(e) }));
    }
  }
  if (m.type === "cwd") {
    if (s.state.session || s.n.items.length) return ws.send(JSON.stringify({ type: "error", message: "The folder can only change before the first message" }));
    const cwd = String(m.cwd);
    if (!existsSync(cwd)) return ws.send(JSON.stringify({ type: "error", message: `${cwd} doesn't exist on this machine` }));
    return reopen(d, s, null, cwd);
  }
  switch (m.type) {
    case "prompt": return s.prompt(String(m.text ?? ""), Array.isArray(m.images) ? m.images : [], typeof m.id === "string" ? m.id : undefined, m.priority === "later" ? "later" : undefined);
    case "unqueue": return s.unqueue(String(m.id));
    case "send_now": return s.sendNow(String(m.id));
    case "interrupt": return s.interrupt();
    case "side_ask": return s.askSide(String(m.text ?? ""));
    case "side_interrupt": return s.side?.interrupt();
    case "side_close": return s.closeSide();
    case "summarize": {
      const id = String(m.id);
      return summarize(s.n.items, String(m.from), s.state.busy)
        .then((text) => ws.send(JSON.stringify({ type: "summary", id, text })))
        .catch((e) => ws.send(JSON.stringify({ type: "summary", id, error: e?.message ?? String(e) })));
    }
    case "view": return s.view(d.client, Boolean(m.on));
    case "answer": return s.answer(m as any);
    case "set": {
      // A model from the other agent starts the chat over on that agent; only an empty chat can.
      if (m.backend && m.backend !== s.backend) {
        if (s.state.session || s.n.items.length) return ws.send(JSON.stringify({ type: "error", message: "Pick the other agent's models before the first message" }));
        await reopen(d, s, null, s.cwd, String(m.backend));
        const { backend: _, ...rest } = m;
        return d.session?.set(rest);
      }
      return s.set(m);
    }
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
    case "mcp_projects": return ws.send(JSON.stringify({ type: "mcp_projects", projects: replay >= 0 ? [] : projectServers(s.cwd) }));
    case "mcp_tools": return ws.send(JSON.stringify({ type: "mcp_tools", server: String(m.server), tools: await s.tools(String(m.server)).catch(() => []) }));
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

// Each live session's open permission prompt or question, for the Needs you inbox.
function pending() {
  return [...sessions.values()].flatMap((s) => {
    const item = s.n.items.find((i) => (i.kind === "permission" || i.kind === "question") && i.state === "pending");
    if (!item) return [];
    return [{ key: s.key, cwd: s.cwd, title: s.state.title ?? s.handoff?.title ?? s.state.first ?? null, backend: s.state.backend, handoff: Boolean(s.handoff), item }];
  });
}

async function api(req: Request, path: string): Promise<Response> {
  if (!authed(req.headers.get("authorization")?.replace(/^Bearer /, ""))) return json({ error: "unauthorized" }, 401);
  if (req.method === "GET" && path === "/api/handoffs") return json({ handoffs: handoffs() });
  if (req.method === "GET" && path === "/api/pending") return json({ pending: pending() });
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
    const s = open(key, cwd, b.backend ? String(b.backend) : undefined);
    await s.load();
    const kind = ["orchestrated", "standalone"].includes(b.kind) ? b.kind : "once";
    s.handoff = { id: String(b.id), title: b.title ? String(b.title) : null, from: String(b.from ?? ""), kind, result: null, report: null };
    delete panes[key]?.closed;
    remember(s);
    if (b.mode) await s.set({ mode: String(b.mode) });
    if (b.text) s.prompt(String(b.text), []);
    return json({ key });
  }
  // A session copied here from another machine (/move): resume it under a new key.
  if (path === "/api/adopt") {
    const cwd = String(b.cwd || "");
    if (!existsSync(cwd)) return json({ error: `${cwd} doesn't exist on this machine` }, 400);
    if (sessions.has(key) || panes[key]) return json({ error: `${key} is already in use` }, 409);
    panes[key] = { session: String(b.session), cwd, preamble: b.preamble ? String(b.preamble) : undefined };
    if (replay < 0) savePanes();
    const s = open(key, cwd);
    await s.load();
    if (b.mode) await s.set({ mode: String(b.mode) });
    if (b.model) await s.set({ model: String(b.model) });
    return json({ key, items: s.n.items.length });
  }
  const s = sessions.get(key) ?? (panes[key] && !panes[key]!.closed ? open(key, panes[key]!.cwd) : undefined);
  if (!s) return json({ error: `no session ${key}` }, 404);
  if (path === "/api/answer") {
    s.answer({ item: String(b.item), decision: b.decision, answers: b.answers, message: b.message });
    return json({ ok: true });
  }
  if (path === "/api/prompt") {
    await s.load();
    s.prompt(String(b.text ?? ""), []);
    return json({ ok: true });
  }
  if (path === "/api/result") {
    if (s.handoff) {
      const status = ["update", "blocked", "done", "failed"].includes(b.result) ? b.result : "done";
      s.handoff.report = { status, note: String(b.note ?? "").slice(0, 200), at: new Date().toISOString() };
      s.handoff.result = status === "done" || status === "failed" ? status : null;
    }
    remember(s);
    return json({ ok: true });
  }
  if (path === "/api/close") {
    s.close();
    sessions.delete(key);
    for (const c of s.clients) c.send({ type: "error", message: "This session was closed" });
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
        const start = Date.now();
        let type = "?";
        try {
          const m = JSON.parse(String(raw));
          type = m.type;
          await handle(ws, m);
        } catch (e) {
          console.error(`${type} failed:`, e);
          ws.send(JSON.stringify({ type: "error", message: String(e) }));
        }
        if (Date.now() - start > 5000) console.warn(`${type} took ${Date.now() - start}ms${ws.data.session ? ` (${ws.data.session.key})` : ""}`);
      },
      close(ws, code, reason) {
        if (ws.data.session) console.log(`close ${ws.data.session.key} ${code}${reason ? ` ${reason}` : ""}`);
        ws.data.session?.detach(ws.data.client);
      },
    },
  });
}

// Only chats a pane is showing; the panel's Memory section reads it.
setInterval(async () => {
  const live = [...sessions.values()].filter((s) => s.pid && s.clients.size);
  if (!live.length) return;
  const procs = await processes().catch(() => null);
  if (procs) for (const s of live) s.measure(procs);
}, 10_000);

// A stalled event loop shows as lag; the hourly line shows it was still alive.
let tick = Date.now(), beats = 0;
setInterval(() => {
  const lag = Date.now() - tick - 60_000;
  tick = Date.now();
  if (lag > 2000) console.warn(`event loop stalled ${lag}ms`);
  if (++beats % 60 === 0) {
    const live = [...sessions.values()];
    console.log(`alive: ${live.length} sessions, ${live.reduce((n, s) => n + s.clients.size, 0)} panes, ${Math.round(process.memoryUsage().rss / 1e6)}MB`);
  }
}, 60_000);

console.log(`herdr-chat engine on ${HOSTS.map((h) => `${h}:${PORT}`).join(", ")}${replay >= 0 ? ` replaying ${ReplaySession.fixture}` : ""}`);
