import metadata from "../package.json";
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
import { WorkerProgress } from "./worker-progress";
export { COMMANDS } from "./commands";
import {
  identity,
  waitForReceiverLock,
  sleep,
} from "./process";

/** Back off without retiring the receiver; jitter avoids synchronized retries. */
export function pollRetryDelay(failures: number, conflict: boolean, jitter = Math.random()) {
  const base = conflict ? 5000 : 2000;
  return Math.round(Math.min(60000, base * 2 ** Math.min(6, Math.max(0, failures - 1))) *
    (1 + Math.max(0, Math.min(1, jitter)) * 0.2));
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
  budget = 250,
) {
  const count = events.length;
  const deadline = Date.now() + budget;
  for (let i = 0; i < count && events.length; i++) {
    if ((await handle(events.shift())) === false) return;
    if (Date.now() >= deadline) return;
  }
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
  signal: AbortSignal,
) {
  if (!signal) throw Error("Receiver requires a Codex-owned lifecycle signal");
  if (signal.aborted) return;
  const path = store.instance(name),
    config = store.read(name);
  if (!config.enabled || !config.thread_id || config.binding_change) return;
  if (config.lifecycle !== "mcp") throw Error("Only Codex-managed MCP receivers are supported");
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
      signal.aborted ||
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
    api.close();
    sender.api.close();
    client?.close();
  };
  const progress = new WorkerProgress(() => shutdown("operation_timeout"));
  const onTerm = () => shutdown("signal:SIGTERM");
  const onInterrupt = () => shutdown("signal:SIGINT");
  const onAbort = () => shutdown("session_host_aborted");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInterrupt);
  signal.addEventListener("abort", onAbort, { once: true });
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
        current.plugin?.id !== config.plugin?.id ||
        current.binding_revision !== config.binding_revision ||
        current.binding_change ||
        !pluginEnabled(current)
      )
        shutdown(
          !current.enabled
            ? "instance_disabled"
            : current.plugin?.id !== config.plugin?.id
              ? "plugin_binding_changed"
            : current.autostart === false
              ? "instance_paused"
              : current.binding_change ||
                  current.thread_id !== config.thread_id ||
        current.plugin?.id !== config.plugin?.id ||
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
        version: metadata.version,
        plugin_id: config.plugin?.id ?? null,
        status: progress.snapshot().status === "stalled" ? "stalled" : engine?.status ?? "connecting",
        pipeline: progress.snapshot(),
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
        let failures = 0;
        while (!stopped) {
          const pollStarted = now();
          try {
            const params: any = { timeout: 5, allowed_updates: ["message"] };
            const offset = journal.get("telegram_offset");
            if (offset !== null) params.offset = offset;
            const rows = await api.call("getUpdates", params, 20000);
            if (failures) journal.put("telegram_poll_recovered", { updated: now(), failures });
            failures = 0;
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
            failures++;
            const conflict = e instanceof TelegramError && e.code === 409;
            const delay = pollRetryDelay(failures, conflict);
            pollHealth = {
              status: "retrying",
              updated: now(),
              started: pollStarted,
              failures,
              retry_after_ms: delay,
              code: e instanceof TelegramError ? e.code : null,
              error: diagnostic(String(e), store.token(name)),
            };
            // Retain a bounded failure timeline; health alone overwrites the
            // transport error which preceded a conflict.
            journal.put("telegram_poll_failures", [
              ...journal.get("telegram_poll_failures", []), pollHealth,
            ].slice(-20));
            if (conflict && now() >= journal.get("poll_conflict_notice_after", 0)) {
              journal.put("poll_conflict_notice_after", now() + 600);
              // Notice delivery must never block the polling recovery loop.
              // A stable receipt also prevents replay after unknown delivery.
              bg.push(sender.send("poll-conflict-" + started, {
                source: "system",
                text: "Telegram reported a receiving conflict. Receiving will retry automatically with a delay. If this keeps happening, check whether another instance is receiving messages for this bot.",
              }).catch(error => {
                journal.put("poll_conflict_notice_error", diagnostic(String(error), store.token(name)));
              }));
            }
            await wait(delay);
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
    while (!stopped) {
      try {
        await progress.run("connect", connect);
        break;
      } catch (e) {
        if (stopped) break;
        console.error(diagnostic(String(e), store.token(name)));
        await wait(2000);
      }
    }
    if (stopped) {
      if (stopReason === "operation_timeout") throw Error("Worker operation timed out");
      return;
    }
    let failed = false;
    let nextRecoveryAttempt = Date.now() + 5000;
    let nextHistoryAttempt = 0;
    while (!stopped) {
      if (engine!.waitingForHistory && Date.now() >= nextHistoryAttempt) {
        nextHistoryAttempt = Date.now() + 1000;
        try {
          await progress.run("attach", () => engine!.attach());
          if (!engine!.waitingForHistory) await recovery.start(client!, engine!.recoveryBoundary);
        } catch {
          engine!.status = "disconnected";
        }
      }
      if (engine!.status === "disconnected") {
        try {
          await progress.run("reconnect", connect);
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
        await progress.run("recover_history", () => recovery.start(client!, engine!.recoveryBoundary));
      }
      await drainOutputEvents(client!.events, async (event) => {
        if (stopped) return false;
        if (
          ["thread/closed", "thread/archived", "thread/deleted"].includes(
            event.method,
          ) &&
          event.params?.threadId === config.thread_id
        ) {
          shutdown("session_" + event.method.split("/")[1]);
          return false;
        }
        await progress.run("codex_event", () => engine!.event(event), 120000);
        if (event.params?.threadId === config.thread_id) lastEvent = now();
      });
      if (stopped) break;
      if (engine!.status === "disconnected") continue;
      engine!.syncQuestionStatus();
      // A bounded event snapshot must give the inbox a turn even if new events
      // keep arriving. Optional message maintenance must not go ahead of input.
      const batch = journal.readyBatch();
      if (batch.length) {
        processing = true;
        try {
          const result = await progress.run("deliver_input", () => engine!.receiveBatch(batch), 300000);
          if (result === "paused") shutdown("instance_paused");
          else journal.handled(batch.map((u: any) => u.update_id));
        } finally {
          processing = false;
        }
      }
      if (stopped) break;
      await progress.run("clean_working", () => sender.cleanWorking())
        .catch((error) =>
          console.error(diagnostic(String(error), store.token(name))),
        );
      await progress.run("refresh_compaction", () => engine!.refreshCompaction())
        .catch((error) =>
          console.error(diagnostic(String(error), store.token(name))),
        );
      await progress.run("refresh_activity_pages", () => sender.refreshActivityPages())
        .catch((error) =>
          console.error(diagnostic(String(error), store.token(name))),
        );
      await progress.run("flush_activity", () => engine!.activity.flush())
        .catch((error) =>
          console.error(diagnostic(String(error), store.token(name))),
        );
      await wait(50);
    }
    if (stopReason === "operation_timeout") throw Error("Worker operation timed out");
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
      pipeline: progress.snapshot(),
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
    signal.removeEventListener("abort", onAbort);
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
