const INCLUSIVE = new Set(["e", "E", "$", "f", "t"]);
const LINEWISE = new Set(["j", "k", "gg", "G"]);
const PAIRS = { "(": "()", ")": "()", b: "()", "[": "[]", "]": "[]", "{": "{}", "}": "{}", B: "{}", "<": "<>", ">": "<>" };

const lineStart = (t, i) => t.lastIndexOf("\n", i - 1) + 1;
const lineEnd = (t, i) => { const n = t.indexOf("\n", i); return n < 0 ? t.length : n; };
const lastChar = (t, i) => Math.max(lineStart(t, i), lineEnd(t, i) - 1);
const kind = (c, big) => (c === undefined || /\s/.test(c) ? 0 : big || /\w/.test(c) ? 1 : 2);

function wordFwd(t, i, big) {
  const k = kind(t[i], big);
  if (k) while (i < t.length && kind(t[i], big) === k) i++;
  while (i < t.length && !kind(t[i], big)) i++;
  return i;
}

function wordEnd(t, i, big) {
  i++;
  while (i < t.length && !kind(t[i], big)) i++;
  const k = kind(t[i], big);
  while (i + 1 < t.length && kind(t[i + 1], big) === k) i++;
  return Math.min(i, t.length - 1);
}

function wordBack(t, i, big) {
  i--;
  while (i > 0 && !kind(t[i], big)) i--;
  const k = kind(t[i], big);
  while (i > 0 && kind(t[i - 1], big) === k) i--;
  return Math.max(i, 0);
}

function vertical(t, i, by) {
  const col = i - lineStart(t, i);
  let s = lineStart(t, i);
  for (let n = 0; n < Math.abs(by); n++) {
    if (by > 0) { const e = lineEnd(t, s); if (e >= t.length) break; s = e + 1; }
    else { if (s === 0) break; s = lineStart(t, s - 1); }
  }
  return Math.min(s + col, lastChar(t, s));
}

function find(t, i, c, dir, till) {
  const s = lineStart(t, i), e = lineEnd(t, i);
  for (let j = i + dir + (till ? dir : 0); j >= s && j < e; j += dir) if (t[j] === c) return till ? j - dir : j;
  return null;
}

function motion(m, t, i, n, arg) {
  let p = i;
  for (let k = 0; k < n; k++) {
    if (m === "h") p = Math.max(lineStart(t, p), p - 1);
    else if (m === "l") p = Math.min(lineEnd(t, p), p + 1);
    else if (m === "w" || m === "W") p = wordFwd(t, p, m === "W");
    else if (m === "e" || m === "E") p = wordEnd(t, p, m === "E");
    else if (m === "b" || m === "B") p = wordBack(t, p, m === "B");
    else if (m === "j" || m === "k") p = vertical(t, p, m === "j" ? 1 : -1);
    else if (m === "f" || m === "F" || m === "t" || m === "T") {
      const q = find(t, p, arg, m === "f" || m === "t" ? 1 : -1, m === "t" || m === "T");
      if (q === null) return null;
      p = q;
    } else break;
  }
  if (m === "0") p = lineStart(t, i);
  else if (m === "^") { p = lineStart(t, i); while (p < lineEnd(t, i) && /[ \t]/.test(t[p])) p++; }
  else if (m === "$") p = lastChar(t, vertical(t, i, n - 1));
  else if (m === "gg") p = 0;
  else if (m === "G") p = lineStart(t, t.length);
  return p;
}

