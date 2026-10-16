// Isolated marketplace install and MCP startup. No Codex sessions, credentials,
// pairing, or Telegram requests are created. Does not change the active install.
import { mkdtempSync, cpSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = resolve(import.meta.dir, "..");
const temporary = mkdtempSync(join(tmpdir(), "telegram-marketplace-"));
const marketplace = join(temporary, "catalog"), codexHome = join(temporary, "codex");
mkdirSync(codexHome);
mkdirSync(join(marketplace, ".agents/plugins"), { recursive: true });
cpSync(join(repo, ".agents/plugins/marketplace.json"), join(marketplace, ".agents/plugins/marketplace.json"));
// Copy only the distributable package. No checkout or node_modules is available.
cpSync(join(repo, "plugins"), join(marketplace, "plugins"), { recursive: true });
const environment = { ...process.env, CODEX_HOME: codexHome };
async function codex(...args: string[]) {
  const child = Bun.spawn(["codex", "plugin", ...args, "--json"], { env: environment, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 30000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw Error(`Isolated plugin command failed: ${err || out}`);
    return JSON.parse(out);
  } finally { clearTimeout(timer); }
}
let client: Client | undefined;
try {
  await codex("marketplace", "add", marketplace);
  const installed = await codex("add", "telegram@codex-telegram");
  const root = installed.installedPath;
  if (!root || !existsSync(join(root, "bridge.js"))) throw Error("Plugin runtime was not installed");
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.telegram;
  if (mcp.command !== "bun") throw Error("Expected portable Bun launcher");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...mcp.args.map((arg: string) => arg.replaceAll("${PLUGIN_ROOT}", root)), "--data-dir", join(temporary, "state")],
    env: Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stderr: "pipe",
  });
  client = new Client({ name: "marketplace-probe", version: "1" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["add_bot", "confirm_pairing", "connect", "send_text", "delivery_status"])
    if (!tools.includes(name)) throw Error(`Missing tool: ${name}`);
  const result = await client.callTool({ name: "list_bots", arguments: {}, _meta: { threadId: "isolated-probe" } });
  if (result.isError || !JSON.stringify(result.content).includes('bots')) throw Error("Fresh plugin discovery failed");
  if (existsSync(join(temporary, "state/manager-installation.json"))) throw Error("Unexpected legacy install dependency");
  let closed = false;
  client.onclose = () => { closed = true; };
  await codex("remove", "telegram@codex-telegram");
  for (let attempt = 0; attempt < 80 && !closed; attempt++) await Bun.sleep(100);
  if (!closed) throw Error("Removed plugin did not stop its MCP host");
  console.log(JSON.stringify({ installation: "verified", tool_loading: "verified", removal_shutdown: "verified", pairing: "not_run", telegram_delivery: "not_run" }));
} finally {
  await client?.close();
  rmSync(temporary, { recursive: true, force: true });
}
