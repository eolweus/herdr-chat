import type { Subprocess } from "bun";

type Msg = Record<string, any>;
type Waiter = { resolve: (v: any) => void; reject: (e: any) => void; timer?: ReturnType<typeof setTimeout> };

export class AcpError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

export const AGY = Bun.which("agy") ?? `${process.env.HOME}/.local/bin/agy`;

// JSON-RPC 2.0 over an `agy acp` child's stdio, one JSON message per line.
export class AcpClient {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private waiters = new Map<number, Waiter>();
  onUpdate: (sessionId: string, update: Msg) => void = () => {};
  onRequest: (method: string, params: Msg) => Promise<unknown> = async (method) => { throw new AcpError(-32601, `${method} isn't supported`); };
  onExit: (code: number | null) => void = () => {};
  onRaw: ((dir: "in" | "out", msg: Msg) => void) | null = null;
  exited = false;
  stderr = "";

  constructor(cwd: string, env: Record<string, string | undefined>, args: string[] = []) {
    this.proc = Bun.spawn([AGY, "acp", ...args], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.read();
    this.readErr();
    this.proc.exited.then((code) => {
      this.exited = true;
      for (const w of this.waiters.values()) { clearTimeout(w.timer); w.reject(new Error(`agy exited (${code})${this.stderr ? `: ${this.stderr.trim().split("\n").pop()}` : ""}`)); }
      this.waiters.clear();
      this.onExit(code);
    });
  }

  get pid() {
    return this.proc.pid;
  }

  private async read() {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: Msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this.onRaw?.("in", msg);
        this.handle(msg);
      }
    }
  }

  private async readErr() {
    const dec = new TextDecoder();
    for await (const chunk of this.proc.stderr) this.stderr = (this.stderr + dec.decode(chunk, { stream: true })).slice(-4000);
  }

  private write(msg: Msg) {
    if (this.exited) return;
    this.onRaw?.("out", msg);
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    this.proc.stdin.flush();
  }

  private handle(msg: Msg) {
    if (msg.id != null && !msg.method) {
      const w = this.waiters.get(msg.id);
      if (!w) return;
      this.waiters.delete(msg.id);
      clearTimeout(w.timer);
      if (msg.error) w.reject(new AcpError(msg.error.code, msg.error.message, msg.error.data));
      else w.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") return this.onUpdate(msg.params?.sessionId, msg.params?.update ?? {});
    if (msg.id != null) {
      this.onRequest(msg.method, msg.params ?? {}).then(
        (result) => this.write({ jsonrpc: "2.0", id: msg.id, result: result ?? null }),
        (e) => this.write({ jsonrpc: "2.0", id: msg.id, error: { code: e instanceof AcpError ? e.code : -32603, message: String(e?.message ?? e) } }),
      );
    }
  }

  request<T = any>(method: string, params: Msg, timeoutMs?: number): Promise<T> {
    if (this.exited) return Promise.reject(new Error("agy isn't running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const w: Waiter = { resolve, reject };
      if (timeoutMs) w.timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.waiters.set(id, w);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Msg) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  initialize() {
    return this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "herdr-chat", version: "1" },
    }, 30_000);
  }

  kill() {
    if (!this.exited) this.proc.kill();
  }
}
