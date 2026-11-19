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
      d.context = { used: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), max: 0 };
      d.model = modelName(e.message.model);
      d.branch = e.gitBranch && e.gitBranch !== "HEAD" ? e.gitBranch : null;
    }
  }

  compact() {
    return hc(["send", this.address, "/compact"]);
  }
}
