import { div } from "gpui-kit";
import { h_flex, InputState, Input } from "gpui-base";
import { split } from "./markdown.js";
import { splitQuotes } from "./quote.js";

// Offsets of q in text, case-insensitively.
export function occurrences(text, q) {
  const out = [];
  if (!q) return out;
  const hay = text.toLowerCase(), needle = q.toLowerCase();
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

// Find in the loaded part of a chat: your messages and the replies, prose and code.
export class Find {
  constructor(view) {
    this.view = view;
    this.open = false;
    this.q = "";
    this.at = 0;
    this.input = null;
    this.list = [];
  }

  show(cx) {
    if (!this.input) {
      this.input = InputState.new({ placeholder: "Find in chat" });
      this.input.on("change", (_e, cx) => { this.q = this.input.value(); this.at = 0; this.reveal(cx); });
      this.input.on("submit", (e, cx) => this.step(e.shift ? -1 : 1, cx));
    }
    this.open = true;
    this.input.focus();
    const n = this.input.value().length;
    if (n) this.input.set_selected_range({ start: 0, end: n });
    this.reveal(cx);
  }

  hide(cx) {
    this.open = false;
    this.view.target = null;
    this.view.input.focus();
    cx.notify();
  }

  // Each match as {id, key, start}: key names the markdown part (`id:i`) or the user message's body.
  matches() {
    const v = this.view, out = [];
    if (!this.open || !this.q) return out;
    for (const item of v.lastShown ?? []) {
      if (item.kind === "user") {
        for (const s of occurrences(splitQuotes(item.text).body ?? "", this.q)) out.push({ id: item.id, key: `${item.id}:user`, start: s });
      } else if (item.kind === "text") {
        split(item.text || " ").forEach((p, i) => {
          const src = p.kind === "md" ? (v.links ? v.links.linkify(p.text) : p.text) : p.code;
          for (const s of occurrences(src, this.q)) out.push({ id: item.id, key: `${item.id}:${i}`, start: s });
        });
      }
    }
    return out;
  }

  refresh() {
    this.list = this.matches();
    if (this.at >= this.list.length) this.at = Math.max(0, this.list.length - 1);
    return this.list;
  }

  current() {
    return this.open ? this.list[this.at] ?? null : null;
  }

  step(d, cx) {
    const n = this.refresh().length;
    if (!n) return;
    this.at = (this.at + d + n) % n;
    this.reveal(cx);
  }

  reveal(cx) {
    const m = this.refresh()[this.at];
    this.view.target = m ? m.id : null;
    if (m) this.view.scrollToRow(m.id);
    cx.notify();
  }

  // [start, end, color] ranges to paint in one markdown part.
  ranges(key, t) {
    if (!this.open || !this.q) return [];
    const cur = this.current();
    const tint = (a) => (/^#[0-9a-f]{6}$/i.test(t.accent ?? "") ? `${t.accent}${a}` : t.accent);
    return this.list.filter((m) => m.key === key).map((m) => [m.start, m.start + this.q.length, tint(cur === m ? "aa" : "40")]);
  }

  key(e, cx) {
    if (e.keystroke === "escape") this.hide(cx);
    else if (e.keystroke === "down") this.step(1, cx);
    else if (e.keystroke === "up") this.step(-1, cx);
    else return;
    cx.stop_propagation();
  }

  render(t) {
    const n = this.list.length;
    const btn = (id, label, tip, on) => div().id(id).px(6).py(1).rounded(5).text_size(12).text_color(t.muted).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click((_e, cx) => on(cx)).child(label);
    return h_flex().id("find-bar").absolute().top(8).right(16).w(320).h(34).px(8).gap(4).items_center().rounded(8)
      .bg(t.raised).border_1().border_color(t.border).on_key_down((e, cx) => this.key(e, cx))
      .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(t.foreground))
      .child(div().flex_none().text_size(11.5).text_color(this.q && !n ? t.blocked : t.dim)
        .child(this.q ? (n ? `${this.at + 1} of ${n}` : "No matches") : ""))
      .child(btn("find-prev", "↑", "Previous · Shift-Enter", (cx) => this.step(-1, cx)))
      .child(btn("find-next", "↓", "Next · Enter", (cx) => this.step(1, cx)))
      .child(btn("find-close", "✕", "Close · Escape", (cx) => this.hide(cx)));
  }
}

