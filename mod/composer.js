import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Textarea, Popover } from "gpui-base";
import { shared } from "herdr";
import { bodyOf, quoteChips } from "./quote.js";

// Run output goes to Claude as a message, but it already shows under its block, so the chat hides it.
export const RUN_TAG = "<!-- herdr-chat:run -->";
export const isRunOutput = (i) => i.kind === "user" && (i.text?.startsWith(RUN_TAG) || i.text?.startsWith("I ran:\n```sh\n"));

const EFFORTS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" };

const EFFORT_NOTE = { medium: ["Recommended", null], max: ["⚠ 3.5× or more usage", "warn"] };

// The session reports a full model id; the menu lists aliases like "opus" that resolve to one.
const agentOf = (m) => m.backend ?? "claude";
const ownModels = (s) => (s.models ?? []).filter((m) => agentOf(m) === (s.backend ?? "claude"));
const otherModels = (s) => (s.models ?? []).filter((m) => agentOf(m) !== (s.backend ?? "claude") && m.value !== "default" && !m.value.startsWith("claude-"));
export const AGENTS = { claude: "Claude", agy: "Antigravity" };

// Coloured logos are images; one-colour glyphs take the text colour.
const ICONS = { claude: { svg: "icons/claude.svg" }, agy: { image: "icons/antigravity.svg" } };
export const agentIcon = (backend, size, color) => {
  const i = ICONS[backend] ?? ICONS.claude;
  return i.image ? image(i.image).size(size).flex_none() : svg(i.svg).size(size).flex_none().text_color(color);
};

function currentModel(s) {
  const ms = ownModels(s);
  const id = ms.find((x) => x.value === s.model)?.resolved ?? s.model;
  return ms.find((x) => x.value !== "default" && (x.value === s.model || x.resolved === id)) ?? ms.find((x) => x.value === "default") ?? null;
}

// Only the levels the model's provider offers; before a model is known, those of the agent's first model.
export function efforts(s) {
  const m = currentModel(s) ?? ownModels(s).find((x) => x.efforts?.length);
  return m?.efforts?.length ? m.efforts : m ? [] : Object.keys(EFFORTS);
}

const primaryModels = (s) => ownModels(s).filter((m) => m.value !== "default" && !m.value.startsWith("claude-"));
const moreModels = (s) => ownModels(s).filter((m) => m.value.startsWith("claude-"));

// Like the Claude app's mode menu, in its order; {agent} becomes the chat's agent.
export const MODES = [
  ["auto", "Auto", "{agent} handles permission decisions"],
  ["default", "Manual", "Always ask before making changes"],
  ["acceptEdits", "Accept edits", "Automatically accept all file edits"],
  ["plan", "Plan", "Create a plan before making changes"],
  ["bypassPermissions", "Bypass permissions", "Accepts all permissions"],
];

// The modes the chat's agent accepts, in the Claude app's order, with the agent's own descriptions when it gives them.
export function availableModes(s) {
  if (!s.modes) return MODES;
  return MODES.flatMap(([value, name, about]) => {
    const m = s.modes.find((x) => x.value === value);
    return m ? [[value, name, m.description || about]] : [];
  });
}

// What the model chip shows: the menu lists aliases like "default" that resolve to a named model.
export function modelLabel(s) {
  const cur = currentModel(s);
  return cur?.value === "default" ? primaryModels(s).find((m) => m.resolved === cur.resolved)?.name ?? cur.name : cur?.name ?? s.model ?? "";
}

export const machineColor = (m) => (shared("machine.colors") ?? {})[m ?? "local"] ?? null;

const chip = (id, t) => h_flex().id(id).gap(6).px(8).py(3).rounded(6).items_center().text_size(11.5).text_color(t.muted)
  .cursor_pointer().hover((s) => s.bg(t.hover));

function meter(state, t) {
  const { used, max } = state.context;
  if (!used || !max) return div();
  const pct = Math.min(100, Math.round((used / max) * 100));
  const color = pct > 85 ? t.blocked : pct > 65 ? t.working : t.dim;
  return h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim).tooltip(`${used.toLocaleString()} of ${max.toLocaleString()} tokens`)
    .child(div().w(44).h(4).rounded(2).bg(t.raised).child(div().h_full().rounded(2).bg(color).w(Math.max(2, (44 * pct) / 100))))
    .child(div().child(`${pct}%`));
}

