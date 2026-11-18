# herdr-chat: plan

A Claude Code chat pane for the Herdr app that feels like the Claude desktop app's Code view.
A pane sits in a tab next to terminals, runs on the user's Claude plan, and works for
spaces on this Mac and on munin.

## What the spike proved (2026-11-18)

- The Agent SDK drives the logged-in `claude` CLI (`apiKeySource: none`, so usage goes to the plan).
- A mod's `websocket` module reaches a local engine. Text and binary frames both work.
- `fs.writeFile(Uint8Array)` into `~/.config/herdr-app/data/` followed by `image()` shows images.
- Pasted images work: `paste_other` → the same `osascript «class PNGf»` dump Claude Code uses → base64 to the engine.
- `TextView.markdown` renders streaming text, tables and code fences. Fences have no syntax highlighting.
- Saving `main.js` hot-reloads the open pane.

Still unproven: the permission-card click path, Enter-to-send in `Textarea`, and scroll performance in long sessions.

## Architecture

```
Herdr app (Mac)                               machine running Claude (Mac or munin)
┌────────────────────────────┐   WebSocket    ┌──────────────────────────────────┐
│ mod: herdr-chat (pane)     │ ─────────────► │ engine (Bun, long-lived service) │
│  renders items, composer,  │ ◄───────────── │  sessions ─► Agent SDK ─► claude │
│  cards; no SDK knowledge   │  items/patches │  normalizer: SDK events → items  │
└────────────────────────────┘                └──────────────────────────────────┘
```

### Engine (`engine/`)

- **One engine per machine.** It runs as a user service: launchd on the Mac, a systemd user unit on munin.
  Sessions live in the engine, not in the WebSocket. Closing the pane or restarting the app leaves
  a running turn running.
- **Sessions are keyed by Claude's session id.** The engine keeps a `pane → session` map in
  `~/.local/state/herdr-chat/panes.json`, because mods can't rewrite their own props but
  `props().pane` is stable.
- **The normalizer is the core of the engine.** It turns SDK messages into a flat list of UI
  items, each with a stable `id`, and sends `upsert`s:
  - `user` (text, images)
  - `text` (markdown, streaming)
  - `thinking` (text, duration)
  - `tool` (name, verb, meta, status, a result summary, an optional diff/output preview, a parent for subagents)
  - `permission`, `question`, `plan` (cards, with state)
  - `notice` (compact, hook, rate limit, error)
  - `turn_end` (files changed, duration)

  The mod renders items and never sees an SDK message. This keeps the per-tool rules in typed,
  testable TS, and lets a reconnect be "send the snapshot".
- **Streaming deltas are batched.** They're coalesced and flushed about every 50 ms, so the mod
  re-parses markdown at most around 20×/s.
- **History after an engine restart:** resume with the SDK's `resume`. The transcript is rebuilt
  from `getSessionMessages` through the same normalizer, so it looks exactly as it did live.
- **Images going out** (screenshots Claude takes, image tool results) travel as base64 inside
  the item. The mod caches them under `data/herdr-chat/<session>/`.

### Protocol (JSON, versioned)

Mod → engine:

| message | fields |
|---|---|
| `hello` | `v`, `token` |
| `open` | `pane`, `cwd`, `resume?` → returns `session` + full snapshot |
| `prompt` | `text`, `images[]`, `when: "now" \| "queue"` |
| `queue.remove` / `queue.move` | `index` |
| `interrupt` | |
| `answer` | `item`, `decision: once \| session \| always \| deny`, `message?` (permission) or `answers` (question/plan) |
| `set` | `mode?`, `model?`, `effort?` |

Engine → mod: `snapshot {items, state}`, `upsert {item}`, `remove {id}`,
`state {busy, mode, model, context: {used, max}, queue[]}`, `error`.

### Mod (`mod/`)

Files, one concern each:

| file | concern |
|---|---|
| `main.js` | connection, reconnect with backoff, state, keys |
| `transcript.js` | item → row; follows output unless the user scrolled up |
| `markdown.js` | splits fences out: prose to `TextView.markdown`, code to a readonly `Editor` with the theme's syntax colours |
| `tools.js` | one-line tool rows (verb + meta + status dot), click to expand output/diff |
| `cards.js` | permission, AskUserQuestion, and later plan approval |
| `composer.js` | textarea, attachment chips, queue list, mode/model chips, context meter, send/stop button |

