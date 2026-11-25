// Board handoffs in a chat: the strip on a handoff's own pane, and the card where a chat posted one.
// The sidebar (spaces-tree) publishes every engine's handoffs, with their sender resolved, as shared "handoffs".

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, notify, panes, run, setShared, shared, spaces } from "herdr";

export const HANDOFF = "#a970ff";
// Matches the sidebar: one-off handoffs purple, orchestrated teal, standalone neutral.
const KIND_COLORS = { orchestrated: "#22a99a", standalone: "#8c929c" };
const kindColor = (h) => KIND_COLORS[h?.kind] ?? HANDOFF;
const KIND_NAMES = { orchestrated: "Orchestrated handoff", standalone: "Standalone handoff" };

const live = () => shared("handoffs") ?? [];
const color = (machine, t) => (shared("machine.colors") ?? {})[machine ?? "local"] ?? t.dim;
const chip = (text, c) => div().flex_none().px(5).h(16).rounded(4).flex().items_center().bg(c + "26").text_color(c).text_size(10.5).font_semibold().child(text);
const quoted = (s, flag) => s.match(new RegExp(`${flag}\\s+(?:"([^"]*)"|'([^']*)'|(\\S+))`))?.slice(1).find((x) => x !== undefined) ?? null;

const closing = () => shared("handoffs.closing") ?? {};

// The same signed close as `board close <id>`; the sidebar clears the mark once the session is gone.
async function markDone(h) {
  setShared("handoffs.closing", { ...closing(), [h.id]: Date.now() });
  const r = await exec("board", ["close", h.id], { timeout: 60000 }).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
  if (r.code === 0) return true;
  const { [h.id]: _, ...rest } = closing();
  setShared("handoffs.closing", rest);
  notify({ title: "Couldn't close the handoff", body: (r.stderr || r.stdout || "").trim().slice(0, 300), level: "error" });
  return false;
}

function doneButton(id, h, t, after) {
  const c = kindColor(h);
  if (closing()[h.id]) return div().flex_none().text_size(12).text_color(t.dim).child(h.status === "working" ? "Closing after this turn…" : "Closing…");
  return div().id(id).flex_none().px(8).h(22).rounded(6).flex().items_center().cursor_pointer()
    .bg(c + "26").text_color(c).text_size(12).font_semibold().hover((s) => s.bg(c + "44"))
    .tooltip("Close this handoff's session once its current turn ends")
    .on_click((_e, cx) => { cx.stop_propagation(); markDone(h).then((ok) => ok && after?.()); })
    .child("✓ Mark done");
}

export const isHandoffPost = (item) => item.kind === "tool" && item.name === "Bash" && /(^|[\s/])board post\b/.test(item.detail ?? "");

function chatPane(key) {
  return panes().find((p) => p.mod === "herdr-chat" && shared(`herdr-chat:info:${p.pane}`)?.key === key)?.pane ?? null;
}

function spaceOf(pane) {
  const tab = pane && panes().find((p) => p.pane === pane)?.tab;
  return tab ? spaces().find((s) => s.tabs.some((x) => x.id === tab))?.id ?? null : null;
}

export function openHandoff(h, near) {
  const open = chatPane(h.key);
  if (open) return run("pane.focus", { pane: open });
  const space = spaceOf(near);
  run("tab.new", { mod: "herdr-chat", props: { key: h.key, machine: h.machine, cwd: h.cwd }, ...(space ? { space } : {}) });
}

function state(h, t) {
  if (!h) return div().flex_none().text_size(12).text_color(t.dim).child("Closed");
  if (h.status === "blocked") return div().flex_none().px(6).h(17).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
  if (h.status === "working") return div().flex_none().text_size(12).text_color(t.working).child("Working…");
  if (h.report?.status === "blocked") return div().flex_none().px(6).h(17).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Asks the sender");
  if (h.result === "done") return div().flex_none().text_size(12).font_semibold().text_color(kindColor(h)).child("✓ Done");
  if (h.result === "failed") return div().flex_none().text_size(12).font_semibold().text_color(t.ansi1).child("✗ Failed");
  return div().flex_none().text_size(12).text_color(t.dim).child("Idle");
}

