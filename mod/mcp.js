import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { closeOverlay, props, run, theme } from "herdr";
import { WebSocket } from "websocket";
import { PROTOCOL, endpoint, openAuth } from "./engine.js";

const ORDER = ["needs-auth", "failed", "pending", "connected", "disabled"];
const STATUS = { "needs-auth": "Needs sign-in", failed: "Failed", pending: "Connecting…", connected: "Connected", disabled: "Disabled" };
const GROUP = { ...STATUS, pending: "Connecting" };
const SOURCE = {
  user: "User config (~/.claude.json)", local: "Local config (~/.claude.json, this folder)", project: "Project config (.mcp.json)",
  claudeai: "claude.ai connector", plugin: "Plugin", dynamic: "Plugin", managed: "Managed by your organization",
  enterprise: "Managed by your organization", sdk: "Herdr", agent: "Agent definition",
};

const tilde = (path) => path.replace(/^\/(Users|home)\/[^/]+/, "~");
const has = (q, ...fields) => !q || fields.some((f) => f?.toLowerCase().includes(q));

const isConnector = (m) => m.scope === "claudeai" || m.source === "claudeai" || m.transport === "claudeai-proxy";

function mcpActions(m) {
  const list = [];
  if (m.status === "connected" && m.tools) list.push(["tools", "View tools"]);
  if (m.status === "needs-auth") list.push(["signin", "Authenticate"]);
  else if (m.status === "connected" && !isConnector(m) && (m.transport === "http" || m.transport === "sse")) list.push(["signin", "Re-authenticate"], ["signout", "Clear authentication"]);
  if (m.status !== "disabled") list.push(["reconnect", "Reconnect"]);
  list.push(m.status === "disabled" ? ["enable", "Enable"] : ["disable", "Disable"]);
  return list;
}

export class McpDialog {
  constructor(p, cx) {
    this.p = p;
    this.servers = null;
    this.busy = new Set();
    this.open = null;
    this.tools = null;
    this.auth = null;
    this.error = null;
    this.tab = "chat";
    this.projects = null;
    this.project = null;
    this.handle = cx.focus_handle();
    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_e, cx) => cx.notify());
    cx.timer.after(50, () => this.search.focus());
    cx.spawn(async (cx) => this.connect(cx));
  }

  async connect(cx) {
    try {
      const { url, token } = await endpoint(this.p.machine, this.p.engine);
      this.ws = await WebSocket.connect(url);
      await this.ws.write(JSON.stringify({ type: "hello", v: PROTOCOL, token }));
      await this.ws.write(JSON.stringify({ type: "open", key: this.p.key, cwd: this.p.cwd }));
      this.send({ type: "mcp_list" });
      for (;;) {
        const raw = await this.ws.read();
        if (typeof raw !== "string") continue;
        await this.receive(JSON.parse(raw), cx);
        cx.notify();
      }
    } catch (e) {
      if (!this.closed) this.error = `Can't reach the engine: ${e?.message ?? e}`;
      cx.notify();
    }
  }

  async receive(m, cx) {
    if (m.type === "mcp") {
      this.servers = m.servers;
      this.busy = new Set();
      if (m.servers.some((x) => x.status === "pending")) cx.timer.after(2000, () => this.send({ type: "mcp_list" }));
    } else if (m.type === "mcp_tools" && this.open === m.server) this.tools = m.tools;
    else if (m.type === "mcp_projects") this.projects = m.projects;
    else if (m.type === "auth") this.auth = await openAuth(this.p.machine, m.server, m.url, (o) => this.send(o));
    else if (m.type === "state" && this.servers && JSON.stringify(m.state.mcp) !== JSON.stringify(this.needsAuth)) {
      this.needsAuth = m.state.mcp;
      this.send({ type: "mcp_list" });
    } else if (m.type === "error" && !m.fatal && this.busy.size) {
      this.busy = new Set();
      this.failure = m.message;
    }
  }

  send(o) {
    this.ws?.write(JSON.stringify(o)).catch(() => {});
  }

  dispose() {
    this.closed = true;
    this.ws?.close().catch(() => {});
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  query() {
    return this.search.value().trim().toLowerCase();
  }

  clearSearch() {
    this.search.set_value("");
    this.search.focus();
  }

  switchTab(tab, cx) {
    this.tab = tab;
    this.clearSearch();
    if (tab === "projects") this.send({ type: "mcp_projects" });
    cx.notify();
  }

  showProject(path, name, cx) {
    this.project = { path, name };
    cx.notify();
  }

  chatIn(path) {
    run("pane.split", { direction: "right", mod: "herdr-chat", props: { machine: this.p.machine, cwd: path, ...(this.p.engine ? { engine: this.p.engine } : {}) } });
    this.dismiss();
  }

  refresh(cx) {
    if (this.tab === "projects") this.send({ type: "mcp_projects" });
    this.send({ type: "mcp_list" });
    if (this.open && Array.isArray(this.tools)) this.send({ type: "mcp_tools", server: this.open });
    cx.notify();
  }

  show(server, cx) {
    this.clearSearch();
    this.open = server;
    this.tools = null;
    this.failure = null;
    cx.notify();
  }

  back(cx) {
    this.clearSearch();
    if (this.tools) this.tools = null;
    else if (this.project) this.project = null;
    else this.open = null;
    cx.notify();
  }

  act(server, action, cx) {
    this.failure = null;
    if (action === "tools") {
      this.clearSearch();
      this.tools = "loading";
      this.send({ type: "mcp_tools", server });
    } else if (action === "signin") {
      this.busy.add(server);
      this.auth = { server, url: null, input: null };
      this.send({ type: "mcp_auth", server });
    } else {
      this.busy.add(server);
      this.send({ type: "mcp_action", server, action });
    }
    cx.notify();
  }

  key(e, cx) {
    if (e.keystroke === "escape" && this.query()) this.clearSearch();
    else if (e.keystroke === "escape" && (this.open || this.project)) this.back(cx);
    else if (e.keystroke === "escape") this.dismiss();
    else return;
    cx.stop_propagation();
  }

  render() {
    return dialog(this);
  }
}

