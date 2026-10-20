import { test, expect } from "bun:test";
import { Engine } from "../bun/engine";
import { AppServer } from "../bun/appserver";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("history pages use protocol cursors without requesting full thread history", async () => {
  const calls: any[] = [];
  const engine = Object.create(Engine.prototype) as Engine;
  Object.assign(engine, { thread: "test", client: { call: async (method: string, params: any) => {
    calls.push({ method, params });
    return params.cursor ? { data: [{ id: "second" }], nextCursor: null }
      : { data: [{ id: "first" }], nextCursor: "opaque" };
  } } });
  const pages = [];
  for await (const page of engine.turnPages("asc", "full")) pages.push(page);
  expect(pages.flat().map(t => t.id)).toEqual(["first", "second"]);
  expect(calls.map(c => c.method)).toEqual(["thread/turns/list", "thread/turns/list"]);
  expect(calls[1].params).toEqual({ threadId: "test", sortDirection: "asc", itemsView: "full", limit: 1, cursor: "opaque" });
});

test("history pagination stops before issuing another request after cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const engine = Object.create(Engine.prototype) as Engine;
  Object.assign(engine, { thread: "test", client: { call: async () => {
    calls++;
    return { data: [], nextCursor: "next" };
  } } });
  for await (const _ of engine.turnPages("asc", "full", controller.signal)) controller.abort();
  expect(calls).toBe(1);
});

test("WebSocket accepts valid JSON above the former 100 MiB history limit", async () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-large-rpc-"));
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", peer => peer.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (!message.id) return;
    peer.send(JSON.stringify({ id: message.id, result: message.method === "large"
      ? { text: "x".repeat(105 * 1024 * 1024) } : {} }));
  }));
  const socket = join(root, "rpc.sock");
  await new Promise<void>(resolve => server.listen(socket, resolve));
  let client: AppServer | undefined;
  try {
    client = await AppServer.connect("unix://" + socket, 30000);
    expect((await client.call("large", {})).text.length).toBe(105 * 1024 * 1024);
  } finally {
    client?.close();
    for (const peer of wss.clients) peer.terminate();
    wss.close();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("payload overflow preserves the failing RPC and transport error code", async () => {
  const root = mkdtempSync(join(tmpdir(), "telegram-overflow-rpc-"));
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", peer => peer.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.id) peer.send(JSON.stringify({ id: message.id, result: message.method === "oversized"
      ? { text: "x".repeat(2 * 1024 * 1024) } : {} }));
  }));
  const socket = join(root, "rpc.sock");
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const previous = process.env.CODEX_TELEGRAM_MAX_PAYLOAD_MIB;
  let client: AppServer | undefined;
  try {
    process.env.CODEX_TELEGRAM_MAX_PAYLOAD_MIB = "1";
    client = await AppServer.connect("unix://" + socket);
    await expect(client.call("oversized", {})).rejects.toThrow("oversized: WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
  } finally {
    if (previous === undefined) delete process.env.CODEX_TELEGRAM_MAX_PAYLOAD_MIB;
    else process.env.CODEX_TELEGRAM_MAX_PAYLOAD_MIB = previous;
    client?.close();
    for (const peer of wss.clients) peer.terminate();
    wss.close(); server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("active attachment reads recent metadata and becomes ready only after that succeeds", async () => {
  const engine = Object.create(Engine.prototype) as Engine;
  const methods: string[] = [];
  let rejectPage = true;
  Object.assign(engine, {
    thread: "test", status: "active", config: {}, usageAttached: true,
    recordModel() {}, journal: { put() {}, get(_key: string, fallback: any) { return fallback; } },
    client: {
      resume: async () => ({ thread: { status: { type: "active" }, turns: [] } }),
      call: async (method: string, params: any) => {
        methods.push(method);
        if (method === "thread/goal/get") return { goal: null };
        expect(engine.status).toBe("connecting");
        expect(params.itemsView).toBe("notLoaded");
        if (rejectPage) throw Error("page failed");
        return { data: [{ id: "live", status: "inProgress", items: [] }] };
      },
    },
  });
  await expect(engine.attach()).rejects.toThrow("page failed");
  expect(engine.status).toBe("connecting");
  rejectPage = false;
  await engine.attach();
  expect(engine.status).toBe("active");
  expect(engine.activeTurn).toBe("live");
  expect(methods).not.toContain("thread/read");
});
