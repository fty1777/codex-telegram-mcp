import { join } from "node:path";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { Store, Journal, atomic, privateDir } from "./state";
import { status, lock, live, sleep } from "./process";
import { AppServer } from "./appserver";
import { randomUUID } from "node:crypto";

/** Allowlist output: never return config objects, credentials, plugin paths,
 * message contents, or delivery error strings from management discovery. */
export function listBots(store: Store) {
  return store.list().map((config) => {
    const runtime = status(store, config.name);
    const receiver = runtime.worker ?? runtime.process;
    const receiverHealth = receiver && runtime.health?.pid === receiver.pid
      ? runtime.health : null;
    let pairingConnectivity = "not_tested";
    let pending = 0,
      held = 0;
    let lastInbound: any, lastOutbound: any, lastExit: any;
    const path = join(store.instance(config.name), "delivery.sqlite3");
    if (existsSync(path)) {
      const db = new Database(path, { readonly: true });
      try {
        const meta = (key: string) => {
          const row: any = db
            .query("SELECT value FROM metadata WHERE key=?")
            .get(key);
          return row ? JSON.parse(row.value) : null;
        };
        lastInbound =
          meta("last_inbound") ??
          db
            .query(
              "SELECT status,updated FROM delivery WHERE direction='in' AND status='accepted' ORDER BY updated DESC LIMIT 1",
            )
            .get();
        lastOutbound =
          meta("last_outbound") ??
          db
            .query(
              "SELECT status,updated FROM delivery WHERE direction='out' ORDER BY updated DESC LIMIT 1",
            )
            .get();
        lastExit = meta("worker_exit");
        const probe: any = db
          .query(
            "SELECT status, updated FROM delivery WHERE direction='out' AND key='pairing-success'",
          )
          .get();
        if (probe) {
          pairingConnectivity =
            probe.status === "sent"
              ? "awaiting_owner_reply"
              : "outbound_unconfirmed";
          if (
            probe.status === "sent" &&
            db
              .query(
                "SELECT 1 FROM delivery WHERE direction='in' AND status='accepted' AND updated > ? LIMIT 1",
              )
              .get(probe.updated)
          )
            pairingConnectivity = "verified";
        }
        pending = (
          db.query("SELECT count(*) AS n FROM inbox WHERE done=0").get() as any
        ).n;
        const table = db
          .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='held_inbox'",
          )
          .get();
        if (table)
          held = (db.query("SELECT count(*) AS n FROM held_inbox").get() as any)
            .n;
      } finally {
        db.close();
      }
    }
    return {
      instance: config.name,
      username: config.username,
      bound_session: config.thread_id ?? null,
      enabled: Boolean(config.enabled),
      running: Boolean(runtime.process),
      pairing_connectivity: pairingConnectivity,
      receiver_status:
        receiverHealth
          ? (receiverHealth.telegram?.status ?? "starting")
          : "stopped",
      setup_stage: !config.thread_id
        ? "paired_unbound"
        : receiverHealth?.telegram?.status === "connected"
          ? "receiver_connected"
          : "paired_receiver_not_ready",
      recovery: receiverHealth?.recovery
        ? {
            status: receiverHealth.recovery.status,
            pending: receiverHealth.recovery.pending,
            blocked: receiverHealth.recovery.blocked,
          }
        : null,
      last_inbound: lastInbound
        ? { status: lastInbound.status, updated: lastInbound.updated }
        : null,
      last_outbound: lastOutbound
        ? { status: lastOutbound.status, updated: lastOutbound.updated }
        : null,
      last_exit: lastExit
        ? { reason: lastExit.reason, updated: lastExit.updated }
        : null,
      pending_messages: pending,
      held_messages: held,
      outgoing_directory: join(store.instance(config.name), "outgoing"),
    };
  });
}

/** Current session is supplied by Codex, not by an agent tool argument. */
export function callingSession(meta: unknown) {
  const id = (meta as any)?.threadId;
  if (typeof id !== "string" || !id.trim())
    throw Error(
      "Codex did not supply the calling session identity; use the rescue CLI instead",
    );
  return id;
}

export interface BindingServices {
  validateSession(id: string, endpoint?: string): Promise<void>;
  waitReceiver(store: Store, name: string): Promise<() => void>;
}
const bindingServices: BindingServices = {
  async validateSession(id, endpoint) {
    const c = await AppServer.connect(endpoint);
    try {
      const { thread } = await c.call("thread/read", {
        threadId: id,
        includeTurns: false,
      });
      if (thread.status?.type === "notLoaded")
        throw Error("Target session is not loaded");
    } finally {
      c.close();
    }
  },
  async waitReceiver(store, name) {
    privateDir(join(store.root, "locks"));
    const deadline = Date.now() + 20000;
    while (true) {
      if (!live(join(store.instance(name), "worker-process.json"))) {
        try {
          return lock(
            join(store.root, "locks", `bot-${store.read(name).bot_id}.lock`),
          );
        } catch {
          /* A receiver may be in its startup critical section. */
        }
      }
      if (Date.now() >= deadline)
        throw Error(
          "Old receiver has not stopped; binding remains paused and unchanged",
        );
      await sleep(100);
    }
  },
};

/** Serialized handoff. No session archive, process kill, or implicit queue transfer.
 * A crash at any intermediate stage leaves the instance paused, not dual-owned. */
export async function changeBinding(
  store: Store,
  name: string,
  target: string | null,
  expectedSession: string | null,
  activate?: boolean,
  services: BindingServices = bindingServices,
) {
  const path = store.instance(name);
  const release = lock(join(path, "management.lock"));
  let releaseBot: (() => void) | undefined;
  try {
    const before = store.read(name);
    if ((before.thread_id ?? null) !== expectedSession)
      throw Error("Binding changed since it was inspected; list bots again");
    if (before.removing && target !== null)
      throw Error("Instance removal is in progress");
    if (target) await services.validateSession(target, before.endpoint);
    if (target === (before.thread_id ?? null) && !before.binding_change) {
      if (target && activate !== undefined)
        atomic(join(path, "config.json"), {
          ...before,
          enabled: activate,
          autostart: activate,
        });
      return {
        status: "unchanged",
        instance: name,
        bound_session: target,
        enabled: target
          ? (activate ?? (before.enabled && before.autostart !== false))
          : false,
      };
    }
    const desiredEnabled =
      target !== null &&
      (activate ??
        before.binding_change?.was_enabled ??
        (before.enabled && before.autostart !== false));
    atomic(join(path, "config.json"), {
      ...before,
      enabled: false,
      autostart: false,
      binding_change: {
        from: before.thread_id ?? null,
        to: target,
        was_enabled:
          before.binding_change?.was_enabled ??
          (before.enabled && before.autostart !== false),
      },
    });
    releaseBot = await services.waitReceiver(store, name);
    const journal = new Journal(path);
    let held;
    try {
      held = journal.holdPending(before.thread_id ?? "unbound");
    } finally {
      journal.close();
    }
    const config = {
      ...store.read(name),
      thread_id: target,
      binding_revision: randomUUID(),
      enabled: desiredEnabled,
      autostart: desiredEnabled,
    };
    delete config.binding_change;
    atomic(join(path, "config.json"), config);
    return {
      status: target ? "bound" : "unbound",
      instance: name,
      bound_session: target,
      enabled: desiredEnabled,
      held_messages: held.held,
    };
  } finally {
    releaseBot?.();
    release();
  }
}