function dialog(view) {
  const t = theme();
  const menu = view;
  const color = { connected: t.done, "needs-auth": t.working, failed: t.blocked, pending: t.dim, disabled: t.dim };
  const dot = (m) => div().flex_none().size(8).rounded(4).bg(color[m.status] ?? t.dim);
  const link = (id, label, fn) => div().id(id).px(6).text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(fn).child(label);
  const server = menu.open ? menu.servers?.find((m) => m.name === menu.open) : null;
  const header = (title, back) => h_flex().px(18).pt(14).pb(10).gap(8).items_center().border_b_1().border_color(t.border)
    .when(Boolean(back), (el) => el.child(link("mcp-back", "‹", back)))
    .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().text_color(t.foreground).child(title))
    .when(!back, (el) => el.child(link("mcp-refresh", "Refresh", (_e, cx) => view.refresh(cx))))
    .child(link("mcp-close", "✕", (_e, cx) => view.dismiss()));
  if (view.error) return v_flex().size_full().rounded(14).border_1().border_color(t.border).bg(t.surface)
    .child(header("MCP servers", null)).child(div().px(18).py(12).text_size(12.5).text_color(t.blocked).child(view.error));
  const project = view.project && view.tab === "projects" ? view.project : null;
  const body = project ? projectDetails(view, project, t) : menu.tools && server ? tools(view, server, t) : server ? details(view, server, t, dot)
    : view.tab === "projects" ? projects(view, t) : list(view, t, dot);
  const title = project ? project.name : menu.tools && server ? `${server.label} tools` : server ? server.label : "MCP servers";
  const back = project || server ? (_e, cx) => view.back(cx) : null;
  const searchable = !project && (!server || menu.tools);
  const tab = (id, label) => div().id(`mcp-tab-${id}`).px(10).py(3).rounded(6).text_size(12).cursor_pointer()
    .text_color(view.tab === id ? t.foreground : t.dim).when(view.tab === id, (el) => el.bg(t.raised).border_1().border_color(t.border))
    .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => view.switchTab(id, cx)).child(label);
  return v_flex().id("mcp-dialog").track_focus(view.handle).on_key_down((e, cx) => view.key(e, cx)).size_full().rounded(14).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
    .child(header(title, back))
    .when(searchable, (el) => el.child(h_flex().px(14).pt(10).gap(8).items_center()
      .child(h_flex().flex_1().h(30).px(10).items_center().rounded(8).border_1().border_color(t.border).bg(t.background)
        .child(Input.new(view.search).flex_1().text_size(12.5)))
      .when(!server, (el) => el.child(tab("chat", "This chat")).child(tab("projects", "Other projects")))))
    .child(body);
}

