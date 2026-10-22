import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Journal, atomic, now } from "../bun/state";
import { prepareSharedPlugin, attachSharedPlugin } from "../bun/channel";
import { completeHandoff, probeHandoff, notifyHandoffFailure, recordHandoff } from "../bun/handoff";
import { AppServer } from "../bun/appserver";
import { Telegram } from "../bun/telegram";
import { identity } from "../bun/process";
import { listBots } from "../bun/management";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telegram-handoff-"));
  const store = new Store(root);
  store.configure("test", "123456:fixture", { id: 123456, username: "fixture" }, 42, "thread");
  const before = { ...store.read("test"), lifecycle: "mcp", shared_mcp: true, autostart: true,
    mcp_server: "old_server", plugin: { id: "old@old", root: "/fixture/old" } };
  atomic(join(store.instance("test"), "config.json"), before);
  const target = { id: "codex-telegram-mcp@fty1777", root: "/fixture/new" };
  const journal = new Journal(store.instance("test"));
  journal.put("telegram_offset", 123);
  journal.begin("out", "unknown-fixture", { text: "fixture" });
  return { root, store, target, before, journal, done() { journal.close(); rmSync(root, { recursive: true, force: true }); } };
}

test.each(["mcp-unavailable", "mcp-startup-failed", "awaiting-session"])("blocked target %s leaves the old binding and receipts unchanged", async readiness => {
  const f = fixture();
  let notices = 0;
  try {
    await expect(prepareSharedPlugin(f.store, "test", f.target, true, {
      probe: async () => ({ status: readiness, diagnostic: "123456:fixture" }),
      notify: async () => { notices++; },
    })).rejects.toThrow("handoff is not ready");
    expect(f.store.read("test")).toEqual(f.before);
    expect(f.journal.get("telegram_offset")).toBe(123);
    expect(f.journal.status("out", "unknown-fixture").status).toBe("unknown");
    expect(f.journal.get("plugin_handoff").phase).toBe("blocked");
    expect(f.journal.get("plugin_handoff").diagnostic).not.toContain("123456:fixture");
    expect(notices).toBe(1);
    expect(() => attachSharedPlugin(f.store, "test", f.target)).toThrow("handoff is not ready");
  } finally { f.done(); }
});

test("a ready management plane permits attachment but does not imply a connected receiver", async () => {
  const f = fixture();
  try {
    const config = await prepareSharedPlugin(f.store, "test", f.target, false, {
      probe: async () => ({ status: "ready" }), notify: async () => {},
    });
    expect(config.plugin).toEqual(f.target);
    expect(config.thread_id).toBe(f.before.thread_id);
    expect(config.owner_id).toBe(f.before.owner_id);
    expect(config.autostart).toBe(true);
    expect(f.journal.get("plugin_handoff").phase).toBe("attached");
    expect(listBots(f.store)[0].receiver_status).toBe("stopped");
  } finally { f.done(); }
});

test("a concurrent binding change cannot be overwritten by a stale handoff", async () => {
  const f = fixture();
  try {
    await expect(prepareSharedPlugin(f.store, "test", f.target, true, {
      probe: async () => {
        atomic(join(f.store.instance("test"), "config.json"), { ...f.before, thread_id: "other" });
        return { status: "ready" };
      }, notify: async () => {},
    })).rejects.toThrow("binding changed");
    expect(f.store.read("test").thread_id).toBe("other");
    expect(f.store.read("test").plugin).toEqual(f.before.plugin);
    expect(f.store.read("test").autostart).toBe(true);
  } finally { f.done(); }
});

