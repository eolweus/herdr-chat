import { Database } from "bun:sqlite";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { AcpClient } from "./acp";
import { AcpSession } from "./acp-session";
import { hasAgy } from "./agy-cache";
import { Session } from "./session";

type Msg = Record<string, any>;
type Chat = { id: string; title: string; when: number; branch: string | null; cwd: string };
export type PastChat = Chat & { backend: string; snippet?: string };

type Agent = {
  Session: new (key: string, cwd: string, session: string | null, onSession: (s: Session) => void) => Session;
  // Chats in one folder, or on the whole machine when cwd is null.
  past: (cwd: string | null, live?: Session) => Promise<Chat[]>;
  // Each chat whose messages contain q, with the text around it.
  grep: (q: string) => Promise<Map<string, string>>;
};

const HOME = process.env.HOME!;
const CLAUDE_DIR = `${process.env.CLAUDE_CONFIG_DIR ?? `${HOME}/.claude`}/projects`;
const AGY_DIR = `${HOME}/.gemini/antigravity-cli/conversations`;
const escape = (q: string) => q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The first match in each file, as `path:text`; a session's id is its file's name.
async function rg(dir: string, args: string[]) {
  const p = Bun.spawn(["rg", "--no-heading", "--with-filename", "-i", "-o", "-m", "1", ...args, dir], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => p.kill(), 20_000);
  const out = await new Response(p.stdout).text();
  clearTimeout(timer);
  const found = new Map<string, string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^(.*?\/([0-9a-f-]{36})\.(?:jsonl|db)):(.*)$/);
    if (m && !found.has(m[2]!)) found.set(m[2]!, m[3]!);
  }
  return found;
}

function around(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  const s = text.slice(Math.max(0, i - 50), i + q.length + 70).replace(/\s+/g, " ").trim();
  return (i > 50 ? "…" : "") + s;
}

async function claudePast(cwd: string | null) {
  const list = await listSessions(cwd ? { dir: cwd, limit: 12 } : {});
  return list.filter((x) => !x.archived).map((x) => ({
    id: x.sessionId, title: x.customTitle || x.summary || x.firstPrompt || "Untitled", when: x.lastModified, branch: x.gitBranch ?? null, cwd: x.cwd ?? cwd ?? "",
  }));
}

// Only text the user or Claude wrote, not paths and ids in the transcript's other fields.
async function claudeGrep(q: string) {
  const text = `"(?:text|content)":"(?:[^"\\\\]|\\\\.){0,4000}?${escape(q)}(?:[^"\\\\]|\\\\.){0,80}`;
  const found = await rg(CLAUDE_DIR, ["--max-depth", "2", "-g", "*.jsonl", "-e", text]);
  for (const [id, raw] of found) {
    let s = raw.replace(/^"(?:text|content)":"/, "");
    try { s = JSON.parse(`"${s.replace(/\\$/, "")}"`); } catch {}
    found.set(id, around(s, q));
  }
  return found;
}

const agyLists = new Map<string, { at: number; list: Promise<Chat[]> }>();

// Without a running agy, a short-lived one lists them; empty chat panes ask often, so the answer is kept a little while.
async function agyPast(cwd: string | null, live?: Session) {
  if (!hasAgy()) return [];
  const ask = async (c: AcpClient) => {
    const r = await c.request("session/list", cwd ? { cwd } : {}, 30_000);
    return (r?.sessions ?? []).filter((x: Msg) => !cwd || x.cwd === cwd)
      .map((x: Msg) => ({ id: x.sessionId, title: x.title || "Untitled", when: Date.parse(x.updatedAt) || 0, branch: null, cwd: x.cwd ?? "" }));
  };
  const running = live instanceof AcpSession ? live.client : null;
  if (running && !running.exited) return ask(running);
  const key = cwd ?? "";
  const hit = agyLists.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.list;
  const list = (async () => {
    const c = new AcpClient(cwd ?? HOME, process.env);
    try {
      await c.initialize();
      return await ask(c);
    } finally {
      c.kill();
    }
  })();
  agyLists.set(key, { at: Date.now(), list });
  list.catch(() => agyLists.delete(key));
  return list;
}

// Each agy conversation is a SQLite file; its steps hold the messages as protobuf with readable text, and the system prompt sits elsewhere.
async function agyGrep(q: string) {
  const found = new Map<string, string>();
  if (!hasAgy()) return found;
  const needle = q.toLowerCase();
  for (const f of new Bun.Glob("*.db").scanSync(AGY_DIR)) {
    let db: Database | null = null;
    try {
      // Read-only needs agy's lock files; a conversation agy isn't using has none, and nothing writes it then.
      try { db = new Database(`${AGY_DIR}/${f}`, { readonly: true }); db.query("select 1 from steps limit 1").get(); }
      catch { db?.close(); db = new Database(`file:${AGY_DIR}/${f}?immutable=1`, { readonly: true }); }
      for (const r of db.query("select step_payload from steps order by idx").all() as { step_payload: Uint8Array | null }[]) {
        if (!r.step_payload) continue;
        const text = Buffer.from(r.step_payload).toString("utf8");
        const i = text.toLowerCase().indexOf(needle);
        if (i < 0) continue;
        const run = /[\x00-\x08\x0e-\x1f\ufffd]/;
        let a = i, b = i + q.length;
        while (a > 0 && i - a < 200 && !run.test(text[a - 1]!)) a--;
        while (b < text.length && b - i < 200 && !run.test(text[b]!)) b++;
        found.set(f.replace(/\.db$/, ""), around(text.slice(a, b), q));
        break;
      }
    } catch {
    } finally {
      db?.close();
    }
  }
  return found;
}

export const AGENTS: Record<string, Agent> = {
  claude: { Session, past: claudePast, grep: claudeGrep },
  agy: { Session: AcpSession, past: agyPast, grep: agyGrep },
};

export const agentFor = (backend: string | undefined) => AGENTS[backend ?? "claude"] ?? AGENTS.claude!;

const each = <T>(f: (backend: string, a: Agent) => Promise<T[]>) =>
  Promise.all(Object.entries(AGENTS).map(([backend, a]) => f(backend, a).catch(() => [] as T[]))).then((l) => l.flat());

// Every agent's chats in this folder, newest first.
export async function pastChats(s: Session, limit = 12): Promise<PastChat[]> {
  const all = await each((backend, a) => a.past(s.cwd, s).then((l) => l.map((x) => ({ ...x, backend }))));
  return all.filter((x) => x.id !== s.state.session).sort((a, b) => b.when - a.when).slice(0, limit);
}

// Every chat on this machine whose title or messages match q; the newest ones when q is empty.
export async function searchChats(q: string, limit = 100): Promise<PastChat[]> {
  q = q.trim();
  const all = await each(async (backend, a) => {
    const [chats, hits] = await Promise.all([a.past(null), q ? a.grep(q) : new Map<string, string>()]);
    return chats.filter((c) => !q || hits.has(c.id) || c.title.toLowerCase().includes(q.toLowerCase()))
      .map((c) => ({ ...c, backend, ...(hits.has(c.id) && { snippet: hits.get(c.id) }) }));
  });
  return all.sort((a, b) => b.when - a.when).slice(0, limit);
}
