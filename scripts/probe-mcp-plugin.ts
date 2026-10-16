// Native plugin removal/disable with real Codex and worker; Telegram calls stubbed.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store, atomic, readJSON } from "../bun/state";
import { install, uninstall, codex, refresh } from "../bun/install";
import { AppServer } from "../bun/appserver";
import { start, status, sleep, identity } from "../bun/process";
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
const runner = async (...args: string[]) => {
  if (args[0] === "add") {
    const selector = args[1].split("@")[0],
      path = join(root, "plugins", selector, "plugins", selector, ".mcp.json");
    const manifest = readJSON(path);
    for (const item of Object.values(manifest.mcpServers) as any[])
      item.args = [script];
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
  const first = status(s, "probe").process.pid,
    plugin = s.read("probe").plugin.id;
  await c.call("config/value/write", {
    keyPath: "plugins." + JSON.stringify(plugin) + ".enabled",
    value: false,
    mergeStrategy: "upsert",
  });
  await until(() => !identity(first), "disable");
  report.disable_stopped_worker = true;
  await c.call("config/value/write", {
    keyPath: "plugins." + JSON.stringify(plugin) + ".enabled",
    value: true,
    mergeStrategy: "upsert",
  });
  await refresh();
  await start(s, "probe", true);
  await until(
    () =>
      status(s, "probe").process?.pid !== first &&
      status(s, "probe").health?.telegram?.status === "connected",
    "reenable",
  );
  const second = status(s, "probe").process.pid;
  await codex("remove", plugin);
  await until(() => !identity(second), "remove");
  report.remove_stopped_worker = true;
  await uninstall(s, "probe", true, runner);
  report.credentials_retained = s.token("probe") === "123456:fixture";
  atomic(join(root, "evidence.json"), report);
  console.log(JSON.stringify(report));
} finally {
  try {
    await uninstall(s, "probe", false, runner);
  } catch (e) {
    console.error(String(e));
  }
  if (thread)
    try {
      await c.call("thread/archive", { threadId: thread });
    } catch {}
  c.close();
  await refresh();
}