export function composer(view, t) {
  const s = view.state;
  const stop = s.busy && !view.hasDraft();
  const mode = MODES.find(([m]) => m === s.mode)?.[1] ?? s.mode;
  return v_flex().w_full().max_w(880).px(16).pt(8).pb(10).gap(6).flex_none()
    .when(s.queue.length > 0, (el) => el.child(v_flex().gap(4).px(4).children(s.queue.map((q) =>
      h_flex().gap(8).px(10).py(5).rounded(8).bg(t.raised).items_center().text_size(12.5)
        .child(div().id(`kind-${q.id}`).text_color(t.dim).tooltip(q.priority === "later" ? `Sent once ${view.agent()} finishes this turn` : `${view.agent()} reads this after its current step`)
          .child(q.priority === "later" ? "Queued" : "Steering"))
        .child(div().flex_1().min_w(0).truncate().child(isRunOutput({ kind: "user", text: q.text }) ? "Command output" : bodyOf(q.text) || `${q.images} image${q.images === 1 ? "" : "s"}`))
        .child(div().id(`now-${q.id}`).flex_none().px(8).py(1).rounded(6).border_1().border_color(t.border).bg(t.surface)
          .cursor_pointer().text_size(11.5).text_color(t.foreground).hover((s) => s.bg(t.hover)).tooltip(`Stop ${view.agent()} and send this now`)
          .on_click((_e, cx) => view.sendNow(q.id, cx)).child("Send now"))
        .child(div().id(`unq-${q.id}`).px(4).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => view.unqueue(q.id, cx)).child("✕"))))))
    .when(view.commandMatches().length > 0, (el) => el.child(commandList(view, t)))
    .child(v_flex().w_full().rounded(14).border_1().border_color(machineColor(view.machine) ?? (view.focusedInput ? t.accent : t.input)).bg(t.surface)
      .when(view.quotes.length > 0, (el) => el.child(quoteChips(view.quotes, t, "quote", (i, cx) => view.removeQuote(i, cx))))
      .when(view.attachments.length > 0, (el) => el.child(h_flex().gap(8).px(10).pt(10).flex_wrap()
        .children(view.attachments.map((a, i) => div().relative()
          .child(div().id(`att-${i}`).cursor_pointer().hover((s) => s.opacity(0.85))
            .on_click(() => view.viewImages(view.attachments.map((x) => x.path), i))
            .child(image(a.path).h(56).max_w(120).rounded(6)))
          .child(div().id(`rm-${i}`).absolute().top(-6).right(-6).w(18).h(18).rounded(9).flex().items_center().justify_center()
            .bg(t.raised).border_1().border_color(t.border).text_size(10).cursor_pointer()
            .on_click((_e, cx) => { cx.stop_propagation(); view.removeAttachment(i, cx); }).child("✕"))))))
      .child(h_flex().w_full().items_end().gap(4).pl(6).pr(8).py(4)
        .child(div().id("attach").mb(4).w(30).h(30).rounded(15).flex().items_center().justify_center().cursor_pointer()
          .text_size(18).text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("Attach files")
          .on_click((_e, cx) => cx.spawn(async (cx) => view.attach(cx))).child("+"))
        .child(div().flex_1().min_w(0).child(Textarea.new(view.input).w_full().px(10).py(7).text_size(14).bg(t.surface)))
        .child(div().id("send").mb(4).w(30).h(30).rounded(15).flex().items_center().justify_center().cursor_pointer()
          .bg(stop ? t.raised : t.solid).text_color(stop ? t.foreground : t.solid_foreground).text_size(13)
          .tooltip(stop ? "Stop (Esc)" : s.busy ? "Steer (Enter) · Queue for later (Cmd-Enter)" : "Send (Enter)")
          .hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => (stop ? view.interrupt(cx) : view.submit(cx)))
          .child(stop ? "■" : "↑"))))
    .child(h_flex().px(4).gap(4).items_center()
      .child(modeMenu(view, t, mode))
      .when(Boolean(s.model) || s.models?.length > 0, (el) => el.child(modelMenu(view, t)))
      .when(view.canWorktree(), (el) => el.child(chip("worktree", t).tooltip("Start this chat in a new git worktree")
        .on_click((_e, cx) => view.toggleWorktree(cx))
        .child(div().size(13).rounded(4).flex().items_center().justify_center().border_1()
          .border_color(s.worktree ? t.accent : t.dim).bg(s.worktree ? t.accent : t.surface)
          .when(Boolean(s.worktree), (el) => el.child(svg("mods/herdr-chat/icons/check.svg").size(9).text_color(t.solid_foreground))))
        .child(div().text_color(s.worktree ? t.foreground : t.muted).child("Worktree"))))
      .when(Boolean(machineColor(view.machine)), (el) => el.child(h_flex().gap(6).px(8).py(3).items_center().text_size(11.5)
        .text_color(machineColor(view.machine)).tooltip(`Running on ${view.machine ?? "this computer"}`)
        .child(div().size(6).rounded(3).bg(machineColor(view.machine)))
        .child(div().child(view.machine ?? "this computer"))))
      .child(div().flex_1())
      .when(view.vimOn(), (el) => el.child(vimBadge(view.vim.mode, t)))
      .when(s.busy, (el) => el.child(h_flex().gap(6).px(6).items_center().text_size(11.5).text_color(t.working)
        .child(div().frames(["◐", "◓", "◑", "◒"], 120))
        .child(div().child(s.status ?? "Working"))))
      .child(meter(s, t)));
}