Look:
- Everything comes from `theme()`, so it follows light/dark and the user's theme.
- User messages are right-aligned bubbles; Claude's replies are full-width prose.
- Rows are quiet and dense; cards have an accent border.

### Opening a chat

- A Herdr key (to be picked with the user) runs `tab.new` / `pane.split` with
  `{mod: "herdr-chat", props: {machine, cwd}}`, taken from the focused space.
- The `machine` prop chooses the engine:
  - local → `127.0.0.1:7777`
  - munin → its WireGuard address, from `data/herdr-chat/machines.json`
- The token is read from `~/.config/herdr-chat/token` on that machine with `readTextFile(path, {on: machine})`.
  The secret never has to be copied by hand.
- The engine binds to localhost plus the WireGuard interface only.

## Milestone 1: a chat you'd use daily

1. **Engine core:** session manager, normalizer, protocol, delta batching, pane map, token auth,
   `bun test` with recorded fixtures.
2. **Replay harness:** `engine --replay fixture.jsonl` plays a recorded session through the real
   protocol, so UI work spends no usage and is deterministic. The fixtures are recorded from real sessions.
3. **Mod shell:** connect/reconnect, snapshot + upserts, a transcript that follows output, the header
   (model, mode, busy).
4. **Messages:**
   - markdown with highlighted code blocks
   - thinking collapsed to "Thought for Ns", expandable
   - user bubbles with images
5. **Tool rows:** verbs for Bash, Read, Edit/Write/MultiEdit, Grep/Glob, WebFetch/WebSearch, Task,
   TodoWrite, plus a generic fallback for MCP tools. Click a row to expand its output.
6. **Cards:**
   - permission: Allow once / Allow for session / Deny with a reason; Edit/Write requests show the diff
   - AskUserQuestion: options, "Other", Skip
7. **Composer:**
   - Enter sends, Shift-Enter adds a newline, ⌘Enter queues, Esc interrupts
   - image paste and drop, with removable chips
   - a queued-message list
   - a mode picker (default / acceptEdits / plan / bypass) and a model picker
   - a context meter
8. **Alerts:** `notify()` with a click-through to the pane when a card needs the user and the pane isn't visible.
9. **Remote:** the engine as a systemd user unit on munin, the machines map, verified over WireGuard.
10. **Install:** `scripts/install.sh` installs the launchd/systemd unit, writes the token and links the mod.
    It lives in this repo; the unit files go through dotfiles if the user wants.

## Milestone 2

- **Plan mode:** a plan approval card and a plan side panel with comments.
- **Work tracking:** a TodoWrite/Tasks panel, and subagent grouping ("3 agents running").
- **Rewind and fork from a message** (`rewindFiles`, `forkSession`), plus a per-turn "Edited N files" summary.
- **Pickers:** slash commands and skills (from the `commands_changed` events), and @-file mentions.
- **Session list:** resume an earlier session (`listSessions`), and compact.
- **Usage:** cost and usage display, reusing the existing `usage` mod's data source.

## How it's checked

- `bun test` covers the normalizer against fixtures, one per tool type and card kind.
- `herdr-app check` runs after every mod change. `herdr-app shot` and the replay harness give
  visual checks without spending usage.
- Each milestone-1 item ends with a real session in a Herdr pane, on the Mac and on munin.

## Risks and open questions

- **Markdown cost:** `TextView.markdown` on long streaming text. If it's slow, the fallback is to
  freeze finished paragraphs and stream only the tail.
- **Long transcripts:** if the plain scroll area stutters, move to `v_virtual_list`, which needs fixed or measured heights.
- **Enter in `Textarea`:** whether `submit` fires on Enter is unverified. If not, handle keys on the wrapping element.
- **Not in the agents list:** a mod pane isn't a terminal, so it won't appear in Herdr's agents list or
  status dots (OSC 7501). Alerts use `notify`/`setBadge` until there's a better hook.
- **WireGuard down:** munin panes show a clear "can't reach munin" state instead of hanging.
