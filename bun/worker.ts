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
import { HistoryRecovery } from "./recovery";
import { Store, Journal, atomic, now, privateDir, readJSON } from "./state";
import { Telegram, TelegramError, Sender } from "./telegram";
import { COMMANDS } from "./commands";
export { COMMANDS } from "./commands";
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
// Drain the captured output backlog before submitting any newly received input.
// A bounded snapshot still lets control return if the server keeps streaming.
export async function drainOutputEvents(
  events: any[],
  handle: (event: any) => Promise<boolean | void>,
) {
  const count = events.length;
  for (let i = 0; i < count && events.length; i++)
    if ((await handle(events.shift())) === false) return;
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
  const recovery = new HistoryRecovery(store, name, sender);
  let stopReason: string | undefined;
  let stopDetail: string | undefined;
  let stopped = false,
    client: AppServer | undefined,
    engine: Engine | undefined,
    processing = false,
    leaseFailures = 0;
  let pollHealth: any = { status: "starting" },
    menuHealth: any = { status: "starting" },
    lastEvent = now();
  const started = now();
  const shutdown = (reason = "worker_finished") => {
    stopReason ??= reason;
    stopped = true;
    recovery.cancel();
    api.abort();
    sender.api.abort();
    client?.close();
  };
  const onTerm = () => shutdown("signal:SIGTERM");
  const onInterrupt = () => shutdown("signal:SIGINT");
  const onAbort = () => shutdown("session_host_aborted");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInterrupt);
  signal?.addEventListener("abort", onAbort, { once: true });
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
        current.autostart === false ||
        current.thread_id !== config.thread_id ||
        current.binding_revision !== config.binding_revision ||
        current.binding_change ||
        !pluginEnabled(current)
      )
        shutdown(
          !current.enabled
            ? "instance_disabled"
            : current.autostart === false
              ? "instance_paused"
              : current.binding_change ||
                  current.thread_id !== config.thread_id ||
                  current.binding_revision !== config.binding_revision
                ? "binding_changed"
                : "plugin_disabled_or_removed",
        );
      else leaseFailures = 0;
    } catch {
      if (++leaseFailures >= 3) shutdown("lease_check_failed");
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
        inbound: journal.get("last_inbound"),
        recovery: recovery.summary(),
        command_menu: menuHealth,
        seconds_since_codex_event: Math.round(now() - lastEvent),
      }),
    1000,
  );
  try {
    const priorHealthPath = join(path, "health.json");
    if (existsSync(priorHealthPath)) {
      const previous = readJSON(priorHealthPath);
      if (previous?.pid && previous.status !== "stopped") {
        const exit = {
          reason: "unclean_previous_exit",
          started: previous.started,
          updated: previous.updated,
        };
        journal.put("worker_exit", exit);
        journal.put(
          "worker_exit:" + (previous.started ?? previous.updated),
          exit,
        );
      }
    }
    if (!pluginEnabled(config)) throw Error("Plugin disabled or removed");
    const connect = async () => {
      client?.close();
      await recovery.stop();
      engine?.close();
      client = await AppServer.connect(config.endpoint);
      await guard(client, config.thread_id);
      engine = new Engine(store, name, client, sender);
      await engine.attach();
      if (!engine.waitingForHistory) await recovery.start(client, engine.recoveryBoundary);
      lastEvent = now();
    };
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
              shutdown("telegram_poll_conflict");
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
            Date.now() >= journal.get("working_refresh_after", 0) &&
            (processing ||
              (engine?.activeTurn &&
                ![...engine.interactions.pending.values()].some(
                  (r) => !r.submitted,
                )))
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
    bg.push(
      (async () => {
        while (!stopped) {
          try {
            await sender.retryDeferred();
            if (!stopped) await recovery.deliverNext();
          } catch (error) {
            if (!stopped)
              console.error(diagnostic(String(error), store.token(name)));
          }
          await wait(1000);
        }
      })(),
    );
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
    let failed = false;
    let nextRecoveryAttempt = Date.now() + 5000;
    let nextHistoryAttempt = 0;
    while (!stopped) {
      if (engine!.waitingForHistory && Date.now() >= nextHistoryAttempt) {
        nextHistoryAttempt = Date.now() + 1000;
        try {
          await engine!.attach();
          if (!engine!.waitingForHistory) await recovery.start(client!, engine!.recoveryBoundary);
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
      if (
        !engine!.waitingForHistory &&
        recovery.status.status === "failed" &&
        !recovery.scanning &&
        Date.now() >= nextRecoveryAttempt
      ) {
        nextRecoveryAttempt = Date.now() + 5000;
        await recovery.start(client!, engine!.recoveryBoundary);
      }
      await drainOutputEvents(client!.events, async (event) => {
        if (stopped) return false;
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
          shutdown("session_" + event.method.split("/")[1]);
          return false;
        }
        await engine!.event(event);
        if (event.params?.threadId === config.thread_id) lastEvent = now();
      });
      if (stopped) break;
      if (engine!.status === "disconnected") continue;
      if (client!.events.length) continue;
      engine!.syncQuestionStatus();
      await sender
        .cleanWorking()
        .catch((error) =>
          console.error(diagnostic(String(error), store.token(name))),
        );
      await engine!
        .refreshCompaction()
        .catch((error) =>
          console.error(diagnostic(String(error), store.token(name))),
        );
      await sender
        .refreshActivityPages()
        .catch((error) =>
          console.error(diagnostic(String(error), store.token(name))),
        );
      await engine!.activity
        .flush()
        .catch((error) =>
          console.error(diagnostic(String(error), store.token(name))),
        );
      // Network-bound maintenance may have allowed more assistant output in.
      // Publish that output before forwarding a newer user message.
      if (client!.events.length) continue;
      const batch = journal.readyBatch();
      if (batch.length) {
        processing = true;
        try {
          const result = await engine!.receiveBatch(batch);
          if (result === "paused") shutdown("instance_paused");
          else journal.handled(batch.map((u: any) => u.update_id));
        } finally {
          processing = false;
        }
      }
      await wait(50);
    }
  } catch (error) {
    stopDetail = diagnostic(String(error), store.token(name));
    shutdown("worker_error");
    throw error;
  } finally {
    shutdown();
    clearInterval(lease);
    clearInterval(health);
    await Promise.allSettled([...bg, recovery.stop()]);
    engine?.close();
    const exit = {
      reason: stopReason,
      detail: stopDetail,
      updated: now(),
      started,
      thread_id: config.thread_id,
      telegram: pollHealth,
      recovery: recovery.summary(),
      inbound: journal.get("last_inbound"),
    };
    journal.put("worker_exit", exit);
    journal.put("worker_exit:" + started, exit);
    journal.close();
    sender.journal.close();
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInterrupt);
    signal?.removeEventListener("abort", onAbort);
    rmSync(join(path, "worker-process.json"), { force: true });
    atomic(join(path, "health.json"), {
      pid: null,
      updated: now(),
      status: "stopped",
      runtime: "bun",
      exit,
    });
    unlock();
  }
}