function object(t, i, around, o) {
  if (o === "w" || o === "W") {
    const k = kind(t[i], o === "W");
    let s = i, e = i;
    while (s > lineStart(t, i) && kind(t[s - 1], o === "W") === k) s--;
    while (e < lineEnd(t, i) && kind(t[e], o === "W") === k) e++;
    if (around) {
      const e2 = e;
      while (e < lineEnd(t, i) && /[ \t]/.test(t[e])) e++;
      if (e === e2) while (s > lineStart(t, i) && /[ \t]/.test(t[s - 1])) s--;
    }
    return [s, e];
  }
  if (o === '"' || o === "'" || o === "`") {
    const s0 = lineStart(t, i), qs = [];
    for (let j = s0; j < lineEnd(t, i); j++) if (t[j] === o && t[j - 1] !== "\\") qs.push(j);
    for (let k = 0; k + 1 < qs.length; k += 2) {
      if (qs[k + 1] >= i) return around ? [qs[k], qs[k + 1] + 1] : [qs[k] + 1, qs[k + 1]];
    }
    return null;
  }
  const pair = PAIRS[o];
  if (!pair) return null;
  const [open, close] = pair;
  let s = t[i] === open ? i : -1;
  for (let j = i - 1, d = 0; s < 0 && j >= 0; j--) {
    if (t[j] === close) d++;
    else if (t[j] === open) { if (d === 0) s = j; else d--; }
  }
  if (s < 0) return null;
  for (let j = s + 1, d = 0; j < t.length; j++) {
    if (t[j] === open) d++;
    else if (t[j] === close) { if (d === 0) return around ? [s, j + 1] : [s + 1, j]; d--; }
  }
  return null;
}

function lines(t, i, n) {
  const s = lineStart(t, i);
  let e = s;
  for (let k = 0; k < n; k++) { e = lineEnd(t, e); if (k < n - 1 && e < t.length) e++; }
  return [s, e];
}

// A small vim for one textarea: normal-mode keys come in, the new text and cursor go out.
export class Vim {
  constructor() {
    this.mode = "insert";
    this.keys = "";
    this.reg = { text: "", line: false };
    this.undos = [];
    this.redos = [];
  }

  reset() {
    this.mode = "insert";
    this.keys = "";
    this.undos = [];
    this.redos = [];
  }

  // Returns undefined to let the key through, else { text, at } with at being where the cursor goes.
  key(k, text, at) {
    if (this.mode === "insert") {
      if (k !== "escape") return undefined;
      this.mode = "normal";
      return { text, at: at > lineStart(text, at) ? at - 1 : at };
    }
    if (k === "escape") {
      if (!this.keys) return undefined;
      this.keys = "";
      return { text, at };
    }
    if (k.length > 1 && !["ctrl-r", "backspace", "space"].includes(k)) return this.keys ? (this.keys = "", { text, at }) : undefined;
    const seq = this.keys + (k === "space" ? " " : k === "backspace" ? "h" : k === "ctrl-r" ? "\x12" : k);
    const r = this.run(seq, text, at);
    if (r === "more") return (this.keys = seq, { text, at });
    this.keys = "";
    if (!r) return { text, at };
    if (r.text !== text && !r.undo) {
      this.undos.push({ text, at });
      this.redos = [];
    }
    if (r.insert) this.mode = "insert";
    else r.at = Math.min(r.at, lastChar(r.text, r.at));
    return { text: r.text, at: r.at };
  }

