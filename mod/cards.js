import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { codeBlock, diffBlock, markdown } from "./markdown.js";

function button(id, label, t, kind, fn) {
  const primary = kind === "primary";
  return div().id(id).px(12).py(6).rounded(8).cursor_pointer().text_size(12.5)
    .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : kind === "danger" ? t.blocked : t.foreground)
    .border_1().border_color(primary ? t.solid : t.border)
    .hover((s) => s.opacity(0.85)).on_click(fn).child(label);
}

function card(t, pending) {
  return v_flex().w_full().gap(10).p(14).rounded(12).border_1()
    .border_color(pending ? t.accent : t.border).bg(t.surface);
}

const settled = (text, t) => div().text_size(12).text_color(t.dim).child(text);

export function permissionCard(item, t, view) {
  const pending = item.state === "pending";
  if (!pending && !item.plan) {
    const ok = item.state === "allowed";
    return h_flex().w_full().px(22).py(4).gap(8).items_center().text_size(12.5).text_color(t.dim).min_w(0)
      .child(div().flex_none().text_color(ok ? t.done : t.blocked).child(ok ? "✓" : "✕"))
      .child(div().flex_none().child(`${ok ? "Allowed" : "Denied"} ${item.tool}`))
      .child(div().flex_1().min_w(0).truncate().child(item.meta));
  }
  const title = item.tool === "ExitPlanMode" ? (pending ? "Ready to code?" : "Plan") : `Allow ${item.tool}?`;
  return v_flex().w_full().px(22).py(6).child(card(t, pending)
    .child(h_flex().gap(8).items_baseline().min_w(0)
      .child(div().flex_none().text_size(13.5).font_semibold().child(title))
      .when(Boolean(item.meta), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(item.meta))))
    .when(Boolean(item.plan), (el) => el.child(div().max_h(420).overflow_hidden().child(markdown(item.id, item.plan, t, view.codes, { size: 13, links: view.links, onLink: (href, cx) => view.openLink(href, cx) }))))
    .when(Boolean(item.detail) && ["Edit", "MultiEdit", "Write"].includes(item.tool), (el) => el.child(diffBlock(item.detail, t, view.mono, 24)))
    .when(Boolean(item.detail) && !["Edit", "MultiEdit", "Write"].includes(item.tool) && Boolean(view.codes.peek(`detail:${item.id}`)), (el) =>
      el.child(codeBlock(view.codes.peek(`detail:${item.id}`), item.detail, t, { maxLines: 24 })))
    .child(pending
      ? v_flex().gap(6)
        .child(h_flex().gap(8)
          .child(button(`allow-${item.id}`, item.tool === "ExitPlanMode" ? "Start coding" : "Allow once", t, "primary", (_e, cx) => view.answer({ item: item.id, decision: "once" }, cx)))
          .when(item.remember, (el) => el.child(button(`session-${item.id}`, "Allow for this session", t, "", (_e, cx) => view.answer({ item: item.id, decision: "session" }, cx))))
          .child(button(`deny-${item.id}`, item.tool === "ExitPlanMode" ? "Keep planning" : "Deny", t, "danger", (_e, cx) => view.answer({ item: item.id, decision: "deny" }, cx))))
        .child(div().text_size(11.5).text_color(t.dim).child(`Or type below to deny and tell ${view.agent()} what to do instead`))
      : settled(item.tool === "ExitPlanMode" ? (item.state === "allowed" ? "Approved" : "Kept planning") : item.state === "allowed" ? "Allowed" : "Denied", t)));
}

