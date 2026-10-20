import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { Store, atomic, readJSON } from "./state";
import { managementServer } from "./manager";
import { McpWorkerOwner, controlMcp } from "./lifecycle";
import { callingSession } from "./management";
import { runWorker, pluginEnabled } from "./worker";
import { diagnostic } from "./engine";
import { Sender } from "./telegram";
import { lock, live, stop } from "./process";

/** One Codex-owned MCP host per session, with independently owned bot workers. */
export class ChannelHost {
  private owners = new Map<string, McpWorkerOwner>();
  private senders = new Map<string, Sender>();
  private closed = false;
  constructor(
    readonly store: Store,
    private run = runWorker,
    private plugin?: SharedPlugin,
  ) {}
  private authorized(name: string, meta: unknown) {
    if (this.closed) throw Error("Channel is closing");
    const c = this.store.read(name);
    if (
      c.removing ||
      c.binding_change ||
      !c.thread_id ||
      callingSession(meta) !== c.thread_id
    )
      throw Error("This bot is not bound to the calling session");
    if (this.plugin && c.plugin?.id !== this.plugin.id)
      throw Error("This bot uses another installation; bind it through this plugin first");
    return c;
  }
  async connect(name: string, meta: unknown) {
    const c = this.authorized(name, meta);
    if (!c.enabled || !c.autostart) return { status: "paused" };
    let owner = this.owners.get(name);
    if (!owner) {
      owner = new McpWorkerOwner(c.thread_id, async (signal) => {
        const thread = this.store.read(name).thread_id;
        for (let attempt = 0; !signal.aborted; attempt++) {
          try {
            await this.run(this.store, name, signal);
            return;
          } catch (error) {
            if (signal.aborted) return;
            let current;
            try {
              current = this.store.read(name);
            } catch {
              return;
            }
            if (
              !current.enabled ||
              !current.autostart ||
              current.binding_change ||
              current.thread_id !== thread
            )
              return;
            const detail = diagnostic(String(error), this.store.token(name));
            console.error(detail);
            const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
            for (
              let elapsed = 0;
              elapsed < delay && !signal.aborted;
              elapsed += 100
            )
              await Bun.sleep(100);
          }
        }
      });
      this.owners.set(name, owner);
    }
    await owner.rebind(c.thread_id);
    this.authorized(name, meta);
    return owner.connect(meta);
  }
  async disconnect(name: string, meta: unknown) {
    this.authorized(name, meta);
    atomic(join(this.store.instance(name), "config.json"), {
      ...this.store.read(name),
      autostart: false,
    });
    const owner = this.owners.get(name);
    if (owner) await owner.disconnect(meta);
    return { status: "stopped" };
  }
  sender(name: string, meta: unknown) {
    this.authorized(name, meta);
    let sender = this.senders.get(name);
    if (!sender) {
      sender = new Sender(this.store, name);
      this.senders.set(name, sender);
    }
    return sender;
  }
  async forget(name: string) {
    await this.owners.get(name)?.close();
    this.owners.delete(name);
    const sender = this.senders.get(name);
    sender?.api.abort();
    sender?.journal.close();
    this.senders.delete(name);
  }
  async close() {
    this.closed = true;
    await Promise.all(
      [...new Set([...this.owners.keys(), ...this.senders.keys()])].map(
        (name) => this.forget(name),
      ),
    );
  }
}

export type SharedPlugin = { id: string; root: string };

/** Drain retired receivers before attaching the only supported lifecycle. */
export async function prepareSharedPlugin(store: Store, name: string, plugin?: SharedPlugin, activate = true) {
  const current = store.read(name);
  if (current.lifecycle !== "mcp" || live(join(store.instance(name), "process.json")))
    await stop(store, name);
  return attachSharedPlugin(store, name, plugin, activate);
}

export function attachSharedPlugin(
  store: Store,
  name: string,
  plugin?: SharedPlugin,
  activate = true,
) {
  const installed = plugin
    ? { phase: "installed", plugin_id: plugin.id, installed_path: plugin.root, mcp_server: "telegram" }
    : readJSON(join(store.root, "manager-installation.json"));
  if (installed.phase !== "installed")
    throw Error("Install the Telegram plugin first");
  const release = lock(join(store.instance(name), "management.lock"));
  try {
    const current = store.read(name);
    if (live(join(store.instance(name), "process.json")) ||
        (current.lifecycle !== "mcp" && live(join(store.instance(name), "worker-process.json"))))
      throw Error("Retired receiver is still active; migrate through the Telegram plugin before attaching.");
    if (current.removing || current.binding_change)
      throw Error("Bot binding is changing; inspect list_bots before retrying");
    const config = {
      ...current,
      lifecycle: "mcp",
      shared_mcp: true,
      mcp_server: installed.mcp_server ?? "telegram",
      autostart: activate ? true : current.autostart,
      plugin: { id: installed.plugin_id, root: installed.installed_path },
    };
    atomic(join(store.instance(name), "config.json"), config);
    return config;
  } finally {
    release();
  }
}

