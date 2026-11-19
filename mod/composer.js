import { div, image } from "gpui-kit";
import { v_flex, h_flex, Textarea, Popover } from "gpui-base";
import { exec, shared } from "herdr";

// Run output goes to Claude as a message, but it already shows under its block, so the chat hides it.
export const RUN_TAG = "<!-- herdr-chat:run -->";
export const isRunOutput = (i) => i.kind === "user" && (i.text?.startsWith(RUN_TAG) || i.text?.startsWith("I ran:\n```sh\n"));

const EFFORTS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" };

const EFFORT_NOTE = { medium: ["Recommended", null], max: ["⚠ 3.5× or more usage", "warn"] };

// The session reports a full model id; the menu lists aliases like "opus" that resolve to one.
function currentModel(s) {
  const ms = s.models ?? [];
  const id = ms.find((x) => x.value === s.model)?.resolved ?? s.model;
  return ms.find((x) => x.value !== "default" && (x.value === s.model || x.resolved === id)) ?? ms.find((x) => x.value === "default") ?? null;
}

export function efforts(s) {
  const m = currentModel(s);
  return m?.efforts?.length ? m.efforts : m ? [] : Object.keys(EFFORTS);
}

const primaryModels = (s) => (s.models ?? []).filter((m) => m.value !== "default" && !m.value.startsWith("claude-"));
const moreModels = (s) => (s.models ?? []).filter((m) => m.value.startsWith("claude-"));

