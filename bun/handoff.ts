import { join } from "node:path";
import { AppServer } from "./appserver";
import { Store, Journal, hash, readJSON, now } from "./state";
import { Sender } from "./telegram";
import { diagnostic } from "./engine";
import { status, sleep } from "./process";

type Plugin = { id: string; root: string };
export type HandoffReadiness = { status: string; diagnostic?: string };

export function receiptPlugin(store: Store, name: string) {
  try { return readJSON(join(store.instance(name), "installation.json")).plugin_id as string | undefined; }
  catch { return undefined; }
}
export function previousPlugin(store: Store, name: string) {
  return store.read(name).plugin?.id as string | undefined ?? receiptPlugin(store, name);
}

/** Read-only management checks. Never starts a second Telegram poller. */
export async function probeHandoff(config: any, plugin: Plugin): Promise<HandoffReadiness> {
  let client: AppServer | undefined;
  try {
    client = await AppServer.connect(config.endpoint);
    const { thread } = await client.call("thread/read", { threadId: config.thread_id, includeTurns: false });
    if (thread.status?.type === "notLoaded") return { status: "awaiting-session" };
    const page = await client.call("mcpServerStatus/list", { threadId: config.thread_id, serverName: "telegram", detail: "toolsAndAuthOnly" });
    const server = page.data?.find((s: any) => s.name === "telegram" && s.pluginId === plugin.id);
    if (!server) return { status: "mcp-unavailable" };
    if (server.toolsError || server.runtimeStatus === "failed")
      return { status: "mcp-startup-failed", diagnostic: String(server.toolsError ?? "MCP startup failed") };
    const result = await client.call("mcpServer/tool/call", {
      threadId: config.thread_id, server: "telegram", tool: "list_bots", arguments: {},
    });
    if (result.isError) return { status: "mcp-unavailable" };
    const value = JSON.parse(result.content[0].text);
    return { status: Array.isArray(value.bots) ? "ready" : "mcp-unavailable" };
  } catch (error) {
    return { status: "mcp-unavailable", diagnostic: String(error) };
  } finally { client?.close(); }
}

export async function assertHandoffTarget(
  store: Store, name: string, plugin: Plugin, thread?: string,
  services = { probe: probeHandoff, notify: notifyHandoffFailure },
) {
  const config = store.read(name);
  const old = previousPlugin(store, name);
  if (!old || old === plugin.id) return;
  const readiness = await services.probe({ ...config, thread_id: thread ?? config.thread_id }, plugin);
  if (readiness.status === "ready") return;
  const state = { from: old, to: plugin.id, thread: config.thread_id,
    target_thread: thread ?? config.thread_id, revision: config.binding_revision ?? null,
    was_running: config.enabled && config.autostart !== false,
    phase: "blocked", status: readiness.status,
    diagnostic: diagnostic(readiness.diagnostic ?? "", store.token(name)) };
  recordHandoff(store, name, state);
  await services.notify(store, name, state);
  throw new HandoffBlocked(readiness.status);
}

const notice = "Telegram could not switch to the updated plugin in this conversation, and receiving has not resumed. Your pairing and pending messages are saved. Continue in the Codex terminal and ask it to check Telegram plugin startup before retrying the switch. Configuration refresh alone does not confirm recovery.";

export async function notifyHandoffFailure(store: Store, name: string, state: any) {
  const config = store.read(name);
  const runtime = status(store, name);
  if (config.thread_id !== state.thread || (config.binding_revision ?? null) !== state.revision || !config.enabled ||
      (config.autostart === false && !state.was_running) || (runtime.worker && runtime.health?.pid === runtime.worker.pid &&
      ["idle", "active"].includes(runtime.health?.status) && runtime.health?.telegram?.status === "connected")) return;
  const sender = new Sender(store, name);
  try {
    // A stable key also suppresses retries after ambiguous Telegram delivery.
    await sender.send("handoff-notice-" + hash(JSON.stringify([
      state.from, state.to, state.thread, state.revision ?? null,
    ])).slice(0, 40), { text: notice, source: "system", format: "plain" });
  } catch (error) {
    sender.journal.put("handoff_notice_error", diagnostic(String(error), store.token(name)));
  } finally { sender.journal.close(); }
}

export class HandoffBlocked extends Error {
  readonly result;
  constructor(status: string) {
    super("Telegram plugin handoff is not ready in this conversation. The existing binding, pairing and receipts were retained. Check MCP startup and tool availability before retrying; do not uninstall the existing plugin or automatically reopen the active conversation.");
    this.name = "HandoffBlocked";
    this.result = { status, phase: "handoff_preflight", detail: this.message };
  }
}

export function recordHandoff(store: Store, name: string, state: any) {
  const journal = new Journal(store.instance(name));
  try { journal.put("plugin_handoff", { ...state, updated: now() }); }
  finally { journal.close(); }
}

/** Attach is not takeover. Only fresh health from the new MCP proves receiving. */
export async function completeHandoff(store: Store, name: string, timeout = 15000) {
  const journal = new Journal(store.instance(name));
  try {
    const state = journal.get("plugin_handoff");
    if (!state || !["attached", "activation_pending"].includes(state.phase)) return null;
    const deadline = Date.now() + timeout;
    do {
      const config = store.read(name);
      if (config.thread_id !== state.thread || config.plugin?.id !== state.to ||
          (config.binding_revision ?? null) !== state.revision) return { status: "handoff-superseded" };
      const report = status(store, name);
      if (report.worker && report.health?.pid === report.worker.pid &&
          report.health?.thread_id === state.thread && report.health?.plugin_id === state.to && report.health?.updated >= state.attached_at &&
          ["idle", "active"].includes(report.health?.status) && report.health?.telegram?.status === "connected") {
        journal.put("plugin_handoff", { ...state, phase: "ready", status: "connected", updated: now() });
        return { status: "connected", handoff: "verified", telegram_round_trip: "not_tested" };
      }
      if (!config.enabled || !config.autostart) return { status: "paused" };
      if (Date.now() >= deadline) break;
      await sleep(100);
    } while (true);
    const pending = { ...state, phase: "activation_pending", status: "receiver-not-ready", updated: now() };
    journal.put("plugin_handoff", pending);
    await notifyHandoffFailure(store, name, pending);
    return { status: "handoff-pending", detail: "Plugin attachment completed, but receiver readiness is not confirmed. Pairing and queued messages are retained; inspect list_bots before retrying." };
  } finally { journal.close(); }
}
