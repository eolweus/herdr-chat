import { div, image } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { markdown, codeBlock, diffBlock } from "./markdown.js";

const DIFF_TOOLS = ["Edit", "MultiEdit", "Write"];
const QUIET_TOOLS = ["Edit", "MultiEdit", "Write", "Read", "NotebookEdit", "TodoWrite"];

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
          const all = item.images.map((_, j) => view.imagePath(item.id, j)).filter(Boolean);
          return path
            ? div().id(`uimg-${item.id}-${i}`).w(160).h(100).rounded(8).overflow_hidden().border_1().border_color(t.border).cursor_pointer()
              .on_click(() => view.viewImages(all, all.indexOf(path))).child(image(path).size_full())
            : div().w(160).h(100).rounded(8).bg(t.surface);
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
  const showResult = Boolean(item.result) && (item.status === "error" || !QUIET_TOOLS.includes(item.name));
  const canOpen = Boolean(item.detail || showResult || item.images?.length || children.length);
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
        if (DIFF_TOOLS.includes(item.name)) return el.child(diffBlock(item.detail, t, view.mono));
        const state = view.codes.peek(`detail:${item.id}`);
        return el.child(state ? codeBlock(state, item.detail, t, { maxLines: 30 }) : div());
      })
      .when(Boolean(children.length), (el) => el.child(v_flex().gap(2).children(children.map((c) =>
        h_flex().gap(8).items_center().text_size(12.5).child(dot(c.status, t))
          .child(div().font_semibold().child(c.verb))
          .child(div().truncate().text_color(t.muted).child(c.meta))))))
      .when(showResult, (el) => el.child(
        div().max_h(260).overflow_hidden().px(10).py(8).rounded(8).bg(t.surface).border_1().border_color(t.border)
          .font_family(view.mono).text_size(12).text_color(item.status === "error" ? t.blocked : t.muted)
          .child(clipLines(item.result, 14))))
      .when(Boolean(item.images?.length), (el) => el.child(h_flex().gap(6).children((item.images ?? []).map((_, i) => {
        const path = view.imagePath(item.id, i);
        return path
          ? div().id(`timg-${item.id}-${i}`).w(240).h(150).rounded(8).overflow_hidden().border_1().border_color(t.border).cursor_pointer()
            .on_click(() => view.viewTools([{ id: item.id, i, path }], 0)).child(image(path).size_full())
          : div();
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

export function endRow(item, t, view) {
  const copied = view.copied === item.id;
  return row().pt(2).pb(12).child(h_flex().gap(10).items_center().text_size(11.5)
    .child(div().text_color(item.error ? t.blocked : t.dim).child(item.error ? `Stopped: ${item.error}` : `Done in ${seconds(item.ms)}`))
    .when(Boolean(view.replyFor(item.id)), (el) => el.child(div().id(`copy-${item.id}`).text_color(copied ? t.done : t.dim).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => view.copyReply(item.id, cx)).child(copied ? "Copied" : "Copy"))))
    .children(view.authFor(item.id).map((m) => signInRow(m, t, view)));
}

export function signInRow(m, t, view) {
  const auth = view.auth?.server === m.name ? view.auth : null;
  return v_flex().w_full().mt(8).gap(8).p(12).rounded(10).border_1().border_color(t.border).bg(t.surface)
    .child(h_flex().gap(10).items_center()
      .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground)
        .child(auth?.url ? `Finish signing in to ${m.label} in your browser, then ask again.` : `${m.label} needs you to sign in before Claude can use it.`))
      .child(div().id(`signin-${m.name}`).flex_none().px(12).py(5).rounded(7).cursor_pointer().text_size(12.5)
        .bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => { view.signIn(m.name); cx.notify(); })
        .child(auth ? (auth.url ? "Open again" : "Opening…") : `Sign in to ${m.label}`)))
    .when(Boolean(auth?.input), (el) => el.child(h_flex().h(30).px(10).items_center().rounded(7).border_1().border_color(t.border).bg(t.background)
      .child(Input.new(auth.input).flex_1().text_size(12.5))));
}

const base = (path) => path.split("/").pop();

function diffCount(detail) {
  const lines = (detail ?? "").split("\n");
  return { add: lines.filter((l) => l.startsWith("+")).length, del: lines.filter((l) => l.startsWith("-")).length };
}

const plural = (n, one, many) => (n === 1 ? one : `${n} ${many}`);

// "Ran 2 commands, read notes.txt, edited main.js +3 -1": counts per kind of tool, in order of first use.
export function summarize(tools) {
  const kinds = new Map();
  const add = (key, tool) => { if (!kinds.has(key)) kinds.set(key, []); kinds.get(key).push(tool); };
  for (const tool of tools) {
    const n = tool.name;
    if (n === "Bash") add("bash", tool);
    else if (n === "Read") add("read", tool);
    else if (n === "Edit" || n === "MultiEdit" || n === "NotebookEdit") add("edit", tool);
    else if (n === "Write") add("write", tool);
    else if (n === "Grep" || n === "Glob") add("search", tool);
    else if (n === "WebFetch") add("fetch", tool);
    else if (n === "WebSearch") add("web", tool);
    else if (n === "Task" || n === "Agent") add("agent", tool);
    else if (n === "TodoWrite") add("todo", tool);
    else if (n === "ToolSearch") add("toolsearch", tool);
    else if (n === "Skill") add("skill", tool);
    else if (n.startsWith("mcp__")) add(`mcp:${n.split("__")[1]}`, tool);
    else add(`other:${n}`, tool);
  }
  const parts = [];
  for (const [key, list] of kinds) {
    const c = list.length;
    const files = [...new Set(list.map((t) => base(t.meta)))];
    const stat = list.reduce((s, t) => { const d = diffCount(t.detail); return { add: s.add + d.add, del: s.del + d.del }; }, { add: 0, del: 0 });
    switch (key) {
      case "bash": parts.push({ text: `ran ${plural(c, "a command", "commands")}` }); break;
      case "read": parts.push({ text: files.length === 1 ? "read" : `read ${files.length} files`, file: files.length === 1 ? files[0] : null }); break;
      case "edit": parts.push({ text: files.length === 1 ? "edited" : `edited ${files.length} files`, file: files.length === 1 ? files[0] : null, ...stat }); break;
      case "write": parts.push({ text: files.length === 1 ? "created" : `created ${files.length} files`, file: files.length === 1 ? files[0] : null, add: stat.add }); break;
      case "search": parts.push({ text: `searched${c > 1 ? ` ${c} times` : ""}` }); break;
      case "fetch": parts.push({ text: `fetched ${plural(c, "a page", "pages")}` }); break;
      case "web": parts.push({ text: "searched the web" }); break;
      case "agent": parts.push({ text: `ran ${plural(c, "an agent", "agents")}` }); break;
      case "todo": parts.push({ text: "updated todos" }); break;
      case "toolsearch": parts.push({ text: "loaded tools" }); break;
      case "skill": parts.push({ text: `used ${c === 1 ? `the ${list[0].meta} skill` : `${c} skills`}` }); break;
      default:
        if (key.startsWith("mcp:")) parts.push({ text: `used ${key.slice(4)}${c > 1 ? ` ${c} times` : ""}` });
        else parts.push({ text: `used ${key.slice(6)}${c > 1 ? ` ${c} times` : ""}` });
    }
  }
  if (parts.length) parts[0].text = parts[0].text[0].toUpperCase() + parts[0].text.slice(1);
  return parts;
}

export function groupRow(group, t, view, children) {
  const open = view.expanded.has(group.id);
  const tools = group.items.filter((i) => i.kind === "tool");
  const running = tools.find((i) => i.status === "running" || i.status === "waiting");
  const failed = tools.filter((i) => i.status === "error").length;
  const thinking = group.items.find((i) => i.kind === "thinking" && i.streaming);
  const parts = summarize(tools);
  const thumbs = tools.flatMap((tool) => (tool.images ?? []).map((_, i) => ({ id: tool.id, i, path: view.imagePath(tool.id, i) }))).filter((x) => x.path);
  const line = h_flex().id(`group-${group.id}`).gap(6).items_center().min_w(0).text_size(13.5).text_color(t.dim)
    .cursor_pointer().hover((s) => s.text_color(t.muted))
    .on_click((_e, cx) => view.toggle(group.id, cx))
    .when(Boolean(running || thinking), (el) => el.child(div().text_size(11).text_color(t.working).frames(SPIN, 120)))
    .children(parts.length ? parts.flatMap((p, i) => {
      const comma = i < parts.length - 1 ? "," : "";
      const tail = [
        ...(p.file ? [{ text: p.file, color: t.foreground }] : []),
        ...(p.add ? [{ text: `+${p.add}`, color: t.ansi2 }] : []),
        ...(p.del ? [{ text: `-${p.del}`, color: t.ansi1 }] : []),
      ];
      const bits = [{ text: p.text, color: null }, ...tail];
      bits[bits.length - 1].text += comma;
      return bits.map((b) => div().flex_none().when(Boolean(b.color), (el) => el.text_color(b.color)).child(b.text));
    }) : [div().child(thinking ? "Thinking" : "Thought")])
    .child(div().flex_none().text_size(12).child(open ? "⌄" : "›"))
    .when(Boolean(running), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`${running.verb}${running.meta ? ` ${running.meta}` : ""}…`)))
    .when(!running, (el) => el.child(div().flex_1()))
    .when(failed > 0, (el) => el.child(div().flex_none().text_color(t.blocked).child(`${failed} failed`)))
    .children(thumbs.slice(0, 4).map((th, n) => div().id(`thumb-${group.id}-${n}`).flex_none().ml(4).w(40).h(26).rounded(4).border_1().border_color(t.border).overflow_hidden()
      .cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); view.viewTools(thumbs, n); })
      .child(image(th.path).size_full())));
  return v_flex().w_full().px(22).py(5)
    .child(line)
    .when(open, (el) => el.child(v_flex().mt(4).ml(4).pl(8).border_l_1().border_color(t.border)
      .children(group.items.map((i) => (i.kind === "tool" ? toolRow(i, t, view, children.get(i.id) ?? []) : thinkingRow(i, t, view)).px(8)))));
}
