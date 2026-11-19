import { exec, hc } from "herdr";

const MODES = { default: "Ask before edits", acceptEdits: "Accept edits", plan: "Plan mode", auto: "Auto mode", bypassPermissions: "Bypass permissions" };

// $1 is the claude pid, $2 the transcript size already read; reads Claude Code's own session file and transcript.
const SCRIPT = `s="$HOME/.claude/sessions/$1.json"
[ -f "$s" ] || exit 3
cat "$s"; echo
sid=$(sed -n 's/.*"sessionId":"\\([^"]*\\)".*/\\1/p' "$s")
for f in "$HOME"/.claude/projects/*/"$sid".jsonl; do break; done
[ -f "$f" ] || exit 0
n=$(wc -c < "$f" | tr -d ' ')
echo "$n"
[ "$n" = "$2" ] && exit 0
grep '"type":"file-history-snapshot"' "$f" | tail -1
echo
tail -c 300000 "$f"`;

// The SDK's breakdown, scaled to the window the TUI itself reports through the statusline cache.
const CONTEXT = `cd "$HOME/projects/herdr-chat/engine" && "$HOME/.bun/bin/bun" context.ts "$1" "$2"
echo
cat "$HOME/.cache/claude-context/$1.json" 2>/dev/null`;

const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
const modelName = (m) => m?.replace(/^claude-([a-z]+)-(\d+)-(\d+).*/, (_, n, a, b) => `${n[0].toUpperCase()}${n.slice(1)} ${a}.${b}`) ?? "";

// A Claude Code TUI running in a Herdr terminal, read the same way for the side panel as a chat.
export class TerminalSession {
  constructor(address) {
    this.address = address;
    this.machine = address.includes("/") ? address.split("/")[0] : null;
    this.size = "";
    this.data = null;
  }

  async refresh(tilde) {
    if (!this.pid) {
      const r = await hc(["get", this.address, "--json"]);
      this.pid = parse(r.stdout)?.foreground?.pid;
      if (!this.pid) return;
    }
    const r = await exec("sh", ["-c", SCRIPT, "sh", String(this.pid), this.size], { on: this.machine });
    if (r.code === 3) return void (this.pid = null);
    const lines = r.stdout.split("\n");
    const info = parse(lines[0]);
    if (!info) return;
    const d = (this.data ??= { terminal: this.address, machine: this.machine, outputs: [], context: { used: 0, max: 0 } });
    d.folder = tilde(info.cwd);
    d.title = info.name ?? null;
    if (!lines[1] || lines[1] === this.size) return;
    this.size = lines[1];
    const snap = parse(lines[2])?.snapshot?.trackedFileBackups ?? {};
    d.outputs = Object.entries(snap)
      .sort((a, b) => (b[1].backupTime ?? "").localeCompare(a[1].backupTime ?? ""))
      .map(([p, b]) => {
        const name = p.split("/").pop();
        const path = p.startsWith("/") ? p : `${b.realParentDir ?? info.cwd}/${name}`;
        return { path, name, created: b.backupFileName === null, add: 0, del: 0 };
      });
    for (const l of lines.slice(3)) {
      const e = l.includes('"type":"assistant"') || l.includes('"type":"permission-mode"') ? parse(l) : null;
      if (e?.type === "permission-mode") d.mode = MODES[e.permissionMode] ?? e.permissionMode;
      const u = e?.type === "assistant" && !e.isSidechain ? e.message?.usage : null;
      if (!u) continue;
      d.context = { used: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), max: this.max ?? 0 };
      d.model = modelName(e.message.model);
      d.branch = e.gitBranch && e.gitBranch !== "HEAD" ? e.gitBranch : null;
    }
    if (d.context.used && Date.now() - (this.ctxAt ?? 0) > 60000) {
      this.ctxAt = Date.now();
      await this.breakdown(info.sessionId, info.cwd);
    }
    this.apply();
  }

  async breakdown(session, cwd) {
    const r = await exec("sh", ["-c", CONTEXT, "sh", session, cwd], { on: this.machine, timeout: 40000 });
    const [sdk, line] = r.stdout.split("\n").map(parse);
    if (!sdk?.categories) return;
    this.sdk = sdk;
    this.max = line?.context_window?.context_window_size ?? sdk.max;
  }

  // Messages take whatever the real usage leaves after the fixed parts, since the SDK only estimates them.
  apply() {
    const d = this.data;
    if (!this.sdk || !d.context.used) return;
    const used = d.context.used;
    const fixed = this.sdk.categories.filter((c) => c.kind === "used" && c.id !== "messages").reduce((n, c) => n + c.tokens, 0);
    const categories = this.sdk.categories.map((c) => (c.id === "messages" ? { ...c, tokens: Math.max(0, used - fixed) } : c));
    d.usage = { total: used, max: this.max, categories };
    d.context = { used, max: this.max };
  }

  compact() {
    return hc(["send", this.address, "/compact"]);
  }
}
