import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, exec, focused, home, panes, run, setShared, shared, theme } from "herdr";
import { openFile } from "./filelinks.js";
import { TerminalSession } from "./terminal.js";
import { machineColor } from "./composer.js";

const DOCS = /\.(md|markdown|html?|pdf)$/i;

const PR_FIELDS = "number,title,state,isDraft,additions,deletions,statusCheckRollup";
const PR_MS = 60000;

function checks(rollup) {
  const states = (rollup ?? []).map((c) => (c.conclusion || c.state || c.status || "").toUpperCase());
  if (!states.length) return null;
  if (states.some((s) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(s))) return "failed";
  if (states.some((s) => ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "WAITING", ""].includes(s))) return "pending";
  return "passed";
}

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));

const PARTS = ["ansi4", "ansi2", "ansi3", "ansi5", "ansi6", "ansi1"];
const size = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

const COLORS = { messages: "ansi4", mcp_tools: "ansi1", system_tools: "ansi2", skills: "ansi3", custom_agents: "ansi5", memory_files: "ansi6" };

// Chats publish themselves to shared "herdr-chat:info:<pane>"; Claude Code terminals are read from
// their transcript. The panel follows the focused one, else the last one it showed in the focused tab.
export class Panel {
  constructor(cx) {
    this.cx = cx;
    this.terms = new Map();
    this.prs = new Map();
    cx.timer.every(3000, () => this.poll());
  }

  current() {
    const f = focused();
    const chats = panes().filter((p) => p.mod === "herdr-chat" && p.tab === f?.tab).map((p) => p.pane);
    const tuis = agents().filter((a) => a.app === "claude-code" && a.tab === f?.tab);
    const all = [...chats, ...tuis.map((a) => a.pane)];
    const pick = all.includes(f?.pane) ? f.pane : all.includes(this.last) ? this.last : all[0];
    if (pick !== this.last) { this.last = pick; this.watch = null; }
    if (!pick) return null;
    const tui = tuis.find((a) => a.pane === pick);
    if (!tui) return shared(`herdr-chat:info:${pick}`);
    if (!this.terms.has(tui.address)) this.terms.set(tui.address, new TerminalSession(tui.address));
    const term = this.terms.get(tui.address);
    if (this.watch !== term) { this.watch = term; this.poll(); }
    return term.data;
  }

  async poll() {
    const term = this.watch;
    if (!term) {
      const info = this.last ? shared(`herdr-chat:info:${this.last}`) : null;
      if (info !== this.shown) { this.shown = info; this.cx.notify(); }
      return;
    }
    if (this.busy) return;
    this.busy = true;
    const h = term.machine ? null : home();
    try { await term.refresh((p) => (h && p?.startsWith(h) ? `~${p.slice(h.length)}` : p ?? "")); } catch {}
    this.busy = false;
    this.cx.notify();
  }

  // gh answers for any machine's PR, so the Mac asks; once a minute per PR while it's shown.
  pr(url) {
    const c = this.prs.get(url);
    if (!c || (!c.busy && Date.now() - c.at > PR_MS)) {
      const next = { data: c?.data ?? null, at: Date.now(), busy: true };
      this.prs.set(url, next);
      exec("/bin/zsh", ["-lc", `exec gh pr view "$1" --json ${PR_FIELDS}`, "zsh", url], { timeout: 20000 })
        .then((r) => { if (r.code === 0) next.data = JSON.parse(r.stdout); })
        .catch(() => {})
        .finally(() => { next.busy = false; next.at = Date.now(); this.cx.notify(); });
    }
    return c?.data ?? null;
  }

