import { div } from "gpui-kit";
import { v_flex, h_flex, EditorState, Editor } from "gpui-base";
import { readTextFile, settings, theme } from "herdr";
import { language, syntax } from "./markdown.js";

export class FileView {
  constructor(p, cx) {
    this.path = p.file;
    this.machine = p.machine ?? null;
    this.state = null;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.path, { on: this.machine });
        if (text === null) this.error = "This file is no longer there";
        else {
          const ext = this.path.split(".").pop();
          this.state = EditorState.new({ language: language(ext), value: text, readonly: true, font_family: settings().font_family, font_size: 12.5, syntax: syntax(theme()) });
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  render() {
    const t = theme();
    return v_flex().size_full().bg(t.background).text_color(t.foreground)
      .child(h_flex().h(30).px(12).items_center().flex_none().border_b_1().border_color(t.border).text_size(12).text_color(t.dim)
        .child(div().truncate().child(`${this.machine ? `${this.machine}:` : ""}${this.path}`)))
      .child(this.state ? Editor.new(this.state).flex_1().min_h(0) : div().p(14).text_size(12.5).text_color(t.dim).child(this.error ?? "Loading…"));
  }
}