test("preflight checks plugin identity and read-only tool dispatch without starting a poller", async () => {
  const original = AppServer.connect;
  const methods: string[] = [];
  let pluginId = "wrong@wrong", failed = false;
  AppServer.connect = async () => ({
    close() {}, call: async (method: string, params: any) => {
      methods.push(method);
      if (method === "thread/read") return { thread: { status: { type: "idle" } } };
      if (method === "mcpServerStatus/list") return { data: [{ name: "telegram", pluginId, runtimeStatus: failed ? "failed" : "connected", toolsError: failed ? "fixture failure" : null }] };
      expect(params.tool).toBe("list_bots");
      return { content: [{ text: JSON.stringify({ bots: [] }) }] };
    },
  }) as any;
  try {
    const target = { id: "new@new", root: "/fixture/new" };
    expect((await probeHandoff({ thread_id: "thread" }, target)).status).toBe("mcp-unavailable");
    expect(methods).not.toContain("mcpServer/tool/call");
    pluginId = target.id;
    expect((await probeHandoff({ thread_id: "thread" }, target)).status).toBe("ready");
    failed = true;
    expect((await probeHandoff({ thread_id: "thread" }, target)).status).toBe("mcp-startup-failed");
    expect(methods).not.toContain("turn/start");
    expect(methods).not.toContain("thread/resume");
  } finally { AppServer.connect = original; }
});

test.each(["sent", "unknown"])("handoff failure notice is not resent after %s delivery and cannot make receiving healthy", async delivery => {
  const f = fixture();
  const original = Telegram.prototype.call;
  let sends = 0;
  Telegram.prototype.call = async () => {
    sends++;
    if (delivery === "unknown") throw Error("lost response");
    return { message_id: 1, chat: { id: 42 } };
  };
  try {
    const state = { from: "old@old", to: f.target.id, thread: "thread", revision: null };
    await notifyHandoffFailure(f.store, "test", state);
    await notifyHandoffFailure(f.store, "test", state);
    expect(sends).toBe(1);
    expect(listBots(f.store)[0].receiver_status).toBe("stopped");
  } finally { Telegram.prototype.call = original; f.done(); }
});

test("handoff completion rejects old-owner health even if polling is connected", async () => {
  const f = fixture();
  try {
    const attachedAt = now();
    recordHandoff(f.store, "test", { from: "old@old", to: f.target.id, thread: "thread", revision: null, phase: "attached", attached_at: attachedAt });
    atomic(join(f.store.instance("test"), "config.json"), { ...f.before, plugin: f.target });
    atomic(join(f.store.instance("test"), "worker-process.json"), identity(process.pid));
    const health = { pid: process.pid, updated: now() + 1, thread_id: "thread", plugin_id: "old@old", status: "active", telegram: { status: "connected" } };
    atomic(join(f.store.instance("test"), "health.json"), health);
    // Suppress real network I/O; this scenario remains a unit readiness check.
    const original = Telegram.prototype.call;
    Telegram.prototype.call = async () => ({ message_id: 1, chat: { id: 42 } });
    try { expect((await completeHandoff(f.store, "test", 0))?.status).toBe("handoff-pending"); }
    finally { Telegram.prototype.call = original; }
    expect(listBots(f.store)[0].receiver_status).toBe("handoff-pending");
    atomic(join(f.store.instance("test"), "health.json"), { ...health, plugin_id: f.target.id });
    expect((await completeHandoff(f.store, "test", 0))?.status).toBe("connected");
    expect(f.journal.get("plugin_handoff").phase).toBe("ready");
    expect(f.journal.status("out", "unknown-fixture").status).toBe("unknown");
  } finally { f.done(); }
});

test("verified handoff waits for the old owner's real bot lock before attaching the replacement", async () => {
  const { lock } = await import("../bun/process");
  const { privateDir } = await import("../bun/state");
  const f = fixture();
  privateDir(join(f.root, "locks"));
  const botLock = join(f.root, "locks", "bot-123456.lock");
  let releaseOld: (() => void) | undefined = lock(botLock);
  let stopped = false;
  const lease = setInterval(() => {
    if (f.store.read("test").autostart === false && releaseOld) {
      expect(f.store.read("test").plugin).toEqual(f.before.plugin);
      releaseOld(); releaseOld = undefined; stopped = true;
    }
  }, 10);
  try {
    const config = await prepareSharedPlugin(f.store, "test", f.target, true, {
      probe: async () => { expect(stopped).toBe(false); expect(f.store.read("test")).toEqual(f.before); return { status: "ready" }; },
      notify: async () => {},
    });
    expect(stopped).toBe(true);
    expect(config.plugin).toEqual(f.target);
    const releaseNew = lock(botLock); releaseNew();
  } finally { clearInterval(lease); releaseOld?.(); f.done(); }
});