function list(view, t, dot) {
  const q = view.query();
  const servers = view.servers?.filter((m) => has(q, m.label, m.name, m.target)) ?? null;
  const groups = ORDER.map((st) => [st, (servers ?? []).filter((m) => m.status === st)]).filter(([, l]) => l.length);
  return v_flex().id("mcp-list").flex_1().min_h(0).overflow_y_scrollbar().px(8).py(6)
    .when(!servers, (el) => el.child(div().px(10).py(10).text_size(12.5).text_color(t.dim).child("Loading servers…")))
    .when(Boolean(servers) && !servers.length, (el) => el.child(div().px(10).py(10).text_size(12.5).text_color(t.dim).child(q ? "No servers match" : "No MCP servers configured")))
    .children(groups.flatMap(([st, l]) => [
      div().px(10).pt(10).pb(4).text_size(11).text_color(t.dim).child(`${GROUP[st]} · ${l.length}`),
      ...l.map((m) => h_flex().id(`mcp-row-${m.name}`).gap(10).px(10).py(7).rounded(8).items_center().min_w(0)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => view.show(m.name, cx))
        .child(dot(m))
        .child(div().flex_none().text_size(13).text_color(m.status === "disabled" ? t.dim : t.foreground).child(m.label))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(m.error ? t.blocked : t.dim)
          .child(view.busy.has(m.name) ? "Working…" : m.error ?? (m.tools ? `${m.tools} tools` : "")))
        .child(div().flex_none().text_size(13).text_color(t.dim).child("›"))),
    ]));
}

function details(view, m, t, dot) {
  const busy = view.busy.has(m.name);
  const auth = view.auth?.server === m.name ? view.auth : null;
  const row = (k, v, c) => h_flex().gap(12).py(3).items_start().min_w(0)
    .child(div().w(96).flex_none().text_size(12).text_color(t.dim).child(k))
    .child(div().flex_1().min_w(0).text_size(12.5).text_color(c ?? t.foreground).child(v));
  const action = ([id, label]) => h_flex().id(`mcp-${id}`).px(10).py(7).rounded(8).items_center().text_size(13)
    .text_color(id === "disable" || id === "signout" ? t.muted : t.foreground)
    .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => view.act(m.name, id, cx))
    .child(div().flex_1().child(label)).child(div().text_size(13).text_color(t.dim).child(id === "tools" ? "›" : ""));
  return v_flex().id("mcp-details").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(12).gap(12)
    .child(v_flex()
      .child(h_flex().gap(8).py(3).items_center()
        .child(div().w(96).flex_none().text_size(12).text_color(t.dim).child("Status"))
        .child(dot(m))
        .child(div().text_size(12.5).text_color(t.foreground).child(STATUS[m.status] ?? m.status)))
      .when(Boolean(m.error), (el) => el.child(row("Error", m.error, t.blocked)))
      .when(Boolean(m.transport), (el) => el.child(row(m.transport === "stdio" ? "Command" : "URL", m.target ?? m.transport)))
      .when(Boolean(m.source ?? m.scope), (el) => el.child(row("Config", SOURCE[m.source ?? m.scope] ?? m.source ?? m.scope)))
      .when(Boolean(m.version), (el) => el.child(row("Version", m.version)))
      .when(m.status === "connected", (el) => el.child(row("Tools", m.tools ? `${m.tools}` : "None")))
      .child(row("Name", m.name, t.dim)))
    .when(Boolean(auth?.url), (el) => el.child(v_flex().gap(8).p(12).rounded(10).bg(t.raised)
      .child(div().text_size(12.5).text_color(t.foreground).child(`Finish signing in to ${m.label} in your browser.`))
      .when(Boolean(auth.input), (el) => el.child(h_flex().h(30).px(10).items_center().rounded(7).border_1().border_color(t.border).bg(t.background)
        .child(Input.new(auth.input).flex_1().text_size(12.5))))))
    .when(Boolean(view.failure), (el) => el.child(div().text_size(12).text_color(t.blocked).child(view.failure)))
    .child(busy && !auth?.url
      ? div().px(10).py(7).text_size(12.5).text_color(t.dim).child("Working…")
      : v_flex().mx(-10).children(mcpActions(m).map(action)));
}

