import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  renameSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { atomic, hash, readJSON, Store, privateDir } from "./state";
import { pause, start, record } from "./process";
import { AppServer } from "./appserver";
import { diagnostic } from "./engine";
export async function codex(...args: string[]) {
  const child = Bun.spawn(["codex", "plugin", ...args, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 45000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code)
      throw Error(
        `Codex plugin ${args[0] ?? "command"} ${timedOut ? "timed out after 45s" : `exited with status ${code}`}. ` +
          diagnostic(
            err ||
              out ||
              "No diagnostic output. Check codex --version and shared App Server connectivity; retry this command before reinstalling.",
          ),
      );
    return JSON.parse(out);
  } finally {
    clearTimeout(timer);
  }
}
export async function refresh() {
  let c: AppServer | undefined;
  try {
    c = await AppServer.connect();
    await c.call("config/mcpServer/reload", null);
    return null;
  } catch (e) {
    return "Live MCP refresh needs retry: " + diagnostic(String(e));
  } finally {
    c?.close();
  }
}
export function bindRuntime(s: Store, n: string, runtime: string) {
  if (
    dirname(runtime) !== join(s.root, "runtimes") ||
    lstatSync(runtime).isSymbolicLink()
  )
    throw Error("Invalid runtime");
  const path = join(s.instance(n), "runtime");
  if (existsSync(path) && !lstatSync(path).isSymbolicLink())
    throw Error("Runtime path is not owned");
  const tmp = join(s.instance(n), ".runtime-link");
  rmSync(tmp, { force: true });
  symlinkSync(runtime, tmp, "dir");
  renameSync(tmp, path);
  return join(path, "codex-telegram");
}
export async function prepareRuntime(s: Store) {
  let sourceJS: string;
  if (import.meta.path.endsWith("bridge.js"))
    sourceJS = readFileSync(import.meta.path, "utf8");
  else {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "cli.ts")],
      target: "bun",
      minify: false,
    });
    if (!built.success) throw Error(String(built.logs));
    sourceJS = await built.outputs[0].text();
  }
  const digest = hash(sourceJS).slice(0, 16),
    runtime = join(s.root, "runtimes", "bun-" + digest);
  privateDir(runtime);
  writeFileSync(join(runtime, "bridge.js"), sourceJS, { mode: 0o600 });
  const quote = (v: string) => "'" + v.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    join(runtime, "codex-telegram"),
    "#!/bin/sh\nexec " +
      quote(process.execPath) +
      " " +
      quote(join(runtime, "bridge.js")) +
      ' "$@"\n',
    { mode: 0o700 },
  );
  atomic(join(runtime, "bridge-runtime.json"), {
    schema: 1,
    digest: "bun-" + digest,
  });
  return { runtime, digest };
}
export async function install(
  s: Store,
  n: string,
  launch = true,
  runner = codex,
) {
  const path = s.instance(n);
  const original = s.read(n);
  if (original.telegram_api?.mode === "local")
    throw Error("Local API migration deferred. Existing runtime retained.");
  const { runtime, digest } = await prepareRuntime(s);
  const selector = "telegram-" + hash(s.root + "\0" + n).slice(0, 12),
    id = selector + "@" + selector,
    source = join(s.root, "plugins", selector),
    plugin = join(source, "plugins", selector),
    version = "0.3.0+" + digest.slice(0, 12);
  const old = record(join(path, "installation.json"));
  if (old && old.plugin_id !== id)
    throw Error("Existing installation belongs to another root");
  if (old && old.version !== version) {
    const files: any = {};
    for (const rel of [
      ".codex-plugin/plugin.json",
      ".mcp.json",
      "hooks/hooks.json",
    ]) {
      const file = join(old.installed_path ?? plugin, rel);
      if (existsSync(file)) files[rel] = readJSON(file);
    }
    atomic(join(path, "previous-installation.json"), {
      config: original,
      receipt: old,
      plugin_files: files,
    });
    await pause(s, n);
    const rows = (await runner("list")).installed ?? [];
    if (rows.some((r: any) => r.pluginId === id && r.installed))
      await runner("remove", id);
  }
  const config = {
    ...s.read(n),
    autostart: launch,
    lifecycle: "mcp",
    mcp_server: "telegram_" + n + "_" + selector.slice(-6),
  };
  atomic(join(path, "config.json"), config);
  bindRuntime(s, n, runtime);
  rmSync(join(plugin, "hooks"), { recursive: true, force: true });
  atomic(join(plugin, ".codex-plugin/plugin.json"), {
    name: selector,
    version,
    description: "Telegram channel: " + n,
    mcpServers: "./.mcp.json",
  });
  atomic(join(plugin, ".mcp.json"), {
    mcpServers: {
      ["telegram_" + n + "_" + selector.slice(-6)]: {
        command: process.execPath,
        args: [
          join(runtime, "bridge.js"),
          "--data-dir",
          s.root,
          "mcp",
          "--instance",
          n,
        ],
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
  const receipt: any = {
    plugin_id: id,
    marketplace: selector,
    source,
    runtime,
    version,
    phase: "installing",
    implementation: "bun",
  };
  atomic(join(path, "installation.json"), receipt);
  await runner("marketplace", "add", source);
  const added = await runner("add", id);
  atomic(join(path, "config.json"), {
    ...s.read(n),
    plugin: { id, root: added.installedPath },
  });
  receipt.installed_path = added.installedPath;
  receipt.phase = "installed";
  atomic(join(path, "installation.json"), receipt);
  const warning = runner === codex ? await refresh() : null;
  const result = launch ? await start(s, n, true) : { status: "installed" };
  return {
    ...result,
    version,
    runtime: "bun",
    warning,
    lifecycle: "mcp",
    session_hooks: "Not required; Codex owns the MCP process.",
  };
}
export async function uninstall(
  s: Store,
  n: string,
  keep = false,
  runner = codex,
) {
  const p = s.instance(n);
  if (s.read(n).shared_mcp) {
    await pause(s, n);
    if (!keep) rmSync(p, { recursive: true });
    collect(s);
    return {
      status: "uninstalled",
      configuration: keep ? "retained" : "removed",
      warning: null,
    };
  }
  if (s.read(n).telegram_api?.mode === "local")
    throw Error("Use existing local API runtime to log out before uninstall");
  await pause(s, n);
  const receipt = record(join(p, "installation.json"));
  if (receipt) {
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
    if (
      receipt.source !== join(s.root, "plugins", receipt.marketplace) ||
      lstatSync(receipt.source).isSymbolicLink()
    )
      throw Error("Unowned plugin source");
    rmSync(receipt.source, { recursive: true, force: true });
    rmSync(join(p, "installation.json"), { force: true });
  }
  rmSync(join(p, "previous-installation.json"), { force: true });
  if (
    existsSync(join(p, "runtime")) &&
    lstatSync(join(p, "runtime")).isSymbolicLink()
  )
    rmSync(join(p, "runtime"));
  if (!keep) rmSync(p, { recursive: true });
  collect(s);
  return {
    status: "uninstalled",
    configuration: keep ? "retained" : "removed",
    warning: runner === codex ? await refresh() : null,
  };
}
export function collect(s: Store) {
  const used = new Set<string>();
  const manager = record(join(s.root, "manager-installation.json"));
  if (manager?.runtime) used.add(manager.runtime);
  for (const c of s.list()) {
    const p = s.instance(c.name);
    for (const filename of [
      "installation.json",
      "previous-installation.json",
    ]) {
      const r = record(join(p, filename));
      if (r) used.add((r.receipt ?? r).runtime);
    }
    if (c.telegram_api?.binary) used.add(dirname(c.telegram_api.binary));
  }
  const base = join(s.root, "runtimes");
  if (!existsSync(base)) return;
  for (const name of readdirSync(base)) {
    const path = join(base, name);
    if (lstatSync(path).isSymbolicLink()) continue;
    const marker = record(join(path, "bridge-runtime.json"));
    if (marker?.schema === 1 && marker.digest === name && !used.has(path))
      rmSync(path, { recursive: true });
  }
}
export async function rollback(s: Store, n: string, runner = codex) {
  const p = s.instance(n),
    saved = readJSON(join(p, "previous-installation.json")),
    old = saved.receipt;
  if (
    old.source !== join(s.root, "plugins", old.marketplace) ||
    !saved.plugin_files?.[".mcp.json"]
  )
    throw Error("Invalid rollback snapshot");
  await pause(s, n);
  if (
    (await runner("list")).installed?.some(
      (r: any) => r.pluginId === old.plugin_id && r.installed,
    )
  )
    await runner("remove", old.plugin_id);
  const plugin = join(old.source, "plugins", old.marketplace);
  rmSync(join(plugin, "hooks"), { recursive: true, force: true });
  for (const [rel, value] of Object.entries(saved.plugin_files)) {
    if (
      ![".codex-plugin/plugin.json", ".mcp.json", "hooks/hooks.json"].includes(
        rel,
      )
    )
      throw Error("Invalid rollback file");
    atomic(join(plugin, rel), value);
  }
  await runner("marketplace", "add", old.source);
  const added = await runner("add", old.plugin_id);
  atomic(join(p, "config.json"), {
    ...saved.config,
    plugin: { id: old.plugin_id, root: added.installedPath },
  });
  atomic(join(p, "installation.json"), {
    ...old,
    installed_path: added.installedPath,
  });
  bindRuntime(s, n, old.runtime);
  if (runner === codex) await refresh();
  if (saved.config.enabled) {
    const child = Bun.spawn(
      [
        join(old.runtime, "codex-telegram"),
        "--data-dir",
        s.root,
        "resume",
        "--instance",
        n,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(child.stdout).text();
    if (await child.exited) throw Error("Rollback restored; start needs retry");
    return JSON.parse(output);
  }
  return { status: "restored-paused" };
}
