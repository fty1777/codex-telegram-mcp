// Real native plugin and an isolated Codex session; never reload a user's session.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Store, atomic } from "../bun/state";
import { AppServer } from "../bun/appserver";
import { installManager, uninstallManager } from "../bun/manager-install";
const root = mkdtempSync("/tmp/bridge-first-load-"),
  store = new Store(root);
const client = await AppServer.connect(undefined, 30000);
let thread: string | undefined;
const evidence: any = { root };
async function check() {
  try {
    const r = await client.call("mcpServer/tool/call", {
      threadId: thread,
      server: "telegram",
      tool: "list_bots",
      arguments: {},
    });
    if (r.isError) return false;
    return Array.isArray(JSON.parse(r.content[0].text).bots);
  } catch (error) {
    if (!String(error).includes("unknown MCP server")) throw error;
    return false;
  }
}
try {
  thread = (
    await client.call("thread/start", {
      cwd: root,
      approvalPolicy: "never",
      sandbox: "read-only",
    })
  ).thread.id;
  // Materialize this disposable conversation so it can be resumed by the same ID.
  await client.call("turn/start", {
    threadId: thread,
    input: [
      {
        type: "text",
        text: "Isolated plugin test. Reply OK only. No tools or changes.",
      },
    ],
  });
  for (let i = 0; ; i++) {
    const { thread: t } = await client.call("thread/read", {
      threadId: thread,
      includeTurns: false,
    });
    if (t.status.type === "idle") break;
    if (i >= 120) throw Error("Fixture did not become idle; refusing reload");
    await Bun.sleep(500);
  }
  await installManager(store);
  evidence.available_after_install = await check();
  await client.call("plugin/reconcile", {
    reason: "Isolated first-load verification",
  });
  await client.call("config/mcpServer/reload", null);
  await Bun.sleep(1000);
  evidence.available_after_refresh = await check();
  if (!evidence.available_after_refresh) {
    await client.call("thread/archive", { threadId: thread });
    await client.call("thread/unarchive", { threadId: thread });
    const resumed = await client.resume(thread!);
    evidence.same_session = resumed.thread.id === thread;
    for (let i = 0; ; i++) {
      if (await check()) break;
      if (i >= 40) throw Error("Plugin still unavailable after idle reload");
      await Bun.sleep(250);
    }
    evidence.available_after_idle_reload = true;
  }
  atomic(join(root, "evidence.json"), evidence);
  console.log(JSON.stringify(evidence));
} finally {
  if (thread)
    await client.call("thread/archive", { threadId: thread }).catch(() => {});
  await uninstallManager(store);
  client.close();
}
