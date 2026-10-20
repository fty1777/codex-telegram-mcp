import { telegramView } from "./telegram-view";
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, atomic, readJSON } from "../bun/state";
import { ChannelHost, attachSharedPlugin } from "../bun/channel";

test("marketplace pairing attaches without a legacy install and preserves existing receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-marketplace-state-"));
  const store = new Store(root);
  const plugin = { id: "telegram@codex-telegram", root: "/fixture/plugin" };
  store.configure(
    "sample",
    "123456:fixture",
    { id: 123456, username: "sample" },
    42,
    "session",
  );
  try {
    const config = attachSharedPlugin(store, "sample", plugin);
    expect(config.plugin).toEqual(plugin);
    expect(config.autostart).toBe(true);
    expect(config.thread_id).toBe("session");
    expect(config.owner_id).toBe(42);
    expect(existsSync(join(root, "manager-installation.json"))).toBe(false);
    const old = { phase: "installed", plugin_id: "legacy@legacy" };
    atomic(join(root, "manager-installation.json"), old);
    atomic(join(store.instance("sample"), "config.json"), {
      ...config,
      autostart: false,
    });
    const updated = attachSharedPlugin(
      store,
      "sample",
      { ...plugin, root: "/fixture/updated" },
      false,
    );
    expect(updated.autostart).toBe(false);
    expect(updated.plugin.root).toBe("/fixture/updated");
    expect(store.token("sample")).toBe("123456:fixture");
    expect(readJSON(join(root, "manager-installation.json"))).toEqual(old);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("marketplace host requires both session ownership and its own plugin binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-marketplace-owner-"));
  const store = new Store(root);
  const plugin = { id: "telegram@codex-telegram", root: "/fixture/plugin" };
  store.configure(
    "sample",
    "123456:fixture",
    { id: 123456, username: "sample" },
    42,
    "session",
  );
  const host = new ChannelHost(store, async () => {}, plugin);
  try {
    await expect(
      host.connect("sample", { threadId: "session" }),
    ).rejects.toThrow("another installation");
    attachSharedPlugin(store, "sample", plugin);
    await expect(
      host.connect("sample", { threadId: "foreign" }),
    ).rejects.toThrow("not bound");
    expect((await host.connect("sample", { threadId: "session" })).status).toBe(
      "connecting",
    );
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one session host owns multiple bots independently and rejects foreign sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-channel-")),
    s = new Store(root);
  for (const [i, name] of ["one", "two"].entries()) {
    s.configure(
      name,
      `${123456 + i}:fixture`,
      { id: 123456 + i, username: name },
      42,
      "session",
    );
    atomic(join(s.instance(name), "config.json"), {
      ...s.read(name),
      autostart: true,
    });
  }
  const active = new Set<string>();
  const host = new ChannelHost(s, async (_s, name, signal) => {
    if (signal?.aborted) return;
    active.add(name);
    await new Promise<void>((resolve) =>
      signal!.addEventListener("abort", () => resolve(), { once: true }),
    );
    active.delete(name);
  });
  try {
    await host.connect("one", { threadId: "session" });
    await host.connect("two", { threadId: "session" });
    expect([...active].sort()).toEqual(["one", "two"]);
    await expect(host.connect("one", { threadId: "other" })).rejects.toThrow(
      "not bound",
    );
    await host.disconnect("one", { threadId: "session" });
    expect([...active]).toEqual(["two"]);
    expect((await host.connect("one", { threadId: "session" })).status).toBe(
      "paused",
    );
    atomic(join(s.instance("one"), "config.json"), {
      ...s.read("one"),
      thread_id: "new",
      autostart: true,
    });
    await host.connect("one", { threadId: "new" });
    expect(() => host.sender("one", { threadId: "session" })).toThrow(
      "not bound",
    );
    await host.forget("one");
    expect([...active]).toEqual(["two"]);
    await host.close();
    expect(active.size).toBe(0);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native tools render progress, literal edits and captions through the common sender", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { channelServer } = await import("../bun/channel");
  const { writeFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "telegram-tools-format-"));
  const store = new Store(root);
  store.configure(
    "sample",
    "123456:fixture",
    { id: 123456, username: "sample" },
    42,
    "session",
  );
  const host = new ChannelHost(store);
  const sender = host.sender("sample", { threadId: "session" });
  const calls: any[] = [];
  sender.api.call = async (method, params) => {
    calls.push({ method, params: telegramView(params) });
    return { message_id: calls.length, chat: { id: 42 } };
  };
  const { server } = channelServer(store, host);
  const client = new Client({ name: "format-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const send = await client.callTool({
      name: "send_text",
      arguments: {
        instance: "sample",
        request_id: "progress",
        text: "**Checking**",
        phase: "commentary",
      },
      _meta: { threadId: "session" },
    });
    expect(send.isError).not.toBe(true);
    expect(calls[0].params.text).toBe("Checking");
    await client.callTool({
      name: "edit_message",
      arguments: {
        instance: "sample",
        request_id: "edit",
        message_id: 1,
        text: "**literal**",
        format: "plain",
      },
      _meta: { threadId: "session" },
    });
    expect(calls[1].params.text).toBe("**literal**");
    expect(calls[1].params.entities).toHaveLength(0);
    const path = join(store.instance("sample"), "outgoing", "test.txt");
    writeFileSync(path, "sample");
    await client.callTool({
      name: "send_document",
      arguments: {
        instance: "sample",
        request_id: "document",
        path,
        caption: "_File_",
      },
      _meta: { threadId: "session" },
    });
    expect(calls[2].params.caption).toBe("File");
    expect(calls[2].params.caption_entities[0].type).toBe("italic");
  } finally {
    await client.close();
    await server.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("receiver retries recover without sending stale connection notices", async () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-plain-notice-"));
  const s = new Store(root);
  s.configure(
    "sample",
    "123456:fixture",
    { id: 123456, username: "sample" },
    42,
    "session",
  );
  atomic(join(s.instance("sample"), "config.json"), {
    ...s.read("sample"),
    autostart: true,
  });
  let attempts = 0;
  const host = new ChannelHost(s, async () => {
    if (++attempts === 1) throw Error("INTERNAL_EXCEPTION_DETAIL");
  });
  const messages: any[] = [];
  host.sender("sample", { threadId: "session" }).api.call = async (
    _method,
    params,
  ) => {
    messages.push(telegramView(params));
    return { message_id: 1, chat: { id: 42 } };
  };
  try {
    await host.connect("sample", { threadId: "session" });
    await Bun.sleep(20);
    expect(messages).toHaveLength(0);
    for (let i = 0; i < 40 && attempts < 2; i++) await Bun.sleep(50);
    expect(attempts).toBe(2);
    expect(messages).toHaveLength(0);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("output backlogs beyond twenty events drain before new input", async () => {
  const { drainOutputEvents } = await import("../bun/worker");
  const queue = Array.from({ length: 25 }, (_, i) => i),
    seen: any[] = [];
  queue.push(99);
  await drainOutputEvents(queue, async (event) => {
    seen.push(event);
  });
  seen.push("new user input");
  expect(seen.slice(-2)).toEqual([99, "new user input"]);
  expect(queue).toHaveLength(0);
});

test("output draining bounds each snapshot without losing newly arriving events", async () => {
  const { drainOutputEvents } = await import("../bun/worker");
  const queue = [1],
    seen: number[] = [];
  await drainOutputEvents(queue, async (event) => {
    seen.push(event);
    queue.push(2);
  });
  expect(seen).toEqual([1]);
  expect(queue).toEqual([2]);
  await drainOutputEvents(queue, async (event) => {
    seen.push(event);
  });
  expect(seen).toEqual([1, 2]);
});

test("plugin attachment retires an owned independent process without losing pairing or receipts", async () => {
  const { prepareSharedPlugin } = await import("../bun/channel");
  const { identity, start } = await import("../bun/process");
  const { Journal } = await import("../bun/state");
  const root = mkdtempSync(join(tmpdir(), "telegram-retire-receiver-"));
  const store = new Store(root);
  store.configure("sample", "123456:fixture", { id: 123456, username: "sample" }, 42, "session");
  const journal = new Journal(store.instance("sample"));
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  try {
    journal.put("telegram_offset", 27);
    journal.begin("out", "unknown-send", { text: "fixture" });
    const path = store.instance("sample");
    atomic(join(path, "process.json"), identity(child.pid));
    atomic(join(path, "worker-process.json"), identity(child.pid));
    await expect(start(store, "sample", true)).rejects.toThrow("Independent receivers are no longer supported");
    expect(child.exitCode).toBeNull();
    const plugin = { id: "telegram@codex-telegram", root: "/fixture/plugin" };
    expect(() => attachSharedPlugin(store, "sample", plugin)).toThrow("Retired receiver is still active");
    const config = await prepareSharedPlugin(store, "sample", plugin);
    await child.exited;
    expect(identity(child.pid)).toBeNull();
    expect(config.lifecycle).toBe("mcp");
    expect(config.shared_mcp).toBe(true);
    expect(config.owner_id).toBe(42);
    expect(config.thread_id).toBe("session");
    expect(store.token("sample")).toBe("123456:fixture");
    expect(journal.get("telegram_offset")).toBe(27);
    expect(journal.status("out", "unknown-send")?.status).toBe("unknown");
  } finally {
    child.kill(); await child.exited;
    journal.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("retired CLI launch commands cannot start receivers", async () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-removed-launcher-"));
  try {
    for (const command of ["run", "supervise", "session-hook"]) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../bun/cli.ts"), command, "sample", "--data-dir", root], { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill(), 5000);
      try {
        const [err, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
        expect(exit).toBe(1);
        expect(err).toContain("Commands:");
        expect(existsSync(join(root, "instances/sample/worker-process.json"))).toBe(false);
      } finally { clearTimeout(timer); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("workers require MCP configuration and an owning lifecycle signal", async () => {
  const { runWorker } = await import("../bun/worker");
  const root = mkdtempSync(join(tmpdir(), "telegram-worker-ownership-"));
  const store = new Store(root);
  store.configure("sample", "123456:fixture", { id: 123456, username: "sample" }, 42, "session");
  try {
    await expect((runWorker as any)(store, "sample")).rejects.toThrow("Codex-owned lifecycle signal");
    await expect(runWorker(store, "sample", new AbortController().signal)).rejects.toThrow("Only Codex-managed MCP receivers are supported");
    expect(existsSync(join(store.instance("sample"), "worker-process.json"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
