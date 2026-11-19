// Prints a Claude Code session's context breakdown as JSON, for sessions running in a terminal:
// bun context.ts <session id> <cwd>. It resumes a fork and never sends a prompt, so nothing is written.
import { query } from "@anthropic-ai/claude-agent-sdk";

const [session, cwd] = process.argv.slice(2);
const CLAUDE = Bun.which("claude") ?? `${process.env.HOME}/.local/bin/claude`;

async function* never(): AsyncGenerator<never> {
  await new Promise(() => {});
}

const q = query({
  prompt: never(),
  options: {
    cwd,
    resume: session,
    forkSession: true,
    persistSession: false,
    pathToClaudeCodeExecutable: CLAUDE,
    settingSources: ["user", "project", "local"],
    systemPrompt: { type: "preset", preset: "claude_code" },
  } as any,
});
setTimeout(() => process.exit(1), 30000);
const u = await q.getContextUsage({ detail: "summary" } as any);
console.log(JSON.stringify({ total: u.totalTokens, max: u.maxTokens, categories: u.categories.map(({ id, name, tokens, kind }: any) => ({ id, name, tokens, kind })) }));
process.exit(0);