  render() {
    const t = theme();
    const a = this.current();
    const target = (cmd) => { setShared("herdr-chat:target", a.key); run(cmd); };
    const compact = () => (a.terminal ? this.terms.get(a.terminal)?.compact() : target("herdr-chat.compact"));
    const isOpen = (id, dflt = true) => shared(`herdr-chat:open:${id}`) ?? dflt;
    const section = (id, title, body, { extra = null, dflt = true } = {}) => {
      const open = isOpen(id, dflt);
      return v_flex().w_full().gap(8).px(16).py(14).border_b_1().border_color(t.border)
        .child(h_flex().id(`${id}-head`).gap(6).items_center().cursor_pointer()
          .on_click((_e, cx) => { setShared(`herdr-chat:open:${id}`, !open); cx.notify(); })
          .child(svg(`mods/herdr-chat/icons/chevron-${open ? "down" : "right"}.svg`).size(13).flex_none().text_color(t.dim))
          .child(div().flex_1().text_size(12.5).font_semibold().text_color(t.foreground).child(title))
          .when(Boolean(extra), (el) => el.child(extra)))
        .when(open, (el) => el.child(body()));
    };
    const body = () => v_flex().w_full().gap(8);
    const row = (icon, text, extra) => h_flex().gap(10).items_center().min_w(0).text_size(12.5)
      .child(svg(`mods/herdr-chat/icons/${icon}.svg`).size(15).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(text))
      .when(Boolean(extra), (el) => el.child(extra));
    const link = (id, label, fn) => div().id(id).flex_none().text_size(11.5).text_color(t.accent).cursor_pointer()
      .hover((s) => s.opacity(0.8)).on_click(fn).child(label);
    const toggle = (id, on, pending) => div().id(id).flex_none().w(28).h(16).p(2).rounded(8).flex().items_center()
      .when(on, (el) => el.justify_end()).bg(on ? t.accent : t.raised).border_1().border_color(on ? t.accent : t.border)
      .when(Boolean(pending), (el) => el.opacity(0.6))
      .child(div().size(10).rounded(5).bg(on ? t.solid_foreground : t.dim));
    const root = v_flex().id("chat-panel").size_full().bg(t.background).text_color(t.foreground).overflow_y_scrollbar();
    if (!a) return root.child(v_flex().size_full().items_center().justify_center().gap(6).p(16)
      .child(svg("icons/claude.svg").size(22).text_color(t.dim))
      .child(div().text_size(12.5).text_color(t.muted).child("No session"))
      .child(div().text_size(12).text_color(t.dim).text_center().child("Open a Claude chat in this tab to see its details here.")));

    const env = section("environment", "Environment", () => body()
      .when(Boolean(a.terminal || a.title), (el) => el.child(row("square-pen", a.terminal ? (a.title ? `Terminal · ${a.title}` : "Claude Code in a terminal") : a.title)))
      .child(row(a.machine ? "server" : "monitor", a.machine ?? "This computer",
        machineColor(a.machine) ? div().size(8).rounded(4).bg(machineColor(a.machine)) : null))
      .child(row("folder", a.folder ?? "No folder"))
      .when(Boolean(a.branch), (el) => el.child(row("git-branch", a.branch)))
      .when(Boolean(a.terminal && a.remote), (el) => el.child(row("smartphone", "Remote Control on", link("remote-link", "Open", () => exec("open", [a.remote])))))
      .when(!a.terminal, (el) => el.child(h_flex().id("remote-row").cursor_pointer().on_click(() => target("herdr-chat.remote"))
        .tooltip(a.remote ? "Open on claude.ai/code and in the Claude app on your phone" : "Continue this chat from claude.ai/code or your phone")
        .child(row("smartphone", a.remotePending ? "Connecting…" : "Remote Control", toggle("remote-toggle", Boolean(a.remote), a.remotePending)).flex_1())))
      .when(!a.terminal && Boolean(a.remote), (el) => el.child(h_flex().gap(10).pl(25).text_size(11.5)
        .child(link("remote-open", "Open in browser", () => exec("open", [a.remote])))
        .child(link("remote-copy", "Copy link", (_e, cx) => cx.write_to_clipboard(a.remote)))))
      .when(Boolean(a.model), (el) => el.child(row("file-text", a.model, div().text_size(11.5).text_color(t.dim).child(a.mode ?? "")))));

    const u = a.usage;
    const used = u ? u.categories.filter((c) => c.kind === "used") : [];
    const total = u?.total ?? a.context?.used ?? 0;
    const max = u?.max ?? a.context?.max ?? 0;
    const pct = max ? Math.round((total / max) * 100) : 0;
    const buffer = u?.categories.find((c) => c.kind === "buffer")?.tokens ?? 0;
    const color = (c) => t[COLORS[c.id] ?? "dim"] ?? t.dim;
    const ctx = section("context", "Context", () => body()
      .child(h_flex().text_size(12.5).child(div().flex_1().child(max ? `${pct}% used` : total ? `${fmt(total)} tokens` : "Not measured yet"))
        .when(Boolean(max), (el) => el.child(div().text_color(t.dim).child(`${fmt(total)} / ${fmt(max)}`))))
      .when(Boolean(max), (el) => el.child(h_flex().w_full().h(6).rounded(3).bg(t.raised).overflow_hidden()
        .children(used.length
          ? used.map((c) => div().h_full().flex_basis(0).flex_grow(c.tokens).bg(color(c)))
            .concat([div().h_full().flex_basis(0).flex_grow(Math.max(0, max - total))])
          : [div().h_full().bg(t.accent).w(`${pct}%`)])))
      .children(used.map((c) => h_flex().gap(8).items_center().text_size(12)
        .child(div().size(8).rounded(2).bg(color(c)))
        .child(div().flex_1().text_color(t.muted).child(c.name))
        .child(div().w(48).text_right().text_color(t.dim).child(fmt(c.tokens)))
        .child(div().w(44).text_right().text_color(t.dim).child(`${((c.tokens / max) * 100).toFixed(1)}%`))))
      .child(h_flex().items_center().pt(4)
        .child(div().flex_1().text_size(12).text_color(t.dim).child(max && buffer ? `${fmt(Math.max(0, max - buffer - total))} until auto-compact` : ""))
        .child(div().id("compact").px(10).py(4).rounded(7).bg(t.raised).border_1().border_color(t.border).text_size(12)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(compact).child("Compact session"))),
      { extra: !isOpen("context") && max ? div().text_size(12).text_color(t.dim).child(`${pct}%`) : null });

    const file = (o, i, prefix) => h_flex().id(`${prefix}-${i}`).gap(10).items_center().min_w(0).text_size(12.5).py(2).rounded(6)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => openFile(cx, o.path, a.machine ?? null, { beside: a.pane ?? null }))
        .child(svg(`mods/herdr-chat/icons/${o.created ? "file" : "square-pen"}.svg`).size(14).flex_none().text_color(t.dim))
        .tooltip(o.path).child(div().flex_1().min_w(0).truncate().child(`…/${o.path.split("/").pop()}`))
        .when(o.add > 0, (el) => el.child(div().text_size(11.5).text_color(t.ansi2).child(`+${o.add}`)))
        .when(o.del > 0, (el) => el.child(div().text_size(11.5).text_color(t.ansi1).child(`-${o.del}`)));
    const docs = (a.outputs ?? []).filter((o) => DOCS.test(o.path));
    const outputs = section("outputs", "Outputs", () => body()
      .when(!docs.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("Documents, pages and PDFs Claude writes show up here.")))
      .children(docs.map((o, i) => file(o, i, "out"))),
      { extra: docs.length ? div().text_size(12).text_color(t.dim).child(String(docs.length)) : null });
    const prs = (a.prs ?? []).map((url) => ({ url, repo: url.split("/").slice(3, 5).join("/"), d: this.pr(url) })).filter((p) => p.d?.state === "OPEN");
    const repos = (a.repos ?? []).filter((r) => !prs.some((p) => p.repo === r.remote));
    const lines = (add, del, rest) => h_flex().gap(6).text_size(11.5)
      .when(Boolean(rest), (el) => el.child(div().text_color(t.dim).child(rest)))
      .child(div().text_color(t.ansi2).child(`+${add}`)).child(div().text_color(t.ansi1).child(`−${del}`));
    const change = (id, icon, tint, title, sub, dot, click) => h_flex().id(id).gap(10).items_start().min_w(0).py(3).rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(click)
      .child(svg(`mods/herdr-chat/icons/${icon}.svg`).size(15).mt(1).flex_none().text_color(tint))
      .child(v_flex().flex_1().min_w(0).gap(2).child(div().truncate().text_size(12.5).child(title)).child(sub))
      .when(Boolean(dot), (el) => el.child(div().size(7).mt(14).mr(4).flex_none().rounded(4).bg(dot)));
    const checkColor = { passed: t.done, pending: t.working, failed: t.blocked };
    const changes = prs.length || repos.length ? section("changes", "Changes", () => body()
      .children(prs.map((p, i) => change(`pr-${i}`, "git-pull-request", p.d.isDraft ? t.dim : t.ansi2, p.d.title,
        lines(p.d.additions, p.d.deletions, `#${p.d.number}`), checkColor[checks(p.d.statusCheckRollup)], () => exec("open", [p.url]))))
      .children(repos.map((r, i) => change(`repo-${i}`, "git-branch", t.dim, r.name,
        lines(r.add, r.del, `${r.files} ${r.files === 1 ? "file" : "files"}`), null,
        () => { run("layout.select", { stack: "panel-body", child: "changes" }); run("layout.show", { id: "panel" }); })))) : null;
    const count = (n) => div().text_size(12).text_color(t.dim).child(String(n));
    const tasks = a.tasks?.length ? section("running", "Running tasks", () => body().children(a.tasks.map((k) => row(k.type.includes("agent") ? "bot" : "terminal", k.description || k.type))),
      { extra: count(a.tasks.length) }) : null;

    const mcp = a.mcp?.length ? section("signin", "Needs sign-in", () => body().children(a.mcp.map((m) => h_flex().gap(10).items_center().min_w(0).text_size(12.5)
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(m.label))
      .child(div().id(`signin-${m.name}`).flex_none().px(8).py(2).rounded(6).border_1().border_color(t.border).bg(t.raised).text_size(11.5)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => { setShared("herdr-chat:signin", { key: a.key, server: m.name }); run("herdr-chat.signin"); })
        .child("Sign in"))))
      .child(div().id("mcp-manage").text_size(11.5).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click(() => target("herdr-chat.mcp")).child("Manage all servers…")), { extra: count(a.mcp.length) }) : null;

    const m = a.memory;
    const part = (i) => t[PARTS[i % PARTS.length]] ?? t.dim;
    const memory = a.terminal ? null : section("memory", "Memory", () => body()
      .when(!m, (el) => el.child(div().text_size(12).text_color(t.dim)
        .child("Claude stops after 5 idle minutes, or sooner when other chats need room, and starts again when you open the chat.")))
      .when(Boolean(m), (el) => el
        .child(h_flex().w_full().h(6).rounded(3).bg(t.raised).overflow_hidden()
          .children(m.parts.map((p, i) => div().h_full().flex_basis(0).flex_grow(Math.max(p.mb, 1)).bg(part(i)))))
        .children(m.parts.map((p, i) => h_flex().gap(8).items_center().text_size(12)
          .child(div().size(8).rounded(2).bg(part(i)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(p.name))
          .when(p.procs > 1, (r) => r.child(div().text_color(t.dim).child(`${p.procs} processes`)))
          .child(div().w(56).text_right().text_color(t.dim).child(size(p.mb)))))),
      { dflt: false, extra: div().id("memory-total").text_size(12).text_color(t.dim).child(m ? `${m.approx ? "≈ " : ""}${size(m.mb)}` : "Not running")
        .when(Boolean(m?.approx), (el) => el.tooltip("Counts memory that processes share in each of them, so it runs high")) });

    const todos = a.todos?.length ? section("todos", "Tasks", () => body().children(a.todos.map((td) => h_flex().gap(8).text_size(12.5)
      .child(div().w(16).text_color(td.status === "completed" ? t.done : td.status === "in_progress" ? t.working : t.dim)
        .child(td.status === "completed" ? "✓" : td.status === "in_progress" ? "◐" : "○"))
      .child(div().flex_1().text_color(td.status === "completed" ? t.dim : t.foreground).child(td.content)))),
      { extra: count(`${a.todos.filter((td) => td.status === "completed").length}/${a.todos.length}`) }) : null;

    return root.child(env).when(Boolean(todos), (el) => el.child(todos)).child(ctx).when(Boolean(memory), (el) => el.child(memory)).child(outputs).when(Boolean(mcp), (el) => el.child(mcp))
      .when(Boolean(changes), (el) => el.child(changes)).when(Boolean(tasks), (el) => el.child(tasks));
  }
}