test("a paused bot keeps its pause when changing plugin identity", async () => {
  const f = fixture();
  atomic(join(f.store.instance("test"), "config.json"), { ...f.before, autostart: false });
  try {
    const result = await prepareSharedPlugin(f.store, "test", f.target, false, {
      probe: async () => ({ status: "ready" }), notify: async () => {},
    });
    expect(result.plugin).toEqual(f.target);
    expect(result.autostart).toBe(false);
    expect(result.thread_id).toBe(f.before.thread_id);
  } finally { f.done(); }
});

test("an already rewritten binding plus a stopped receiver is checked without deleting stale installation metadata", async () => {
  const f = fixture();
  const rewritten = { ...f.before, plugin: f.target, mcp_server: "telegram" };
  const receipt = { plugin_id: "old@old", version: "fixture-old", private_diagnostic: "PRIVATE" };
  atomic(join(f.store.instance("test"), "config.json"), rewritten);
  atomic(join(f.store.instance("test"), "installation.json"), receipt);
  atomic(join(f.store.instance("test"), "health.json"), { pid: null, status: "stopped" });
  try {
    await expect(prepareSharedPlugin(f.store, "test", f.target, false, {
      probe: async () => ({ status: "mcp-unavailable" }), notify: async () => {},
    })).rejects.toThrow("handoff is not ready");
    expect(f.store.read("test")).toEqual(rewritten);
    expect(f.journal.get("plugin_handoff").from).toBe("old@old");
    expect(f.journal.status("out", "unknown-fixture").status).toBe("unknown");
    const { readJSON } = await import("../bun/state");
    expect(readJSON(join(f.store.instance("test"), "installation.json"))).toEqual(receipt);
    expect(JSON.stringify(listBots(f.store))).not.toContain("PRIVATE");
  } finally { f.done(); }
});

test.each([false, true])("native binding checks the target before moving a bot (target ready: %s)", async ready => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { channelServer } = await import("../bun/channel");
  const f = fixture();
  const original = AppServer.connect, originalCall = Telegram.prototype.call;
  AppServer.connect = async () => ({ close() {}, call: async (method: string, params: any) => {
    if (method === "thread/read") return { thread: { status: { type: "idle" } } };
    if (method === "mcpServerStatus/list") return { data: ready ? [{ name: "telegram", pluginId: f.target.id, runtimeStatus: "connected" }] : [] };
    expect(params.tool).toBe("list_bots");
    return { content: [{ text: JSON.stringify({ bots: [] }) }] };
  } }) as any;
  Telegram.prototype.call = async () => ({ message_id: 1, chat: { id: 42 } });
  const { server, host } = channelServer(f.store, undefined, f.target);
  const client = new Client({ name: "handoff-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const result: any = await client.callTool({ name: "bind_bot", arguments: {
      instance: "test", expected_session: "thread", activate: false,
    }, _meta: { threadId: "new-thread" } });
    if (!ready) {
      expect(result.isError).toBe(true);
      expect(f.store.read("test")).toEqual(f.before);
    } else {
      expect(result.isError).not.toBe(true);
      const config = f.store.read("test");
      expect(config.thread_id).toBe("new-thread");
      expect(config.plugin).toEqual(f.target);
      expect(config.autostart).toBe(false);
      expect(config.enabled).toBe(false);
      expect(JSON.parse(result.content[0].text).connection.status).toBe("paused");
    }
  } finally {
    await client.close(); await host.close(); await server.close();
    AppServer.connect = original; Telegram.prototype.call = originalCall; f.done();
  }
});

test("an intentionally paused bot does not receive an outage notice", async () => {
  const f = fixture();
  const original = Telegram.prototype.call;
  let sends = 0;
  Telegram.prototype.call = async () => { sends++; return { message_id: 1 }; };
  atomic(join(f.store.instance("test"), "config.json"), { ...f.before, autostart: false });
  try {
    await notifyHandoffFailure(f.store, "test", { from: "old@old", to: f.target.id, thread: "thread", revision: null, was_running: false });
    expect(sends).toBe(0);
  } finally { Telegram.prototype.call = original; f.done(); }
});
