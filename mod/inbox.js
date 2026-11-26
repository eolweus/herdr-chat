import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home, machines, panes, props, run, settings, shared, spaces, theme } from "herdr";
import { CodeCache } from "./markdown.js";
import { FileLinks } from "./filelinks.js";
import { permissionCard, questionCard, questionMethods } from "./cards.js";
import { AGENTS, agentIcon } from "./composer.js";
import { endpoint } from "./engine.js";

const POLL_MS = 1500;
// A machine that stops answering keeps its last list this long, so a blip doesn't drop rows.
const KEEP_MS = 15000;

const tilde = (path, h) => (h && path?.startsWith(h) ? `~${path.slice(h.length)}` : path ?? "");
const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
const lang = (tool) => (tool === "Bash" ? "bash" : "");

export class Inbox {
  constructor(cx) {
    this.cx = cx;
    this.byMachine = new Map();
    this.ends = new Map();
    this.picked = null;
    this.answered = new Set();
    this.codes = new CodeCache();
    this.links = new FileLinks();
    this.mono = settings().font_family;
    this.picks = new Map();
    this.qPage = new Map();
    this.otherInputs = new Map();
    this.home = home();
    this.poll();
    cx.timer.every(POLL_MS, () => this.poll());
  }

  async end(machine) {
    if (!this.ends.has(machine)) {
      const e = await endpoint(machine, undefined);
      this.ends.set(machine, { url: e.url.replace(/^ws/, "http").replace(/\/+$/, ""), token: e.token });
    }
    return this.ends.get(machine);
  }

  async poll() {
    const names = props()?.engine ? [null] : [null, ...machines().filter((m) => m.name && m.layout === "ready").map((m) => m.name)];
    await Promise.all(names.map(async (machine) => {
      try {
        const e = await this.end(machine);
        const res = await fetch(`${e.url}/api/pending`, { headers: { authorization: `Bearer ${e.token}` } });
        if (res.status === 401) this.ends.delete(machine);
        if (!res.ok) throw new Error(String(res.status));
        const { pending } = await res.json();
        this.byMachine.set(machine, { list: pending.map((p) => ({ ...p, machine })), at: Date.now() });
      } catch {
        const was = this.byMachine.get(machine);
        if (was && Date.now() - was.at > KEEP_MS) this.byMachine.delete(machine);
      }
    }));
    for (const m of this.byMachine.values()) for (const { item } of m.list) {
      if (item.kind === "permission" && item.detail) this.codes.prepare(`detail:${item.id}`, lang(item.tool), item.detail, theme());
      if (item.kind === "question" && !this.otherInputs.has(item.id)) this.prepareQuestion(item);
    }
    this.cx.notify();
  }

  // Chats from the engines, then agents in terminals, which can only be answered where they run.
  list() {
    const ps = panes();
    const where = (p) => {
      const space = spaces().find((s) => s.id === p?.space);
      const tab = space?.tabs?.find((x) => x.id === p?.tab);
      return [space?.name, tab?.name].filter(Boolean).join(" · ");
    };
    const chats = [...this.byMachine.values()].flatMap((m) => m.list).filter((c) => !this.answered.has(c.item.id)).map((c) => {
      const pane = ps.find((p) => p.mod === "herdr-chat" && shared(`herdr-chat:info:${p.pane}`)?.key === c.key && (shared(`herdr-chat:info:${p.pane}`)?.machine ?? null) === c.machine);
      return { kind: "chat", id: `${c.machine ?? ""}/${c.key}`, name: firstLine(c.title) || "Chat", where: [pane ? where(pane) : c.handoff ? "handoff" : "no pane open", tilde(c.cwd, this.home), c.machine].filter(Boolean).join(" · "), pane: pane?.pane ?? null, chat: c };
    });
    const terms = ps.filter((p) => p.terminal && p.status === "blocked").map((p) => ({
      kind: "terminal", id: `term/${p.pane}`, name: p.name || p.title || p.program?.name || "Agent", where: [where(p), tilde(p.cwd, this.home)].filter(Boolean).join(" · "), pane: p.pane, program: p.program,
    }));
    const seen = new Set(chats.map((c) => c.pane).filter(Boolean));
    const stale = ps.filter((p) => p.mod === "herdr-chat" && !seen.has(p.pane) && shared(`herdr-chat:pane:${p.pane}`)?.status === "blocked").map((p) => {
      const info = shared(`herdr-chat:pane:${p.pane}`);
      return { kind: "pane", id: `pane/${p.pane}`, name: firstLine(info?.title) || "Chat", where: [where(p), info?.folder].filter(Boolean).join(" · "), pane: p.pane, backend: info?.backend };
    });
    return [...chats, ...stale, ...terms];
  }

