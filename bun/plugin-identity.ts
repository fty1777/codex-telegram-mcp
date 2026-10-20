import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJSON, Store } from "./state";

export class PluginIdentityError extends Error {
  constructor() {
    super("Marketplace plugin identity unavailable. Run the installed plugin's bridge.js or pass --plugin-root with its installed directory. Keep the existing pairing; do not install a legacy manager.");
    this.name = "PluginIdentityError";
  }
}

export function marketplacePlugin(root: string) {
  try {
    root = realpathSync(resolve(root));
    const portable = existsSync(join(root, "plugin.json"));
    const manifest = readJSON(join(root, portable ? "plugin.json" : ".codex-plugin/plugin.json"));
    const mcp = readJSON(join(root, portable ? "mcp.json" : ".mcp.json")).mcpServers?.telegram;
    const launcher = portable
      ? mcp?.type === "stdio" && mcp?.cwd === "${PLUGIN_ROOT}" &&
        JSON.stringify(mcp.args) === JSON.stringify(["./bridge.js", "plugin", "--plugin-root", "."])
      : manifest.mcpServers === "./.mcp.json" &&
        JSON.stringify(mcp?.args) === JSON.stringify(["${PLUGIN_ROOT}/bridge.js", "plugin", "--plugin-root", "${PLUGIN_ROOT}"]);
    if (manifest.name !== "telegram" || mcp?.command !== "bun" || !launcher ||
        !existsSync(join(root, "bridge.js"))) throw new PluginIdentityError();
    return { id: "telegram@codex-telegram", root };
  } catch {
    throw new PluginIdentityError();
  }
}

export function rescuePlugin(store: Store, name: string, explicit: string | undefined, entryDirectory: string) {
  if (explicit) return marketplacePlugin(explicit);
  if (existsSync(join(entryDirectory, "plugin.json")) || existsSync(join(entryDirectory, ".codex-plugin/plugin.json")))
    return marketplacePlugin(entryDirectory);
  const configured = store.read(name).plugin;
  if (configured?.id === "telegram@codex-telegram")
    return marketplacePlugin(configured.root);
  if (existsSync(join(store.root, "manager-installation.json"))) return undefined;
  throw new PluginIdentityError();
}
