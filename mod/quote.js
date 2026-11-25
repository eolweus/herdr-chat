import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

// The Claude desktop app's reply format, so Claude reads quotes the same way in both.
const MARK = /^<!-- reply(?: \d+)? -->$/;

const blockquote = (text) => text.trim().split("\n").map((l) => `> ${l}`).join("\n");
const escape = (text) => text.replace(/^<!-- reply/gm, "&lt;!-- reply");

export function withQuotes(quotes, text) {
  if (!quotes.length) return text;
  const lead = quotes.map((q, i) => `${i === 0 ? `<!-- reply ${quotes.length} -->` : "<!-- reply -->"}\n${blockquote(escape(q))}`).join("\n\n");
  return text ? `${lead}\n\n\n${text}` : lead;
}

export function splitQuotes(text) {
  const lines = (text ?? "").split("\n");
  if (!MARK.test(lines[0] ?? "")) return { quotes: [], body: text ?? "" };
  const quotes = [];
  let i = 0;
  while (i < lines.length && MARK.test(lines[i])) {
    const q = [];
    for (i++; i < lines.length && lines[i].startsWith(">"); i++) q.push(lines[i].replace(/^> ?/, ""));
    quotes.push(q.join("\n"));
    while (i < lines.length && lines[i] === "") i++;
  }
  return { quotes, body: lines.slice(i).join("\n") };
}

export const bodyOf = (text) => splitQuotes(text).body;

export function quoteBlock(text, t, size = 13) {
  return div().w_full().pl(10).border_l_2().border_color(t.border).text_size(size).text_color(t.muted)
    .child(text.length > 600 ? `${text.slice(0, 600)}…` : text);
}

export function quoteChips(quotes, t, idPrefix, onRemove) {
  return v_flex().gap(4).px(10).pt(8).children(quotes.map((q, i) => h_flex().gap(8).items_start()
    .child(div().flex_1().min_w(0).pl(8).border_l_2().border_color(t.accent).text_size(12.5).text_color(t.muted)
      .child(q.length > 240 ? `${q.slice(0, 240)}…` : q))
    .child(div().id(`${idPrefix}-${i}`).flex_none().px(4).cursor_pointer().text_size(11).text_color(t.dim)
      .hover((s) => s.text_color(t.foreground)).tooltip("Remove quote")
      .on_click((_e, cx) => { cx.stop_propagation(); onRemove(i, cx); }).child("✕"))));
}
