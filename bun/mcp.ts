import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store, atomic } from "./state";
import { join } from "node:path";
import { Sender } from "./telegram";
import { pluginEnabled, runWorker, healthyReceiverHandoff } from "./worker";
import { controlMcp, McpWorkerOwner } from "./lifecycle";
import { diagnostic } from "./engine";
import { callingSession, listBots, changeBinding } from "./management";
export async function mcp(store: Store, name: string) {
  const sender = new Sender(store, name),
    c = store.read(name);
  const server = new McpServer(
    { name: "codex-telegram-" + name, version: "0.2.0" },
    {
      instructions: `This server sends through instance ${name}, bot @${c.username}, with a managed session binding (use list_bots to inspect it). Use send_text for meaningful progress or blockers. Public commentary and final answers are also forwarded; do not repeat an already sent message. Reuse request_id on retries. Unknown delivery must be checked, never blindly resent. Copy files into ${sender.path}/outgoing before sending. Do not put sent file paths in final replies. Tools are bound to this instance owner.`,
    },
  );
  const receipt = (r: any) => ({
    content: [{ type: "text" as const, text: JSON.stringify(r) }],
  });
  const presentation = {
    format: z.enum(["markdown", "plain"]).optional(),
    phase: z.enum(["commentary", "final_answer"]).optional(),
  };
  const key = { request_id: z.string().min(1).max(200) };
  server.tool(
    "list_bots",
    "List locally configured bots and their session bindings, running state, and pending/held message counts. Never returns tokens or message contents.",
    {},
    async (_args, extra) => {
      callingSession(extra._meta);
      return receipt({ bots: listBots(store) });
    },
  );
  const owner = new McpWorkerOwner(c.thread_id, async (signal) => {
    const runId = Date.now();
    let notified = false;
    for (let attempt = 0; !signal.aborted; attempt++) {
      try {
        await runWorker(store, name, signal);
        return; // Normal shutdown (archive, pause, conflicting poller) stays stopped.
      } catch (e) {
        if (signal.aborted) return;
        const error = diagnostic(String(e), store.token(name));
        console.error(error);
        if (!notified && !healthyReceiverHandoff(store, name, e)) {
          notified = true;
          await sender
            .send("mcp-worker-failure-" + runId, {
              source: "system",
              text: "Your Telegram connection was interrupted. Reconnecting automatically; no action is needed right now.",
            })
            .catch(() => {});
        }
        const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
        for (
          let elapsed = 0;
          elapsed < delay && !signal.aborted;
          elapsed += 100
        )
          await Bun.sleep(100);
        const current = store.read(name);
        if (!current.enabled || !current.autostart || !pluginEnabled(current))
          return;
      }
    }
  });
  let bindingOperation = Promise.resolve();
  const inBinding = <T>(work: () => Promise<T>) => {
    const pending = bindingOperation.then(work);
    bindingOperation = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
  const authorizeCurrent = async (meta: unknown) => {
    const current = store.read(name);
    if (
      current.removing ||
      current.binding_change ||
      !current.thread_id ||
      callingSession(meta) !== current.thread_id
    )
      throw Error("This bot is not bound to the calling session");
    await owner.rebind(current.thread_id);
    const latest = store.read(name);
    if (
      latest.removing ||
      latest.binding_change ||
      latest.thread_id !== current.thread_id ||
      latest.binding_revision !== current.binding_revision
    )
      throw Error(
        "Binding changed during authorization; retry after inspecting list_bots",
      );
    owner.authorize(meta);
  };
  server.tool(
    "bind_bot",
    "Bind this existing bot to the calling Codex session. Old pending messages are held, never transferred. Inspect list_bots first. Paused state is preserved unless activate is explicitly true.",
    {
      expected_session: z.string().nullable(),
      activate: z.boolean().optional(),
    },
    async (args, extra) =>
      inBinding(async () => {
        const target = callingSession(extra._meta);
        const result = await changeBinding(
          store,
          name,
          target,
          args.expected_session,
          args.activate,
        );
        await owner.rebind(target);
        const connection = store.read(name).enabled
          ? owner.connect(extra._meta)
          : { status: "paused" };
        return receipt({ ...result, connection });
      }),
  );
  server.tool(
    "unbind_bot",
    "Stop and unbind this bot, keeping credentials, pairing and held messages. Does not stop Codex.",
    { expected_session: z.string().nullable() },
    async (args, extra) =>
      inBinding(async () => {
        callingSession(extra._meta);
        return receipt(
          await changeBinding(store, name, null, args.expected_session),
        );
      }),
  );
  if (c.lifecycle === "mcp") {
    server.tool(
      "connect",
      "Connect this session's Telegram receiver. Other sessions cannot take ownership.",
      {},
      async (_a, extra) => {
        if (!store.read(name).enabled || !store.read(name).autostart)
          throw Error("Instance paused; resume first");
        await authorizeCurrent(extra._meta);
        return receipt(owner.connect(extra._meta));
      },
    );
    server.tool(
      "disconnect",
      "Stop this session's Telegram receiver without closing Codex.",
      {},
      async (_a, extra) => {
        await authorizeCurrent(extra._meta);
        atomic(join(store.instance(name), "config.json"), {
          ...store.read(name),
          autostart: false,
        });
        return receipt(await owner.disconnect(extra._meta));
      },
    );
  }
  server.tool(
    "send_text",
    "Send Markdown formatted text. Use phase=commentary for progress and format=plain for literal text. Check status and message_id.",
    {
      ...key,
      ...presentation,
      text: z.string(),
      reply_to: z.number().int().positive().optional(),
    },
    async (a, extra) => {
      if (c.lifecycle === "mcp") await authorizeCurrent(extra._meta);
      return receipt(
        await sender.send(a.request_id, {
          ...a,
          source: a.phase === "commentary" ? "working" : undefined,
        }),
      );
    },
  );
  server.tool(
    "edit_message",
    "Edit a previous bot message without a new notification.",
    {
      ...key,
      ...presentation,
      text: z.string(),
      message_id: z.number().int().positive(),
    },
    async (a, extra) => {
      if (c.lifecycle === "mcp") await authorizeCurrent(extra._meta);
      return receipt(
        await sender.send(a.request_id, {
          text: a.text,
          edit_id: a.message_id,
          format: a.format,
          source: a.phase === "commentary" ? "working" : undefined,
        }),
      );
    },
  );
  for (const [tool, kind] of [
    ["send_photo", "photo"],
    ["send_document", "document"],
  ])
    server.tool(
      tool,
      "Send a file from this instance outgoing directory.",
      {
        ...key,
        ...presentation,
        path: z.string(),
        caption: z.string().optional(),
      },
      async (a, extra) => {
        if (c.lifecycle === "mcp") await authorizeCurrent(extra._meta);
        return receipt(
          await sender.send(a.request_id, {
            file: a.path,
            caption: a.caption,
            format: a.format,
            source: a.phase === "commentary" ? "working" : undefined,
            kind,
          }),
        );
      },
    );
  server.tool(
    "delivery_status",
    "Read a durable receipt. Unknown does not mean failed.",
    key,
    async (a) => receipt(sender.journal.status("out", a.request_id)),
  );
  let failures = 0;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(lease);
    await owner.close();
    sender.api.abort();
    sender.journal.close();
    await server.close();
  };
  const lease = setInterval(() => {
    try {
      const current = store.read(name);
      if (
        !pluginEnabled(current) ||
        JSON.stringify(current.plugin) !== JSON.stringify(c.plugin)
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
  // Initialization is complete before attempting a call back through App Server.
  // The routed call receives the bound thread's identity even when this MCP was
  // started by another session. Never resume an unloaded session from here.
  server.server.oninitialized = () => {
    if (c.lifecycle === "mcp" && c.enabled && c.autostart)
      void controlMcp(c, "connect").catch((e) =>
        console.error("MCP connection pending:", String(e)),
      );
  };
  await server.connect(new StdioServerTransport());
}
