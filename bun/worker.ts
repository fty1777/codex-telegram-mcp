import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { AppServer } from "./appserver";
import { Engine, diagnostic } from "./engine";
import { Store, Journal, atomic, now, privateDir } from "./state";
import { Telegram, TelegramError, Sender } from "./telegram";
import {
  identity,
  waitForReceiverLock,
  sleep,
  status,
  LockBusyError,
} from "./process";

export function healthyReceiverHandoff(
  store: Store,
  name: string,
  error: unknown,
) {
  if (!(error instanceof LockBusyError)) return false;
  const state = status(store, name);
  return Boolean(
    state.process &&
      state.health?.pid === state.process.pid &&
      state.health?.telegram?.status === "connected" &&
      now() - state.health.updated < 15,
  );
}
export const COMMANDS = [
  ["help", "Command descriptions"],
  ["status", "Session status"],
  ["queue", "Queued messages"],
  ["stop", "Interrupt current turn"],
  ["approve", "Approve pending request"],
  ["deny", "Deny pending request"],
  ["answer", "Answer pending question"],
].map(([command, description]) => ({ command, description }));
export function pluginEnabled(config: any) {
  if (!config.plugin) return true;
  const p = config.plugin;
  if (
    !existsSync(join(p.root, ".codex-plugin/plugin.json")) &&
    !existsSync(join(p.root, "plugin.json"))
  )
    return false;
  const settings = Bun.TOML.parse(
    readFileSync(
      join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"),
      "utf8",
    ),
  ) as any;
  const enabled = settings.plugins?.[p.id]?.enabled;
  if (typeof enabled !== "boolean")
    throw Error("Plugin enable state unavailable");
  return enabled;
}
export async function guard(client: AppServer, thread: string) {
  const t = (
    await client.call("thread/read", { threadId: thread, includeTurns: false })
  ).thread;
  if (t.status?.type !== "notLoaded") return;
  for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    let found = false;
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (
        !basename(args[0]).includes("codex") ||
        !args.includes("resume") ||
        !args.includes(thread) ||
        args.includes("--remote")
      )
        continue;
      found = readdirSync(`/proc/${pid}/fd`).some((fd) => {
        try {
          return readlinkSync(`/proc/${pid}/fd/${fd}`).endsWith(
            "-" + thread + ".jsonl",
          );
        } catch {
          return false;
        }
      });
    } catch {}
    if (found)
      throw Error(
        `Session open in standalone Codex. Reconnect that terminal: codex --remote unix:// resume ${thread}`,
      );
  }
}
export async function runWorker(
  store: Store,
  name: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return;
  const path = store.instance(name),
    config = store.read(name);
  if (!config.enabled || !config.thread_id || config.binding_change) return;
  if (config.telegram_api?.mode === "local")
    throw Error(
      "Local Bot API migration is deferred; keep this instance on its previous runtime until local mode is supported",
    );
  privateDir(join(store.root, "locks"));
  const unlock = await waitForReceiverLock(
    join(store.root, "locks", `bot-${config.bot_id}.lock`),
    signal,
  );
  if (!unlock) return;
  try {
    const current = store.read(name);
    if (
      signal?.aborted ||
      !current.enabled ||
      current.autostart === false ||
      current.binding_change ||
      current.thread_id !== config.thread_id ||
      current.binding_revision !== config.binding_revision
    ) {
      unlock();
      return;
    }
  } catch (error) {
    unlock();
    throw error;
  }
  const api = Telegram.forInstance(store, name),
    sender = new Sender(store, name),
    journal = new Journal(path);
  let stopped = false,
    client: AppServer | undefined,
    engine: Engine | undefined,
    processing = false,
    leaseFailures = 0;
  let pollHealth: any = { status: "starting" },
    menuHealth: any = { status: "starting" },
    lastEvent = now();
  const started = now();
  const shutdown = () => {
    stopped = true;
    api.abort();
    sender.api.abort();
    client?.close();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  signal?.addEventListener("abort", shutdown, { once: true });
  atomic(join(path, "worker-process.json"), identity(process.pid));
  let bg: Promise<any>[] = [];
  const wait = async (ms: number) => {
    for (let t = 0; t < ms && !stopped; t += 100)
      await sleep(Math.min(100, ms - t));
  };
  const lease = setInterval(() => {
    try {
      const current = store.read(name);
      if (
        !current.enabled ||
        current.thread_id !== config.thread_id ||
        current.binding_revision !== config.binding_revision ||
        current.binding_change ||
        !pluginEnabled(current)
      )
        shutdown();
      else leaseFailures = 0;
    } catch {
      if (++leaseFailures >= 3) shutdown();
    }
  }, 2000);
  const health = setInterval(
    () =>
      atomic(join(path, "health.json"), {
        pid: process.pid,
        started,
        updated: now(),
        runtime: "bun",
        status: engine?.status ?? "connecting",
        thread_id: config.thread_id,
        active_turn: engine?.activeTurn ?? null,
        telegram: pollHealth,
        outbound: journal.get("last_outbound"),
        command_menu: menuHealth,
        seconds_since_codex_event: Math.round(now() - lastEvent),
      }),
    1000,
  );
  try {
    if (!pluginEnabled(config)) throw Error("Plugin disabled or removed");
    const connect = async () => {
      client?.close();
      engine?.close();
      client = await AppServer.connect(config.endpoint);
      await guard(client, config.thread_id);
      engine = new Engine(store, name, client, sender);
      await engine.attach();
      await engine.recover();
      lastEvent = now();
    };
    let startupNotified = false;
    while (!stopped) {
      try {
        await connect();
        break;
      } catch (e) {
        if (stopped) break;
        console.error(diagnostic(String(e), store.token(name)));
        if (!startupNotified) {
          await sender.send("startup-" + started, {
            source: "system",
            text: "Your Codex conversation is temporarily unavailable. Reconnecting automatically; no action is needed right now.",
          });
          startupNotified = true;
        }
        await wait(2000);
      }
    }
    if (stopped) return;
    bg.push(
      (async () => {
        while (!stopped) {
          try {
            const params: any = { timeout: 5, allowed_updates: ["message"] };
            const offset = journal.get("telegram_offset");
            if (offset !== null) params.offset = offset;
            const rows = await api.call("getUpdates", params, 8000);
            pollHealth = { status: "connected", updated: now() };
            if (rows.length) {
              const owner = config.owner_id;
              const accepted = rows.filter(
                (u: any) =>
                  u.message?.chat?.type === "private" &&
                  u.message.chat.id === owner &&
                  u.message.from?.id === owner &&
                  !u.message.from?.is_bot,
              );
              journal.enqueue(
                accepted,
                Math.max(...rows.map((u: any) => u.update_id)) + 1,
              );
            }
          } catch (e) {
            if (stopped) break;
            pollHealth = {
              status: "retrying",
              updated: now(),
              error: diagnostic(String(e), store.token(name)),
            };
            if (e instanceof TelegramError && e.code === 409) {
              await sender.send("poll-conflict-" + started, {
                source: "system",
                text: "Telegram receiving has stopped because this bot is being used by another connection. Ask Codex to check the connection before restarting it.",
              });
              shutdown();
              break;
            }
            await wait(2000);
          }
        }
      })(),
    );
    bg.push(
      (async () => {
        while (!stopped) {
          if (
            processing ||
            (engine?.activeTurn &&
              ![...engine.interactions.pending.values()].some(
                (r) => !r.submitted,
              ))
          )
            await api
              .call(
                "sendChatAction",
                { chat_id: config.owner_id, action: "typing" },
                3000,
              )
              .catch(() => {});
          await wait(4000);
        }
      })(),
    );
    bg.push(
      (async () => {
        for (let attempts = 0; !stopped; attempts++) {
          try {
            await api.call(
              "setMyCommands",
              {
                commands: COMMANDS,
                scope: { type: "chat", chat_id: config.owner_id },
              },
              10000,
            );
            menuHealth = { status: "registered", updated: now() };
            return;
          } catch (e) {
            menuHealth = {
              status: "retrying",
              updated: now(),
              error: diagnostic(String(e), store.token(name)),
            };
            await wait(Math.min(300000, 5000 * 2 ** Math.min(attempts, 6)));
          }
        }
      })(),
    );
    let failed = false;
    let nextHistoryAttempt = 0;
    while (!stopped) {
      if (engine!.waitingForHistory && Date.now() >= nextHistoryAttempt) {
        nextHistoryAttempt = Date.now() + 1000;
        try {
          await engine!.attach();
          await engine!.recover();
        } catch {
          engine!.status = "disconnected";
        }
      }
      if (engine!.status === "disconnected") {
        try {
          await connect();
          failed = false;
        } catch (e) {
          if (stopped) break;
          if (engine) engine.status = "disconnected";
          if (!failed) {
            console.error(diagnostic(String(e), store.token(name)));
            await sender.send("disconnect-" + Date.now(), {
              source: "system",
              text: "Your Codex conversation is temporarily unavailable. Pending messages are saved while the connection is restored.",
            });
            failed = true;
          }
          await wait(2000);
          continue;
        }
      }
      for (let i = 0; i < 20 && client!.events.length && !stopped; i++) {
        const event = client!.events.shift();
        if (
          ["thread/closed", "thread/archived", "thread/deleted"].includes(
            event.method,
          ) &&
          event.params?.threadId === config.thread_id
        ) {
          atomic(join(path, "session-active.json"), {
            thread_id: config.thread_id,
            active: false,
          });
          shutdown();
          break;
        }
        await engine!.event(event);
        if (event.params?.threadId === config.thread_id) lastEvent = now();
      }
      if (stopped) break;
      if (engine!.status === "disconnected") continue;
      const batch = journal.readyBatch();
      if (batch.length) {
        processing = true;
        try {
          const result = await engine!.receiveBatch(batch);
          if (result === "paused") shutdown();
          else journal.handled(batch.map((u: any) => u.update_id));
        } finally {
          processing = false;
        }
      }
      await wait(50);
    }
  } finally {
    shutdown();
    clearInterval(lease);
    clearInterval(health);
    await Promise.allSettled(bg);
    engine?.close();
    journal.close();
    sender.journal.close();
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    signal?.removeEventListener("abort", shutdown);
    rmSync(join(path, "worker-process.json"), { force: true });
    atomic(join(path, "health.json"), {
      pid: null,
      updated: now(),
      status: "stopped",
      runtime: "bun",
    });
    unlock();
  }
}