const VIM_MODES = { normal: ["NORMAL", "done"], insert: ["INSERT", "accent"], visual: ["VISUAL", "working"], vline: ["V-LINE", "working"] };

function vimBadge(mode, t) {
  const [label, color] = VIM_MODES[mode] ?? VIM_MODES.insert;
  return div().px(7).py(1).rounded(5).bg(t[color]).text_color(t.background).text_size(11).font_semibold().child(label);
}

function commandList(view, t) {
  const cmds = view.commandMatches();
  return v_flex().w_full().p(4).rounded(12).border_1().border_color(t.border).bg(t.surface)
    .children(cmds.map((c, i) => h_flex().id(`cmd-${c.name}`).gap(10).px(10).py(6).rounded(8).items_baseline().cursor_pointer()
      .bg(i === view.commandAt ? t.selected : t.surface).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => view.complete(c, cx))
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(`/${c.name}`))
      .when(Boolean(c.hint), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(c.hint)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(c.description))))
    .child(div().px(10).pt(4).pb(2).text_size(11).text_color(t.dim).child("↑↓ to move · Tab or Enter to pick · Esc to clear"));
}

const toggle = (id, on, t, onClick) => div().id(id).flex_none().w(34).h(20).rounded(10).p(2).cursor_pointer()
  .bg(on ? t.accent : t.raised).border_1().border_color(on ? t.accent : t.border).flex().items_center().when(on, (el) => el.justify_end())
  .on_click(onClick).child(div().size(14).rounded(7).bg(t.surface).shadow_md());

const card = (t) => v_flex().p(6).rounded(14).border_1().border_color(t.border).bg(t.surface).shadow_lg();
const rule = (t) => div().h(1).mx(8).my(4).bg(t.border);
const row = (id, t) => h_flex().id(id).gap(10).px(10).py(6).rounded(8).items_center().cursor_pointer().text_size(13).text_color(t.foreground).hover((s) => s.bg(t.hover));
const check = (t) => div().flex_none().text_color(t.accent).child("✓");

// Like the desktop app's model menu: models up front, effort and older models in panels beside it.
function modeMenu(view, t, label) {
  const s = view.state;
  const trigger = chip("mode", t).when(view.modeMenu, (el) => el.bg(t.hover)).tooltip("Mode · Shift-Tab to cycle")
    .child(div().text_color(s.mode === "bypassPermissions" ? t.blocked : s.mode === "plan" ? t.accent : t.muted).child(label));
  const list = card(t).w(300)
    .child(div().px(10).pt(4).pb(4).text_size(12).text_color(t.dim).child("Mode"))
    .children(availableModes(s).map(([value, name, about], i) => h_flex().id(`mode-${value}`).gap(10).px(10).py(6).rounded(8).items_center().cursor_pointer()
      .hover((st) => st.bg(t.hover)).on_click((_e, cx) => view.pickMode(value, cx))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(13.5).text_color(value === "bypassPermissions" ? t.blocked : t.foreground).child(name))
        .child(div().text_size(12).text_color(t.dim).child(about.replace("{agent}", view.agent()))))
      .when(s.mode === value, (el) => el.child(check(t)))
      .child(div().flex_none().w(12).text_size(12).text_color(t.dim).child(String(i + 1)))));
  return Popover.new("mode-menu").anchor("bottom_left").open(Boolean(view.modeMenu))
    .on_open_change((open, cx) => { view.modeMenu = open; cx.notify(); })
    .trigger(trigger)
    .content(div().mb(6)
      .on_key_down((e, cx) => {
        const m = availableModes(s)[Number(e.keystroke) - 1];
        if (m) { view.pickMode(m[0], cx); cx.stop_propagation(); }
      })
      .child(list));
}

