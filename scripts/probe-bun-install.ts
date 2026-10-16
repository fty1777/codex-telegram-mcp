import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, atomic } from "../bun/state";
import { install, uninstall } from "../bun/install";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = mkdtempSync(join(tmpdir(), "bridge-bun-install-")),
  s = new Store(root);
s.configure(
  "probe",
  "123456:fixture",
  { id: 123456, username: "fixture" },
  1,
  "fixture-no-session",
);
try {
  const result = await install(s, "probe", false);
  const receipt = JSON.parse(
    readFileSync(join(s.instance("probe"), "installation.json"), "utf8"),
  );
  const transport = new StdioClientTransport({
    command: join(receipt.runtime, "codex-telegram"),
    args: ["--data-dir", root, "mcp", "--instance", "probe"],
    stderr: "pipe",
  });
  const client = new Client({ name: "probe", version: "1" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  await uninstall(s, "probe", true);
  if (s.read("probe").enabled) throw Error("Retained instance not paused");
  await install(s, "probe", false);
  await uninstall(s, "probe");
  if (existsSync(s.instance("probe"))) throw Error("Instance not removed");
  atomic(join(root, "evidence.json"), {
    runtime: "bun",
    tools,
    install: true,
    keep_config: true,
    reinstall: true,
    full_uninstall: true,
  });
  console.log(join(root, "evidence.json"));
} catch (e) {
  try {
    await uninstall(s, "probe");
  } catch {}
  throw e;
}
