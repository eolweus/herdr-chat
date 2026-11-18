import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, InputState, ScrollHandle } from "gpui-base";
import { appHome, checking, exec, focused, home, nextCommand, notify, panes, props, readTextFile, theme } from "herdr";
import { WebSocket } from "websocket";
import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { CodeCache } from "./markdown.js";
import { userRow, textRow, thinkingRow, toolRow, noticeRow, endRow } from "./rows.js";
import { permissionCard, questionCard } from "./cards.js";
import { composer } from "./composer.js";

const PROTOCOL = 1;
const PORT = 7777;
const DATA = "data/herdr-chat";
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const CYCLE = ["default", "acceptEdits", "plan", "auto"];

const safe = (s) => s.replace(/[^A-Za-z0-9_-]/g, "_");
const tilde = (path, h) => (h && path?.startsWith(h) ? `~${path.slice(h.length)}` : path ?? "");

export default class HerdrChat extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.key = p.key ?? null;
    this.machine = p.machine || null;
    this.cwd = p.cwd ?? focused()?.cwd ?? null;
    this.items = [];
    this.byId = new Map();
    this.state = { busy: false, status: null, mode: "default", model: "", context: { used: 0, max: 0 }, queue: [], session: null };
    this.conn = "connecting";
    this.error = null;
    this.codes = new CodeCache();
    this.expanded = new Set();
    this.picks = new Map();
    this.otherInputs = new Map();
    this.images = new Map();
    this.attachments = [];
    this.following = true;
    this.stick = true;
    this.pane = null;
    this.scroll = ScrollHandle.new();
    this.input = TextareaState.new({ placeholder: "Ask Claude…" });
    this.input.set_auto_grow(1, 12);
    this.input.on("submit", (e, cx) => this.enter(e, cx));
    this.input.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.input.on("change", (_e, cx) => cx.notify());
    this.input.on("focus", (_e, cx) => { this.focusedInput = true; this.findPane(); cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.focusedInput = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.input.focus();
    cx.timer.after(150, () => this.input.focus());
    cx.timer.after(400, () => this.findPane());
    if (checking()) return;
    cx.spawn(async (cx) => this.connect(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "focus") this.input.focus();
        cx.notify();
      }
    });
  }

  async close() {
    await this.ws?.close().catch(() => {});
  }

  // A pane mod isn't told its own pane id; it's the focused herdr-chat pane right after opening or a click.
  findPane() {
    const f = focused()?.pane;
    if (f && panes().find((x) => x.pane === f)?.mod === "herdr-chat") this.pane = f;
  }

  async endpoint() {
    let url = `ws://127.0.0.1:${PORT}`;
    if (this.machine) {
      const map = JSON.parse((await readTextFile(`${appHome()}/${DATA}/machines.json`).catch(() => null)) ?? "{}");
      if (map[this.machine]) url = map[this.machine];
      else {
        const r = await exec("ssh", ["-G", this.machine]);
        const host = r.stdout.match(/^hostname (\S+)/m)?.[1] ?? this.machine;
        url = `ws://${host}:${PORT}`;
      }
    }
    const r = await exec("sh", ["-c", "cat ~/.config/herdr-chat/token"], { on: this.machine });
    if (r.code !== 0) throw new Error(`no engine token on ${this.machine ?? "this computer"} (run scripts/install.sh there)`);
    return { url, token: r.stdout.trim() };
  }

  async connect(cx) {
    await fs.mkdir(`${appHome()}/${DATA}/img`, { recursive: true }).catch(() => {});
    let delay = 1000;
    for (;;) {
      try {
        const { url, token } = await this.endpoint();
        this.ws = await WebSocket.connect(url);
        await this.ws.write(JSON.stringify({ type: "hello", v: PROTOCOL, token }));
        await this.ws.write(JSON.stringify({ type: "open", key: this.key, cwd: this.cwd }));
        this.conn = "connected";
        this.error = null;
        delay = 1000;
        cx.notify();
        for (;;) {
          const raw = await this.ws.read();
          if (typeof raw !== "string") continue;
          await this.receive(JSON.parse(raw), cx);
          cx.notify();
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.ws = null;
      this.conn = "offline";
      cx.notify();
      await new Promise((r) => cx.timer.after(delay, () => r(null)));
      delay = Math.min(delay * 2, 15000);
    }
  }

  send(o) {
    this.ws?.write(JSON.stringify(o)).catch(() => {});
  }

  async receive(m, cx) {
    if (m.type === "hello" && m.v !== PROTOCOL) this.error = `engine speaks protocol ${m.v}, this pane ${PROTOCOL}`;
    else if (m.type === "error") this.error = m.message;
    else if (m.type === "state") this.setState(m.state);
    else if (m.type === "snapshot") {
      this.items = [];
      this.byId.clear();
      for (const item of m.items) await this.upsert(item, false);
      this.setState(m.state);
      this.stick = true;
    } else if (m.type === "upsert") await this.upsert(m.item, true);
  }

  setState(next) {
    const was = this.state.busy;
    this.state = next;
    if (was && !next.busy && !this.visible()) {
      notify({ title: "Claude finished", body: tilde(this.cwd, home()), level: "success", action: this.focusAction() });
    }
  }

  async upsert(item, live) {
    const prev = this.byId.get(item.id);
    if (prev) this.items[this.items.indexOf(prev)] = item;
    else this.items.push(item);
    this.byId.set(item.id, item);
    const t = theme();
    if (item.kind === "text") this.codes.prepareText(item.id, item.text, t);
    if (item.kind === "permission") {
      if (item.detail) this.codes.prepare(`detail:${item.id}`, this.detailLang(item.tool), item.detail, t);
      if (item.plan) this.codes.prepareText(item.id, item.plan, t);
    }
    if (item.kind === "question" && item.state === "pending" && !this.otherInputs.has(item.id)) this.prepareQuestion(item);
    if (item.kind === "tool" && this.expanded.has(item.id) && item.detail) this.codes.prepare(`detail:${item.id}`, this.detailLang(item.name), item.detail, t);
    if (item.images?.length) await this.saveImages(item);
    if (live && !prev && (item.kind === "permission" || item.kind === "question") && item.state === "pending") this.alert(item);
    if (this.following) this.stick = true;
  }

  detailLang(tool) {
    return tool === "Bash" ? "bash" : ["Edit", "MultiEdit", "Write"].includes(tool) ? "diff" : "";
  }

  prepareQuestion(item) {
    const inputs = item.questions.map((q) => {
      const s = InputState.new({ placeholder: "Something else…" });
      s.on("submit", (_e, cx) => {
        if (item.questions.length === 1 && !q.multiSelect && s.value().trim()) this.answer({ item: item.id, answers: { [q.question]: s.value().trim() } }, cx);
        else this.submitQuestion(item, cx);
      });
      return s;
    });
    this.otherInputs.set(item.id, inputs);
  }

  async saveImages(item) {
    for (const [i, img] of item.images.entries()) {
      const key = `${item.id}:${i}`;
      if (this.images.has(key)) continue;
      const rel = `${DATA}/img/${safe(item.id)}-${i}.${IMAGE_EXT[img.type] ?? "png"}`;
      try {
        await fs.writeFile(`${appHome()}/${rel}`, Buffer.from(img.data, "base64"));
        this.images.set(key, rel);
      } catch {}
    }
  }

  imagePath(id, i) {
    return this.images.get(`${id}:${i}`) ?? null;
  }

  visible() {
    return Boolean(this.pane) && focused()?.pane === this.pane;
  }

  focusAction() {
    return this.pane ? { name: "pane.focus", args: { pane: this.pane } } : undefined;
  }

  alert(item) {
    if (this.visible()) return;
    const body = item.kind === "question" ? item.questions[0]?.question ?? "" : `${item.tool}${item.meta ? ` · ${item.meta}` : ""}`;
    notify({ title: item.kind === "question" ? "Claude has a question" : "Claude needs permission", body, level: "warning", action: this.focusAction() });
  }

  pending() {
    return this.items.find((i) => (i.kind === "permission" || i.kind === "question") && i.state === "pending") ?? null;
  }

  hasDraft() {
    return Boolean(this.input.value().trim() || this.attachments.length);
  }

  // Enter arrives as a submit after the textarea has inserted its newline; Shift-Enter keeps it.
  enter(e, cx) {
    if (e?.shift) return;
    const v = this.input.value();
    const at = this.input.selected_range().start;
    if (v[at - 1] === "\n") this.input.set_value(v.slice(0, at - 1) + v.slice(at));
    this.submit(cx);
  }

  submit(cx) {
    const text = this.input.value().trim();
    if (!this.ws || (!text && !this.attachments.length)) return;
    const waiting = this.pending();
    if (waiting && text && !this.attachments.length) {
      if (waiting.kind === "permission") this.answer({ item: waiting.id, decision: "deny", message: text }, cx);
      else this.answer({ item: waiting.id, answers: null, message: `The user replied instead of picking: ${text}` }, cx);
    }
    this.send({ type: "prompt", text, images: this.attachments.map(({ type, data }) => ({ type, data })) });
    this.input.set_value("");
    this.attachments = [];
    this.following = true;
    this.stick = true;
    cx.notify();
  }

  answer(a, cx) {
    this.send({ type: "answer", ...a });
    cx.notify();
  }

  pick(item, q, label, single, cx) {
    if (single) return this.answer({ item: item.id, answers: { [q.question]: label } }, cx);
    const picks = this.picks.get(item.id) ?? {};
    const set = picks[q.question] ?? new Set();
    if (q.multiSelect) set.has(label) ? set.delete(label) : set.add(label);
    else { set.clear(); set.add(label); }
    picks[q.question] = set;
    this.picks.set(item.id, picks);
    cx.notify();
  }

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
    if (Object.keys(answers).length < item.questions.length) return;
    this.answer({ item: item.id, answers }, cx);
  }

  interrupt(cx) {
    this.send({ type: "interrupt" });
    cx.notify();
  }

  unqueue(id, cx) {
    this.send({ type: "unqueue", id });
    cx.notify();
  }

  cycleMode(cx) {
    const next = CYCLE[(CYCLE.indexOf(this.state.mode) + 1) % CYCLE.length];
    this.send({ type: "set", mode: next });
    this.state = { ...this.state, mode: next };
    cx.notify();
  }

  toggle(id, cx) {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else {
      this.expanded.add(id);
      const item = this.byId.get(id);
      if (item?.kind === "tool" && item.detail) this.codes.prepare(`detail:${id}`, this.detailLang(item.name), item.detail, theme());
    }
    cx.notify();
  }

  async pasteImage(cx) {
    const rel = `${DATA}/img/paste-${Date.now()}.png`;
    const abs = `${appHome()}/${rel}`;
    const r = await exec("osascript", [
      "-e", "set png_data to (the clipboard as «class PNGf»)",
      "-e", `set fp to open for access POSIX file "${abs}" with write permission`,
      "-e", "write png_data to fp",
      "-e", "close access fp",
    ]);
    if (r.code !== 0) return;
    const data = Buffer.from(await fs.readFile(abs)).toString("base64");
    this.attachments.push({ type: "image/png", data, path: rel });
    cx.notify();
  }

  async drop(paths, cx) {
    for (const path of paths) {
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      if (!MIME[ext]) {
        this.input.replace(`${path} `);
        continue;
      }
      try {
        const bytes = await fs.readFile(path);
        const rel = `${DATA}/img/drop-${Date.now()}.${ext}`;
        await fs.writeFile(`${appHome()}/${rel}`, bytes);
        this.attachments.push({ type: MIME[ext], data: Buffer.from(bytes).toString("base64"), path: rel });
      } catch {}
    }
    cx.notify();
  }

  removeAttachment(i, cx) {
    this.attachments.splice(i, 1);
    cx.notify();
  }

  key(e, cx) {
    if (e.keystroke === "escape" && this.state.busy) this.interrupt(cx);
    else if (e.keystroke === "shift-tab") this.cycleMode(cx);
    else return;
    cx.stop_propagation();
  }

  wheel(e, cx) {
    if (e.delta.y > 0 && this.following) { this.following = false; cx.notify(); }
  }

  jump(cx) {
    this.following = true;
    this.stick = true;
    cx.notify();
  }

  renderItem(item, t, children) {
    switch (item.kind) {
      case "user": return userRow(item, t, this);
      case "text": return textRow(item, t, this);
      case "thinking": return thinkingRow(item, t, this);
      case "tool": return toolRow(item, t, this, children.get(item.id) ?? []);
      case "permission": return permissionCard(item, t, this);
      case "question": return questionCard(item, t, this);
      case "notice": return noticeRow(item, t);
      case "turn_end": return endRow(item, t);
    }
    return div();
  }

  header(t) {
    const s = this.state;
    const status = this.conn !== "connected"
      ? div().text_color(this.conn === "offline" ? t.blocked : t.dim).truncate()
        .child(this.conn === "offline" ? `Offline${this.error ? `: ${this.error}` : ""} · retrying` : "Connecting…")
      : s.busy
        ? h_flex().gap(6).items_center().text_color(t.working)
          .child(div().frames(["◐", "◓", "◑", "◒"], 120))
          .child(div().child(s.status ?? "Working"))
        : div();
    return h_flex().h(34).px(16).gap(10).items_center().flex_none().border_b_1().border_color(t.border).text_size(12)
      .child(div().font_semibold().text_color(t.foreground).child("Claude"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim)
        .child(`${this.machine ? `${this.machine} · ` : ""}${tilde(this.cwd, this.machine ? null : home())}`))
      .child(status);
  }

  empty(t) {
    return v_flex().flex_1().items_center().justify_center().gap(8)
      .child(div().text_size(20).text_color(t.foreground).child("What should we work on?"))
      .child(div().text_size(12.5).text_color(t.dim).child(tilde(this.cwd, this.machine ? null : home()) || ""));
  }

  render() {
    const t = theme();
    const children = new Map();
    for (const i of this.items) if (i.kind === "tool" && i.parent) children.set(i.parent, [...(children.get(i.parent) ?? []), i]);
    const shown = this.items.filter((i) => !(i.kind === "tool" && i.parent && this.byId.has(i.parent)));
    if (this.stick && shown.length) {
      this.scroll.scroll_to_item(shown.length);
      this.stick = false;
    }
    const transcript = v_flex().id("transcript").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).pt(10)
      .on_scroll_wheel((e, cx) => this.wheel(e, cx))
      .items_center()
      .children(shown.map((i) => this.renderItem(i, t, children).max_w(880)))
      .child(div().h(8));
    return v_flex().id("root").track_focus(this.handle).size_full().bg(t.background).text_color(t.foreground)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_drop((e, cx) => cx.spawn(async (cx) => this.drop(e.paths, cx)))
      .on_click((_e, cx) => { this.findPane(); cx.notify(); })
      .child(this.header(t))
      .child(shown.length ? div().relative().flex_1().min_h(0).flex().flex_col()
        .child(transcript)
        .when(!this.following, (el) => el.child(div().absolute().bottom(10).w_full().flex().justify_center()
          .child(div().id("jump").px(12).py(5).rounded(14).bg(t.raised).border_1().border_color(t.border)
            .text_size(12).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.jump(cx)).child("↓ Latest"))))
        : this.empty(t))
      .child(h_flex().w_full().justify_center().flex_none().child(composer(this, t)));
  }
}
