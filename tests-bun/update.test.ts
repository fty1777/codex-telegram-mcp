import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, atomic } from "../bun/state";
import { updatePlugin } from "../bun/update";
import { DeliveryUnknown } from "../bun/appserver";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telegram-update-"));
  const store = new Store(join(root, "state"));
  store.configure("test", "123456:fixture", { id: 123456, username: "fixture" }, 42, "session");
  const config = { ...store.read("test"), enabled: true, autostart: true, shared_mcp: true,
    plugin: { id: "codex-telegram-mcp@fty1777", root: "/fixture/old" } };
  atomic(join(store.instance("test"), "config.json"), config);
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ name: "codex-telegram-mcp", version: "2.0.0" }));
  const rpc: string[] = [], commands: string[][] = [];
  let activated = false, closed = 0;
  const client: any = {
    send() {}, close() { closed++; },
    resume: async () => { rpc.push("thread/resume"); return {}; },
    call: async (method: string) => {
      rpc.push(method);
      if (method === "thread/read") return { thread: { status: { type: "active" } } };
      if (method === "config/mcpServer/reload") activated = true;
      if (method === "mcpServer/tool/call") return { content: [{ text: JSON.stringify({ version: activated ? "2.0.0" : "1.0.0", pid: activated ? 22 : 11 }) }] };
      return {};
    },
  };
  const services: any = {
    connect: async () => client,
    runner: async (...args: string[]) => { commands.push(args); return args[0] === "add" ? { installedPath: root } : { errors: [] }; },
    health: () => ({ worker: { pid: 22 }, health: { pid: 22, thread_id: "session", version: "2.0.0", status: "active", telegram: { status: "connected" } } }),
    wait: async () => {},
  };
  return { store, config, client, services, rpc, commands, closed: () => closed, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("updater replaces the running plugin in its existing session and preserves pairing and configuration", async () => {
  const f = fixture();
  try {
    const result = await updatePlugin(f.store, {}, f.services);
    expect(result.status).toBe("updated");
    expect(result.installed_version).toBe("2.0.0");
    expect(result.receiver_readiness).toBe("verified");
    expect(result.telegram_round_trip).toBe("not_tested");
    expect(f.commands).toEqual([["marketplace", "upgrade", "fty1777"], ["add", "codex-telegram-mcp@fty1777"]]);
    expect(f.rpc.indexOf("thread/resume")).toBeLessThan(f.rpc.indexOf("config/mcpServer/reload"));
    expect(f.rpc).not.toContain("thread/archive");
    expect(f.rpc).not.toContain("turn/start");
    expect(f.store.read("test")).toEqual(f.config);
    expect(f.closed()).toBe(1);
  } finally { f.done(); }
});

test.each(["stale", "connecting"])("polling alone does not confirm activation with %s receiver health", async kind => {
  const f = fixture();
  f.services.health = () => ({ worker: { pid: kind === "stale" ? 11 : 22 }, health: {
    pid: kind === "stale" ? 11 : 22, thread_id: "session", version: "2.0.0", status: kind === "connecting" ? "connecting" : "active", telegram: { status: "connected" },
  } });
  try {
    const result = await updatePlugin(f.store, { timeout: 0 }, f.services);
    expect(result.status).toBe("activation_pending");
    expect(result.pending_sessions).toBe(1);
    expect(f.store.read("test")).toEqual(f.config);
    expect(f.commands.filter(c => c[0] === "add")).toHaveLength(1);
  } finally { f.done(); }
});

test("updating files never loads an inactive conversation", async () => {
  const f = fixture();
  f.client.call = async (method: string) => {
    f.rpc.push(method);
    if (method === "thread/read") return { thread: { status: { type: "notLoaded" } } };
    throw Error("Must not touch inactive session");
  };
  try {
    const result = await updatePlugin(f.store, {}, f.services);
    expect(result.status).toBe("awaiting_session");
    expect(result.verified_sessions).toBe(0);
    expect(f.rpc).toEqual(["thread/read"]);
  } finally { f.done(); }
});

test("marketplace failure retains running sessions without installing or refreshing MCP", async () => {
  const f = fixture();
  f.services.runner = async (...args: string[]) => { f.commands.push(args); return { errors: [{ message: "fixture failure" }] }; };
  try {
    await expect(updatePlugin(f.store, {}, f.services)).rejects.toThrow("running plugin was retained");
    expect(f.commands).toHaveLength(1);
    expect(f.rpc).not.toContain("config/mcpServer/reload");
    expect(f.store.read("test")).toEqual(f.config);
    expect(f.closed()).toBe(1);
  } finally { f.done(); }
});

test("ambiguous session retention fails before any installation and is never retried", async () => {
  const f = fixture();
  f.client.resume = async () => { throw new DeliveryUnknown("unknown"); };
  try {
    await expect(updatePlugin(f.store, {}, f.services)).rejects.toThrow("unknown");
    expect(f.commands).toHaveLength(0);
    expect(f.closed()).toBe(1);
  } finally { f.done(); }
});

test("a paused bot is preserved without starting its receiver", async () => {
  const f = fixture();
  atomic(join(f.store.instance("test"), "config.json"), { ...f.config, autostart: false });
  try {
    const result = await updatePlugin(f.store, {}, f.services);
    expect(result.status).toBe("installed");
    expect(f.rpc).toHaveLength(0);
    expect(f.store.read("test").autostart).toBe(false);
  } finally { f.done(); }
});

test("only an explicit concurrent catalog refresh is retried, and installation still runs once", async () => {
  const f = fixture();
  const runner = f.services.runner;
  let refreshes = 0;
  f.services.runner = async (...args: string[]) => {
    if (args[0] === "marketplace" && ++refreshes < 3)
      throw Error("installed marketplace changed while auto-upgrade was in flight");
    return runner(...args);
  };
  try {
    expect((await updatePlugin(f.store, {}, f.services)).status).toBe("updated");
    expect(refreshes).toBe(3);
    expect(f.commands.filter(c => c[0] === "add")).toHaveLength(1);
  } finally { f.done(); }
});

test("an already current runtime is verified without another MCP refresh", async () => {
  const f = fixture();
  const original = f.client.call;
  f.client.call = async (method: string, params: any) => method === "mcpServer/tool/call"
    ? { content: [{ text: JSON.stringify({ version: "2.0.0", pid: 22 }) }] }
    : original(method, params);
  try {
    expect((await updatePlugin(f.store, {}, f.services)).status).toBe("up_to_date");
    expect(f.rpc).not.toContain("config/mcpServer/reload");
  } finally { f.done(); }
});

test("the updater can install with an empty local state directory", async () => {
  const f = fixture();
  try {
    const empty = new Store(join(f.store.root, "empty"));
    expect((await updatePlugin(empty, {}, f.services)).status).toBe("installed");
    expect(f.rpc).toHaveLength(0);
  } finally { f.done(); }
});

test("receiver health from another conversation cannot confirm an update", async () => {
  const f = fixture();
  f.services.health = () => ({ worker: { pid: 22 }, health: {
    pid: 22, thread_id: "another-session", version: "2.0.0", status: "active", telegram: { status: "connected" },
  } });
  try {
    expect((await updatePlugin(f.store, { timeout: 0 }, f.services)).status).toBe("activation_pending");
  } finally { f.done(); }
});

test("concurrent updaters cannot overlap installations", async () => {
  const f = fixture();
  const runner = f.services.runner;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.services.runner = async (...args: string[]) => { await gate; return runner(...args); };
  const first = updatePlugin(f.store, {}, f.services);
  try {
    await Bun.sleep(0);
    await expect(updatePlugin(f.store, {}, f.services)).rejects.toThrow("Operation already running");
    release();
    expect((await first).status).toBe("updated");
    expect(f.commands.filter(c => c[0] === "add")).toHaveLength(1);
  } finally { release(); await first.catch(() => {}); f.done(); }
});

test("a lost version-query connection aborts before replacing the subscribed receiver", async () => {
  const f = fixture();
  const original = f.client.call;
  f.client.call = async (method: string, params: any) => {
    if (method === "mcpServer/tool/call") throw new DeliveryUnknown("connection lost");
    return original(method, params);
  };
  try {
    await expect(updatePlugin(f.store, {}, f.services)).rejects.toThrow("connection lost");
    expect(f.commands).toHaveLength(0);
    expect(f.closed()).toBe(1);
  } finally { f.done(); }
});