function modelMenu(view, t) {
  const s = view.state;
  const cur = currentModel(s);
  const effort = s.effort && efforts(s).includes(s.effort) ? s.effort : null;
  const trigger = chip("model", t).when(view.modelMenu, (el) => el.bg(t.hover))
    .child(agentIcon(s.backend, 12, t.muted))
    .child(div().text_color(t.foreground).child(modelLabel(s) || "Model"))
    .when(Boolean(effort), (el) => el.child(div().text_color(t.dim).child(EFFORTS[effort])));
  const sub = (name) => (hovered, cx) => { if (hovered && view.modelSub !== name) { view.modelSub = name; cx.notify(); } };
  const pick = (m, i, list) => row(`model-${m.value}`, t).on_hover(sub(null)).on_click((_e, cx) => view.pickModel(m.value, cx))
    .child(div().flex_1().child(m.name))
    .child(cur && (m.value === cur.value || m.resolved === cur.resolved) ? check(t) : div().flex_none().text_size(12).text_color(t.dim).child(list ? String(i + 1) : ""));
  const main = card(t).w(240)
    .children(primaryModels(s).map((m, i) => pick(m, i, true)))
    .when(efforts(s).length > 0, (el) => el.child(rule(t)).child(row("effort", t).on_hover(sub("effort")).bg(view.modelSub === "effort" ? t.hover : t.surface)
      .on_click((_e, cx) => { view.modelSub = "effort"; cx.notify(); })
      .child(div().flex_1().child("Effort"))
      .child(div().text_color(t.dim).child(effort ? EFFORTS[effort] : "Default")).child(div().text_color(t.dim).child("›"))))
    .when(otherModels(s).length > 0, (el) => {
      const other = agentOf(otherModels(s)[0]);
      const locked = view.started();
      return el.child(rule(t))
        .child(h_flex().px(10).pt(2).pb(2).gap(6).items_center().text_size(12).text_color(t.dim)
          .child(agentIcon(other, 11, t.dim)).child(div().child(locked ? `${AGENTS[other]} · new chats only` : AGENTS[other])))
        .children(otherModels(s).map((m) => locked
          ? h_flex().id(`model-${other}-${m.value}`).px(10).py(6).text_size(13).text_color(t.dim).tooltip(`Start a new chat to use ${AGENTS[other]}`).child(m.name)
          : row(`model-${other}-${m.value}`, t).on_hover(sub(null)).on_click((_e, cx) => view.pickModel(m.value, cx, other)).child(div().flex_1().child(m.name))));
    })
    .when(moreModels(s).length > 0, (el) => el.child(rule(t)).child(row("more", t).on_hover(sub("more")).bg(view.modelSub === "more" ? t.hover : t.surface)
      .on_click((_e, cx) => { view.modelSub = "more"; cx.notify(); })
      .child(div().flex_1().child("More models")).child(div().text_color(t.dim).child("›"))))
    .when(Boolean(cur?.fast), (el) => el.child(rule(t))
      .child(div().px(10).pt(2).text_size(12).text_color(t.dim).child("Fast mode"))
      .child(h_flex().px(10).py(6).gap(10).items_center().text_size(13).text_color(t.foreground).on_hover(sub(null))
        .child(div().flex_1().child("Enable fast mode"))
        .child(toggle("fast", s.fast, t, (_e, cx) => view.setFlag("fast", !s.fast, cx)))));
  const side = view.modelSub === "effort" ? card(t).w(300)
    .child(div().px(10).pt(4).pb(6).text_size(12).text_color(t.muted).child("Higher effort means more thorough responses, but takes longer and uses your limits faster."))
    .children(efforts(s).map((e) => row(`effort-${e}`, t).on_click((_e, cx) => view.pickEffort(e, cx))
      .child(div().child(EFFORTS[e] ?? e))
      .when(Boolean(EFFORT_NOTE[e]), (el) => el.child(div().px(6).py(1).rounded(5).text_size(11)
        .bg(EFFORT_NOTE[e][1] ? t.working + "22" : t.raised).text_color(EFFORT_NOTE[e][1] ? t.working : t.muted).child(EFFORT_NOTE[e][0])))
      .child(div().flex_1())
      .when(effort === e, (el) => el.child(check(t)))))
    .when(view.claudeOnly(), (el) => el.child(rule(t))
      .child(h_flex().px(10).py(6).gap(10).items_center().text_size(13).text_color(t.foreground)
        .child(div().flex_1().child("Ultracode"))
        .child(toggle("ultracode", s.ultracode, t, (_e, cx) => view.setFlag("ultracode", !s.ultracode, cx)))))
    : view.modelSub === "more" ? card(t).w(260).children(moreModels(s).map((m, i) => pick(m, i, false))) : null;
  return Popover.new("model-menu").anchor("bottom_left").open(Boolean(view.modelMenu))
    .on_open_change((open, cx) => { view.modelMenu = open; if (!open) view.modelSub = null; cx.notify(); })
    .trigger(trigger)
    .content(h_flex().gap(6).items_end().mb(6)
      .on_key_down((e, cx) => {
        const i = Number(e.keystroke) - 1;
        const m = primaryModels(s)[i];
        if (m) { view.pickModel(m.value, cx); cx.stop_propagation(); }
      })
      .child(main).when(Boolean(side), (el) => el.child(side)));
}

