import { describe as group, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Normalizer, cleanUserText } from "../src/normalizer";
import { Session } from "../src/session";
import { diff, describe } from "../src/tools";

const lines = readFileSync(`${import.meta.dir}/fixtures/basic.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sdk = lines.filter((m) => m.type !== "_ask");
const cwd = sdk.find((m) => m.subtype === "init").cwd;

function live() {
  const n = new Normalizer(cwd);
  for (const m of sdk) n.feed(m);
  return n;
}

const shape = (n: Normalizer) => n.items.map((i) => (i.kind === "tool" ? `tool:${i.name}:${i.status}` : i.kind));

group("live session", () => {
  const n = live();
  const tools = n.items.filter((i) => i.kind === "tool");

  test("every tool finishes with a past-tense verb and a short target", () => {
    expect(tools.map((t) => [t.name, t.status, t.verb, t.meta])).toEqual([
      ["Bash", "ok", "Ran", expect.any(String)],
      ["Read", "ok", "Read", "notes.txt"],
      ["Write", "ok", "Wrote", "hello.py"],
      ["Edit", "ok", "Edited", "hello.py"],
    ]);
  });

  test("edits carry a diff", () => {
    const edit = tools.find((t) => t.name === "Edit")!;
    expect(edit.detail).toMatch(/^[-+]/m);
    expect(edit.detail).toContain("+");
  });

  test("AskUserQuestion shows as an answered question card, not a tool row", () => {
    expect(tools.some((t) => t.name === "AskUserQuestion")).toBe(false);
    expect(n.items.find((i) => i.kind === "question")).toMatchObject({ state: "answered", answers: { "Should hello.py print red or blue?": "Blue" } });
  });

  test("streamed text is finished and not duplicated by the final message", () => {
    const texts = n.items.filter((i) => i.kind === "text");
    const blocks = sdk.filter((m) => m.type === "assistant").flatMap((m) => m.message.content).filter((b: any) => b.type === "text");
    expect(texts.length).toBe(blocks.length);
    for (const t of texts) expect(t.kind === "text" && t.streaming).toBe(false);
    const last = texts.at(-1)!;
    expect(last.kind === "text" && last.text).toContain("```python");
  });

  test("the turn ends and state settles", () => {
    expect(n.items.at(-1)?.kind).toBe("turn_end");
    expect(n.state.busy).toBe(false);
    expect(n.state.session).toBeTruthy();
    expect(n.state.context.max).toBeGreaterThan(0);
    expect(n.state.context.used).toBeGreaterThan(0);
  });
});

test("history without stream events looks the same as the live run", () => {
  const n = new Normalizer(cwd);
  for (const m of sdk) if (m.type !== "stream_event") n.feed({ ...m, isReplay: true });
  expect(shape(n)).toEqual(shape(live()));
});

test("subagent tools hang off their agent row", () => {
  const n = new Normalizer("/p");
  n.feed({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "tool_use", id: "a", name: "Agent", input: { description: "look around" } }] } });
  n.feed({ type: "assistant", parent_tool_use_id: "a", message: { id: "m2", content: [{ type: "tool_use", id: "b", name: "Read", input: { file_path: "/p/x.ts" } }] } });
  const agent = n.get("a");
  const child = n.get("b");
  expect(agent?.kind === "tool" && agent.children).toBe(1);
  expect(child?.kind === "tool" && [child.parent, child.meta]).toEqual(["a", "x.ts"]);
});

group("user text", () => {
  test("slash commands show as typed", () => {
    expect(cleanUserText("<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>42</command-args>")).toBe("/review 42");
  });
  test("reminders are dropped", () => {
    expect(cleanUserText("<system-reminder>x</system-reminder>\nhi")).toBe("hi");
    expect(cleanUserText("<system-reminder>x</system-reminder>")).toBeNull();
    expect(cleanUserText("<local-command-stdout>ok</local-command-stdout>")).toBeNull();
  });
});

group("tools", () => {
  test("diff keeps only the changed middle", () => {
    expect(diff("a\nb\nc", "a\nB\nc")).toBe("-b\n+B");
  });
  test("mcp tools name their server", () => {
    expect(describe("mcp__linear__get_issue", { id: "LIN-1" }, "/")).toMatchObject({ done: "get_issue", meta: "linear · LIN-1" });
  });
});

group("cards", () => {
  const session = () => new Session("k", "/p", null, () => {});

  test("allow for session turns suggestions into session rules", async () => {
    const s = session();
    const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "localSettings" }];
    const r = (s as any).ask("Bash", { command: "ls" }, "t1", suggestions);
    expect(s.n.get("perm:t1")).toMatchObject({ kind: "permission", meta: "ls", remember: true, state: "pending" });
    s.answer({ item: "perm:t1", decision: "session" });
    expect(await r).toMatchObject({ behavior: "allow", updatedPermissions: [{ destination: "session" }] });
    expect(s.n.get("perm:t1")).toMatchObject({ state: "allowed" });
  });

  test("deny passes the reason to Claude", async () => {
    const s = session();
    const r = (s as any).ask("Write", { file_path: "/p/a" }, "t2");
    s.answer({ item: "perm:t2", decision: "deny", message: "not there" });
    expect(await r).toEqual({ behavior: "deny", message: "not there" });
  });

  test("questions answer through updatedInput", async () => {
    const s = session();
    const input = { questions: [{ question: "Colour?", header: "c", multiSelect: false, options: [] }] };
    const r = (s as any).ask("AskUserQuestion", input, "t3");
    s.answer({ item: "q:t3", answers: { "Colour?": "Blue" } });
    expect(await r).toEqual({ behavior: "allow", updatedInput: { ...input, answers: { "Colour?": "Blue" } } });
  });

  test("interrupt clears waiting cards", async () => {
    const s = session();
    const r = (s as any).ask("Bash", { command: "rm -rf x" }, "t4");
    await s.interrupt();
    expect(await r).toMatchObject({ behavior: "deny", interrupt: true });
    expect(s.n.get("perm:t4")).toMatchObject({ state: "denied" });
  });
});
