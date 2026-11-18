import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, ScrollHandle } from "gpui-base";
import { appHome, checking, exec, focused, props, theme } from "herdr";
import { WebSocket } from "websocket";
import * as fs from "fs/promises";
import { Buffer } from "buffer";

const URL = "ws://127.0.0.1:7777";
const DATA = "data/herdr-chat";

export default class HerdrChat extends View {
  init(_props, cx) {
    this.items = [];
    this.blocks = {};
    this.attachments = [];
    this.status = "connecting";
    this.log = [];
    this.scroll = ScrollHandle.new();
    this.input = TextareaState.new({ placeholder: "Message Claude…" });
    this.input.set_auto_grow(1, 10);
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.on("paste_other", (_e, cx) => this.pasteImage(cx));
    if (checking()) return;
    cx.spawn(async (cx) => this.connect(cx));
  }

  async connect(cx) {
    const machine = props()?.machine;
    if (machine) {
      this.status = `not available on ${machine} yet`;
      this.items.push({ kind: "error", text: `Chat only runs on this computer for now. ${machine} gets its own engine in milestone 1.` });
      return cx.notify();
    }
    try {
      await fs.mkdir(`${appHome()}/${DATA}`, { recursive: true });
      this.ws = await WebSocket.connect(URL);
      this.status = "connected";
      const cwd = props()?.cwd ?? focused()?.cwd ?? "/tmp";
      await this.ws.write(JSON.stringify({ type: "start", cwd }));
      const p = props() ?? {};
      if (p.testEcho) await this.ws.write(JSON.stringify({ type: "echo_image", path: p.testEcho }));
      if (p.testPaste) await this.pasteImage(cx);
      if (p.testPrompt) { this.input.set_value(p.testPrompt); this.submit(cx); }
      cx.notify();
      for (;;) {
        const raw = await this.ws.read();
        try {
          if (typeof raw !== "string") await this.gotBinary(raw);
          else this.handle(JSON.parse(raw));
        } catch (e) {
          this.items.push({ kind: "error", text: `event: ${e}` });
        }
        cx.notify();
      }
    } catch (e) {
      this.status = `error: ${e}`;
      cx.notify();
    }
  }

  async gotBinary(bytes) {
    const rel = `${DATA}/echo-${Date.now()}.png`;
    await fs.writeFile(`${appHome()}/${rel}`, bytes);
    this.items.push({ kind: "image", path: rel, note: `binary over ws: ${bytes.length} bytes` });
  }

  handle(m) {
    if (m.type === "permission_request") {
      this.items.push({ kind: "permission", ...m, answered: null });
    } else if (m.type === "error") {
      this.items.push({ kind: "error", text: m.message });
    } else if (m.type === "sdk") {
      this.sdk(m.msg);
    }
    if (this.items.length) this.scroll.scroll_to_item(this.items.length - 1);
  }