export const MODES = [
  ["default", "Ask before edits"],
  ["acceptEdits", "Edit automatically"],
  ["plan", "Plan mode"],
  ["auto", "Auto mode"],
  ["bypassPermissions", "Bypass permissions"],
];

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
        .child(div().text_color(t.dim).child("Queued"))
        .child(div().flex_1().min_w(0).truncate().child(isRunOutput({ kind: "user", text: q.text }) ? "Command output" : q.text || `${q.images} image${q.images === 1 ? "" : "s"}`))
        .child(div().id(`unq-${q.id}`).px(4).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => view.unqueue(q.id, cx)).child("✕"))))))
    .when(view.commandMatches().length > 0, (el) => el.child(commandList(view, t)))
    .when(Boolean(view.mcpMenu), (el) => el.child(mcpList(view, t)))
    .when(Boolean(view.remoteMenu), (el) => el.child(remoteCard(view, t)))
    .child(v_flex().w_full().rounded(14).border_1().border_color(machineColor(view.machine) ?? (view.focusedInput ? t.accent : t.input)).bg(t.surface)
      .when(view.attachments.length > 0, (el) => el.child(h_flex().gap(8).px(10).pt(10).flex_wrap()
        .children(view.attachments.map((a, i) => div().relative()
          .child(image(a.path).h(56).max_w(120).rounded(6))
          .child(div().id(`rm-${i}`).absolute().top(-6).right(-6).w(18).h(18).rounded(9).flex().items_center().justify_center()
            .bg(t.raised).border_1().border_color(t.border).text_size(10).cursor_pointer()
            .on_click((_e, cx) => view.removeAttachment(i, cx)).child("✕"))))))
      .child(h_flex().w_full().items_end().gap(4).pl(6).pr(8).py(4)
        .child(div().id("attach").mb(4).w(30).h(30).rounded(15).flex().items_center().justify_center().cursor_pointer()
          .text_size(18).text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("Attach files")
          .on_click((_e, cx) => cx.spawn(async (cx) => view.attach(cx))).child("+"))
        .child(div().flex_1().min_w(0).child(Textarea.new(view.input).w_full().px(10).py(7).text_size(14).bg(t.surface)))
        .child(div().id("send").mb(4).w(30).h(30).rounded(15).flex().items_center().justify_center().cursor_pointer()
          .bg(stop ? t.raised : t.solid).text_color(stop ? t.foreground : t.solid_foreground).text_size(13)
          .tooltip(stop ? "Stop (Esc)" : s.busy ? "Queue (Enter)" : "Send (Enter)")
          .hover((s) => s.opacity(0.85))
          .on_click((_e, cx) => (stop ? view.interrupt(cx) : view.submit(cx)))
          .child(stop ? "■" : "↑"))))
    .child(h_flex().px(4).gap(4).items_center()
      .child(chip("mode", t).tooltip("Shift-Tab to change").on_click((_e, cx) => view.cycleMode(cx))
        .child(div().text_color(s.mode === "bypassPermissions" ? t.blocked : s.mode === "plan" ? t.accent : t.muted).child(mode)))
      .when(Boolean(s.model) || s.models?.length > 0, (el) => el.child(modelMenu(view, t)))
      .when(view.canWorktree(), (el) => el.child(chip("worktree", t).tooltip("Start this chat in a new git worktree")
        .on_click((_e, cx) => view.toggleWorktree(cx))
        .child(div().text_color(s.worktree ? t.foreground : t.dim).child(s.worktree ? "☑" : "☐"))
        .child(div().text_color(s.worktree ? t.foreground : t.muted).child("Worktree"))))
      .child(chip("remote", t).tooltip(s.remote ? "Remote Control is on" : "Continue this chat from claude.ai or your phone")
        .on_click((_e, cx) => view.toggleRemoteMenu(cx))
        .when(Boolean(s.remote), (el) => el.child(div().size(6).rounded(3).bg(t.done)))
        .child(div().text_color(s.remote ? t.foreground : t.muted).child(view.remotePending ? "Connecting…" : s.remote ? "Remote on" : "Remote")))
      .when(Boolean(machineColor(view.machine)), (el) => el.child(h_flex().gap(6).px(8).py(3).items_center().text_size(11.5)
        .text_color(machineColor(view.machine)).tooltip(`Running on ${view.machine ?? "this computer"}`)
        .child(div().size(6).rounded(3).bg(machineColor(view.machine)))
        .child(div().child(view.machine ?? "this computer"))))
      .child(div().flex_1())
      .when(s.busy, (el) => el.child(h_flex().gap(6).px(6).items_center().text_size(11.5).text_color(t.working)
        .child(div().frames(["◐", "◓", "◑", "◒"], 120))
        .child(div().child(s.status ?? "Working"))))
      .child(meter(s, t)));
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
function modelMenu(view, t) {
  const s = view.state;
  const cur = currentModel(s);
  const effort = s.effort && efforts(s).includes(s.effort) ? s.effort : null;
  const trigger = chip("model", t).when(view.modelMenu, (el) => el.bg(t.hover))
    .child(div().text_color(t.foreground).child(cur?.value === "default" ? primaryModels(s).find((m) => m.resolved === cur.resolved)?.name ?? cur.name : cur?.name ?? (s.model || "Model")))
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
    .child(rule(t))
    .child(h_flex().px(10).py(6).gap(10).items_center().text_size(13).text_color(t.foreground)
      .child(div().flex_1().child("Ultracode"))
      .child(toggle("ultracode", s.ultracode, t, (_e, cx) => view.setFlag("ultracode", !s.ultracode, cx))))
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

const MCP_ORDER = ["needs-auth", "failed", "pending", "connected", "disabled"];
const MCP_GROUP = { "needs-auth": "Needs sign-in", failed: "Failed", pending: "Connecting", connected: "Connected", disabled: "Disabled" };

function mcpList(view, t) {
  const { servers, busy } = view.mcpMenu;
  const color = { connected: t.done, "needs-auth": t.working, failed: t.blocked, pending: t.dim, disabled: t.dim };
  const action = (m, id, label) => div().id(`mcp-${id}-${m.name}`).flex_none().px(8).py(2).rounded(6).border_1().border_color(t.border)
    .bg(t.raised).text_size(11.5).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => view.mcpAction(m.name, id, cx)).child(label);
  const actions = (m) => {
    if (busy.has(m.name)) return [div().text_size(11.5).text_color(t.dim).child(view.auth?.server === m.name && view.auth.url ? "Finish in your browser" : "Working…")];
    if (m.status === "needs-auth") return [action(m, "signin", "Sign in"), action(m, "disable", "Disable")];
    if (m.status === "disabled") return [action(m, "enable", "Enable")];
    if (m.status === "connected" && !m.name.startsWith("claude.ai ") && m.scope !== "claudeai") return [action(m, "reconnect", "Reconnect"), action(m, "signout", "Sign out"), action(m, "disable", "Disable")];
    return [action(m, "reconnect", "Reconnect"), action(m, "disable", "Disable")];
  };
  const groups = MCP_ORDER.map((st) => [st, (servers ?? []).filter((m) => m.status === st)]).filter(([, list]) => list.length);
  return v_flex().w_full().rounded(12).border_1().border_color(t.border).bg(t.surface)
    .child(h_flex().px(14).pt(10).pb(6).items_center()
      .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child("MCP servers"))
      .child(div().id("mcp-refresh").px(6).text_size(11.5).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => view.openMcp(cx)).child("Refresh"))
      .child(div().id("mcp-close").px(6).text_size(13).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { view.mcpMenu = null; cx.notify(); }).child("✕")))
    .child(v_flex().id("mcp-list").max_h(380).overflow_y_scrollbar().px(4).pb(6)
      .when(!servers, (el) => el.child(div().px(10).py(8).text_size(12).text_color(t.dim).child("Loading servers…")))
      .when(Boolean(servers) && !servers.length, (el) => el.child(div().px(10).py(8).text_size(12).text_color(t.dim).child("No MCP servers configured")))
      .children(groups.flatMap(([st, list]) => [
        div().px(10).pt(8).pb(2).text_size(11).text_color(t.dim).child(MCP_GROUP[st]),
        ...list.map((m) => h_flex().gap(10).px(10).py(6).rounded(8).items_center().min_w(0).hover((s) => s.bg(t.hover))
          .child(div().flex_none().size(7).rounded(4).bg(color[m.status] ?? t.dim))
          .child(div().flex_none().text_size(13).text_color(m.status === "disabled" ? t.dim : t.foreground).child(m.label))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(m.error ? t.blocked : t.dim)
            .child(m.error ?? (m.tools ? `${m.tools} tools` : "")))
          .children(actions(m))),
      ])))
    .child(div().px(14).pb(8).text_size(11).text_color(t.dim).child("Esc to close"));
}