export function questionCard(item, t, view) {
  const pending = item.state === "pending";
  const picks = view.picks.get(item.id) ?? {};
  const inputs = view.otherInputs.get(item.id) ?? [];
  const total = item.questions.length;
  const single = total === 1 && !item.questions[0].multiSelect;
  const page = Math.min(view.qPage.get(item.id) ?? 0, total - 1);
  const answered = (q, qi) => (picks[q.question]?.size ?? 0) > 0 || Boolean(inputs[qi]?.value().trim());
  const shown = pending && total > 1 ? [[item.questions[page], page]] : item.questions.map((q, qi) => [q, qi]);
  const go = (to) => (_e, cx) => view.goQuestion(item, to, cx);
  const steps = h_flex().gap(4).items_center().children(item.questions.map((q, qi) =>
    div().id(`step-${item.id}-${qi}`).size(7).rounded(4).cursor_pointer().on_click(go(qi))
      .bg(qi === page ? t.accent : answered(q, qi) ? t.muted : t.border)));
  return v_flex().w_full().px(22).py(6).child(card(t, pending)
    .when(pending && total > 1, (el) => el.child(h_flex().gap(8).items_center()
      .child(div().text_size(11.5).text_color(t.dim).child(`Question ${page + 1} of ${total}`))
      .child(steps)))
    .children(shown.map(([q, qi]) => {
      const chosen = picks[q.question] ?? new Set();
      const answer = item.answers?.[q.question];
      return v_flex().gap(8)
        .child(h_flex().gap(8).items_start()
          .when(Boolean(q.header), (el) => el.child(div().flex_none().mt(1).px(6).py(1).rounded(5).bg(t.raised).text_size(11).text_color(t.muted).child(q.header)))
          .child(div().flex_1().min_w(0).text_size(13.5).font_semibold().child(q.question)))
        .child(!pending
          ? settled(answer ? `→ ${answer}` : "Skipped", t)
          : v_flex().gap(4)
            .children(q.options.map((o, oi) => {
              const on = chosen.has(o.label);
              return h_flex().id(`opt-${item.id}-${qi}-${oi}`).gap(10).px(10).py(7).rounded(8).cursor_pointer().items_center()
                .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background)
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => view.pick(item, q, o.label, single, cx))
                .child(div().w(16).flex_none().text_size(12).text_color(on ? t.accent : t.dim).child(q.multiSelect ? (on ? "☑" : "☐") : on ? "◉" : "○"))
                .child(v_flex().flex_1().min_w(0)
                  .child(div().text_size(13).child(o.label))
                  .when(Boolean(o.description), (el) => el.child(div().text_size(12).text_color(t.dim).child(o.description))));
            }))
            .when(Boolean(inputs[qi]), (el) => el.child(
              h_flex().h(32).px(10).items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
                .child(Input.new(inputs[qi]).flex_1().text_size(13)))));
    }))
    .when(pending, (el) => el.child(h_flex().gap(8).items_center()
      .when(total > 1 && page > 0, (el) => el.child(button(`back-${item.id}`, "Back", t, "", go(page - 1))))
      .when(total > 1 && page < total - 1, (el) => el.child(button(`next-${item.id}`, "Next", t, "primary", go(page + 1))))
      .when(!single && page === total - 1, (el) => el.child(button(`submit-${item.id}`, "Submit", t, "primary", (_e, cx) => view.submitQuestion(item, cx))))
      .when(single, (el) => el.child(div().text_size(11.5).text_color(t.dim).child("Pick one, or type an answer and press Enter")))
      .child(div().flex_1())
      .child(button(`skip-${item.id}`, "Skip", t, "", (_e, cx) => view.answer({ item: item.id, answers: null }, cx))))));
}

// Answering question cards; hosts provide answer(a, cx) and the picks, qPage and otherInputs maps.
export const questionMethods = {
  prepareQuestion(item) {
    const inputs = item.questions.map((q) => {
      const s = InputState.new({ placeholder: "Something else…" });
      s.on("submit", (_e, cx) => {
        const qi = item.questions.indexOf(q);
        if (item.questions.length === 1 && !q.multiSelect && s.value().trim()) this.answer({ item: item.id, answers: { [q.question]: s.value().trim() } }, cx);
        else if (qi < item.questions.length - 1) this.goQuestion(item, qi + 1, cx);
        else this.submitQuestion(item, cx);
      });
      return s;
    });
    this.otherInputs.set(item.id, inputs);
  },

  pick(item, q, label, single, cx) {
    if (single) return this.answer({ item: item.id, answers: { [q.question]: label } }, cx);
    const picks = this.picks.get(item.id) ?? {};
    const set = picks[q.question] ?? new Set();
    if (q.multiSelect) set.has(label) ? set.delete(label) : set.add(label);
    else { set.clear(); set.add(label); }
    picks[q.question] = set;
    this.picks.set(item.id, picks);
    const qi = item.questions.indexOf(q);
    if (!q.multiSelect && qi < item.questions.length - 1) return this.goQuestion(item, qi + 1, cx);
    cx.notify();
  },

  goQuestion(item, page, cx) {
    this.qPage.set(item.id, Math.max(0, Math.min(page, item.questions.length - 1)));
    cx.notify();
  },

  submitQuestion(item, cx) {
    const picks = this.picks.get(item.id) ?? {};
    const inputs = this.otherInputs.get(item.id) ?? [];
    const answers = {};
    item.questions.forEach((q, i) => {
      const parts = [...(picks[q.question] ?? [])];
      const other = inputs[i]?.value().trim();
      if (other) parts.push(other);
      if (parts.length) answers[q.question] = parts.join(", ");
    });
    const missing = item.questions.findIndex((q) => !answers[q.question]);
    if (missing >= 0) return this.goQuestion(item, missing, cx);
    this.answer({ item: item.id, answers }, cx);
  },
};
