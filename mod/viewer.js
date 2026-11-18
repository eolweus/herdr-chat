import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, props, theme } from "herdr";

export class Viewer {
  constructor(p, cx) {
    this.paths = p.viewer.paths ?? [];
    this.at = Math.max(0, p.viewer.index ?? 0);
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(100, () => this.handle.focus());
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(d, cx) {
    this.at = (this.at + d + this.paths.length) % this.paths.length;
    cx.notify();
  }

  key(e, cx) {
    if (e.keystroke === "left" && this.paths.length > 1) this.go(-1, cx);
    else if (e.keystroke === "right" && this.paths.length > 1) this.go(1, cx);
    else if (e.keystroke === "escape" || e.keystroke === "space") this.close();
    else return;
    cx.stop_propagation();
  }

  render() {
    const t = theme();
    const arrow = (id, label, d) => div().id(id).w(36).h(36).rounded(18).flex().items_center().justify_center()
      .bg(t.raised).text_color(t.foreground).cursor_pointer().hover((s) => s.opacity(0.8))
      .on_click((_e, cx) => { cx.stop_propagation(); this.go(d, cx); }).child(label);
    return v_flex().id("viewer").track_focus(this.handle).size_full().rounded(12).bg("#000000e0")
      .on_key_down((e, cx) => this.key(e, cx))
      .on_click(() => this.close())
      .child(h_flex().flex_1().min_h(0).items_center().gap(12).p(20)
        .when(this.paths.length > 1, (el) => el.child(arrow("prev", "‹", -1)))
        .child(div().flex_1().h_full().child(this.paths[this.at] ? image(this.paths[this.at]).size_full() : div()))
        .when(this.paths.length > 1, (el) => el.child(arrow("next", "›", 1))))
      .child(h_flex().h(30).justify_center().items_center().text_size(12).text_color("#ffffffb0")
        .child(this.paths.length > 1 ? `${this.at + 1} / ${this.paths.length} · ← → · Esc to close` : "Esc or click to close"));
  }
}