  run(keys, t, i) {
    const m = keys.match(/^([1-9]\d*)?(?:([dcy])([1-9]\d*)?)?(.*)$/s);
    const n = (Number(m[1]) || 1) * (Number(m[3]) || 1);
    const op = m[2], rest = m[4];
    if (!rest) return "more";
    if (op) {
      if (rest === op) {
        const [s, e] = lines(t, i, n);
        return this.apply(op, t, s, e, true);
      }
      if (/^[ia]$/.test(rest) || /^[fFtT]$/.test(rest) || rest === "g") return "more";
      const obj = rest.match(/^([ia])(.)$/s);
      if (obj) {
        const r = object(t, i, obj[1] === "a", obj[2]);
        return r && this.apply(op, t, r[0], r[1], false);
      }
      let mo = rest.match(/^([fFtT])(.)$/s);
      let name = mo ? mo[1] : rest;
      if (op === "c" && (name === "w" || name === "W") && kind(t[i])) name = name === "w" ? "e" : "E";
      const p = motion(name, t, i, n, mo?.[2]);
      if (p === null || (!mo && !/^(h|l|w|W|e|E|b|B|j|k|0|\^|\$|gg|G)$/.test(name))) return null;
      if (LINEWISE.has(name)) {
        const a = Math.min(i, p), b = Math.max(i, p);
        return this.apply(op, t, lineStart(t, a), lineEnd(t, b), true);
      }
      let s = Math.min(i, p), e = Math.max(i, p) + (INCLUSIVE.has(name) || INCLUSIVE.has(name.toLowerCase()) ? 1 : 0);
      if (name === "w" || name === "W") e = Math.min(e, Math.max(lineEnd(t, i), i));
      return this.apply(op, t, s, Math.min(e, t.length), false);
    }
    const c = rest[0];
    if (/^[fFtTr]$/.test(rest) || rest === "g") return "more";
    if (rest.length > 1 && !/^[fFtTr]./s.test(rest) && rest !== "gg") return null;
    const at = (p) => ({ text: t, at: p });
    const edit = (s, e, ins, p, insert = false) => ({ text: t.slice(0, s) + ins + t.slice(e), at: p, insert });
    const ls = lineStart(t, i), le = lineEnd(t, i);
    switch (rest[0] === "g" ? rest : c) {
      case "h": case "l": case "w": case "W": case "e": case "E": case "b": case "B":
      case "j": case "k": case "0": case "^": case "$": case "gg": case "G":
        return at(motion(rest, t, i, n) ?? i);
      case "f": case "F": case "t": case "T": return at(motion(c, t, i, n, rest[1]) ?? i);
      case "i": return { text: t, at: i, insert: true };
      case "a": return { text: t, at: Math.min(i + 1, le), insert: true };
      case "I": return { text: t, at: motion("^", t, i, 1), insert: true };
      case "A": return { text: t, at: le, insert: true };
      case "o": return edit(le, le, "\n", le + 1, true);
      case "O": return edit(ls, ls, "\n", ls, true);
      case "x": return i < le ? this.apply("d", t, i, Math.min(i + n, le), false) : null;
      case "X": return i > ls ? this.apply("d", t, Math.max(ls, i - n), i, false) : null;
      case "s": return this.apply("c", t, i, Math.min(i + n, le), false);
      case "S": return this.apply("c", t, ...lines(t, i, n), true);
      case "D": return this.apply("d", t, i, lineEnd(t, vertical(t, i, n - 1)), false);
      case "C": return this.apply("c", t, i, lineEnd(t, vertical(t, i, n - 1)), false);
      case "Y": return this.apply("y", t, ...lines(t, i, n), true);
      case "r": return i + n <= le ? edit(i, i + n, rest[1].repeat(n), i + n - 1) : null;
      case "~": {
        const e = Math.min(i + n, le);
        const flip = [...t.slice(i, e)].map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join("");
        return edit(i, e, flip, Math.min(e, lastChar(t, i)));
      }
      case "J": {
        if (le >= t.length) return null;
        let e = le + 1;
        while (/[ \t]/.test(t[e] ?? "")) e++;
        return edit(le, e, t[e] === "\n" || e >= t.length ? "" : " ", le);
      }
      case "p": case "P": {
        const s = this.reg.text.repeat(n);
        if (!s) return null;
        if (this.reg.line) {
          if (c === "p") return le >= t.length ? edit(le, le, `\n${s}`, le + 1) : edit(le + 1, le + 1, `${s}\n`, le + 1);
          return edit(ls, ls, `${s}\n`, ls);
        }
        const p = c === "p" && i < le ? i + 1 : i;
        return edit(p, p, s, p + s.length - 1);
      }
      case "u": {
        const u = this.undos.pop();
        if (!u) return null;
        this.redos.push({ text: t, at: i });
        return { ...u, undo: true };
      }
      case "\x12": {
        const r = this.redos.pop();
        if (!r) return null;
        this.undos.push({ text: t, at: i });
        return { ...r, undo: true };
      }
    }
    return null;
  }

  // Line-wise ranges run from the first line's start to the last line's end, without its newline.
  apply(op, t, s, e, line) {
    this.reg = { text: t.slice(s, e), line };
    if (op === "y") return { text: t, at: s };
    if (op === "c") return { text: t.slice(0, s) + t.slice(e), at: s, insert: true };
    if (!line) return { text: t.slice(0, s) + t.slice(e), at: s };
    const out = e < t.length ? t.slice(0, s) + t.slice(e + 1) : t.slice(0, Math.max(0, s - 1));
    return { text: out, at: motion("^", out, Math.min(s, lineStart(out, out.length)), 1) };
  }
}
