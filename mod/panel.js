import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, exec, focused, home, panes, run, setShared, shared, theme } from "herdr";
import { openFile } from "./filelinks.js";
import { TerminalSession } from "./terminal.js";
import { machineColor } from "./composer.js";

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));

const COLORS = { messages: "ansi4", mcp_tools: "ansi1", system_tools: "ansi2", skills: "ansi3", custom_agents: "ansi5", memory_files: "ansi6" };

// Chats publish themselves to shared "herdr-chat:info:<pane>"; Claude Code terminals are read from
// their transcript. The panel follows the focused one, else the last one it showed in the focused tab.
export class Panel {
  constructor(cx) {
    this.cx = cx;
    this.terms = new Map();
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
    if (!term || this.busy) return;
    this.busy = true;
    const h = term.machine ? null : home();
    try { await term.refresh((p) => (h && p?.startsWith(h) ? `~${p.slice(h.length)}` : p ?? "")); } catch {}
    this.busy = false;
    this.cx.notify();
  }

  render() {
    const t = theme();
    const a = this.current();
    const target = (cmd) => { setShared("herdr-chat:target", a.key); run(cmd); };
    const compact = () => (a.terminal ? this.terms.get(a.terminal)?.compact() : target("herdr-chat.compact"));
    const section = (title) => v_flex().w_full().gap(8).px(16).py(14).border_b_1().border_color(t.border)
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(title));
    const row = (icon, text, extra) => h_flex().gap(10).items_center().min_w(0).text_size(12.5)
      .child(svg(`mods/herdr-chat/icons/${icon}.svg`).size(15).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(text))
      .when(Boolean(extra), (el) => el.child(extra));
    const root = v_flex().id("chat-panel").size_full().bg(t.background).text_color(t.foreground).overflow_y_scrollbar();
    if (!a) return root.child(v_flex().size_full().items_center().justify_center().gap(6).p(16)
      .child(svg("icons/claude.svg").size(22).text_color(t.dim))
      .child(div().text_size(12.5).text_color(t.muted).child("No session"))
      .child(div().text_size(12).text_color(t.dim).text_center().child("Open a Claude chat in this tab to see its details here.")));

    const env = section("Environment")
      .when(Boolean(a.terminal || a.title), (el) => el.child(row("square-pen", a.terminal ? (a.title ? `Terminal · ${a.title}` : "Claude Code in a terminal") : a.title)))
      .child(row(a.machine ? "server" : "monitor", a.machine ?? "This computer",
        machineColor(a.machine) ? div().size(8).rounded(4).bg(machineColor(a.machine)) : null))
      .child(row("folder", a.folder ?? "No folder"))
      .when(Boolean(a.branch), (el) => el.child(row("git-branch", a.branch)))
      .when(Boolean(a.remote), (el) => el.child(row("monitor", "Remote Control on", div().id("remote-link").text_size(11.5).text_color(t.accent)
        .cursor_pointer().on_click(() => exec("open", [a.remote])).child("Open"))))
      .when(Boolean(a.model), (el) => el.child(row("file-text", a.model, div().text_size(11.5).text_color(t.dim).child(a.mode ?? ""))));

    const u = a.usage;
    const used = u ? u.categories.filter((c) => c.kind === "used") : [];
    const total = u?.total ?? a.context?.used ?? 0;
    const max = u?.max ?? a.context?.max ?? 0;
    const pct = max ? Math.round((total / max) * 100) : 0;
    const buffer = u?.categories.find((c) => c.kind === "buffer")?.tokens ?? 0;
    const color = (c) => t[COLORS[c.id] ?? "dim"] ?? t.dim;
    const ctx = section("Context")
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
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(compact).child("Compact session")));

    const outputs = section("Outputs")
      .when(!a.outputs?.length, (el) => el.child(div().text_size(12).text_color(t.dim).child("Files Claude creates or edits show up here.")))
      .children((a.outputs ?? []).map((o, i) => h_flex().id(`out-${i}`).gap(10).items_center().min_w(0).text_size(12.5).py(2).rounded(6)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => openFile(cx, o.path, a.machine ?? null))
        .child(svg(`mods/herdr-chat/icons/${o.created ? "file" : "square-pen"}.svg`).size(14).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().child(o.name))
        .when(o.add > 0, (el) => el.child(div().text_size(11.5).text_color(t.ansi2).child(`+${o.add}`)))
        .when(o.del > 0, (el) => el.child(div().text_size(11.5).text_color(t.ansi1).child(`-${o.del}`)))));

    const mcp = a.mcp?.length ? section("Needs sign-in").children(a.mcp.map((m) => h_flex().gap(10).items_center().min_w(0).text_size(12.5)
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(m.label))
      .child(div().id(`signin-${m.name}`).flex_none().px(8).py(2).rounded(6).border_1().border_color(t.border).bg(t.raised).text_size(11.5)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => { setShared("herdr-chat:signin", { key: a.key, server: m.name }); run("herdr-chat.signin"); })
        .child("Sign in"))))
      .child(div().id("mcp-manage").text_size(11.5).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click(() => target("herdr-chat.mcp")).child("Manage all servers…")) : null;

    const todos = a.todos?.length ? section("Tasks").children(a.todos.map((td) => h_flex().gap(8).text_size(12.5)
      .child(div().w(16).text_color(td.status === "completed" ? t.done : td.status === "in_progress" ? t.working : t.dim)
        .child(td.status === "completed" ? "✓" : td.status === "in_progress" ? "◐" : "○"))
      .child(div().flex_1().text_color(td.status === "completed" ? t.dim : t.foreground).child(td.content)))) : null;

    return root.child(env).when(Boolean(todos), (el) => el.child(todos)).child(ctx).child(outputs).when(Boolean(mcp), (el) => el.child(mcp));
  }
}
