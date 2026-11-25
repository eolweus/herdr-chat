import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Model } from "./items";

type Msg = Record<string, any>;

const DIR = `${process.env.HOME}/.local/state/herdr-chat`;
const AGY_CACHE = `${DIR}/agy.json`;
const CLAUDE_CACHE = `${DIR}/claude-models.json`;
// Herdr's usage meter reads this next to ~/.cache/claude-usage.json.
const USAGE = `${process.env.HOME}/.cache/gemini-usage.json`;

export const AGY = Bun.which("agy") ?? `${process.env.HOME}/.local/bin/agy`;
export const hasAgy = () => existsSync(AGY);

function read(path: string): Msg {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

function write(path: string, data: unknown) {
  try {
    mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(`${path}.${process.pid}`, JSON.stringify(data));
    renameSync(`${path}.${process.pid}`, path);
  } catch {}
}

// agy's model list and commands, so a chat can show them before agy starts, and the model and effort last picked.
export const agyCached = (): Msg => read(AGY_CACHE);
export const agyCache = (patch: Msg) => write(AGY_CACHE, { ...agyCached(), ...patch });

const tag = (list: Model[] | undefined, backend: string) => (list ?? []).map((m) => ({ ...m, backend }));

export const agyModels = (): Model[] => hasAgy() ? tag(agyCached().models, "agy") : [];
export const claudeModels = (): Model[] => tag(read(CLAUDE_CACHE).models, "claude");
export const saveClaudeModels = (models: Model[]) => { if (models.length) write(CLAUDE_CACHE, { models }); };

// `agy models` lists each model at each thinking level ("gemini-3.8-flash-high"); the pane shows a model with its levels.
async function seedAgyModels() {
  if (agyCached().models?.length) return;
  const p = Bun.spawn([AGY, "models"], { cwd: process.env.HOME, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  const rows = out.split("\n").map((l) => l.split("\t")).filter((r) => r.length === 2).map(([id, name]) => ({ id: id!.trim(), name: name!.trim() }));
  const LEVEL = /-(low|medium|high|xhigh)$/;
  const families = new Map<string, { name: string; efforts: string[] }>();
  for (const r of rows) {
    const base = r.id.replace(LEVEL, "");
    const f = families.get(base) ?? { name: r.name.replace(/\s*\([^)]*\)$/, ""), efforts: [] };
    if (LEVEL.test(r.id)) f.efforts.push(r.id.match(LEVEL)![1]!);
    families.set(base, f);
  }
  const models: Model[] = [];
  for (const [base, f] of families) {
    if (f.efforts.length > 1) models.push({ value: base, name: f.name, description: "", efforts: f.efforts, resolved: base, fast: false });
    else for (const r of rows.filter((x) => x.id.replace(LEVEL, "") === base)) models.push({ value: r.id, name: r.name, description: "", efforts: [], resolved: r.id, fast: false });
  }
  if (models.length) agyCache({ models });
}

let lastUsage = 0;
let fetching = false;

// Antigravity's weekly and 5-hour limits, per model group, as used percentages like the Claude cache.
export async function refreshGemini(force = false) {
  if (!hasAgy() || fetching || (!force && Date.now() - lastUsage < 60_000)) return;
  fetching = true;
  lastUsage = Date.now();
  try {
    await seedAgyModels().catch(() => {});
    const p = Bun.spawn([AGY, "-p", "/usage", "--output-format", "json"], { cwd: process.env.HOME, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => p.kill(), 60_000);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    const groups = JSON.parse(out)?.command?.data?.groups;
    if (!Array.isArray(groups)) return;
    write(USAGE, {
      at: Math.floor(Date.now() / 1000),
      groups: groups.map((g: Msg) => ({
        name: g.name,
        windows: (g.buckets ?? []).map((b: Msg) => {
          const reset = Date.parse(b.reset_time ?? "");
          return { window: b.window, used_percentage: Math.round((1 - (b.remaining_fraction ?? 1)) * 1000) / 10, resets_at: reset > 0 ? Math.floor(reset / 1000) : null };
        }),
      })),
    });
  } catch {
  } finally {
    fetching = false;
  }
}
