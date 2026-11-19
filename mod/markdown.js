import { div } from "gpui-kit";
import { v_flex, h_flex, TextView, EditorState, Editor } from "gpui-base";
import { settings } from "herdr";

const LANG = {
  ts: "js", tsx: "js", typescript: "js", javascript: "js", jsx: "js", mjs: "js", cjs: "js",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", shellscript: "bash",
  py: "python", rs: "rust", yml: "yaml", toml: "yaml", jsonc: "json", md: "markdown", golang: "go",
};

const LINE = 18;

export const language = (lang) => LANG[lang] ?? lang ?? "";

// Splits fenced code out of markdown; an unclosed fence (still streaming) is marked open.
export function split(text) {
  const parts = [];
  let prose = [];
  let code = null;
  for (const line of text.split("\n")) {
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (code) {
      if (fence && fence[1][0] === code.mark[0] && fence[1].length >= code.mark.length && !line.trim().slice(fence[1].length)) {
        parts.push({ kind: "code", lang: code.lang, code: code.lines.join("\n"), open: false });
        code = null;
      } else code.lines.push(line);
    } else if (fence) {
      if (prose.length) parts.push({ kind: "md", text: prose.join("\n") });
      prose = [];
      code = { mark: fence[1], lang: fence[2].toLowerCase(), lines: [] };
    } else prose.push(line);
  }
  if (code) parts.push({ kind: "code", lang: code.lang, code: code.lines.join("\n"), open: true });
  else if (prose.length) parts.push({ kind: "md", text: prose.join("\n") });
  return parts.filter((p) => p.kind === "code" || p.text.trim());
}

export function syntax(t) {
  return { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi6 };
}

// Editors are retained state: made in handlers with prepare(), only looked up while rendering.
export class CodeCache {
  constructor() { this.map = new Map(); }

  prepare(key, lang, code, t) {
    const hit = this.map.get(key);
    if (hit) {
      if (hit.code !== code) { hit.state.set_value(code); hit.code = code; }
      return;
    }
    const state = EditorState.new({
      language: language(lang), value: code, readonly: true, line_numbers: false, folding: false,
      font_family: settings().font_family, font_size: 12.5, syntax: syntax(t),
    });
    this.map.set(key, { state, code });
  }

  prepareText(id, text, t) {
    split(text).forEach((p, i) => { if (p.kind === "code" && !p.open) this.prepare(`${id}:${i}`, p.lang, p.code, t); });
  }

  peek(key) {
    return this.map.get(key)?.state ?? null;
  }

  clear() {
    for (const { state } of this.map.values()) state.release();
    this.map.clear();
  }
}

const SHELLS = new Set(["bash", "sh", "shell", "zsh", "console"]);

const commandOf = (label, code) => (label === "console"
  ? code.split("\n").filter((l) => /^\s*\$ /.test(l)).map((l) => l.replace(/^\s*\$ /, "")).join("\n")
  : code);

function runOutput(r, t, id, onDismiss) {
  const text = r.output.trimEnd();
  return v_flex().w_full().border_t_1().border_color(t.border).px(10).py(6).gap(4)
    .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
      .child(r.status === "running" ? div().text_color(t.working).frames(["◐", "◓", "◑", "◒"], 120) : div().text_color(r.code === 0 ? t.done : t.blocked).child(r.code === 0 ? "✓" : "✕"))
      .child(div().flex_1().child(r.status === "running" ? "Running…" : r.code === 0 ? "Done" : `Exit code ${r.code}`))
      .when(r.status !== "running", (el) => el.child(div().id(`run-x-${id}`).px(4).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => onDismiss(cx)).child("✕"))))
    .when(Boolean(text), (el) => el.child(div().id(`run-out-${id}`).max_h(220).overflow_y_scrollbar()
      .font_family(settings().font_family).text_size(12).text_color(t.muted).child(text)));
}

export function codeBlock(state, code, t, { label, maxLines = 40, onRun, runs, id } = {}) {
  const lines = Math.min(code.split("\n").length, maxLines);
  const run = onRun && SHELLS.has(label ?? "");
  const r = run ? runs?.get(id) : null;
  return v_flex().w_full().rounded(8).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
    .when(Boolean(label), (el) => el.child(h_flex().px(10).pt(6).items_center().text_size(11).text_color(t.dim)
      .child(div().flex_1().child(label))
      .when(run, (el) => el.child(h_flex().id(`run-${id}`).gap(4).px(6).py(1).rounded(5).items_center().cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Run here · Shift-click to run in a terminal")
        .on_click((e, cx) => onRun(id, commandOf(label, code), e.modifiers.shift, cx))
        .child("▶").child(r ? "Run again" : "Run")))))
    .child(div().w_full().h(lines * LINE + 14).px(4).py(6).child(Editor.new(state).size_full()))
    .when(Boolean(r), (el) => el.child(runOutput(r, t, id, (cx) => onRun(id, null, false, cx))));
}

export function markdown(id, text, t, codes, { size = 14, onRun, runs } = {}) {
  const parts = split(text);
  return v_flex().w_full().gap(10).children(parts.map((p, i) => {
    if (p.kind === "md") return TextView.markdown(`${id}:${i}`, p.text).selectable(true).text_size(size).w_full();
    const state = p.open ? null : codes.peek(`${id}:${i}`);
    if (!state) return TextView.markdown(`${id}:${i}`, "```" + p.lang + "\n" + p.code + "\n```").selectable(true).text_size(size).w_full();
    return codeBlock(state, p.code, t, { label: p.lang, maxLines: 400, onRun, runs, id: `${id}-${i}` });
  }));
}

const tint = (hex, alpha) => (/^#[0-9a-f]{6}$/i.test(hex ?? "") ? `${hex}${alpha}` : hex);

export function diffBlock(detail, t, mono, maxLines = 30) {
  const lines = detail.split("\n");
  const shown = lines.slice(0, maxLines);
  return v_flex().w_full().py(6).rounded(8).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
    .font_family(mono).text_size(12)
    .children(shown.map((l) => {
      const sign = l[0];
      const bg = sign === "+" ? tint(t.ansi2, "22") : sign === "-" ? tint(t.ansi1, "22") : null;
      return div().w_full().px(10).when(Boolean(bg), (el) => el.bg(bg))
        .text_color(sign === "+" || sign === "-" ? t.foreground : t.dim).child(l || " ");
    }))
    .when(lines.length > maxLines, (el) => el.child(div().px(10).pt(2).text_color(t.dim).child(`… ${lines.length - maxLines} more lines`)));
}
