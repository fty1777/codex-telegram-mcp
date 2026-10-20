// Real Codex-managed MCP startup in an isolated HOME and CODEX_HOME.
// Creates one disposable session, no model turns, credentials or Telegram requests.
// Does not change the active installation or reload an existing session.
import { mkdtempSync, cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";

const repo = resolve(import.meta.dir, "..");
const temporary = mkdtempSync(join(tmpdir(), "telegram-marketplace-"));
const marketplace = join(temporary, "catalog"), codexHome = join(temporary, "codex");
mkdirSync(codexHome);
mkdirSync(join(marketplace, ".agents/plugins"), { recursive: true });
cpSync(join(repo, ".agents/plugins/marketplace.json"), join(marketplace, ".agents/plugins/marketplace.json"));
// Copy only the distributable package. No checkout or node_modules is available.
cpSync(join(repo, "plugins"), join(marketplace, "plugins"), { recursive: true });
const home = join(temporary, "home");
mkdirSync(home);
const environment = { ...process.env, HOME: home, CODEX_HOME: codexHome, PATH: dirname(process.execPath) + ":" + (process.env.PATH ?? "") };
async function codex(...args: string[]) {
  const child = Bun.spawn(["codex", "plugin", ...args, "--json"], { env: environment, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw Error(`Isolated plugin command failed: ${err || out}`);
    return JSON.parse(out);
  } finally { clearTimeout(timer); }
}
let app: ReturnType<typeof Bun.spawn> | undefined;
let reader: Promise<void> | undefined;
let errors: Promise<string> | undefined;
const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
let sequence = 0;
async function call(method: string, params: any) {
  const id = ++sequence;
  let timeout: ReturnType<typeof setTimeout>;
  const result = new Promise<any>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    timeout = setTimeout(() => { pending.delete(id); reject(Error(method + " timed out")); }, 20000);
  });
  (app!.stdin as any).write(JSON.stringify({ id, method, params }) + "\n");
  try { return await result; } finally { clearTimeout(timeout!); }
}
const hotLoad = process.argv.includes("--hot-load");
async function install() {
  const installed = await codex("add", "codex-telegram-mcp@fty1777");
  if (!installed.installedPath || !existsSync(join(installed.installedPath, "bridge.js")))
    throw Error("Plugin runtime was not installed");
}
try {
  await codex("marketplace", "add", marketplace);
  if (!hotLoad) await install();
  app = Bun.spawn(["codex", "app-server", "--listen", "stdio://"], {
    env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  errors = new Response(app.stderr as ReadableStream).text();
  reader = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of app!.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === undefined || message.method) continue;
        const task = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) task?.reject(Error(JSON.stringify(message.error)));
        else task?.resolve(message.result);
      }
    }
    for (const task of pending.values()) task.reject(Error("Isolated App Server closed"));
    pending.clear();
  })();
  await call("initialize", { clientInfo: { name: "telegram_marketplace_probe", version: "1" }, capabilities: { experimentalApi: true } });
  (app.stdin as any).write(JSON.stringify({ method: "initialized" }) + "\n");
  const { thread } = await call("thread/start", { cwd: temporary, approvalPolicy: "never", sandbox: "read-only" });
  if (hotLoad) {
    await install();
    await call("plugin/reconcile", { reason: "Isolated plugin hot-load probe" });
    await call("config/mcpServer/reload", null);
  }
  let ready = false;
  let lastError = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const result = await call("mcpServer/tool/call", { threadId: thread.id, server: "telegram", tool: "list_bots", arguments: {} });
      if (!result.isError && JSON.parse(result.content[0].text).bots.length === 0) { ready = true; break; }
      lastError = JSON.stringify(result);
    } catch (error) { lastError = String(error); }
    await Bun.sleep(250);
  }
  if (!ready) {
    const status = await call("mcpServerStatus/list", { threadId: thread.id });
    const summary = status.data?.map((s: any) => ({ name: s.name, runtimeStatus: s.runtimeStatus, toolsError: s.toolsError, tool_count: Object.keys(s.tools ?? {}).length }));
    throw Error("Codex-managed session dispatch unavailable: " + JSON.stringify(summary) + " " + lastError);
  }
  const status = await call("mcpServerStatus/list", { threadId: thread.id });
  if (!JSON.stringify(status).includes("send_text")) throw Error("Codex did not load Telegram tools");
  if (existsSync(join(home, ".local/share/codex-telegram/manager-installation.json"))) throw Error("Unexpected legacy install dependency");
  await call("thread/archive", { threadId: thread.id });
  await codex("remove", "codex-telegram-mcp@fty1777");
  console.log(JSON.stringify({ installation: "verified", mode: hotLoad ? "hot_load" : "fresh_session", codex_managed_tool_loading: "verified", removal: "verified", model_turns: 0, pairing: "not_run", telegram_delivery: "not_run" }));
} finally {
  if (app) { app.kill(); await app.exited; }
  await reader?.catch(() => {});
  await errors;
  rmSync(temporary, { recursive: true, force: true });
}
