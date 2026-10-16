import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, readJSON, atomic } from "../bun/state";
import { installManager, uninstallManager } from "../bun/manager-install";
import { collect } from "../bun/install";

test("manager installs without any bot and pins its runtime through bot cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-manager-install-")),
    s = new Store(root);
  const installed = new Set<string>(),
    marketplaces = new Set<string>();
  const runner = async (...args: string[]): Promise<any> => {
    if (args[0] === "list")
      return {
        installed: [...installed].map((pluginId) => ({
          pluginId,
          installed: true,
        })),
      };
    if (args[0] === "add") {
      installed.add(args[1]!);
      return { installedPath: "/fixture/plugin" };
    }
    if (args[0] === "remove") {
      installed.delete(args[1]!);
      return {};
    }
    if (args[1] === "list")
      return { marketplaces: [...marketplaces].map((name) => ({ name })) };
    if (args[1] === "add")
      marketplaces.add(
        readJSON(join(args[2]!, ".agents/plugins/marketplace.json")).name,
      );
    if (args[1] === "remove") marketplaces.delete(args[2]!);
    return {};
  };
  try {
    const result = await installManager(s, runner);
    expect(result.status).toBe("installed");
    expect(s.list()).toEqual([]);
    const receipt = readJSON(join(root, "manager-installation.json"));
    const manifest = readJSON(
      join(receipt.source, "plugins", receipt.marketplace, ".mcp.json"),
    );
    expect(manifest.mcpServers.telegram.args.at(-1)).toBe("channel");
    expect(
      existsSync(join(receipt.source, "plugins", receipt.marketplace, "hooks")),
    ).toBe(false);
    collect(s);
    expect(existsSync(receipt.runtime)).toBe(true);
    s.configure(
      "sample",
      "123456:fixture",
      { id: 123456, username: "fixture" },
      42,
      "session",
    );
    atomic(join(s.instance("sample"), "config.json"), {
      ...s.read("sample"),
      shared_mcp: true,
      mcp_server: "stale_server",
    });
    await installManager(s, runner);
    expect(s.read("sample").mcp_server).toBe("telegram");
    expect(s.read("sample").plugin.id).toBe(receipt.plugin_id);

    await uninstallManager(s, runner);
    expect(installed.size).toBe(0);
    expect(marketplaces.size).toBe(0);
    expect(existsSync(receipt.runtime)).toBe(false);
    expect((await uninstallManager(s, runner)).status).toBe("absent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
