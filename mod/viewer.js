import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, props, theme } from "herdr";
import * as fs from "fs/promises";
import { Buffer } from "buffer";

const PAD = 24;
const MAX = 8;

function sizeOf(b) {
  const u32 = (i) => b.readUInt32BE(i);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: u32(16), h: u32(20) };
  if (b[0] === 0x47 && b[1] === 0x49) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8L") { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    if (kind === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

export class Viewer {
  constructor(p, cx) {
    this.paths = p.viewer.paths ?? [];
    this.at = Math.max(0, p.viewer.index ?? 0);
    this.sizes = {};
    this.reset();
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(100, () => this.handle.focus());
    cx.spawn(async (cx) => {
      for (const path of this.paths) {
        const file = path.startsWith("/") ? path : `${appHome()}/${path}`;
        try { this.sizes[path] = sizeOf(Buffer.from(await fs.readFile(file))); } catch { this.sizes[path] = null; }
        cx.notify();
      }
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  reset() {
    this.scale = null;
    this.pos = null;
    this.drag = null;
  }

  go(d, cx) {
    this.at = (this.at + d + this.paths.length) % this.paths.length;
    this.reset();
    cx.notify();
  }

  // Until the stage reports its bounds, guess them from the dialog's share of the window.
  stage() {
    if (this.area) return this.area;
    const vp = window.viewport_size();
    const arrows = this.paths.length > 1 ? 2 * 48 : 0;
    return { width: vp.width * 0.92 - 40 - arrows, height: vp.height * 0.92 - 70 };
  }

  fit(size) {
    const a = this.stage();
    return Math.min((a.width - 2 * PAD) / size.w, (a.height - 2 * PAD) / size.h, 1);
  }

  place(size) {
    const a = this.stage();
    const s = this.scale ?? this.fit(size);
    const w = size.w * s, h = size.h * s;
    const axis = (p, img, room) => img + 2 * PAD <= room ? (room - img) / 2 : Math.min(PAD, Math.max(room - img - PAD, p));
    const want = this.pos ?? { x: (a.width - w) / 2, y: (a.height - h) / 2 };
    return { x: axis(want.x, w, a.width), y: axis(want.y, h, a.height), w, h, s };
  }

  zoomAt(size, next, at, cx) {
    const now = this.place(size);
    const s = Math.min(MAX, Math.max(this.fit(size), next));
    const k = s / now.s;
    this.scale = s;
    this.pos = { x: at.x - (at.x - now.x) * k, y: at.y - (at.y - now.y) * k };
    cx.notify();
  }

  zoomed(size) {
    return this.scale != null && this.scale > this.fit(size) + 1e-6;
  }

  track(e) {
    if (e.bounds) this.area = { width: e.bounds.width, height: e.bounds.height };
  }

  key(e, cx) {
    const size = this.sizes[this.paths[this.at]];
    const mid = () => { const a = this.stage(); return { x: a.width / 2, y: a.height / 2 }; };
    if (e.keystroke === "left" && this.paths.length > 1) this.go(-1, cx);
    else if (e.keystroke === "right" && this.paths.length > 1) this.go(1, cx);
    else if (e.keystroke === "escape" || e.keystroke === "space") this.close();
    else if (size && (e.keystroke === "=" || e.keystroke === "+" || e.keystroke === "shift-=")) this.zoomAt(size, this.place(size).s * 1.5, mid(), cx);
    else if (size && e.keystroke === "-") this.zoomAt(size, this.place(size).s / 1.5, mid(), cx);
    else if (e.keystroke === "0") { this.reset(); cx.notify(); }
    else return;
    cx.stop_propagation();
  }

  picture(path, size, t) {
    if (!size) return div().absolute().inset_0().p(PAD).child(image(path).size_full());
    const at = this.place(size);
    const zoomed = this.zoomed(size);
    return div().id("stage").absolute().inset_0().overflow_hidden()
      .map((el) => this.drag?.moved ? el.cursor_grabbing() : zoomed ? el.cursor_grab() : el.cursor_pointer())
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.track(e);
        if (e.local_position) this.drag = { from: e.local_position, start: { x: at.x, y: at.y }, moved: false };
      })
      .on_mouse_move((e, cx) => {
        this.track(e);
        const d = this.drag;
        if (!d) return;
        const dx = e.local_position.x - d.from.x, dy = e.local_position.y - d.from.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        this.pos = { x: d.start.x + dx, y: d.start.y + dy };
        if (this.scale == null) this.scale = at.s;
        cx.notify();
      })
      .on_mouse_up("left", (e, cx) => {
        cx.stop_propagation();
        const d = this.drag;
        this.drag = null;
        if (!d) return;
        if (d.moved) return void cx.notify();
        const p = e.local_position ?? d.from;
        const inside = p.x >= at.x && p.x <= at.x + at.w && p.y >= at.y && p.y <= at.y + at.h;
        if (zoomed) { this.reset(); cx.notify(); }
        else if (inside) this.zoomAt(size, Math.max(1, at.s * 2.5), p, cx);
        else this.close();
      })
      .on_click((_e, cx) => cx.stop_propagation())
      .on_scroll_wheel((e, cx) => {
        this.track(e);
        cx.stop_propagation();
        if ((e.modifiers?.platform || e.modifiers?.control) && e.local_position) {
          return this.zoomAt(size, at.s * Math.exp(-e.delta.y / 200), e.local_position, cx);
        }
        if (!zoomed) return;
        this.pos = { x: at.x + e.delta.x, y: at.y + e.delta.y };
        cx.notify();
      })
      .on_pinch((e, cx) => {
        this.track(e);
        cx.stop_propagation();
        this.zoomAt(size, at.s * (1 + e.delta), e.local_position ?? { x: at.x + at.w / 2, y: at.y + at.h / 2 }, cx);
      })
      .child(image(path).absolute().left(at.x).top(at.y).w(at.w).h(at.h));
  }

  render() {
    const t = theme();
    const path = this.paths[this.at];
    const size = path ? this.sizes[path] : null;
    const arrow = (id, label, d) => div().id(id).self_center().w(36).h(36).flex_none().rounded(18).flex().items_center().justify_center()
      .bg(t.raised).text_color(t.foreground).cursor_pointer().hover((s) => s.opacity(0.8))
      .on_click((_e, cx) => { cx.stop_propagation(); this.go(d, cx); }).child(label);
    const pct = size ? `${Math.round(this.place(size).s * 100)}%` : null;
    const hint = [
      this.paths.length > 1 ? `${this.at + 1} / ${this.paths.length} · ← →` : null,
      size ? (this.zoomed(size) ? `${pct} · drag or scroll to move · click to fit` : `${pct} · click to zoom, pinch or ⌘ scroll`) : null,
      "Esc to close",
    ].filter(Boolean).join(" · ");
    return v_flex().id("viewer").track_focus(this.handle).size_full().rounded(12).bg("#000000e0")
      .on_key_down((e, cx) => this.key(e, cx))
      .on_click(() => this.close())
      .child(h_flex().flex_1().min_h(0).items_stretch().gap(12).px(20).pt(20)
        .when(this.paths.length > 1, (el) => el.child(arrow("prev", "‹", -1)))
        .child(div().relative().flex_1().min_w(0).child(path ? this.picture(path, size, t) : div()))
        .when(this.paths.length > 1, (el) => el.child(arrow("next", "›", 1))))
      .child(h_flex().h(30).flex_none().justify_center().items_center().text_size(12).text_color("#ffffffb0").child(hint));
  }
}
