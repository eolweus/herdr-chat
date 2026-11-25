import { div } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextareaState, ScrollHandle } from "gpui-base";
import { theme } from "herdr";
import { markdown } from "./markdown.js";
import { thinkingRow, toolRow, noticeRow } from "./rows.js";
import { quoteBlock, quoteChips, splitQuotes, withQuotes } from "./quote.js";

// A read-only fork of the chat for questions on the side. The engine never saves it, so it lives only while this panel is open.
export class SidePanel {
  constructor(view) {
    this.view = view;
    this.open = false;
    this.items = [];
    this.byId = new Map();
    this.busy = false;
    this.status = null;
    this.quotes = [];
    this.scroll = ScrollHandle.new();
    this.stick = false;
    this.input = TextareaState.new({ placeholder: "Ask on the side…" });
    this.input.set_auto_grow(1, 8);
    this.input.on("submit", (e, cx) => {
      if (e?.shift) return;
      const v = this.input.value();
      const at = this.input.selected_range().start;
      if (v[at - 1] === "\n") this.input.set_value(v.slice(0, at - 1) + v.slice(at));
      this.submit(cx);
    });
    this.input.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
  }

  show(cx) {
    this.open = true;
    this.input.focus();
    cx?.notify();
  }

  toggle(cx) {
    if (this.open) this.close(cx);
    else this.show(cx);
  }

  close(cx) {
    this.open = false;
    this.reset();
    this.view.send({ type: "side_close" });
    this.view.input.focus();
    cx?.notify();
  }

  fresh(cx) {
    this.view.send({ type: "side_close" });
    this.reset();
    this.input.focus();
    cx.notify();
  }

  reset() {
    this.items = [];
    this.byId.clear();
    this.busy = false;
    this.status = null;
  }

  quote(text, cx) {
    const input = this.view.quoteInput();
    input.on("submit", (_e, cx) => { this.input.focus(); cx.notify(); });
    this.quotes.push({ text, input });
    this.show(cx);
    input.focus();
  }

  ask(text, cx) {
    const said = withQuotes(this.quotes.map((q) => ({ text: q.text, comment: q.input?.value() ?? "" })), text.trim());
    if (!said) return;
    if (!this.view.state.session) {
      this.upsert({ id: `side-note:${Date.now()}`, kind: "notice", level: "warning", text: "Send a message in this chat first, so there's a conversation to fork." });
      return cx?.notify();
    }
    this.view.send({ type: "side_ask", text: said });
    this.quotes = [];
    this.busy = true;
    this.stick = true;
    this.show(cx);
  }

  submit(cx) {
    this.ask(this.input.value(), cx);
    this.input.set_value("");
  }

  interrupt(cx) {
    this.view.send({ type: "side_interrupt" });
    cx.notify();
  }

  // Engine messages for the side chat; false for everything else.
  receive(m) {
    if (m.type === "side_upsert") { this.upsert(m.item); this.open = true; }
    else if (m.type === "side_state") { this.busy = m.busy; this.status = m.status; }
    else if (m.type === "side_closed") this.busy = false;
    else return false;
    return true;
  }

  restore(side) {
    this.reset();
    if (!side) return;
    for (const item of side.items) this.upsert(item);
    this.busy = side.busy;
    this.status = side.status;
    this.open = true;
  }

  upsert(item) {
    const prev = this.byId.get(item.id);
    if (prev) this.items[this.items.indexOf(prev)] = item;
    else this.items.push(item);
    this.byId.set(item.id, item);
    if (item.kind === "text") this.view.codes.prepareText(`side:${item.id}`, item.text, theme());
    this.stick = true;
  }

  row(item, t) {
    const view = this.view;
    switch (item.kind) {
      case "user": {
        const { quotes, body } = splitQuotes(item.text);
        return v_flex().w_full().items_end().px(14).pt(8).child(v_flex().max_w(360).gap(6).px(12).py(8).rounded(14).bg(t.raised)
          .children(quotes.map((q) => quoteBlock(q, t, 12.5)))
          .when(Boolean(body), (el) => el.child(div().text_size(13).child(body))));
      }
      case "text": return v_flex().w_full().px(14).py(6).child(markdown(`side:${item.id}`, item.text || " ", t, view.codes, { size: 13, links: view.links, onLink: (href, cx) => view.openLink(href, cx) }));
      case "thinking": return thinkingRow(item, t, view).px(14);
      case "tool": return toolRow(item, t, view, []).px(14);
      case "notice": return noticeRow(item, t);
    }
    return null;
  }

  render(t) {
    if (this.stick && this.items.length) { this.scroll.scroll_to_item(this.items.length - 1); this.stick = false; }
    const rows = this.items.map((i) => this.row(i, t)).filter(Boolean);
    const btn = (id, label, tip, fn) => div().id(id).px(6).py(2).rounded(5).cursor_pointer().text_size(12).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(fn).child(label);
    return v_flex().w(380).flex_none().h_full().border_l_1().border_color(t.border).bg(t.background)
      .child(h_flex().px(12).py(7).gap(6).items_center().border_b_1().border_color(t.border)
        .child(div().text_size(12.5).font_semibold().child("Side chat"))
        .child(div().flex_1().truncate().text_size(11.5).text_color(t.dim).child("Read-only · not saved"))
        .child(btn("side-new", "New", "Start over with a fresh fork", (_e, cx) => this.fresh(cx)))
        .child(btn("side-close", "✕", "Close the side chat (Cmd-;)", (_e, cx) => this.close(cx))))
      .child(rows.length
        ? v_flex().id("side-transcript").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).pb(8).children(rows)
        : v_flex().flex_1().items_center().justify_center().px(24).gap(6).text_size(12.5).text_color(t.dim)
          .child(div().text_center().child("Ask about this chat without interrupting it."))
          .child(div().text_center().child("Claude can read files here but not change anything.")))
      .child(v_flex().p(8).gap(4)
        .when(this.busy, (el) => el.child(h_flex().px(4).gap(6).items_center().text_size(11.5).text_color(t.working)
          .child(div().frames(["◐", "◓", "◑", "◒"], 120)).child(div().child(this.status ?? "Working"))))
        .child(v_flex().w_full().rounded(12).border_1().border_color(this.focused ? t.accent : t.input).bg(t.surface)
          .when(this.quotes.length > 0, (el) => el.child(quoteChips(this.quotes, t, "side-q", (i, cx) => { this.quotes.splice(i, 1); cx.notify(); })))
          .child(h_flex().items_end().gap(4).pl(4).pr(6).py(3)
            .child(div().flex_1().min_w(0).child(Textarea.new(this.input).w_full().px(8).py(6).text_size(13).bg(t.surface)))
            .child(div().id("side-send").mb(3).w(26).h(26).rounded(13).flex().items_center().justify_center().cursor_pointer()
              .bg(this.busy ? t.raised : t.solid).text_color(this.busy ? t.foreground : t.solid_foreground).text_size(12)
              .tooltip(this.busy ? "Stop (Esc)" : "Ask (Enter)").hover((s) => s.opacity(0.85))
              .on_click((_e, cx) => (this.busy ? this.interrupt(cx) : this.submit(cx)))
              .child(this.busy ? "■" : "↑")))));
  }
}
