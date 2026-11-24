import { appHome, exec, home, panes, run } from "herdr";

// herdr-mods' files-work also previews images and PDFs and opens nvim; use it when it's installed.
let filesWork = null;

// Opens beside `beside`, replacing a file viewer already in that tab so clicks don't pile up panes.
export function openFile(cx, path, machine, opts) {
  cx.spawn(async () => {
    filesWork ??= (await exec("test", ["-e", `${appHome()}/mods/files-work/mod.json`]).catch(() => null))?.code === 0;
    split(path, machine, opts);
  });
}

function split(path, machine, { line = null, beside = null } = {}) {
  const mod = filesWork ? "files-work" : "herdr-chat";
  const props = filesWork ? { path, machine, line } : { file: path, machine };
  const all = panes(), tab = beside && all.find((x) => x.pane === beside)?.tab;
  const old = filesWork && tab && all.find((x) => x.tab === tab && x.mod === "files-work");
  if (old) run("pane.close", { pane: old.pane });
  run("pane.split", { direction: "right", ...(beside ? { pane: beside } : {}), mod, props });
}

const SCHEME = "herdr-file:";
const LINE = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/;
const PATHLIKE = /^(?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\/?$/;
// Existing links, inline code and URLs are kept whole; paths are looked for in the text between them.
const TOKENS = /(`[^`\n]+`|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]+>|[a-z][\w+.-]*:\/\/\S+)/i;
const BARE = /(^|[\s"'(*_])((?:~|\.{1,2})?\/?[\w.@+-]+\/[\w./@+-]*[\w@+-]|\/[\w.@+-]+\.[\w]+)((?::\d+){1,2})?/g;

const parse = (ref) => {
  const m = ref.match(LINE);
  return m ? { path: ref.slice(0, m.index), line: Number(m[1] ?? m[2]) } : { path: ref, line: null };
};
const candidate = (path) => PATHLIKE.test(path) && (path.includes("/") || /\.[A-Za-z][\w]{0,7}$/.test(path)) && !/^\d/.test(path);
const url = (abs, line) => SCHEME + encodeURIComponent(abs).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`) + (line ? `#${line}` : "");

// Turns references to files that exist into links, checking each path once per chat on its machine.
export class FileLinks {
  constructor() {
    this.known = new Map();
    this.pending = new Set();
    this.memo = new Map();
  }

  resolve(raw) {
    if (!this.known.has(raw)) this.pending.add(raw);
    return this.known.get(raw) ?? null;
  }

  linkify(text) {
    let out = this.memo.get(text);
    if (out === undefined) {
      if (this.memo.size > 500) this.memo.clear();
      this.memo.set(text, (out = this.link(text)));
    }
    return out;
  }

  link(text) {
    return text.split(TOKENS).map((part, i) => {
      if (i % 2 === 0) return part.replace(BARE, (all, pre, ref, line) => {
        const abs = this.resolve(ref);
        return abs ? `${pre}[${ref}${line ?? ""}](${url(abs, line ? Number(line.slice(1).split(":")[0]) : null)})` : all;
      });
      if (part[0] !== "`") return part;
      const { path, line } = parse(part.slice(1, -1).trim());
      if (!candidate(path)) return part;
      const abs = this.resolve(path);
      return abs ? `[${part}](${url(abs, line)})` : part;
    }).join("");
  }

  async check(cwd, machine) {
    if (!this.pending.size || this.checking) return false;
    const paths = [...this.pending].slice(0, 200);
    this.checking = true;
    try {
      const r = await exec("sh", ["-c", `cd "$1" 2>/dev/null; shift
for p; do case $p in "~/"*) q="$HOME/\${p#??}";; /*) q=$p;; *) q="$PWD/$p";; esac; [ -f "$q" ] && printf '%s\\t%s\\n' "$p" "$q"; done; exit 0`, "sh", cwd || "/", ...paths], { on: machine, timeout: 10000 });
      for (const p of paths) { this.pending.delete(p); this.known.set(p, null); }
      for (const l of r.stdout.split("\n")) {
        const [p, q] = l.split("\t");
        if (q) this.known.set(p, q.replace(/\/\.\//g, "/"));
      }
      this.memo.clear();
      return r.stdout.length > 0;
    } catch {
      return false;
    } finally {
      this.checking = false;
    }
  }

  // Links Claude writes itself point at paths, sometimes relative or with #L42.
  target(href, cwd) {
    if (href.startsWith(SCHEME)) {
      const [p, line] = href.slice(SCHEME.length).split("#");
      return { path: decodeURIComponent(p), line: line ? Number(line) : null };
    }
    if (/^[a-z][\w+.-]*:/i.test(href) && !href.startsWith("file:")) return null;
    const { path, line } = parse(decodeURIComponent(href.replace(/^file:\/\//, "")));
    const abs = path.startsWith("~/") ? (cwd?.startsWith(home()) ? home() + path.slice(1) : path) : path.startsWith("/") || !cwd ? path : `${cwd}/${path.replace(/^\.\//, "")}`;
    return { path: this.known.get(path) ?? abs, line };
  }
}