  sdk(msg) {
    if (msg.type === "system" && msg.subtype === "init") {
      this.model = msg.model;
    } else if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev.type === "content_block_start") {
        const b = ev.content_block;
        const item = b.type === "text" ? { kind: "text", text: "" }
          : b.type === "thinking" ? { kind: "thinking", text: "" }
          : b.type === "tool_use" ? { kind: "tool", name: b.name, id: b.id, input: "" }
          : null;
        if (item) { this.items.push(item); this.blocks[ev.index] = item; }
      } else if (ev.type === "content_block_delta") {
        const item = this.blocks[ev.index];
        const d = ev.delta;
        if (!item) return;
        if (d.type === "text_delta") item.text += d.text;
        else if (d.type === "thinking_delta") item.text += d.thinking;
        else if (d.type === "input_json_delta") item.input += d.partial_json;
      } else if (ev.type === "message_start") {
        this.blocks = {};
      }
    } else if (msg.type === "user") {
      for (const c of msg.message?.content ?? []) {
        if (c.type !== "tool_result") continue;
        const tool = this.items.find((i) => i.kind === "tool" && i.id === c.tool_use_id);
        if (tool) tool.done = !c.is_error ? "ok" : "failed";
      }
    } else if (msg.type === "result") {
      this.busy = false;
      this.items.push({ kind: "result", text: `${msg.subtype} · ${(msg.duration_ms / 1000).toFixed(1)}s · ${msg.num_turns} turns` });
    }
  }

  async pasteImage(cx) {
    const rel = `${DATA}/paste-${Date.now()}.png`;
    const abs = `${appHome()}/${rel}`;
    const r = await exec("osascript", [
      "-e", "set png_data to (the clipboard as «class PNGf»)",
      "-e", `set fp to open for access POSIX file "${abs}" with write permission`,
      "-e", "write png_data to fp",
      "-e", "close access fp",
    ]);
    if (r.code === 0) this.attachments.push(rel);
    else this.items.push({ kind: "error", text: `paste failed: ${r.stderr}` });
    cx.notify();
  }

  submit(cx) {
    const text = this.input.value().trim();
    if (!this.ws || (!text && !this.attachments.length)) return;
    if (text.startsWith("/echo ")) {
      this.ws.write(JSON.stringify({ type: "echo_image", path: text.slice(6).trim() }));
      this.input.set_value("");
      return;
    }
    const atts = this.attachments;
    this.attachments = [];
    this.input.set_value("");
    this.items.push({ kind: "user", text, images: atts });
    this.busy = true;
    cx.spawn(async (cx) => {
      const images = [];
      for (const rel of atts) images.push(Buffer.from(await fs.readFile(`${appHome()}/${rel}`)).toString("base64"));
      await this.ws.write(JSON.stringify({ type: "prompt", text, images }));
      cx.notify();
    });
    cx.notify();
  }

  answer(item, allow, cx) {
    item.answered = allow ? "allowed" : "denied";
    this.ws.write(JSON.stringify({ type: "permission", id: item.id, allow, input: item.input }));
    cx.notify();
  }

  renderItem(item, i, t) {
    const row = () => v_flex().w_full().px(20).py(6);
    switch (item.kind) {
      case "user":
        return row().items_end().child(
          v_flex().max_w(560).gap(6).px(14).py(10).rounded(14).bg(t.raised)
            .children(item.images.map((p) => image(p).w(180).rounded(8)))
            .child(div().text_size(14).child(item.text)));
      case "text":
        return row().child(TextView.markdown(`md-${i}`, item.text || " ").selectable(true).text_size(14));
      case "thinking":
        return row().child(div().text_size(12.5).text_color(t.dim).italic().child(`Thinking · ${item.text.length} chars`));
      case "tool": {
        let input = {};
        try { input = JSON.parse(item.input || "{}"); } catch {}
        const meta = input.description ?? input.command ?? input.file_path ?? input.pattern ?? "";
        const dot = item.done === "failed" ? t.blocked : item.done ? t.done : t.working;
        return row().child(h_flex().gap(8).items_center().text_size(13)
          .child(div().size(7).rounded(4).bg(dot))
          .child(div().font_semibold().child(item.name))
          .child(div().text_color(t.muted).truncate().child(String(meta))));
      }
      case "permission": {
        const btn = (id, label, primary, fn) => div().id(`${id}-${i}`).px(12).py(6).rounded(8).cursor_pointer()
          .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
          .text_size(12.5).hover((s) => s.opacity(0.88)).on_click(fn).child(label);
        return row().child(v_flex().gap(10).p(14).rounded(12).border_1().border_color(t.accent).bg(t.surface)
          .child(div().text_size(13.5).font_semibold().child(`Allow Claude to use ${item.toolName}?`))
          .child(div().text_size(12).text_color(t.muted).child(JSON.stringify(item.input).slice(0, 400)))
          .child(item.answered
            ? div().text_size(12).text_color(t.dim).child(item.answered)
            : h_flex().gap(8)
              .child(btn("allow", "Allow", true, (_e, cx) => this.answer(item, true, cx)))
              .child(btn("deny", "Deny", false, (_e, cx) => this.answer(item, false, cx)))));
      }
      case "image":
        return row().child(v_flex().gap(4).child(image(item.path).w(240).rounded(8))
          .child(div().text_size(11).text_color(t.dim).child(item.note)));
      case "result":
        return row().child(div().text_size(11).text_color(t.dim).child(item.text));
      case "error":
        return row().child(div().text_size(12.5).text_color(t.blocked).child(item.text));
    }
    return div();
  }

  render() {
    const t = theme();
    return v_flex().id("root").size_full().bg(t.background).text_color(t.foreground)
      .child(h_flex().px(16).h(32).items_center().gap(8).border_b_1().border_color(t.border).text_size(12).text_color(t.muted)
        .child(div().child("Claude"))
        .child(div().text_color(t.dim).child(this.model ?? this.status))
        .when(Boolean(this.busy), (el) => el.child(div().text_color(t.working).frames(["·  ", "·· ", "···", " ··", "  ·", "   "], 140))))
      .child(v_flex().id("transcript").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).py(10)
        .children(this.items.map((it, i) => this.renderItem(it, i, t))))
      .child(v_flex().p(12).gap(8).border_t_1().border_color(t.border)
        .when(this.attachments.length > 0, (el) => el.child(h_flex().gap(6)
          .children(this.attachments.map((p) => image(p).h(56).rounded(6)))))
        .child(Textarea.new(this.input).w_full().px(12).py(8).rounded(10).border_1().border_color(t.input).bg(t.surface).text_size(14)));
  }
}
