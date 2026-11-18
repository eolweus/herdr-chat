import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { markdown, codeBlock } from "./markdown.js";

const SPIN = ["◐", "◓", "◑", "◒"];

export const seconds = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

const row = () => v_flex().w_full().px(22).py(5);

function dot(status, t) {
  if (status === "running") return div().w(14).text_size(11).text_color(t.working).frames(SPIN, 120);
  if (status === "waiting") return div().w(14).text_size(11).text_color(t.accent).child("●");
  return div().w(14).text_size(9).text_color(status === "error" ? t.blocked : t.done).child("●");
}

export function userRow(item, t, view) {
  return row().items_end().py(10).child(
    v_flex().max_w(600).gap(8).px(14).py(10).rounded(16).bg(t.raised)
      .when(item.images.length > 0, (el) => el.child(h_flex().gap(6).flex_wrap()
        .children(item.images.map((_, i) => {
          const path = view.imagePath(item.id, i);
          return path ? image(path).max_w(240).max_h(240).rounded(8) : div().w(120).h(80).rounded(8).bg(t.surface);
        }))))
      .when(Boolean(item.text), (el) => el.child(div().text_size(14).child(item.text))));
}

export function textRow(item, t, view) {
  return row().py(8).child(markdown(item.id, item.text || " ", t, view.codes));
}

export function thinkingRow(item, t, view) {
  const open = view.expanded.has(item.id);
  const label = item.streaming ? "Thinking" : item.ms ? `Thought for ${seconds(item.ms)}` : "Thought";
  return row().child(
    h_flex().id(`think-${item.id}`).gap(6).items_center().text_size(12.5).text_color(t.dim)
      .when(Boolean(item.text), (el) => el.cursor_pointer().hover((s) => s.text_color(t.muted)).on_click((_e, cx) => view.toggle(item.id, cx)))
      .child(div().child(label))
      .when(item.streaming, (el) => el.child(div().frames(["·  ", "·· ", "···"], 300)))
      .when(Boolean(item.text) && !item.streaming, (el) => el.child(div().child(open ? "▾" : "▸"))))
    .when(open && Boolean(item.text), (el) => el.child(
      div().mt(6).pl(12).border_l_2().border_color(t.border).text_size(12.5).text_color(t.muted).child(item.text)));
}

export function toolRow(item, t, view, children) {
  const open = view.expanded.has(item.id);
  const canOpen = Boolean(item.detail || item.result || item.images?.length || children.length);
  const running = item.status === "running" && children.length;
  const latest = running ? children.at(-1) : null;
  return row().py(3).child(
    h_flex().id(`tool-${item.id}`).gap(8).items_center().text_size(13).min_w(0)
      .when(canOpen, (el) => el.cursor_pointer().on_click((_e, cx) => view.toggle(item.id, cx)))
      .child(dot(item.status, t))
      .child(div().flex_none().font_semibold().text_color(t.foreground).child(item.verb))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted)
        .child(latest ? `${item.meta} · ${latest.verb} ${latest.meta}` : item.meta))
      .when(Boolean(children.length), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(`${children.length} tools`)))
      .when(canOpen, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(open ? "▾" : "▸"))))
    .when(open, (el) => el.child(v_flex().mt(6).ml(22).gap(6)
      .when(Boolean(item.detail), (el) => {
        const state = view.codes.peek(`detail:${item.id}`);
        return el.child(state ? codeBlock(state, item.detail, t, { maxLines: 30 }) : div());
      })
      .when(Boolean(children.length), (el) => el.child(v_flex().gap(2).children(children.map((c) =>
        h_flex().gap(8).items_center().text_size(12.5).child(dot(c.status, t))
          .child(div().font_semibold().child(c.verb))
          .child(div().truncate().text_color(t.muted).child(c.meta))))))
      .when(Boolean(item.result), (el) => el.child(
        div().max_h(260).overflow_hidden().px(10).py(8).rounded(8).bg(t.surface).border_1().border_color(t.border)
          .font_family(view.mono).text_size(12).text_color(item.status === "error" ? t.blocked : t.muted)
          .child(clipLines(item.result, 14))))
      .when(Boolean(item.images?.length), (el) => el.child(h_flex().gap(6).children((item.images ?? []).map((_, i) => {
        const path = view.imagePath(item.id, i);
        return path ? image(path).max_w(360).rounded(8) : div();
      }))))));
}

function clipLines(text, n) {
  const lines = text.split("\n");
  return lines.length > n ? [...lines.slice(0, n), `… ${lines.length - n} more lines`].join("\n") : text;
}

export function noticeRow(item, t) {
  const color = item.level === "error" ? t.blocked : item.level === "warning" ? t.working : t.dim;
  return row().items_center().py(6).child(div().text_size(12).text_color(color).child(item.text));
}

export function endRow(item, t) {
  return row().pt(2).pb(12).child(
    div().text_size(11.5).text_color(item.error ? t.blocked : t.dim)
      .child(item.error ? `Stopped: ${item.error}` : `Done in ${seconds(item.ms)}`));
}
