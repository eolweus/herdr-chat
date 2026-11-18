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
      state: "pending" | "allowed" | "denied";
    }
  | {
      id: string;
      kind: "question";
      questions: Question[];
      state: "pending" | "answered" | "skipped";
      answers?: Record<string, string>;
    }
  | { id: string; kind: "notice"; level: "info" | "warning" | "error"; text: string }
  | { id: string; kind: "turn_end"; ms: number; error?: string };

export type ItemOf<K extends Item["kind"]> = Extract<Item, { kind: K }>;

export type State = {
  busy: boolean;
  status: string | null;
  mode: string;
  model: string;
  context: { used: number; max: number };
  queue: { id: string; text: string; images: number }[];
  session: string | null;
  usage: Usage | null;
  commands: Command[];
  models: Model[];
  mcp: Mcp[];
};

export type Mcp = { name: string; label: string };

export type Model = { value: string; name: string; description: string };

export type Command = { name: string; description: string; hint: string };

export type Usage = {
  total: number;
  max: number;
  categories: { id?: string; name: string; tokens: number; kind: string }[];
};