function tools(view, m, t) {
  const q = view.query();
  const list = Array.isArray(view.tools) ? view.tools.filter((x) => has(q, x.name, x.description)) : view.tools;
  const badge = (label, c) => div().flex_none().px(6).rounded(5).border_1().border_color(t.border).text_size(10.5).text_color(c).child(label);
  return v_flex().id("mcp-tools").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(8)
    .when(list === "loading", (el) => el.child(div().py(8).text_size(12.5).text_color(t.dim).child("Loading tools…")))
    .when(Array.isArray(list) && !list.length, (el) => el.child(div().py(8).text_size(12.5).text_color(t.dim).child(q ? "No tools match" : `${m.label} has no tools right now`)))
    .children(Array.isArray(list) ? list.map((x) => v_flex().py(7).gap(2).border_b_1().border_color(t.border)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(x.name))
        .when(x.readOnly, (el) => el.child(badge("read-only", t.dim)))
        .when(x.destructive, (el) => el.child(badge("destructive", t.blocked))))
      .when(Boolean(x.description), (el) => el.child(div().text_size(12).text_color(t.dim).child(x.description)))) : []);
}

const SCOPE = { local: "Local config (~/.claude.json)", project: "Project config (.mcp.json)" };

function projects(view, t) {
  const q = view.query();
  const list = (view.projects ?? []).map((p) => ({ ...p, servers: p.servers.filter((m) => has(q, m.name, m.target, p.path)) })).filter((p) => p.servers.length);
  return v_flex().id("mcp-projects").flex_1().min_h(0).overflow_y_scrollbar().px(8).py(6)
    .when(!view.projects, (el) => el.child(div().px(10).py(10).text_size(12.5).text_color(t.dim).child("Loading projects…")))
    .when(Boolean(view.projects) && !list.length, (el) => el.child(div().px(10).py(10).text_size(12.5).text_color(t.dim)
      .child(q ? "No servers match" : "No other folder has its own MCP servers")))
    .children(list.flatMap((p) => [
      div().px(10).pt(10).pb(4).text_size(11).text_color(t.dim).truncate().child(tilde(p.path)),
      ...p.servers.map((m) => h_flex().id(`mcp-p-${p.path}-${m.name}`).gap(10).px(10).py(7).rounded(8).items_center().min_w(0)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => view.showProject(p.path, m.name, cx))
        .child(div().flex_none().text_size(13).text_color(t.foreground).child(m.name))
        .child(div().flex_none().px(6).rounded(5).border_1().border_color(t.border).text_size(10.5).text_color(t.dim).child(m.scope === "project" ? ".mcp.json" : "local"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(m.target ?? ""))
        .child(div().flex_none().text_size(13).text_color(t.dim).child("›"))),
    ]));
}

function projectDetails(view, sel, t) {
  const m = view.projects?.find((p) => p.path === sel.path)?.servers.find((x) => x.name === sel.name);
  const row = (k, v) => h_flex().gap(12).py(3).items_start().min_w(0)
    .child(div().w(96).flex_none().text_size(12).text_color(t.dim).child(k))
    .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.foreground).child(v));
  return v_flex().id("mcp-project").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(12).gap(12)
    .child(v_flex()
      .child(row("Folder", tilde(sel.path)))
      .when(Boolean(m?.transport), (el) => el.child(row(m.transport === "stdio" ? "Command" : "URL", m.target ?? m.transport)))
      .child(row("Config", SCOPE[m?.scope] ?? "")))
    .child(div().text_size(12).text_color(t.dim).child("Chats started in this folder load this server. This chat can't use it."))
    .child(h_flex().id("mcp-chat-in").mx(-10).px(10).py(7).rounded(8).items_center().text_size(13).text_color(t.foreground)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => view.chatIn(sel.path))
      .child(div().flex_1().child("Start a chat in this folder")).child(div().text_size(13).text_color(t.dim).child("›")));
}
