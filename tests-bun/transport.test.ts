import { test, expect } from "bun:test";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServer, DeliveryUnknown } from "../bun/appserver";
import { Telegram, Sender } from "../bun/telegram";
import { Store } from "../bun/state";
test("Unix websocket JSON-RPC multiplexes events and disconnect is unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-rpc-")),
    socket = join(dir, "rpc.sock");
  const server = createServer();
  const ws = new WebSocketServer({ server });
  ws.on("connection", (peer) =>
    peer.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.method === "initialize")
        peer.send(JSON.stringify({ id: m.id, result: { ok: true } }));
      if (m.method === "test") {
        peer.send(
          JSON.stringify({
            method: "item/completed",
            params: { threadId: "thread" },
          }),
        );
        peer.send(JSON.stringify({ id: m.id, result: { answer: 42 } }));
      }
      if (m.method === "disconnect") peer.close();
    }),
  );
  await new Promise<void>((r) => server.listen(socket, r));
  const c = await AppServer.connect("unix://" + socket);
  try {
    expect((await c.call("test", {})).answer).toBe(42);
    expect(c.events[0].method).toBe("item/completed");
    await expect(c.call("disconnect", {})).rejects.toBeInstanceOf(
      DeliveryUnknown,
    );
  } finally {
    c.close();
    ws.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("HTTP multipart sends exact file and snapshot cleans on confirmation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-http-")),
    s = new Store(dir);
  s.configure(
    "t",
    "123456:fixture",
    { id: 123456, username: "t" },
    1,
    "thread",
  );
  const path = join(s.instance("t"), "outgoing", "你好.txt");
  writeFileSync(path, "content\n");
  let seen: any;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const f = await req.formData();
      const file = f.get("document") as File;
      seen = {
        name: file.name,
        text: await file.text(),
        chat: f.get("chat_id"),
      };
      return Response.json({
        ok: true,
        result: { chat: { id: 1 }, message_id: 4 },
      });
    },
  });
  const api = new Telegram(
    "123456:fixture",
    `http://127.0.0.1:${server.port}`,
    dir,
  );
  Object.defineProperty(api, "localDir", { value: undefined });
  const sender = new Sender(s, "t", api);
  try {
    expect((await sender.send("file", { file: path })).status).toBe("sent");
    expect(seen).toEqual({ name: "你好.txt", text: "content\n", chat: "1" });
  } finally {
    sender.journal.close();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("local download validates server path and preserves bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-download-")),
    source = join(dir, "file.pdf");
  writeFileSync(source, "pdf bytes");
  const api = new Telegram("123456:fixture", "http://127.0.0.1:12345", dir);
  api.call = async () => ({ file_path: source, file_size: 9 });
  try {
    const path = await api.download("id", join(dir, "inbox"));
    expect(readFileSync(path, "utf8")).toBe("pdf bytes");
    api.call = async () => ({ file_path: "/etc/passwd" });
    await expect(api.download("other", join(dir, "inbox"))).rejects.toThrow(
      "outside",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed stop signals only a matching live process identity", async () => {
  const { identity, stop, live } = await import("../bun/process");
  const { atomic } = await import("../bun/state");
  const dir = mkdtempSync(join(tmpdir(), "bridge-stop-")),
    s = new Store(dir);
  s.configure(
    "t",
    "123456:fixture",
    { id: 123456, username: "t" },
    1,
    "thread",
  );
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(()=>{},1000)"],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    const own = identity(child.pid);
    atomic(join(s.instance("t"), "process.json"), {
      ...own,
      start_ticks: "wrong",
    });
    await stop(s, "t");
    expect(child.exitCode).toBeNull();
    atomic(join(s.instance("t"), "process.json"), own);
    await stop(s, "t");
    await child.exited;
    expect(live(join(s.instance("t"), "process.json"))).toBeNull();
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP stdio exposes tools and reads receipts without sending", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );
  const dir = mkdtempSync(join(tmpdir(), "bridge-mcp-")),
    s = new Store(dir);
  s.configure(
    "t",
    "123456:fixture",
    { id: 123456, username: "t" },
    1,
    "thread",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(import.meta.dir, "../bun/cli.ts"),
      "--data-dir",
      dir,
      "mcp",
      "--instance",
      "t",
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "bind_bot",
      "delivery_status",
      "edit_message",
      "list_bots",
      "send_document",
      "send_photo",
      "send_text",
      "unbind_bot",
    ]);
    const r: any = await client.callTool({
      name: "delivery_status",
      arguments: { request_id: "none" },
    });
    expect(JSON.parse(r.content[0].text).status).toBe("not_found");
    const inventory: any = await client.callTool({
      name: "list_bots",
      arguments: {},
      _meta: { threadId: "another-session" },
    });
    expect(JSON.parse(inventory.content[0].text).bots[0].instance).toBe("t");
    expect(JSON.stringify(inventory)).not.toContain("123456:fixture");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("standalone management MCP works before any bot exists and requires session metadata", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );
  const dir = mkdtempSync(join(tmpdir(), "bridge-manager-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(import.meta.dir, "../bun/cli.ts"),
      "--data-dir",
      dir,
      "manager",
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "add_bot",
      "bind_bot",
      "cancel_pairing",
      "check_pairing",
      "confirm_pairing",
      "list_bots",
      "remove_bot",
      "unbind_bot",
    ]);
    const rejected: any = await client.callTool({
      name: "list_bots",
      arguments: {},
    });
    expect(rejected.isError).toBe(true);
    const listed: any = await client.callTool({
      name: "list_bots",
      arguments: {},
      _meta: { threadId: "session" },
    });
    expect(JSON.parse(listed.content[0].text)).toEqual({ bots: [] });
    const store = new Store(dir);
    store.configure(
      "sample",
      "123456:fixture",
      { id: 123456, username: "fixture" },
      12,
      "old",
    );
    const removed: any = await client.callTool({
      name: "remove_bot",
      arguments: {
        instance: "sample",
        expected_session: "old",
        confirm: "REMOVE_BOT",
      },
      _meta: { threadId: "session" },
    });
    expect(removed.isError).not.toBe(true);
    expect(JSON.parse(removed.content[0].text).configuration).toBe("removed");
    expect(store.list()).toEqual([]);
    const again: any = await client.callTool({
      name: "list_bots",
      arguments: {},
      _meta: { threadId: "session" },
    });
    expect(again.isError).not.toBe(true);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("metadata reads retry boundedly; sends and API rejections do not", async () => {
  const counts: Record<string, number> = {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const method = new URL(request.url).pathname.split("/").pop()!;
      counts[method] = (counts[method] ?? 0) + 1;
      if (method === "getWebhookInfo")
        return Response.json({
          ok: false,
          error_code: 401,
          description: "Unauthorized",
        });
      if (method === "getMe" && counts[method] === 3)
        return Response.json({ ok: true, result: { id: 123456 } });
      return new Response("invalid response", { status: 502 });
    },
  });
  const api = new Telegram(
    "123456:fixture",
    `http://127.0.0.1:${server.port}`,
    tmpdir(),
  );
  try {
    expect(await api.call("getMe", {})).toEqual({ id: 123456 });
    expect(counts.getMe).toBe(3);
    await expect(api.call("getFile", {})).rejects.toThrow(
      "Telegram getFile failed after",
    );
    expect(counts.getFile).toBe(3);
    await expect(api.call("sendMessage", {})).rejects.toThrow(
      "delivery unknown",
    );
    expect(counts.sendMessage).toBe(1);
    await expect(api.call("getWebhookInfo", {})).rejects.toThrow(
      "Unauthorized",
    );
    expect(counts.getWebhookInfo).toBe(1);
    await expect(api.call("getUpdates", {})).rejects.toThrow(
      "poll/read failed",
    );
    expect(counts.getUpdates).toBe(1);
  } finally {
    api.abort();
    server.stop(true);
  }
});

