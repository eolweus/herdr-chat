import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Item } from "./items";

const CLAUDE = Bun.which("claude") ?? `${process.env.HOME}/.local/bin/claude`;
const MAX_CHARS = 40_000;

const BUSY = `The agent is still working: lead with what it is doing right now, then what it got done so far.`;

const PROMPT = `Below is what happened in a coding agent's chat while the user was away. Write them a catch-up in 2-4 short plain sentences: where things stand now, what changed, and anything that needs their attention or decision. Name concrete files, commands and outcomes. Plain text only: no markdown, backticks, headings or lists. Don't greet or speculate beyond the log.`;

export function excerpt(items: Item[]): string {
  const lines: string[] = [];
  for (const i of items) {
    if (i.kind === "user") lines.push(`USER: ${i.text}`);
    else if (i.kind === "text") lines.push(`AGENT: ${i.text}`);
    else if (i.kind === "tool" && !i.parent) lines.push(`TOOL ${i.name} ${i.meta}${i.status === "error" ? " (failed)" : ""}`);
    else if (i.kind === "permission" && i.state === "pending") lines.push(`WAITING FOR PERMISSION: ${i.tool} ${i.meta}`);
    else if (i.kind === "question" && i.state === "pending") lines.push(`WAITING FOR AN ANSWER: ${i.questions.map((q) => q.question).join(" / ")}`);
    else if (i.kind === "notice" && i.level !== "info") lines.push(`${i.level.toUpperCase()}: ${i.text}`);
    else if (i.kind === "turn_end" && i.error) lines.push(`TURN FAILED: ${i.error}`);
  }
  const all = lines.join("\n");
  return all.length > MAX_CHARS ? `…\n${all.slice(-MAX_CHARS)}` : all;
}

export async function summarize(items: Item[], from: string, busy = false): Promise<string> {
  const at = items.findIndex((i) => i.id === from);
  if (at < 0) throw new Error("That part of the chat isn't loaded");
  const log = excerpt(items.slice(at));
  if (!log) return "";
  const q = query({
    prompt: `${PROMPT}${busy ? ` ${BUSY}` : ""}\n\n<log>\n${log}\n</log>`,
    options: {
      cwd: process.env.HOME,
      model: "haiku",
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      pathToClaudeCodeExecutable: CLAUDE,
      systemPrompt: "You summarize coding-agent logs for the person who started the agent.",
    },
  });
  let text = "";
  for await (const m of q) {
    if (m.type === "result") {
      if (m.subtype !== "success") throw new Error(`Summary failed: ${m.subtype}`);
      text = m.result;
    }
  }
  return text.trim();
}