  agent() {
    return AGENTS[this.current?.chat?.backend ?? "claude"] ?? "Claude";
  }

  async answer(a, cx) {
    const c = this.current?.chat;
    if (!c) return;
    this.answered.add(a.item);
    cx.notify();
    try {
      const e = await this.end(c.machine);
      const res = await fetch(`${e.url}/api/answer`, { method: "POST", headers: { authorization: `Bearer ${e.token}`, "content-type": "application/json" }, body: JSON.stringify({ key: c.key, ...a }) });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      this.answered.delete(a.item);
      cx.notify();
    }
  }

  openLink(href, cx) {
    if (/^https?:\/\//.test(href)) cx.open_url(href);
  }

  open(entry) {
    if (entry.pane) run("pane.focus", { pane: entry.pane });
  }

  render() {
    const t = theme();
    const list = this.list();
    if (!list.length) {
      return v_flex().size_full().min_h(0).min_w(0).overflow_hidden().items_center().justify_center().gap(8).bg(t.background).text_color(t.muted)
        .child(div().text_size(28).text_color(t.done).child("✓"))
        .child(div().text_size(17).font_semibold().text_color(t.foreground).child("All clear"))
        .child(div().text_size(13).child("No agent is waiting for you."));
    }
    const cur = list.find((e) => e.id === this.picked) ?? list[0];
    this.current = cur;
    const item = cur.chat?.item;
    const row = (e) => {
      const on = e.id === cur.id;
      const icon = e.kind !== "terminal" ? agentIcon(e.chat?.backend ?? e.backend ?? "claude", 16, t.muted) : e.program?.icon ? svg(e.program.icon).size(16).text_color(t.muted) : null;
      return h_flex().id(`need-${e.id}`).px(10).py(8).gap(10).items_center().rounded(8).cursor_pointer()
        .bg(on ? t.selected : t.background).hover((s) => s.bg(on ? t.selected : t.hover))
        .on_click((_e, cx) => { this.picked = e.id; cx.notify(); })
        .when(Boolean(icon), (el) => el.child(div().flex_none().child(icon)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(13.5).text_color(t.foreground).child(e.name))
          .child(div().truncate().text_size(11.5).text_color(t.muted).child(e.where)))
        .child(div().size(8).flex_none().rounded(4).bg(t.blocked));
    };
    const detail = item
      ? (item.kind === "question" ? questionCard(item, t, this) : permissionCard(item, t, this))
      : div().px(22).text_size(13).text_color(t.muted).child(cur.kind === "terminal" ? "It's waiting in its terminal. Open it to answer." : "Its engine can't show the card here yet. Open the chat to answer.");
    return h_flex().id("inbox").size_full().min_h(0).min_w(0).overflow_hidden().items_start().bg(t.background).text_color(t.foreground)
      .child(v_flex().id("inbox-list").w(320).flex_none().h_full().p(10).gap(2).border_r_1().border_color(t.border).overflow_y_scrollbar()
        .child(div().px(4).pb(6).text_size(15).font_semibold().child(`Needs you · ${list.length}`))
        .children(list.map(row)))
      .child(v_flex().id("inbox-detail").flex_1().min_w(0).h_full().overflow_y_scrollbar().py(24).gap(12).items_center()
        .child(v_flex().w_full().max_w(880).gap(12)
          .child(v_flex().px(22).gap(2)
            .child(div().text_size(18).font_semibold().child(cur.name))
            .child(div().text_size(12.5).text_color(t.muted).child(cur.where)))
          .child(detail)
          .when(Boolean(cur.pane), (el) => el.child(div().px(22).child(div().id("inbox-open").px(14).h(32).flex().items_center().rounded(8).cursor_pointer().text_size(13)
            .bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9))
            .on_click(() => this.open(cur)).child(cur.kind === "terminal" ? "Open terminal" : "Open chat"))))));
  }
}

Object.assign(Inbox.prototype, questionMethods);
