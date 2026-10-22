import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppServer, DeliveryUnknown, RpcError, type Client } from "./appserver";
import { codex } from "./install";
import { Store, privateDir } from "./state";
import { status, sleep, lock } from "./process";

const marketplace = "fty1777", pluginId = "codex-telegram-mcp@fty1777";
type Connection = Client & { close(): void };

/** A bounded, foreground update. No detached receiver or session replacement. */
export async function updatePlugin(
  store: Store,
  options: { session?: string; endpoint?: string; timeout?: number } = {},
  services: {
    runner?: typeof codex;
    connect?: (endpoint?: string) => Promise<Connection>;
    health?: typeof status;
    wait?: (ms: number) => Promise<unknown>;
  } = {},
) {
  const runner = services.runner ?? codex;
  const connect = services.connect ?? AppServer.connect;
  const health = services.health ?? status;
  const wait = services.wait ?? sleep;
  const bots = store.list().filter(c => c.plugin?.id === pluginId && c.shared_mcp);
  const targets = new Map<string, { thread: string; endpoint?: string; bots: string[] }>();
  for (const bot of bots.filter(c => c.enabled && c.autostart && c.thread_id)) {
    const key = JSON.stringify([bot.endpoint ?? null, bot.thread_id]);
    const target: { thread: string; endpoint?: string; bots: string[] } = targets.get(key) ?? { thread: bot.thread_id, endpoint: bot.endpoint, bots: [] };
    target.bots.push(bot.name);
    targets.set(key, target);
  }
  if (options.session) {
    const bound = bots.find(c => c.thread_id === options.session);
    const endpoint = options.endpoint ?? bound?.endpoint;
    const key = JSON.stringify([endpoint ?? null, options.session]);
    if (!targets.has(key)) targets.set(key, { thread: options.session, endpoint, bots: [] });
  }
  const connections = new Map<string, Connection>();
  const loaded: { client: Connection; thread: string; bots: string[]; before?: any }[] = [];
  const waiting: string[] = [];
  const info = async (client: Connection, thread: string) => {
    const response = await client.call("mcpServer/tool/call", {
      threadId: thread, server: "telegram", tool: "plugin_status", arguments: {},
    });
    if (response.isError) throw Error("Telegram running-version query failed");
    const result = JSON.parse(response.content[0].text);
    if (typeof result.version !== "string" || (!Number.isSafeInteger(result.pid) || result.pid <= 0))
      throw Error("Invalid Telegram runtime identity");
    return result;
  };
  privateDir(store.root);
  const release = lock(join(store.root, "update.lock"));
  try {
    // Keep loaded sessions subscribed across MCP replacement. Never load an
    // inactive session merely to update its plugin, and never start a model turn.
    for (const target of targets.values()) {
      const key = target.endpoint ?? "";
      let client = connections.get(key);
      if (!client) { client = await connect(target.endpoint); connections.set(key, client); }
      const { thread } = await client.call("thread/read", { threadId: target.thread, includeTurns: false });
      if (thread.status?.type === "notLoaded") { waiting.push(target.thread); continue; }
      try { await client.resume(target.thread); }
      catch (error) {
        if (!(error instanceof RpcError) || thread.status?.type !== "idle" ||
            !error.message.includes("no rollout found for thread id " + target.thread)) throw error;
      }
      let before;
      try { before = await info(client, target.thread); }
      catch (error) {
        // A missing old-version tool is expected; a lost subscription is not.
        if (error instanceof DeliveryUnknown) throw error;
      }
      loaded.push({ client, thread: target.thread, bots: target.bots, before });
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const refreshed = await runner("marketplace", "upgrade", marketplace);
        if (refreshed.errors?.length) throw Error("Telegram marketplace could not be updated; the running plugin was retained");
        break;
      } catch (error) {
        // Codex can auto-refresh the same Git catalog while this command runs.
        // Only this explicit read/refresh race is safe to retry, never installs.
        if (attempt >= 2 || !(error instanceof Error) ||
            !error.message.includes("changed while auto-upgrade was in flight")) throw error;
        await wait(250);
      }
    }
    const installed = await runner("add", pluginId);
    if (!installed.installedPath) throw Error("Plugin installation did not return an installed package");
    const manifest = JSON.parse(readFileSync(join(installed.installedPath, "plugin.json"), "utf8"));
    if (manifest.name !== "codex-telegram-mcp" || typeof manifest.version !== "string")
      throw Error("Installed Telegram package has an unexpected identity");
    const version = manifest.version;
    const alreadyCurrent = loaded.length > 0 && loaded.every(t => t.before?.version === version);
    if (!alreadyCurrent) {
      for (const client of new Set(loaded.map(t => t.client))) {
        await client.call("plugin/reconcile", { reason: "Activate Telegram plugin update" });
        await client.call("config/mcpServer/reload", null);
      }
    }
    const deadline = Date.now() + (options.timeout ?? 30000);
    const pending = new Set(loaded);
    const verified: any[] = [];
    while (pending.size) {
      for (const target of pending) {
        try {
          const runtime = await info(target.client, target.thread);
          if (runtime.version !== version) continue;
          const ready = target.bots.every(name => {
            const report = health(store, name);
            return report.worker?.pid === runtime.pid && report.health?.pid === runtime.pid &&
              report.health?.version === version && report.health?.thread_id === target.thread &&
              ["idle", "active"].includes(report.health?.status) &&
              report.health?.pipeline?.status !== "stalled" &&
              report.health?.telegram?.status === "connected";
          });
          if (!ready) continue;
          verified.push({ session: target.thread, version, receiver: target.bots.length ? "ready" : "not_configured" });
          pending.delete(target);
        } catch { /* A refresh temporarily removes dispatch while replacing MCP. */ }
      }
      if (!pending.size) break;
      if (Date.now() >= deadline) return {
        status: "activation_pending", installed_version: version,
        verified_sessions: verified.length, pending_sessions: pending.size,
        waiting_sessions: waiting.length,
        detail: "New files are installed, but the running version and receiver readiness are not fully confirmed. Pairing and queued messages are retained. Check plugin_status and list_bots before retrying activation; do not reinstall or reopen the conversation automatically.",
      };
      await wait(250);
    }
    return {
      status: waiting.length ? "awaiting_session" : !loaded.length ? "installed" : alreadyCurrent ? "up_to_date" : "updated",
      installed_version: version, verified_sessions: verified.length,
      waiting_sessions: waiting.length,
      receiver_readiness: loaded.some(t => t.bots.length) ? "verified" : "not_tested",
      telegram_round_trip: "not_tested",
    };
  } finally {
    try { for (const client of connections.values()) client.close(); }
    finally { release(); }
  }
}
