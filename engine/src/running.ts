import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Session } from "./session";

// Older than this, a cut-off turn is left alone: picking it up hours later would surprise more than help.
export const RESUME_WITHIN_MS = 15 * 60_000;
const BEAT_MS = 30_000;

export const CONTINUE = "The herdr-chat engine restarted and cut off your last turn. Continue where you left off. Anything that was running (commands, background shells, subagents) was killed, so check its state before relying on it.";

type Chat = { queue: string[] };
type File = { at: number; chats: Record<string, Chat> };

export function cutOff(file: string, now = Date.now()): Record<string, Chat> {
  if (!existsSync(file)) return {};
  try {
    const f = JSON.parse(readFileSync(file, "utf8")) as File;
    return now - f.at < RESUME_WITHIN_MS ? f.chats : {};
  } catch {
    return {};
  }
}

// Which chats are mid-turn, with what's queued behind them, kept on disk for the next engine.
export class Running {
  private last = "";
  private wrote = 0;

  constructor(private file: string, private sessions: () => Iterable<Session>) {}

  save(force = false) {
    const chats: Record<string, Chat> = {};
    for (const s of this.sessions()) {
      if (!s.state.busy || !s.state.session) continue;
      chats[s.key] = { queue: (s.state.queue ?? []).map((q) => q.text).filter(Boolean) };
    }
    const json = JSON.stringify(chats);
    if (!force && json === this.last && Date.now() - this.wrote < BEAT_MS) return;
    this.last = json;
    this.wrote = Date.now();
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ at: this.wrote, chats }));
    renameSync(`${this.file}.tmp`, this.file);
  }
}