export function handoffCard(item, t, view) {
  const posted = (item.result ?? "").match(/posted (\S+) -> (\S+)/);
  const id = posted?.[1] ?? null;
  const to = posted?.[2] ?? quoted(item.detail ?? "", "--to") ?? "?";
  const h = id ? live().find((x) => x.id === id) : null;
  const title = h?.title ?? quoted(item.detail ?? "", "--title") ?? "Handoff";
  const machine = h?.label ?? to.split("/")[0];
  const pending = item.status === "running" || item.status === "waiting";
  const failed = item.status === "error";
  const c = kindColor(h ?? { kind: quoted(item.detail ?? "", "--kind") });
  return h_flex().w_full().px(22).py(5).child(
    h_flex().id(`handoff-${item.id}`).w_full().gap(8).items_center().px(12).py(8).rounded(10)
      .border_1().border_color(c + "66").bg(c + "12")
      .when(Boolean(h), (el) => el.cursor_pointer().hover((s) => s.bg(c + "24")).on_click(() => openHandoff(h, view.pane)))
      .child(div().flex_none().text_size(14).font_bold().text_color(c).child("⤷"))
      .child(div().flex_none().text_size(13).font_semibold().text_color(c).child(pending ? "Handing off to" : failed ? "Couldn't hand off to" : "Handed off to"))
      .child(chip(machine, h ? color(h.machine, t) : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(title))
      .when(!pending && !failed, (el) => el.child(state(h, t)))
      .when(Boolean(h), (el) => el.child(doneButton(`handoff-done-${item.id}`, h, t)))
      .when(Boolean(h), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child("Open ›"))));
}

// The sender's title: another chat's, a terminal agent's, or the handoff it came from.
function senderTitle(h) {
  if (h.parentKey) return live().find((x) => x.key === h.parentKey)?.title ?? "a handoff";
  if (!h.parent) return null;
  const chat = shared(`herdr-chat:pane:${h.parent}`);
  return chat?.title ?? panes().find((p) => p.pane === h.parent)?.title ?? null;
}

export function handoffStrip(view, t) {
  const meta = view.handoff;
  if (!meta) return null;
  const h = live().find((x) => x.key === view.key && (x.machine ?? null) === (view.machine ?? null)) ?? null;
  // Marked done here: once the session is gone, so is its tab.
  if (view.leaving && h) view.seen = true;
  if (view.leaving && view.seen && !h && view.pane) { view.leaving = false; run("pane.close", { pane: view.pane }); }
  const from = String(meta.from ?? "").split("/")[0] || "?";
  const sender = h && senderTitle(h);
  const back = h && (h.parent ?? (h.parentKey ? chatPane(h.parentKey) : null));
  const c = kindColor(h ?? meta);
  const kind = (h ?? meta).kind;
  const note = kind && kind !== "once" && h?.report?.note && !h.result ? h.report.note : null;
  return h_flex().px(16).py(6).gap(8).flex_none().items_center().text_size(12.5)
    .bg(c + "14").border_b_1().border_color(c + "40")
    .child(div().w(3).h(16).rounded(2).bg(c))
    .child(div().flex_none().text_size(14).font_bold().text_color(c).child("⤷"))
    .child(div().flex_none().font_semibold().text_color(c).child(KIND_NAMES[kind] ?? "Handoff"))
    .child(div().flex_none().text_color(t.dim).child("from"))
    .child(chip(h?.fromLabel ?? from, h ? color(h.fromMachine, t) : t.dim))
    .when(Boolean(sender), (el) => el.child(div().id("handoff-sender").min_w(0).truncate().text_color(t.muted)
      .when(Boolean(back), (s) => s.cursor_pointer().hover((x) => x.text_color(t.foreground)).on_click(() => run("pane.focus", { pane: back })))
      .child(back ? `${sender} ↩` : sender)))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).when(Boolean(note), (el) => el.child(`· ${note}`)))
    .child(div().flex_none().text_color(t.dim).child("running on"))
    .child(chip(h?.label ?? (view.machine ?? "this computer"), color(view.machine, t)))
    .when(Boolean(h), (el) => el.child(state(h, t)))
    .when(Boolean(h), (el) => el.child(doneButton("handoff-strip-done", h, t, () => { view.leaving = true; })));
}
