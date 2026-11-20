import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";

// Herdr's usage meter reads this; Claude Code's status line writes the same shape.
const CACHE = `${process.env.HOME}/.cache/claude-usage.json`;
const MIN_GAP = 60_000;

let last = 0;
let running = false;

type Window = { utilization: number | null; resets_at: string | null } | null | undefined;

const window = (w: Window) => w && w.utilization != null
  ? { used_percentage: w.utilization, resets_at: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : null }
  : undefined;

async function* idle() { await new Promise(() => {}); }

export async function refreshLimits(q?: Query | null) {
  if (running || Date.now() - last < MIN_GAP) return;
  running = true;
  last = Date.now();
  const own = q ? null : query({ prompt: idle() as any, options: { cwd: process.env.HOME } });
  try {
    const live = (q ?? own)!;
    if (own) await own.initializationResult();
    const u: any = await (live as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    if (!u?.rate_limits_available || !u.rate_limits) return;
    const rate_limits = { five_hour: window(u.rate_limits.five_hour), seven_day: window(u.rate_limits.seven_day) };
    mkdirSync(`${process.env.HOME}/.cache`, { recursive: true });
    writeFileSync(`${CACHE}.${process.pid}`, JSON.stringify({ at: Math.floor(Date.now() / 1000), rate_limits }));
    renameSync(`${CACHE}.${process.pid}`, CACHE);
  } catch {
  } finally {
    own?.close();
    running = false;
  }
}