test("closing Telegram during read retry backoff prevents another request", async () => {
  let count = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      count++;
      setTimeout(() => api.abort(), 20);
      return new Response("invalid response");
    },
  });
  const api = new Telegram(
    "123456:fixture",
    `http://127.0.0.1:${server.port}`,
    tmpdir(),
  );
  try {
    await expect(api.call("getMe", {})).rejects.toThrow("getMe failed");
    expect(count).toBe(1);
  } finally {
    api.abort();
    server.stop(true);
  }
});

test("Telegram deadlines include response bodies that ignore abort, without retrying sends", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const api = new Telegram("123456:fixture");
  try {
    globalThis.fetch = (async () => {
      calls++;
      return { json: () => new Promise(() => {}) } as any;
    }) as any;
    await expect(api.call("sendRichMessage", { chat_id: 1 }, 20)).rejects.toThrow("delivery unknown");
    expect(calls).toBe(1);
    const pending = api.call("sendRichMessage", { chat_id: 1 }, 10000);
    api.close();
    await expect(pending).rejects.toThrow("delivery unknown");
    await expect(api.call("sendRichMessage", { chat_id: 1 })).rejects.toThrow("request was not sent");
    expect(calls).toBe(2);
  } finally { globalThis.fetch = original; api.close(); }
});
