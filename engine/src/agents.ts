import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { AcpClient } from "./acp";
import { AcpSession } from "./acp-session";
import { hasAgy } from "./agy-cache";
import { Session } from "./session";

type Msg = Record<string, any>;
export type PastChat = { id: string; title: string; when: number; branch: string | null; backend: string };

type Agent = {
  Session: new (key: string, cwd: string, session: string | null, onSession: (s: Session) => void) => Session;
  past: (cwd: string, live: Session) => Promise<Omit<PastChat, "backend">[]>;
};

async function claudePast(cwd: string) {
  const list = await listSessions({ dir: cwd, limit: 12 });
  return list.filter((x) => !x.archived).map((x) => ({
    id: x.sessionId, title: x.customTitle || x.summary || x.firstPrompt || "Untitled", when: x.lastModified, branch: x.gitBranch ?? null,
  }));
}

const agyLists = new Map<string, { at: number; list: Promise<Omit<PastChat, "backend">[]> }>();

// Without a running agy, a short-lived one lists them; empty chat panes ask often, so the answer is kept a little while.
async function agyPast(cwd: string, live: Session) {
  if (!hasAgy()) return [];
  const ask = async (c: AcpClient) => {
    const r = await c.request("session/list", { cwd }, 30_000);
    return (r?.sessions ?? []).filter((x: Msg) => x.cwd === cwd)
      .map((x: Msg) => ({ id: x.sessionId, title: x.title || "Untitled", when: Date.parse(x.updatedAt) || 0, branch: null }));
  };
  const running = live instanceof AcpSession ? live.client : null;
  if (running && !running.exited) return ask(running);
  const hit = agyLists.get(cwd);
  if (hit && Date.now() - hit.at < 30_000) return hit.list;
  const list = (async () => {
    const c = new AcpClient(cwd, process.env);
    try {
      await c.initialize();
      return await ask(c);
    } finally {
      c.kill();
    }
  })();
  agyLists.set(cwd, { at: Date.now(), list });
  list.catch(() => agyLists.delete(cwd));
  return list;
}

export const AGENTS: Record<string, Agent> = {
  claude: { Session, past: claudePast },
  agy: { Session: AcpSession, past: agyPast },
};

export const agentFor = (backend: string | undefined) => AGENTS[backend ?? "claude"] ?? AGENTS.claude!;

// Every agent's chats in this folder, newest first.
export async function pastChats(s: Session, limit = 12): Promise<PastChat[]> {
  const lists = await Promise.all(Object.entries(AGENTS).map(([backend, a]) =>
    a.past(s.cwd, s).then((l) => l.map((x) => ({ ...x, backend })), () => [])));
  return lists.flat().filter((x) => x.id !== s.state.session).sort((a, b) => b.when - a.when).slice(0, limit);
}
