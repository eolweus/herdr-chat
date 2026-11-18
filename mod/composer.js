import { div, image } from "gpui-kit";
import { v_flex, h_flex, Textarea } from "gpui-base";

export const MODES = [
  ["default", "Ask before edits"],
  ["acceptEdits", "Edit automatically"],
  ["plan", "Plan mode"],
  ["auto", "Auto mode"],
  ["bypassPermissions", "Bypass permissions"],
];

const chip = (id, t) => h_flex().id(id).gap(6).px(8).py(3).rounded(6).items_center().text_size(11.5).text_color(t.muted)
  .cursor_pointer().hover((s) => s.bg(t.hover));

function meter(state, t) {
  const { used, max } = state.context;
  if (!used || !max) return div();
  const pct = Math.min(100, Math.round((used / max) * 100));
  const color = pct > 85 ? t.blocked : pct > 65 ? t.working : t.dim;
  return h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim).tooltip(`${used.toLocaleString()} of ${max.toLocaleString()} tokens`)
    .child(div().w(44).h(4).rounded(2).bg(t.raised).child(div().h_full().rounded(2).bg(color).w(Math.max(2, (44 * pct) / 100))))
    .child(div().child(`${pct}%`));
}

export function composer(view, t) {
  const s = view.state;
  const stop = s.busy && !view.hasDraft();
  const mode = MODES.find(([m]) => m === s.mode)?.[1] ?? s.mode;
  return v_flex().w_full().max_w(880).px(16).pt(8).pb(10).gap(6).flex_none()
    .when(s.queue.length > 0, (el) => el.child(v_flex().gap(4).px(4).children(s.queue.map((q) =>
      h_flex().gap(8).px(10).py(5).rounded(8).bg(t.raised).items_center().text_size(12.5)
        .child(div().text_color(t.dim).child("Queued"))
        .child(div().flex_1().min_w(0).truncate().child(q.text || `${q.images} image${q.images === 1 ? "" : "s"}`))
        .child(div().id(`unq-${q.id}`).px(4).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => view.unqueue(q.id, cx)).child("✕"))))))
    .when(view.commandMatches().length > 0, (el) => el.child(commandList(view, t)))
    .when(Boolean(view.modelMenu) && s.models?.length > 0, (el) => el.child(modelList(view, t)))
    .child(v_flex().w_full().rounded(14).border_1().border_color(view.focusedInput ? t.accent : t.input).bg(t.surface)
      .when(view.attachments.length > 0, (el) => el.child(h_flex().gap(8).px(10).pt(10).flex_wrap()
        .children(view.attachments.map((a, i) => div().relative()
          .child(image(a.path).h(56).max_w(120).rounded(6))
          .child(div().id(`rm-${i}`).absolute().top(-6).right(-6).w(18).h(18).rounded(9).flex().items_center().justify_center()
            .bg(t.raised).border_1().border_color(t.border).text_size(10).cursor_pointer()
            .on_click((_e, cx) => view.removeAttachment(i, cx)).child("✕"))))))
      .child(h_flex().w_full().items_end().gap(4).pl(6).pr(8).py(4)
        .child(div().id("attach").mb(4).w(30).h(30).rounded(15).flex().items_center().justify_center().cursor_pointer()
          .text_size(18).text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("Attach files")
          .on_click((_e, cx) => cx.spawn(async (cx) => view.attach(cx))).child("+"))
        .child(div().flex_1().min_w(0).child(Textarea.new(view.input).w_full().px(10).py(7).text_size(14).bg(t.surface)))
        .child(div().id("send").mb(4).w(30).h(30).rounded(15).flex().items_center().justify_center().cursor_pointer()
          .bg(stop ? t.raised : t.solid).text_color(stop ? t.foreground : t.solid_foreground).text_size(13)
          .tooltip(stop ? "Stop (Esc)" : s.busy ? "Queue (Enter)" : "Send (Enter)")
          .hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => (stop ? view.interrupt(cx) : view.submit(cx)))
          .child(stop ? "■" : "↑"))))
    .child(h_flex().px(4).gap(4).items_center()
      .child(chip("mode", t).tooltip("Shift-Tab to change").on_click((_e, cx) => view.cycleMode(cx))
        .child(div().text_color(s.mode === "bypassPermissions" ? t.blocked : s.mode === "plan" ? t.accent : t.muted).child(mode)))
      .when(Boolean(s.model) || s.models?.length > 0, (el) => el.child(chip("model", t).on_click((_e, cx) => view.toggleModels(cx))
        .child(div().child(s.model || "Model")).child(div().text_size(10).child(view.modelMenu ? "⌄" : "›"))))
      .child(div().flex_1())
      .when(s.busy, (el) => el.child(h_flex().gap(6).px(6).items_center().text_size(11.5).text_color(t.working)
        .child(div().frames(["◐", "◓", "◑", "◒"], 120))
        .child(div().child(s.status ?? "Working"))))
      .child(meter(s, t)));
}

function commandList(view, t) {
  const cmds = view.commandMatches();
  return v_flex().w_full().p(4).rounded(12).border_1().border_color(t.border).bg(t.surface)
    .children(cmds.map((c, i) => h_flex().id(`cmd-${c.name}`).gap(10).px(10).py(6).rounded(8).items_baseline().cursor_pointer()
      .bg(i === view.commandAt ? t.selected : t.surface).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => view.complete(c, cx))
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(`/${c.name}`))
      .when(Boolean(c.hint), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(c.hint)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(c.description))))
    .child(div().px(10).pt(4).pb(2).text_size(11).text_color(t.dim).child("↑↓ to move · Tab or Enter to pick · Esc to clear"));
}

function modelList(view, t) {
  return v_flex().w_full().p(4).rounded(12).border_1().border_color(t.border).bg(t.surface)
    .children(view.state.models.map((m) => h_flex().id(`model-${m.value}`).gap(10).px(10).py(6).rounded(8).items_baseline().cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => view.pickModel(m.value, cx))
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(m.name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(m.description))));
}
