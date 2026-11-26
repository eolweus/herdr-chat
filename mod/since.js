import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

export const AWAY_MS = 5 * 60000;
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function span(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} ${m === 1 ? "minute" : "minutes"}`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"}`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? "day" : "days"}`;
}

const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

export function facts(fresh, busy) {
  const turns = fresh.filter((i) => i.kind === "turn_end");
  const files = new Set(fresh.filter((i) => i.kind === "tool" && EDITS.has(i.name)).map((i) => i.path ?? i.meta));
  const commands = fresh.filter((i) => i.kind === "tool" && i.name === "Bash").length;
  const failed = turns.filter((i) => i.error).length + fresh.filter((i) => i.kind === "notice" && i.level === "error").length;
  const out = [];
  if (turns.length) out.push(`${n(turns.length, "turn")} finished`);
  if (files.size) out.push(`edited ${n(files.size, "file")}`);
  if (commands) out.push(`ran ${n(commands, "command")}`);
  if (failed) out.push(n(failed, "error"));
  if (busy) out.push("still working");
  return out;
}

// Pending cards anywhere in the chat, since one asked before the user left still waits for them.
export function waiting(items) {
  const p = items.find((i) => (i.kind === "permission" || i.kind === "question") && i.state === "pending");
  if (!p) return null;
  return p.kind === "question" ? `a question: ${p.questions?.[0]?.question ?? ""}` : `permission to ${p.verb.toLowerCase()} ${p.meta}`.trim();
}

// More than one glance at the chat would catch up on.
export function isALot(fresh) {
  const turns = fresh.filter((i) => i.kind === "turn_end").length;
  const tools = fresh.filter((i) => i.kind === "tool" && !i.parent).length;
  const words = fresh.reduce((k, i) => k + (i.kind === "text" ? i.text.split(/\s+/).filter(Boolean).length : 0), 0);
  return turns >= 2 || tools >= 10 || words >= 300;
}

export class Since {
  constructor() {
    this.here = true;
    this.left = null;
    this.card = null;
  }

  // Returns the card when the user just came back to a chat that moved on while they were away.
  tick(here, items, now = Date.now()) {
    if (here === this.here) return null;
    this.here = here;
    if (!here) {
      this.left = this.card ? this.card.left : { at: now, ids: new Set(items.map((i) => i.id)) };
      this.card = null;
      return null;
    }
    const left = this.left;
    this.left = null;
    if (!left || now - left.at < AWAY_MS) return null;
    const fresh = items.filter((i) => !left.ids.has(i.id));
    if (!isALot(fresh)) return null;
    this.card = { left, away: now - left.at, from: fresh[0].id, ids: new Set(fresh.map((i) => i.id)), summary: null, error: null, asked: null };
    return this.card;
  }

  hide() {
    this.card = null;
  }
}

export function parseSummary(text) {
  const out = { now: null, points: [], needs: null, rest: [] };
  for (const raw of (text ?? "").split("\n")) {
    const l = raw.replace(/`/g, "").trim();
    if (!l) continue;
    const m = l.match(/^(NOW|NEEDS):\s*(.*)$/i);
    if (m) out[m[1].toLowerCase()] = m[2] || null;
    else if (/^[-•*]\s+/.test(l)) out.points.push(l.replace(/^[-•*]\s+/, ""));
    else out.rest.push(l);
  }
  if (out.needs && /^(none|nothing|n\/a)\b/i.test(out.needs)) out.needs = null;
  return out;
}

export function sinceCard(c, items, busy, t, { onJump, onHide }) {
  const fresh = items.filter((i) => c.ids.has(i.id));
  const stats = facts(fresh, busy);
  const wait = waiting(items);
  const sum = c.summary ? parseSummary(c.summary) : null;
  const needs = [wait && `Waiting for ${wait}`, sum?.needs].filter(Boolean);
  const small = (text, color = t.muted) => div().text_size(12.5).text_color(color).child(text);
  const chip = (text) => div().px(8).h(20).flex().items_center().rounded(10).bg(t.hover).text_size(11.5).text_color(t.muted).child(text);
  const point = (text) => h_flex().gap(8).items_start()
    .child(div().flex_none().w(10).text_size(13).text_color(t.dim).child("•"))
    .child(div().flex_1().min_w(0).text_size(13).child(text));
  return v_flex().id("since-card").w_full().max_w(760).p(14).gap(10).rounded(12).bg(t.raised).border_1().border_color(t.border)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(h_flex().gap(8).items_center()
      .child(div().text_size(13.5).font_semibold().child("Since you left"))
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.dim).child(`away ${span(c.away)}`))
      .child(div().id("since-hide").flex_none().size(22).flex().items_center().justify_center().rounded(6).text_color(t.muted)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onHide(cx)).child("×")))
    .when(stats.length > 0, (el) => el.child(h_flex().flex_wrap().gap(6).children(stats.map(chip))))
    .when(Boolean(sum), (el) => el.child(v_flex().gap(6)
      .when(Boolean(sum.now), (e) => e.child(div().text_size(13.5).font_medium().child(sum.now)))
      .when(sum.points.length > 0, (e) => e.child(v_flex().gap(3).children(sum.points.map(point))))
      .when(sum.rest.length > 0, (e) => e.child(div().text_size(13).child(sum.rest.join(" "))))))
    .when(Boolean(c.asked && !c.summary && !c.error), (el) => el.child(small("Summarizing…", t.dim)))
    .when(Boolean(c.error), (el) => el.child(small(`No summary: ${c.error}`, t.dim)))
    .when(needs.length > 0, (el) => el.child(v_flex().gap(3).px(10).py(8).rounded(8).border_1().border_color(t.accent).bg(t.surface)
      .child(div().text_size(11.5).font_semibold().text_color(t.accent).child("Needs you"))
      .children(needs.map((n) => div().text_size(13).child(n)))))
    .child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.dim).child(c.summary ? "Summary by Haiku, may be wrong" : ""))
      .child(div().id("since-jump").flex_none().px(10).h(26).flex().items_center().rounded(8).text_size(12).cursor_pointer()
        .border_1().border_color(t.border).hover((s) => s.bg(t.hover)).on_click((_e, cx) => onJump(cx)).child("Jump to where you left")));
}
