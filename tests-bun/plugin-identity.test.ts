import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, atomic } from "../bun/state";
import { attachSharedPlugin } from "../bun/channel";
import { marketplacePlugin, rescuePlugin } from "../bun/plugin-identity";

test("rescue resolves marketplace packages without a legacy receipt and rejects invalid roots", () => {
  const temporary = mkdtempSync(join(tmpdir(), "telegram-rescue-plugin-"));
  const store = new Store(join(temporary, "state"));
  const root = join(temporary, "plugin");
  mkdirSync(join(root, ".codex-plugin"), { recursive: true });
  atomic(join(root, ".codex-plugin/plugin.json"), { name: "codex-telegram-mcp", mcpServers: "./.mcp.json" });
  atomic(join(root, ".mcp.json"), { mcpServers: { telegram: { command: "bun", args: ["${PLUGIN_ROOT}/bridge.js", "plugin", "--plugin-root", "${PLUGIN_ROOT}"] } } });
  writeFileSync(join(root, "bridge.js"), "// fixture");
  store.configure("sample", "123456:fixture", { id: 123456, username: "fixture" }, 42, "session");
  try {
    const plugin = { id: "codex-telegram-mcp@fty1777", root };
    expect(rescuePlugin(store, "sample", root, "/not-installed")).toEqual(plugin);
    expect(rescuePlugin(store, "sample", undefined, root)).toEqual(plugin);
    expect(() => rescuePlugin(store, "sample", undefined, "/not-installed")).toThrow("--plugin-root");
    attachSharedPlugin(store, "sample", rescuePlugin(store, "sample", root, "/not-installed"));
    expect(store.read("sample").plugin).toEqual(plugin);
    expect(store.read("sample").thread_id).toBe("session");
    expect(store.read("sample").owner_id).toBe(42);
    expect(rescuePlugin(store, "sample", undefined, "/not-installed")).toEqual(plugin);
    atomic(join(root, ".codex-plugin/plugin.json"), { name: "other", mcpServers: "./.mcp.json" });
    expect(() => marketplacePlugin(root)).toThrow("Marketplace plugin identity unavailable");
    expect(() => rescuePlugin(store, "sample", root, root)).toThrow("Marketplace plugin identity unavailable");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test.each(["source", "bundle"])("%s rescue CLI attaches marketplace identity when MCP tools are not loaded", async (mode) => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { createHash } = await import("node:crypto");
  const { readFileSync, copyFileSync } = await import("node:fs");
  const temporary = mkdtempSync(join(tmpdir(), "telegram-rescue-cli-"));
  const root = join(temporary, "plugin");
  const state = join(temporary, "state");
  const socket = join(temporary, "rpc.sock");
  const store = new Store(state);
  const server = createServer();
  const ws = new WebSocketServer({ server });
  ws.on("connection", (peer) => peer.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.id === undefined) return;
    const response = m.method === "mcpServer/tool/call"
      ? { error: { code: -32600, message: "unknown MCP server telegram" } }
      : { result: m.method === "thread/read" ? { thread: { id: "fixture-session", status: { type: "idle" } } } : {} };
    peer.send(JSON.stringify({ id: m.id, ...response }));
  }));
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    mkdirSync(join(root, ".codex-plugin"), { recursive: true });
    for (const file of [".codex-plugin/plugin.json", "plugin.json", "mcp.json"])
      copyFileSync(join(import.meta.dir, "../plugins/telegram", file), join(root, file));
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, "../bun/cli.ts")], target: "bun", minify: true });
    expect(build.success).toBe(true);
    writeFileSync(join(root, "bridge.js"), await build.outputs[0].text());
    const code = "ABCDEF123456";
    atomic(join(state, "pairings/sample.json"), {
      name: "sample", token: "123456:fixture", session: "fixture-session", endpoint: "unix://" + socket,
      bot: { id: 123456, username: "fixture_bot" }, protocol: 2, window_id: "fixture-window",
      opened_at: Date.now(), expires_at: Date.now() + 60000, failed_attempts: 0,
      candidates: [{ user_id: 42, code_hash: createHash("sha256").update(code).digest("hex") }], offset: 2,
    });
    const preload = join(temporary, "network-stub.ts");
    const wire = join(temporary, "wire.json");
    writeFileSync(preload, `import {writeFileSync} from "node:fs";globalThis.fetch=async(input,init)=>{if(!String(input).endsWith("/sendRichMessage"))throw Error("Unexpected network request");writeFileSync(${JSON.stringify(wire)},String(init.body));return Response.json({ok:true,result:{message_id:1,chat:{id:42}}});};`);
    const entry = mode === "bundle" ? join(root, "bridge.js") : join(import.meta.dir, "../bun/cli.ts");
    const args = [process.execPath, "--preload", preload, entry, "pair-confirm", "sample", "--data-dir", state, "--session", "fixture-session", "--code", code];
    if (mode === "source") args.push("--plugin-root", root);
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).toBe("");
    expect(exit).toBe(0);
    const result = JSON.parse(out);
    expect(result.status).toBe("configured");
    expect(result.connection.status).toBe("mcp-unavailable");
    expect(result.notification.status).toBe("sent");
    expect(store.read("sample").plugin).toEqual({ id: "codex-telegram-mcp@fty1777", root });
    expect(store.read("sample").owner_id).toBe(42);
    expect(readFileSync(wire, "utf8")).toContain("The receiver is not ready");
    expect(readFileSync(wire, "utf8")).toContain("do not pair again");
    expect(() => readFileSync(join(state, "manager-installation.json"))).toThrow();
  } finally {
    for (const peer of ws.clients) peer.terminate();
    ws.close(); server.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}, 15000);
