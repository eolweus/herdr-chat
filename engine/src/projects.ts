import { existsSync, readFileSync } from "node:fs";
import type { ProjectServers } from "./items";

const read = (path: string): Record<string, any> => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
};

const describe = (name: string, c: Record<string, any>, scope: "local" | "project") => ({
  name, scope,
  transport: c.type ?? (c.command ? "stdio" : null),
  target: c.url ?? (c.command ? [c.command, ...(c.args ?? [])].join(" ") : null),
});

// Servers set up for other folders, which this chat's session never loads.
export function projectServers(here: string): ProjectServers[] {
  const projects = read(`${process.env.HOME}/.claude.json`).projects ?? {};
  const out: ProjectServers[] = [];
  for (const [path, p] of Object.entries<any>(projects)) {
    if (path === here) continue;
    const servers = Object.entries<any>(p?.mcpServers ?? {}).map(([n, c]) => describe(n, c, "local"));
    if (existsSync(`${path}/.mcp.json`)) servers.push(...Object.entries<any>(read(`${path}/.mcp.json`).mcpServers ?? {}).map(([n, c]) => describe(n, c, "project")));
    if (servers.length) out.push({ path, servers });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
