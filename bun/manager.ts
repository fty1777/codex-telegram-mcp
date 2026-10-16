import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store, atomic } from "./state";
import { callingSession, listBots, changeBinding } from "./management";
import {
  beginPairing,
  pollPairing,
  pairingStatus,
  completePairing,
  cancelPairing,
} from "./pairing";
import { install, uninstall } from "./install";
import { start, lock } from "./process";
import { join } from "node:path";

/** Codex owns this stdio process and its short-lived pairing pollers.
 * Credentials never appear in the MCP manifest. */
export function managementServer(
  store: Store,
  services: {
    install: (s: Store, n: string) => Promise<any>;
    uninstall: (s: Store, n: string) => Promise<any>;
    start?: (s: Store, n: string) => Promise<any>;
  } = { install, uninstall },
) {
  const server = new McpServer(
    { name: "codex-telegram-manager", version: "0.3.0" },
    {
      instructions:
        "Manage Telegram bots and send messages from this Codex session. Use send_text for progress, and send_photo/send_document for attachments. Find the allowed outgoing_directory using list_bots. Reuse request_id for retries and inspect unknown receipts; never include an already sent path in the final reply. Public commentary and final replies are automatically forwarded. BotFather creates bots; add_bot connects an existing token. Ask the user to privately send /start to the bot, then paste its pairing code here. Redeem that code with confirm_pairing; no extra identity confirmation is needed. Never echo a token. Binding always targets the calling session. Inspect list_bots before changing bindings. Pending messages from the previous session are held, not replayed. Do not claim connection when installation returns awaiting-session-reload. No Telegram /bind is provided.",
    },
  );
  const watching = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  let closed = false;
  const close = server.close.bind(server);
  const stopAll = () => {
    closed = true;
    for (const task of watching.values()) task.controller.abort();
  };
  server.close = async () => {
    stopAll();
    await Promise.all([...watching.values()].map((t) => t.done));
    await close();
  };
  server.server.onclose = stopAll;
  async function stopWatching(name: string) {
    const task = watching.get(name);
    task?.controller.abort();
    await task?.done;
  }
  function watch(name: string, session: string) {
    if (closed || watching.has(name)) return;
    const controller = new AbortController();
    const done = (async () => {
      try {
        while (!controller.signal.aborted) {
          try {
            const result = await pollPairing(
              store,
              name,
              session,
              undefined,
              controller.signal,
            );
            if (["closed", "stopped"].includes(result.status)) break;
          } catch (error) {
            if (/expired|ENOENT|another session/.test(String(error))) break;
          }
          if (!controller.signal.aborted) await Bun.sleep(1000);
        }
      } finally {
        watching.delete(name);
      }
    })();
    watching.set(name, { controller, done });
  }
  const result = (value: any) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  const instance = { instance: z.string().min(1).max(64) };
  server.tool(
    "list_bots",
    "List bots, bindings and receiver status without credentials.",
    {},
    async (_args, extra) => {
      callingSession(extra._meta);
      return result({ bots: listBots(store) });
    },
  );
  server.tool(
    "add_bot",
    "Connect an existing BotFather token and open a short private pairing window. Does not create a Telegram bot. Repeating the same request resumes pairing.",
    {
      ...instance,
      token: z.string().min(1),
    },
    async (args, extra) => {
      const session = callingSession(extra._meta);
      const started = await beginPairing(
        store,
        args.instance,
        args.token,
        session,
      );
      watch(args.instance, session);
      return result(started);
    },
  );
  server.tool(
    "check_pairing",
    "Check pairing progress. Ask the user for the code received from the bot.",
    instance,
    async (args, extra) => {
      const session = callingSession(extra._meta);
      const state = pairingStatus(store, args.instance, session);
      watch(args.instance, session);
      return result(state);
    },
  );
  server.tool(
    "confirm_pairing",
    "Redeem the code supplied by the user in this initiating session and start the receiver.",
    {
      ...instance,
      code: z.string().min(1).max(64),
    },
    async (args, extra) => {
      const completed = await completePairing(
        store,
        args.instance,
        callingSession(extra._meta),
        args.code,
        async () => {
          await stopWatching(args.instance);
          return services.install(store, args.instance);
        },
      );
      const { connection: installation, ...configured } = completed;
      return result({ ...configured, installation });
    },
  );
  server.tool(
    "cancel_pairing",
    "Cancel this session's pending pairing and delete its saved credential.",
    instance,
    async (args, extra) => {
      const cancelled = cancelPairing(
        store,
        args.instance,
        callingSession(extra._meta),
      );
      await stopWatching(args.instance);
      return result(cancelled);
    },
  );
  server.tool(
    "bind_bot",
    "Bind an existing bot to this session. Inspect list_bots first. Preserves pause unless activate is true. Holds old pending messages.",
    {
      ...instance,
      expected_session: z.string().nullable(),
      activate: z.boolean().optional(),
    },
    async (args, extra) => {
      const changed = await changeBinding(
        store,
        args.instance,
        callingSession(extra._meta),
        args.expected_session,
        args.activate,
      );
      return result({
        ...changed,
        connection: changed.enabled
          ? await (services.start ?? start)(store, args.instance)
          : { status: "paused" },
      });
    },
  );
  server.tool(
    "unbind_bot",
    "Stop receiving and unbind, retaining credentials and paired user. Inspect list_bots first.",
    {
      ...instance,
      expected_session: z.string().nullable(),
    },
    async (args, extra) => {
      callingSession(extra._meta);
      return result(
        await changeBinding(store, args.instance, null, args.expected_session),
      );
    },
  );
  server.tool(
    "remove_bot",
    "Remove local instance, credentials and history. Does not delete the Telegram bot. Inspect list_bots and obtain user intent to remove first.",
    {
      ...instance,
      expected_session: z.string().nullable(),
      confirm: z.literal("REMOVE_BOT"),
    },
    async (args, extra) => {
      callingSession(extra._meta);
      await changeBinding(store, args.instance, null, args.expected_session);
      const release = lock(
        join(store.instance(args.instance), "management.lock"),
      );
      try {
        const current = store.read(args.instance);
        if (current.thread_id || current.enabled || current.binding_change)
          throw Error(
            "Binding changed during removal; inspect list_bots before retrying",
          );
        atomic(join(store.instance(args.instance), "config.json"), {
          ...current,
          removing: true,
        });
      } finally {
        release();
      }
      return result(await services.uninstall(store, args.instance));
    },
  );
  return server;
}
export async function manager(store: Store) {
  const server = managementServer(store);
  await server.connect(new StdioServerTransport());
}
