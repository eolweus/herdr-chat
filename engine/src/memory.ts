import type { Memory } from "./items";

export type Proc = { pid: number; ppid: number; kb: number; args: string };
export type Server = { name: string; command: string; args: string[] };

export async function processes(): Promise<Proc[]> {
  const p = Bun.spawn(["ps", "-axo", "pid=,ppid=,rss=,args="], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  return out.split("\n").flatMap((l) => {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m ? [{ pid: +m[1]!, ppid: +m[2]!, kb: +m[3]!, args: m[4]! }] : [];
  });
}

const LAUNCHERS = new Set(["npx", "npm", "node", "bun", "bunx", "uvx", "uv", "python", "python3", "pnpm", "docker"]);
const base = (s: string) => s.split("/").pop() ?? s;

function nameOf(args: string, servers: Server[]) {
  for (const s of servers) {
    const words = s.args.filter((a) => !a.startsWith("-"));
    if (words.length ? words.every((a) => args.includes(a)) : !LAUNCHERS.has(base(s.command)) && args.includes(s.command)) return s.name;
  }
  const mcp = args.split(/\s+/).find((w) => /mcp/i.test(w));
  if (mcp) {
    const pkg = mcp.replace(/(.)@[^/]*$/, "$1");
    const scope = pkg.match(/^@([^/]+)\/mcp$/);
    return scope ? scope[1]! : base(pkg).replace(/^mcp-|-mcp$/i, "");
  }
  if (/^(\S*\/)?(ba|z|fi|da)?sh\b/.test(args)) return "Shell commands";
  return base(args.split(/\s+/)[0] ?? "");
}

// RSS counts shared pages in every process, so the total runs a little high.
export function memoryOf(pid: number, procs: Proc[], servers: Server[]): Memory | null {
  const self = procs.find((p) => p.pid === pid);
  if (!self) return null;
  const kids = new Map<number, Proc[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const tree = (p: Proc): [number, number] => (kids.get(p.pid) ?? []).reduce<[number, number]>(([kb, n], c) => {
    const [k, m] = tree(c);
    return [kb + k, n + m];
  }, [p.kb, 1]);
  const parts = new Map<string, { name: string; mb: number; procs: number }>();
  const add = (name: string, kb: number, n: number) => {
    const part = parts.get(name) ?? { name, mb: 0, procs: 0 };
    part.mb += kb / 1024;
    part.procs += n;
    parts.set(name, part);
  };
  add("Claude Code", self.kb, 1);
  for (const c of kids.get(pid) ?? []) add(nameOf(c.args, servers), ...tree(c));
  const list = [...parts.values()].map((p) => ({ ...p, mb: Math.round(p.mb) })).sort((a, b) => b.mb - a.mb);
  return { mb: list.reduce((n, p) => n + p.mb, 0), parts: list };
}
