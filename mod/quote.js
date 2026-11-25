import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";

// The Claude desktop app's reply format, so Claude reads quotes the same way in both: each quote, then the reply to it.
const MARK = /^<!-- reply(?: \d+)? -->$/;

const blockquote = (text) => text.trim().split("\n").map((l) => `> ${l}`).join("\n");
const escape = (text) => text.replace(/^<!-- reply/gm, "&lt;!-- reply");
// Two blank lines end the quotes, so a reply keeps at most one.
const tidy = (text) => escape(text.trim()).replace(/\n{3,}/g, "\n\n");

export function withQuotes(quotes, text) {
  if (!quotes.length) return text;
  const lead = quotes.map((q, i) => {
    const mark = i === 0 ? `<!-- reply ${quotes.length} -->` : "<!-- reply -->";
    const reply = tidy(q.comment ?? "");
    return `${mark}\n${blockquote(escape(q.text))}${reply ? `\n\n${reply}` : ""}`;
  }).join("\n\n");
  return text ? `${lead}\n\n\n${text}` : lead;
}

export function splitQuotes(text) {
  const lines = (text ?? "").split("\n");
  if (!MARK.test(lines[0] ?? "")) return { quotes: [], body: text ?? "" };
  const quotes = [];
  let i = 0;
  const end = () => lines[i] === "" && lines[i + 1] === "";
  while (i < lines.length && MARK.test(lines[i])) {
    const q = [], reply = [];
    for (i++; i < lines.length && lines[i].startsWith(">"); i++) q.push(lines[i].replace(/^> ?/, ""));
    if (!end() && lines[i] === "") i++;
    for (; i < lines.length && !MARK.test(lines[i]) && !end(); i++) reply.push(lines[i]);
    while (reply.at(-1) === "") reply.pop();
    quotes.push({ text: q.join("\n"), comment: reply.join("\n") });
    if (end()) break;
  }
  while (i < lines.length && lines[i] === "") i++;
  return { quotes, body: lines.slice(i).join("\n") };
}

export const bodyOf = (text) => {
  const { quotes, body } = splitQuotes(text);
  return body || quotes[0]?.comment || quotes[0]?.text || "";
};

const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text);

export function quoteBlock(q, t, size = 13) {
  return v_flex().w_full().gap(4)
    .child(div().w_full().pl(10).border_l_2().border_color(t.border).text_size(size).text_color(t.muted).child(clip(q.text, 600)))
    .when(Boolean(q.comment), (el) => el.child(div().text_size(size + 1).child(q.comment)));
}

export function quoteChips(quotes, t, idPrefix, onRemove) {
  return v_flex().gap(6).px(10).pt(8).children(quotes.map((q, i) => h_flex().gap(8).items_start()
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(div().pl(8).border_l_2().border_color(t.accent).text_size(12.5).text_color(t.muted).child(clip(q.text, 240)))
      .when(Boolean(q.comment), (el) => el.child(div().pl(10).text_size(12.5).text_color(t.foreground).child(clip(q.comment, 240)))))
    .child(div().id(`${idPrefix}-${i}`).flex_none().px(4).cursor_pointer().text_size(11).text_color(t.dim)
      .hover((s) => s.text_color(t.foreground)).tooltip("Remove quote")
      .on_click((_e, cx) => { cx.stop_propagation(); onRemove(i, cx); }).child("✕"))));
}
