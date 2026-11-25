import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { imagesOf } from "./normalizer";
import type { Image } from "./items";

const files = new Map<string, string>();

async function transcript(id: string): Promise<string | null> {
  const known = files.get(id);
  if (known) {
    const text = await readFile(known, "utf8").catch(() => null);
    if (text !== null) return text;
  }
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  for (const dir of await readdir(root).catch(() => [] as string[])) {
    const file = join(root, dir, `${id}.jsonl`);
    const text = await readFile(file, "utf8").catch(() => null);
    if (text !== null) { files.set(id, file); return text; }
  }
  return null;
}

// Items are tool results (by tool_use_id) or user messages (by uuid).
export async function savedImages(session: string, item: string): Promise<Image[] | null> {
  const text = await transcript(session);
  if (!text) return null;
  for (const line of text.split("\n")) {
    if (!line.includes(item) || !line.includes('"image"')) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e.message?.content;
    if (e.uuid === item) return imagesOf(content);
    const r = Array.isArray(content) && content.find((c: any) => c?.type === "tool_result" && c.tool_use_id === item);
    if (r) return imagesOf(r.content);
  }
  return null;
}

// getSessionMessages starts at the latest compact; the parts before it are only linked by logicalParentUuid.
export async function beforeCompacts(id: string, later: { type: string; uuid?: string }[]): Promise<any[]> {
  const boundary = later[0]?.type === "system" ? later[0].uuid : null;
  if (!boundary) return [];
  const text = await transcript(id);
  if (!text) return [];
  const byUuid = new Map<string, any>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.uuid) byUuid.set(e.uuid, e);
    } catch {}
  }
  const seen = new Set(later.map((m) => m.uuid));
  const out: any[] = [], walked = new Set<string>();
  let e = byUuid.get(boundary);
  for (let cur = e?.parentUuid ?? e?.logicalParentUuid; cur && !walked.has(cur) && (e = byUuid.get(cur)); cur = e.parentUuid ?? e.logicalParentUuid) {
    walked.add(cur);
    if (seen.has(e.uuid) || e.isSidechain || (e.type !== "user" && e.type !== "assistant")) continue;
    seen.add(e.uuid);
    out.push({
      type: e.type, uuid: e.uuid, session_id: id, message: e.message, parent_tool_use_id: null,
      tool_use_result: e.toolUseResult, isCompactSummary: e.isCompactSummary, is_meta: e.isMeta, timestamp: e.timestamp,
    });
  }
  return out.reverse();
}

// Claude Code notes each PR a session opens or links as a "pr-link" entry.
export async function prLinks(id: string): Promise<string[]> {
  const text = await transcript(id);
  if (!text) return [];
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.includes('"type":"pr-link"')) continue;
    try { const url = JSON.parse(line).prUrl; if (url) out.add(url); } catch {}
  }
  return [...out];
}
