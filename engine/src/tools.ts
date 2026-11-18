type Input = Record<string, any>;

export type Described = { running: string; done: string; meta: string; detail?: string };

const MAX_DETAIL_LINES = 80;

export function rel(path: unknown, cwd: string): string {
  if (typeof path !== "string") return "";
  if (path.startsWith(cwd + "/")) return path.slice(cwd.length + 1);
  const home = process.env.HOME;
  if (home && path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}

function clip(lines: string[]): string {
  if (lines.length <= MAX_DETAIL_LINES) return lines.join("\n");
  return [...lines.slice(0, MAX_DETAIL_LINES), `… ${lines.length - MAX_DETAIL_LINES} more lines`].join("\n");
}

export function diff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return clip([...a.slice(start, endA).map((l) => "-" + l), ...b.slice(start, endB).map((l) => "+" + l)]);
}

function firstString(input: Input): string {
  for (const v of Object.values(input)) if (typeof v === "string" && v.length < 200) return v;
  return "";
}

export function describe(name: string, input: Input, cwd: string): Described {
  const path = rel(input.file_path ?? input.notebook_path ?? input.path, cwd);
  switch (name) {
    case "Bash":
      return { running: "Running", done: "Ran", meta: input.description || input.command || "", detail: input.command };
    case "Read":
      return { running: "Reading", done: "Read", meta: path };
    case "Edit":
      return { running: "Editing", done: "Edited", meta: path, detail: diff(input.old_string ?? "", input.new_string ?? "") };
    case "MultiEdit":
      return {
        running: "Editing", done: "Edited", meta: path,
        detail: (input.edits ?? []).map((e: Input) => diff(e.old_string ?? "", e.new_string ?? "")).join("\n…\n"),
      };
    case "NotebookEdit":
      return { running: "Editing", done: "Edited", meta: path };
    case "Write":
      return { running: "Writing", done: "Wrote", meta: path, detail: clip(String(input.content ?? "").split("\n").map((l) => "+" + l)) };
    case "Grep":
      return { running: "Searching", done: "Searched", meta: `${input.pattern ?? ""}${path ? ` in ${path}` : ""}` };
    case "Glob":
      return { running: "Finding", done: "Found", meta: `${input.pattern ?? ""}${path ? ` in ${path}` : ""}` };
    case "WebFetch":
      return { running: "Fetching", done: "Fetched", meta: input.url ?? "" };
    case "WebSearch":
      return { running: "Searching the web", done: "Searched the web", meta: input.query ?? "" };
    case "Task":
    case "Agent":
      return { running: "Agent", done: "Agent", meta: input.description ?? "" };
    case "TodoWrite": {
      const todos: Input[] = input.todos ?? [];
      const done = todos.filter((t) => t.status === "completed").length;
      return {
        running: "Updating todos", done: "Updated todos", meta: `${done}/${todos.length} done`,
        detail: todos.map((t) => `${t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "·"} ${t.content}`).join("\n"),
      };
    }
    case "Skill":
      return { running: "Loading skill", done: "Skill", meta: input.skill ?? input.command ?? "" };
    case "ToolSearch":
      return { running: "Loading tools", done: "Loaded tools", meta: input.query ?? "" };
    case "ExitPlanMode":
      return { running: "Plan", done: "Plan", meta: "" };
  }
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return { running: mcp[2]!, done: mcp[2]!, meta: `${mcp[1]!}${firstString(input) ? ` · ${firstString(input)}` : ""}` };
  return { running: name, done: name, meta: firstString(input) };
}