export function channelServer(store: Store, providedHost?: ChannelHost, plugin?: SharedPlugin) {
  const host = providedHost ?? new ChannelHost(store, runWorker, plugin);
  const server = managementServer(store, {
    install: async (_s, name) => {
      const config = await prepareSharedPlugin(store, name, plugin);
      return host.connect(name, { threadId: config.thread_id });
    },
    start: async (_s, name) => {
      if (plugin) await prepareSharedPlugin(store, name, plugin, false);
      return host.connect(name, { threadId: store.read(name).thread_id });
    },
    uninstall: async (_s, name) => {
      await host.forget(name);
      rmSync(store.instance(name), { recursive: true });
      return {
        status: "removed",
        configuration: "removed",
        plugin: "retained",
      };
    },
  });
  const receipt = (value: any) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  const instance = { instance: z.string().min(1).max(64) };
  const presentation = {
    format: z.enum(["markdown", "plain"]).optional(),
    phase: z.enum(["commentary", "final_answer"]).optional(),
  };
  const key = { ...instance, request_id: z.string().min(1).max(200) };
  server.tool(
    "connect",
    "Connect this session's bound bot receiver.",
    instance,
    async (args, extra) =>
      receipt(await host.connect(args.instance, extra._meta)),
  );
  server.tool(
    "disconnect",
    "Stop this bot receiver while keeping Codex and other bots running.",
    instance,
    async (args, extra) =>
      receipt(await host.disconnect(args.instance, extra._meta)),
  );
  server.tool(
    "send_text",
    "Send Markdown formatted text immediately. Use phase=commentary for progress and format=plain for literal text. Reuse request_id on retries; inspect unknown delivery before any new send.",
    {
      ...key,
      ...presentation,
      text: z.string(),
      reply_to: z.number().int().positive().optional(),
    },
    async (args, extra) =>
      receipt(
        await host.sender(args.instance, extra._meta).send(args.request_id, {
          ...args,
          source: args.phase === "commentary" ? "working" : undefined,
        }),
      ),
  );
  server.tool(
    "edit_message",
    "Edit a previously sent bot message.",
    {
      ...key,
      ...presentation,
      text: z.string(),
      message_id: z.number().int().positive(),
    },
    async (args, extra) =>
      receipt(
        await host.sender(args.instance, extra._meta).send(args.request_id, {
          text: args.text,
          edit_id: args.message_id,
          format: args.format,
          source: args.phase === "commentary" ? "working" : undefined,
        }),
      ),
  );
  for (const [tool, kind] of [
    ["send_photo", "photo"],
    ["send_document", "document"],
  ] as const)
    server.tool(
      tool,
      "Send a file from this bot's outgoing directory. Never repeat the sent path in a final reply.",
      {
        ...key,
        ...presentation,
        path: z.string(),
        caption: z.string().optional(),
      },
      async (args, extra) =>
        receipt(
          await host.sender(args.instance, extra._meta).send(args.request_id, {
            file: args.path,
            kind,
            caption: args.caption,
            format: args.format,
            source: args.phase === "commentary" ? "working" : undefined,
          }),
        ),
    );
  server.tool(
    "delivery_status",
    "Read a durable delivery receipt; unknown is not a rejection.",
    key,
    async (args, extra) =>
      receipt(
        host
          .sender(args.instance, extra._meta)
          .journal.status("out", args.request_id),
      ),
  );
  return { server, host };
}
export async function channel(store: Store, plugin?: SharedPlugin) {
  const { server, host } = channelServer(store, undefined, plugin);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(lease);
    await host.close();
    await server.close();
  };
  let failures = 0;
  const lease = setInterval(() => {
    try {
      const receipt = plugin
        ? { phase: "installed", plugin_id: plugin.id, installed_path: plugin.root }
        : readJSON(join(store.root, "manager-installation.json"));
      if (receipt.phase !== "installed") return;
      if (
        !pluginEnabled({
          plugin: { id: receipt.plugin_id, root: receipt.installed_path },
        })
      )
        void close();
      failures = 0;
    } catch {
      if (++failures >= 3) void close();
    }
  }, 2000);
  lease.unref();
  server.server.onclose = () => {
    void close();
  };
  process.once("SIGTERM", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
  server.server.oninitialized = () => {
    for (const c of store
      .list()
      .filter((c) => c.shared_mcp && c.thread_id && c.enabled && c.autostart && (!plugin || c.plugin?.id === plugin.id))) {
      // Marketplace updates move the installed files; retain pairing and session
      // ownership while updating only this plugin's cached location.
      try {
        if (plugin) attachSharedPlugin(store, c.name, plugin, false);
      } catch (error) {
        console.error("Connection pending:", diagnostic(String(error)));
        continue;
      }
      void controlMcp(c, "connect").catch((e) =>
        console.error("Connection pending:", String(e)),
      );
    }
  };
  await server.connect(new StdioServerTransport());
}
