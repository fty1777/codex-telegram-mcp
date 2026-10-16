import { join } from "node:path";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { Store, atomic, hash } from "./state";
import { codex, prepareRuntime, refresh, collect } from "./install";
import { AppServer } from "./appserver";
import { controlMcp } from "./lifecycle";
import { record, lock, status, sleep } from "./process";

export async function installManager(
  store: Store,
  runner = codex,
  adopt?: {
    marketplace: string;
    plugin_id: string;
    mcp_server: string;
    version?: string;
  },
  retainSessions = runner === codex,
) {
  let client: AppServer | undefined;
  const retained: string[] = [];
  try {
    if (retainSessions) {
      const candidates = store
        .list()
        .filter((c) => c.shared_mcp && c.thread_id && c.enabled && c.autostart);
      if (candidates.length) client = await AppServer.connect();
      for (const config of candidates) {
        const { thread } = await client!.call("thread/read", {
          threadId: config.thread_id,
          includeTurns: false,
        });
        if (thread.status?.type === "notLoaded") continue;
        // Hold an existing loaded session while its MCP process is replaced. Otherwise
        // a receiver that is its last subscriber can unload it during an upgrade.
        await client!.resume(config.thread_id);
        retained.push(config.name);
      }
    }
    const installed = await installManagerFiles(store, runner, adopt);
    if (retained.length) await refresh();
    for (const name of retained) {
      const config = store.read(name);
      if (!config.enabled || !config.autostart) continue;
      const connected = await controlMcp(config, "connect", true);
      if (connected?.isError || connected?.status?.startsWith("awaiting-"))
        throw Error(
          "Plugin installed but receiver reconnect needs attention: " + name,
        );
      for (let i = 0; i < 200; i++) {
        const report = status(store, name);
        if (
          report.process &&
          report.health?.pid === report.process.pid &&
          report.health?.telegram?.status === "connected"
        )
          break;
        if (i === 199)
          throw Error(
            "Plugin installed but receiver health not confirmed: " + name,
          );
        await sleep(100);
      }
    }
    return installed;
  } finally {
    client?.close();
  }
}

async function installManagerFiles(
  store: Store,
  runner = codex,
  adopt?: {
    marketplace: string;
    plugin_id: string;
    mcp_server: string;
    version?: string;
  },
) {
  const { runtime, digest } = await prepareRuntime(store);
  const previous =
    adopt ?? record(join(store.root, "manager-installation.json"));
  const selector =
    previous?.marketplace ?? "telegram-" + hash(store.root).slice(0, 12);
  if (!/^[a-zA-Z0-9_-]+$/.test(selector)) throw Error("Invalid plugin name");
  const id = selector + "@" + selector;
  const serverName = previous?.mcp_server ?? "telegram";
  if (!/^[a-zA-Z0-9_-]+$/.test(serverName))
    throw Error("Invalid MCP server name");
  const source = join(store.root, "plugins", selector);
  const plugin = join(source, "plugins", selector);
  const version = "0.4.0+" + digest.slice(0, 12);
  if (previous && previous.plugin_id !== id)
    throw Error("Manager installation belongs to another root");
  if (
    previous?.version !== version &&
    (await runner("list")).installed?.some(
      (r: any) => r.pluginId === id && r.installed,
    )
  )
    await runner("remove", id);
  atomic(join(plugin, ".codex-plugin/plugin.json"), {
    name: selector,
    version,
    description: "Manage Telegram bots from Codex sessions",
    mcpServers: "./.mcp.json",
  });
  atomic(join(plugin, ".mcp.json"), {
    mcpServers: {
      [serverName]: {
        command: process.execPath,
        args: [join(runtime, "bridge.js"), "--data-dir", store.root, "channel"],
      },
    },
  });
  atomic(join(source, ".agents/plugins/marketplace.json"), {
    name: selector,
    plugins: [
      {
        name: selector,
        source: { source: "local", path: "./plugins/" + selector },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  });
  // Pin the runtime before installation so instance cleanup cannot collect it.
  atomic(join(store.root, "manager-installation.json"), {
    plugin_id: id,
    marketplace: selector,
    source,
    runtime,
    version,
    mcp_server: serverName,
    phase: "installing",
  });
  await runner("marketplace", "add", source);
  const added = await runner("add", id);
  atomic(join(store.root, "manager-installation.json"), {
    plugin_id: id,
    marketplace: selector,
    source,
    runtime,
    version,
    mcp_server: serverName,
    phase: "installed",
    installed_path: added.installedPath,
  });
  for (const config of store.list().filter((c) => c.shared_mcp)) {
    const release = lock(join(store.instance(config.name), "management.lock"));
    try {
      atomic(join(store.instance(config.name), "config.json"), {
        ...store.read(config.name),
        mcp_server: serverName,
        plugin: { id, root: added.installedPath },
      });
    } finally {
      release();
    }
  }
  return {
    status: "installed",
    plugin_id: id,
    version,
    warning: runner === codex ? await refresh() : null,
    detail:
      "Use telegram tools in Codex. An already open session may need reloading to load a newly installed MCP server.",
  };
}
export async function uninstallManager(store: Store, runner = codex) {
  const path = join(store.root, "manager-installation.json"),
    receipt = record(path);
  if (!receipt) return { status: "absent" };
  if (
    receipt.source !== join(store.root, "plugins", receipt.marketplace) ||
    (existsSync(receipt.source) && lstatSync(receipt.source).isSymbolicLink())
  )
    throw Error("Unowned manager source");
  if (
    (await runner("list")).installed?.some(
      (r: any) => r.pluginId === receipt.plugin_id && r.installed,
    )
  )
    await runner("remove", receipt.plugin_id);
  if (
    (await runner("marketplace", "list")).marketplaces?.some(
      (r: any) => r.name === receipt.marketplace,
    )
  )
    await runner("marketplace", "remove", receipt.marketplace);
  rmSync(receipt.source, { recursive: true, force: true });
  rmSync(path, { force: true });
  collect(store);
  return {
    status: "uninstalled",
    bots: "retained",
    warning: runner === codex ? await refresh() : null,
  };
}
