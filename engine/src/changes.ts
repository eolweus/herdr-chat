import { spawnSync } from "bun";
import { existsSync } from "node:fs";
import { dirname, basename } from "node:path";
import type { Item, Output, RepoChange } from "./items";

const PR = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

// PRs this chat made or worked on through gh.
export function prsOf(items: Item[]): string[] {
  const out = new Set<string>();
  for (const i of items) {
    if (i.kind !== "tool" || i.name !== "Bash" || !/\bgh\s+pr\b/.test(i.detail ?? "")) continue;
    for (const m of `${i.detail}\n${i.result ?? ""}`.matchAll(PR)) out.add(`https://github.com/${m[1]}/pull/${m[2]}`);
  }
  return [...out];
}

const roots = new Map<string, { root: string; remote: string | null } | null>();

function repoOf(dir: string) {
  if (roots.has(dir)) return roots.get(dir)!;
  let repo: { root: string; remote: string | null } | null = null;
  for (let d = dir; d && d !== "/"; d = dirname(d)) {
    if (!existsSync(`${d}/.git`)) continue;
    const url = spawnSync(["git", "-C", d, "remote", "get-url", "origin"]).stdout.toString().trim();
    repo = { root: d, remote: url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] ?? null };
    break;
  }
  roots.set(dir, repo);
  return repo;
}

export function reposOf(outputs: Output[]): RepoChange[] {
  const by = new Map<string, RepoChange>();
  for (const o of outputs) {
    const r = repoOf(dirname(o.path));
    if (!r) continue;
    const c = by.get(r.root) ?? { root: r.root, name: basename(r.root), remote: r.remote, add: 0, del: 0, files: 0 };
    c.add += o.add;
    c.del += o.del;
    c.files++;
    by.set(r.root, c);
  }
  return [...by.values()];
}