function remoteCard(view, t) {
  const url = view.state.remote;
  const button = (id, label, primary, fn) => div().id(id).flex_none().px(10).py(4).rounded(7).text_size(12).cursor_pointer()
    .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).border_1().border_color(primary ? t.solid : t.border)
    .hover((s) => s.opacity(0.85)).on_click(fn).child(label);
  return v_flex().w_full().gap(8).p(14).rounded(12).border_1().border_color(t.border).bg(t.surface)
    .child(h_flex().items_center()
      .child(div().flex_1().text_size(13).font_semibold().text_color(t.foreground).child("Remote Control"))
      .child(div().id("remote-close").px(6).text_size(13).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { view.remoteMenu = false; cx.notify(); }).child("✕")))
    .child(div().text_size(12.5).text_color(t.muted).child(url
      ? "This chat is open on claude.ai/code and in the Claude app on your phone. Messages from either side show up here."
      : "Continue this chat from claude.ai/code or the Claude app on your phone. It keeps running here, on this machine."))
    .when(Boolean(url), (el) => el.child(div().text_size(12).text_color(t.dim).truncate().child(url ?? "")))
    .child(h_flex().gap(8)
      .when(!url, (el) => el.child(button("remote-on", view.remotePending ? "Connecting…" : "Turn on", true, (_e, cx) => view.setRemote(true, cx))))
      .when(Boolean(url), (el) => el
        .child(button("remote-open", "Open in browser", true, () => exec("open", [url])))
        .child(button("remote-copy", view.copied === "remote" ? "Copied" : "Copy link", false, (_e, cx) => view.copyText("remote", url, cx)))
        .child(button("remote-off", "Turn off", false, (_e, cx) => view.setRemote(false, cx)))))
    .child(div().text_size(11).text_color(t.dim).child("New chats start with it on when remoteControlAtStartup is set in ~/.claude/settings.json."));
}
