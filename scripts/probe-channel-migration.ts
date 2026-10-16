// Native plugin removal/disable with real Codex and worker; Telegram calls stubbed.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store, atomic, readJSON } from "../bun/state";
import { install, uninstall, codex, refresh } from "../bun/install";
import { AppServer } from "../bun/appserver";
import { start, stop, status, sleep, identity } from "../bun/process";
import { installManager, uninstallManager } from "../bun/manager-install";
import { attachSharedPlugin } from "../bun/channel";
const root = mkdtempSync("/tmp/bridge-mcp-plugin-"),
  s = new Store(root),
  repo = resolve(import.meta.dir, ".."),
  script = join(root, "server.ts");
s.configure(
  "probe",
  "123456:fixture",
  { id: 123456, username: "fixture" },
  1,
  "pending",
);
writeFileSync(
  script,
  `
import {Store} from ${JSON.stringify(join(repo, "bun/state.ts"))};
import {Telegram} from ${JSON.stringify(join(repo, "bun/telegram.ts"))};
import {mcp} from ${JSON.stringify(join(repo, "bun/mcp.ts"))};
Telegram.prototype.call=async function(method){if(method==='getUpdates'){await Bun.sleep(100);return [];}return {message_id:1,chat:{id:1}}};
const state=new Store(${JSON.stringify(root)});
while(state.read('probe').thread_id==='pending') await Bun.sleep(50);
await mcp(state,'probe');
`,
);
const channelScript = join(root, "channel.ts");
writeFileSync(
  channelScript,
  `
import { Store } from ${JSON.stringify(join(repo, "bun/state.ts"))};
import { Telegram } from ${JSON.stringify(join(repo, "bun/telegram.ts"))};
import { channel } from ${JSON.stringify(join(repo, "bun/channel.ts"))};
Telegram.prototype.call=async function(method){if(method==='getUpdates'){await Bun.sleep(100);return [];}return {message_id:1,chat:{id:1}}};
await channel(new Store(${JSON.stringify(root)}));
`,
);
const runner = async (...args: string[]) => {
  if (args[0] === "add") {
    const selector = args[1].split("@")[0],
      path = join(root, "plugins", selector, "plugins", selector, ".mcp.json");
    const manifest = readJSON(path);
    for (const item of Object.values(manifest.mcpServers) as any[])
      item.args = [
        readJSON(
          join(path, "..", ".codex-plugin/plugin.json"),
        ).version.startsWith("0.4.")
          ? channelScript
          : script,
      ];
    atomic(path, manifest);
  }
  return codex(...args);
};
const c = await AppServer.connect(undefined, 20000);
let thread: string | undefined;
const report: any = { root };
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await sleep(100);
  }
  throw Error("Timeout " + label);
}
try {
  const t = await c.call("thread/start", {
    cwd: root,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  thread = t.thread.id;
  atomic(join(s.instance("probe"), "config.json"), {
    ...s.read("probe"),
    thread_id: thread,
  });
  await c.call("turn/start", {
    threadId: thread,
    input: [
      {
        type: "text",
        text: "Isolated plugin lifecycle test. Reply only OK; do not use tools or change files.",
      },
    ],
  });
  await sleep(1000);
  await install(s, "probe", false, runner);
  await refresh();
  const initial = await start(s, "probe", true);
  report.install_status = initial;
  if (initial.status === "awaiting-session-reload") {
    await c.call("thread/archive", { threadId: thread });
    await c.call("thread/unarchive", { threadId: thread });
    await c.resume(thread!);
  }
  await until(
    () => status(s, "probe").health?.telegram?.status === "connected",
    "connect",
  );
  const first = status(s, "probe").process.pid;
  const old = readJSON(join(s.instance("probe"), "installation.json"));
  const legacyName = s.read("probe").mcp_server;
  await stop(s, "probe");
  await installManager(s, runner, { ...old, mcp_server: legacyName });
  const shared = attachSharedPlugin(s, "probe");
  atomic(join(s.instance("probe"), "config.json"), {
    ...shared,
    mcp_server: legacyName,
  });
  await refresh();
  report.connect = await start(s, "probe", true);
  if (report.connect.status === "awaiting-session-reload") {
    await c.call("thread/archive", { threadId: thread });
    await c.call("thread/unarchive", { threadId: thread });
    await c.resume(thread!);
    report.idle_fixture_reloaded = true;
  }
  await until(
    () =>
      status(s, "probe").process?.pid !== first &&
      status(s, "probe").health?.telegram?.status === "connected",
    "shared migration after idle fixture reload",
  );
  report.same_session = s.read("probe").thread_id === thread;
  report.single_plugin_migration = true;
  const result = await c.call("mcpServer/tool/call", {
    threadId: thread,
    server: legacyName,
    tool: "list_bots",
    arguments: {},
  });
  if (result.isError) throw Error(JSON.stringify(result));
  report.management_available_after_reload = true;
  atomic(join(root, "evidence.json"), report);
  console.log(JSON.stringify(report));
} catch (e) {
  atomic(join(root, "failure.json"), {
    error: String(e),
    report,
    status: status(s, "probe"),
  });
  console.error(root);
  throw e;
} finally {
  try {
    await uninstall(s, "probe", false, runner);
  } catch (e) {
    console.error(String(e));
  }
  await uninstallManager(s, runner);
  if (thread)
    try {
      await c.call("thread/archive", { threadId: thread });
    } catch {}
  c.close();
  await refresh();
}
