import { describe as group, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Normalizer } from "../src/normalizer";
import { AcpFeed } from "../src/acp-feed";

function play(file: string) {
  const rows = readFileSync(`${import.meta.dir}/fixtures/${file}`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cwd = rows.find((r) => r.msg.method === "session/new")?.msg.params.cwd ?? "/";
  const n = new Normalizer(cwd);
  const feed = new AcpFeed(n, "t");
  let loading: number | null = null;
  for (const r of rows) {
    if (r.dir === "out" && r.msg.method === "session/load") loading = r.msg.id;
    if (r.dir === "in" && loading !== null && r.msg.id === loading) { loading = null; feed.settle(); }
    if (r.msg.method === "session/update") feed.feed(r.msg.params.update, loading !== null);
    if (r.dir === "in" && r.msg.result?.stopReason) feed.end(1000, r.msg.result.stopReason);
  }
  return n;
}

group("agy tools", () => {
  const n = play("acp-agy-tools.jsonl");
  const tools = n.items.flatMap((i) => (i.kind === "tool" ? [i] : []));

  test("map to the Claude tools the pane draws", () => {
    expect(tools.map((t) => [t.name, t.status, t.verb, t.meta])).toEqual([
      ["Bash", "ok", "Ran", "List files and search return"],
      ["Read", "ok", "Read", "README.md"],
      ["Read", "ok", "Read", "src/calc.py"],
      ["Write", "ok", "Wrote", "src/mul.py"],
      ["Edit", "ok", "Edited", "src/calc.py"],
      ["Bash", "ok", "Ran", expect.any(String)],
      ["Bash", "ok", "Ran", expect.any(String)],
      ["TodoWrite", "ok", "Updated todos", "0/3 done"],
    ]);
  });

  test("shell output loses agy's header", () => {
    expect(tools[5]!.result).toBe("42");
  });

  test("edits carry a diff and an absolute path", () => {
    expect(tools[4]!.detail).toContain('+    """Return the sum of a and b."""');
    expect(tools[3]!.path).toEndWith("/src/mul.py");
  });

  test("text, thinking and turn ends come through", () => {
    const kinds = new Set(n.items.map((i) => i.kind));
    expect(kinds).toContain("text");
    expect(kinds).toContain("thinking");
    expect(n.items.filter((i) => i.kind === "turn_end")).toHaveLength(4);
    expect(n.items.some((i) => i.kind === "text" && i.streaming)).toBe(false);
  });

  test("state picks up models, mode, context and title", () => {
    expect(n.state.models.map((m) => m.value)).toContain("gemini-4-hydrogen");
    expect(n.state.models[0]!.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(n.state.mode).toBe("acceptEdits");
    expect(n.state.context.max).toBe(1048576);
    expect(n.state.context.used).toBeGreaterThan(0);
    expect(n.state.title).toBeTruthy();
  });
});

group("probe session", () => {
  const n = play("acp-agy.jsonl");

  test("a denied command ends as an error, a cancelled turn says so", () => {
    const rm = n.items.find((i) => i.kind === "tool" && i.detail?.startsWith("rm "));
    expect(rm?.kind === "tool" && rm.status).toBe("error");
    expect(n.items.some((i) => i.kind === "notice" && i.text === "Interrupted")).toBe(true);
  });

  test("replayed user messages become user rows", () => {
    const users = n.items.filter((i) => i.kind === "user");
    expect(users.map((u) => u.kind === "user" && u.text)).toContain("Read hello.txt in the current folder and tell me the secret word. Be brief.");
  });
});

test("questions stay hidden; agy writes them out as text", () => {
  const n = play("acp-agy-question.jsonl");
  expect(n.items.some((i) => i.kind === "tool")).toBe(false);
  expect(n.items.some((i) => i.kind === "text" && i.text.includes("Which colour"))).toBe(true);
});
