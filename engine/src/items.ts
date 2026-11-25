export type Image = { type: string; data: string };

export type ToolStatus = "waiting" | "running" | "ok" | "error";

export type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
};

export type Item =
  | { id: string; kind: "user"; text: string; images: Image[] }
  | { id: string; kind: "text"; text: string; streaming: boolean }
  | { id: string; kind: "thinking"; text: string; streaming: boolean; ms?: number }
  | {
      id: string;
      kind: "tool";
      name: string;
      verb: string;
      meta: string;
      detail?: string;
      path?: string;
      status: ToolStatus;
      result?: string;
      images?: Image[];
      parent?: string;
      children?: number;
    }
  | {
      id: string;
      kind: "permission";
      tool: string;
      verb: string;
      meta: string;
      detail?: string;
      plan?: string;
      remember: boolean;
      state: "pending" | "allowed" | "denied" | "withdrawn";
    }
  | {
      id: string;
      kind: "question";
      questions: Question[];
      state: "pending" | "answered" | "skipped" | "withdrawn";
      answers?: Record<string, string>;
    }
  | { id: string; kind: "notice"; level: "info" | "warning" | "error"; text: string }
  | { id: string; kind: "turn_end"; ms: number; error?: string };

export type ItemOf<K extends Item["kind"]> = Extract<Item, { kind: K }>;

export type Task = { id: string; type: string; description: string };

export type State = {
  /** "claude" (Agent SDK) or "agy" (Antigravity over ACP). */
  backend: string;
  busy: boolean;
  status: string | null;
  mode: string;
  model: string;
  context: { used: number; max: number };
  queue: { id: string; text: string; images: number; priority: "now" | "next" | "later" }[];
  session: string | null;
  usage: Usage | null;
  commands: Command[];
  models: Model[];
  mcp: Mcp[];
  remote: string | null;
  title: string | null;
  /** null: the model's default. */
  effort: string | null;
  /** The next start makes a git worktree; only before the session's first message. */
  worktree: boolean;
  ultracode: boolean;
  fast: boolean;
  /** Files written or edited anywhere in the chat, newest first; panes hold only part of it. */
  outputs: Output[];
  /** Background shells and agents of the running process. */
  tasks: Task[];
  /** GitHub PR links from gh pr commands in this chat. */
  prs: string[];
  repos: RepoChange[];
  /** The first message, a title until the session has one. */
  first: string | null;
  /** The running CLI and the processes it started; null while it isn't running. */
  memory: Memory | null;
};

/** approx: RSS, which counts memory shared between processes in each of them. */
export type Memory = { mb: number; parts: { name: string; mb: number; procs: number }[]; approx: boolean };

export type Output = { path: string; name: string; created: boolean; add: number; del: number };
export type RepoChange = { root: string; name: string; remote: string | null; add: number; del: number; files: number };

export type Mcp = { name: string; label: string };
export type McpServer = Mcp & {
  status: string; error: string | null; tools: number; scope: string | null;
  source?: string | null; version?: string | null; transport?: string | null; target?: string | null;
};
export type ProjectServers = { path: string; servers: { name: string; scope: "local" | "project"; transport: string | null; target: string | null }[] };
export type McpTool = { name: string; description: string; readOnly: boolean; destructive: boolean };

export type Model = { value: string; name: string; description: string; efforts: string[]; resolved: string; fast: boolean; backend?: string };

export type Command = { name: string; description: string; hint: string };

export type Usage = {
  total: number;
  max: number;
  categories: { id?: string; name: string; tokens: number; kind: string }[];
};
