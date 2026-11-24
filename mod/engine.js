import { InputState } from "gpui-base";
import { appHome, exec, props, readTextFile } from "herdr";

export const PROTOCOL = 3;
const PORT = 7777;

export async function endpoint(machine, engine = props()?.engine) {
  let url = engine ?? `ws://127.0.0.1:${PORT}`;
  if (machine && !engine) {
    const map = JSON.parse((await readTextFile(`${appHome()}/data/herdr-chat/machines.json`).catch(() => null)) ?? "{}");
    if (map[machine]) url = map[machine];
    else {
      const r = await exec("ssh", ["-G", machine]);
      const host = r.stdout.match(/^hostname (\S+)/m)?.[1] ?? machine;
      url = `ws://${host}:${PORT}`;
    }
  }
  const r = await exec("sh", ["-c", "cat ~/.config/herdr-chat/token"], { on: machine });
  if (r.code !== 0) throw new Error(`no engine token on ${machine ?? "this computer"} (run scripts/install.sh there)`);
  return { url, token: r.stdout.trim() };
}

export async function openAuth(machine, server, url, send) {
  if (!url) return null;
  await exec("open", [url]);
  const port = new URL(new URL(url).searchParams.get("redirect_uri") ?? "http://x").port;
  if (machine && port) {
    await exec("sh", ["-c", `(ssh -o ExitOnForwardFailure=yes -N -L ${port}:127.0.0.1:${port} ${machine} & p=$!; sleep 300; kill $p) >/dev/null 2>&1 &`]);
  }
  const input = machine ? InputState.new({ placeholder: "Browser showed an error? Paste its address here" }) : null;
  input?.on("enter", (_e, cx) => {
    const v = input.value().trim();
    if (v) send({ type: "mcp_callback", server, url: v });
    input.set_value("");
    cx.notify();
  });
  return { server, url, input };
}
