// Real Codex-managed MCP startup in an isolated HOME and CODEX_HOME.
// Creates one disposable session, no model turns, credentials or Telegram requests.
// Does not change the active installation or reload a user session.
// --upgrade replaces MCP only in its disposable test session.
import { mkdtempSync, cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { AppServer, RpcError } from "../bun/appserver";
import { probeHandoff } from "../bun/handoff";

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
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw Error(`Isolated plugin ${args.slice(0, 2).join(" ")} ${timedOut ? "timed out" : "failed"}: ${err || out}`);
    return JSON.parse(out);
  } finally { clearTimeout(timer); }
}
let app: ReturnType<typeof Bun.spawn> | undefined;
let reader: Promise<void> | undefined;
let errors: Promise<string> | undefined;
const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
let sequence = 0;
let unixClient: AppServer | undefined;
let installedPath: string;
const socket = join(temporary, "app-server.sock");
async function call(method: string, params: any) {
  if (unixClient) return unixClient.call(method, params);
  const id = ++sequence;
  let timeout: ReturnType<typeof setTimeout>;
  const result = new Promise<any>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    timeout = setTimeout(() => { pending.delete(id); reject(Error(method + " timed out")); }, 20000);
  });
  (app!.stdin as any).write(JSON.stringify({ id, method, params }) + "\n");
  try { return await result; } finally { clearTimeout(timeout!); }
}
async function commitCatalog() {
  for (const args of [["init", "--initial-branch=main"], ["add", "."],
    ["-c", "user.name=Upgrade probe", "-c", "user.email=probe@example.invalid", "commit", "-m", "Probe package"]]) {
    const child = Bun.spawn(["git", ...args], { cwd: marketplace, env: environment, stdout: "ignore", stderr: "pipe" });
    const error = await new Response(child.stderr).text();
    if (await child.exited) throw Error("Isolated catalog preparation failed: " + error);
  }
}
const hotLoad = process.argv.includes("--hot-load");
const upgrade = process.argv.includes("--upgrade");
async function install() {
  const installed = await codex("add", "codex-telegram-mcp@fty1777");
  installedPath = installed.installedPath;
  if (!installed.installedPath || !existsSync(join(installed.installedPath, "bridge.js")))
    throw Error("Plugin runtime was not installed");
}
try {
  const upgradeSource = "https://telegram-upgrade.invalid/catalog.git";
  if (upgrade) {
    writeFileSync(join(home, ".gitconfig"), `[url "file://${marketplace}"]\n  insteadOf = ${upgradeSource}\n`);
    await commitCatalog();
  }
  await codex("marketplace", "add", upgrade ? upgradeSource : marketplace);
  if (!hotLoad) await install();
  app = Bun.spawn(["codex", "app-server", "--listen", upgrade ? "unix://" + socket : "stdio://"], {
    env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  errors = new Response(app.stderr as ReadableStream).text();
  if (upgrade) {
    reader = new Response(app.stdout as ReadableStream).text().then(() => {});
    for (let i = 0; i < 100 && !existsSync(socket); i++) await Bun.sleep(100);
    unixClient = await AppServer.connect("unix://" + socket, 20000);
  } else {
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
        if (message.error) task?.reject(new RpcError(message.error));
        else task?.resolve(message.result);
      }
    }
    for (const task of pending.values()) task.reject(Error("Isolated App Server closed"));
    pending.clear();
  })();
  await call("initialize", { clientInfo: { name: "telegram_marketplace_probe", version: "1" }, capabilities: { experimentalApi: true } });
  (app.stdin as any).write(JSON.stringify({ method: "initialized" }) + "\n");
  }
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
  if (upgrade) {
    // Persist harmless fixture history without starting a model turn, so the
    // real update exercises subscription retention on a resumable conversation.
    await call("thread/inject_items", { threadId: thread.id, items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Offline upgrade probe fixture." }] },
    ] });
    await unixClient!.resume(thread.id);
    const info = async () => {
      const result = await call("mcpServer/tool/call", { threadId: thread.id, server: "telegram", tool: "plugin_status", arguments: {} });
      if (result.isError) throw Error("Running-version query failed");
      return JSON.parse(result.content[0].text);
    };
    const before = await info();
    const plugin = join(marketplace, "plugins/telegram");
    const next = before.version + "-upgrade-probe";
    for (const file of ["plugin.json", ".codex-plugin/plugin.json"]) {
      const path = join(plugin, file), manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.version = next;
      writeFileSync(path, JSON.stringify(manifest));
    }
    const bundle = join(plugin, "bridge.js");
    writeFileSync(bundle, readFileSync(bundle, "utf8").replaceAll(JSON.stringify(before.version), JSON.stringify(next)));
    await commitCatalog();
    const updater = Bun.spawn([process.execPath, join(installedPath!, "bridge.js"), "update",
      "--data-dir", join(temporary, "state"), "--session", thread.id, "--endpoint", "unix://" + socket],
      { env: environment, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => updater.kill(), 90000);
    let outcome: any;
    try {
      const [out, err, code] = await Promise.all([new Response(updater.stdout).text(), new Response(updater.stderr).text(), updater.exited]);
      if (code) throw Error("Bundled updater failed: " + err);
      outcome = JSON.parse(out);
    } finally { clearTimeout(timer); }
    const after = await info();
    if (outcome.status !== "updated" || after.version !== next || after.pid === before.pid)
      throw Error("Existing session did not switch to the updated runtime: " + JSON.stringify({ outcome, before, after }));
    const preflight = await probeHandoff({ endpoint: "unix://" + socket, thread_id: thread.id },
      { id: "codex-telegram-mcp@fty1777", root: installedPath! });
    if (preflight.status !== "ready") throw Error("Actual thread management-plane preflight failed: " + JSON.stringify(preflight));
    console.log(JSON.stringify({ existing_session_upgrade: "verified", running_version: after.version, process_replaced: true, session_reopened: false, handoff_management_preflight: "verified" }));
  }
  await call("thread/archive", { threadId: thread.id });
  await codex("remove", "codex-telegram-mcp@fty1777");
  console.log(JSON.stringify({ installation: "verified", mode: upgrade ? "existing_session_upgrade" : hotLoad ? "hot_load" : "fresh_session", codex_managed_tool_loading: "verified", removal: "verified", model_turns: 0, pairing: "not_run", telegram_delivery: "not_run" }));
} finally {
  unixClient?.close();
  if (app) { app.kill(); await app.exited; }
  await reader?.catch(() => {});
  await errors;
  rmSync(temporary, { recursive: true, force: true });
}
