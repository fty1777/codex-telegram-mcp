import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Store, Journal, atomic, privateDir, readJSON } from "./state";
import { lock } from "./process";
import { Sender, Telegram } from "./telegram";
import { messages } from "./format";

type Api = Pick<Telegram, "call">;
type ApiFactory = (token: string) => Api;
const defaultApi: ApiFactory = (token) => new Telegram(token);

/** Both tool and rescue setup record the same durable connectivity probe. */
export async function completePairing(
  store: Store,
  name: string,
  session: string,
  code: string,
  connect: () => Promise<any>,
  api?: Telegram,
) {
  const configured = redeemPairing(store, name, session, code);
  let connection;
  try {
    connection = await connect();
  } catch {
    connection = {
      status: "paired_receiver_not_started",
      next_step:
        "Use list_bots, then bind_bot with activate=true in this session to retry starting the receiver. Pairing is already saved; do not pair again.",
    };
  }
  let notification;
  let sender: Sender | undefined;
  try {
    sender = new Sender(store, name, api);
    notification = await sender.send("pairing-success", {
      source: "system",
      text: "Pairing complete. This bot now accepts only your private messages. Send a short message to test the connection.",
    });
  } catch {
    notification = {
      status: "unavailable",
      next_step: "Inspect delivery_status for pairing-success before retrying.",
    };
  } finally {
    sender?.journal.close();
  }
  return { ...configured, connection, notification };
}
function directory(store: Store) {
  privateDir(store.root);
  const path = join(store.root, "pairings");
  privateDir(path);
  return path;
}
function pathFor(store: Store, name: string) {
  store.instance(name); // Apply the same name and symlink checks as instances.
  return join(directory(store), name + ".json");
}
function readPairing(store: Store, name: string, session: string) {
  const value = readJSON(pathFor(store, name));
  if (value.session !== session)
    throw Error("Pairing belongs to another session");
  if (value.expires_at <= Date.now())
    throw Error("Pairing expired; cancel and start again");
  return value;
}
function summary(value: any) {
  return {
    instance: value.name,
    username: value.bot.username,
    expires_at: new Date(value.expires_at).toISOString(),
    pairing_url: `https://t.me/${value.bot.username}`,
    status: "awaiting_code",
    candidate_count: value.candidates.length,
  };
}

/** A short-lived, durable setup operation, never a background poller. */
export async function beginPairing(
  store: Store,
  name: string,
  token: string,
  session: string,
  endpoint?: string,
  apiFactory: ApiFactory = defaultApi,
) {
  const path = pathFor(store, name);
  const release = lock(join(directory(store), "management.lock"));
  try {
    if (!session.trim()) throw Error("Calling session required");
    if (!/^\d+:[\w-]+$/.test(token)) throw Error("Invalid bot token format");
    if (existsSync(path)) {
      const previous = readPairing(store, name, session);
      if (previous.token !== token)
        throw Error(
          "Pairing already exists; cancel it before replacing credentials",
        );
      return summary(previous);
    }
    if (existsSync(join(store.instance(name), "config.json")))
      throw Error("Instance already configured");
    const api = apiFactory(token);
    const bot = await api.call("getMe", {});
    if (!bot.is_bot || !bot.username || !Number.isSafeInteger(bot.id))
      throw Error("Invalid bot identity");
    if (store.list().some((c) => c.bot_id === bot.id))
      throw Error("Bot already configured; bind the existing instance instead");
    for (const file of readdirSync(directory(store)).filter((n) =>
      n.endsWith(".json"),
    )) {
      const pending = readJSON(join(directory(store), file));
      // Even expired credentials remain reserved until explicitly cancelled.
      if (pending.bot.id === bot.id)
        throw Error("Bot already has a pending pairing");
    }
    if ((await api.call("getWebhookInfo", {})).url)
      throw Error(
        "Bot has an existing webhook; remove the old integration first",
      );
    const value = {
      name,
      token,
      session,
      endpoint,
      bot: { id: bot.id, username: bot.username },
      protocol: 2,
      window_id: randomBytes(16).toString("hex"),
      opened_at: Date.now(),
      failed_attempts: 0,
      expires_at: Date.now() + 15 * 60_000,
      candidates: [] as any[],
      offset: undefined,
    };
    atomic(path, value);
    return summary(value);
  } finally {
    release();
  }
}

export function pairingStatus(store: Store, name: string, session: string) {
  return summary(readPairing(store, name, session));
}

export async function pollPairing(
  store: Store,
  name: string,
  session: string,
  apiFactory: ApiFactory = defaultApi,
  signal?: AbortSignal,
) {
  const path = pathFor(store, name);
  const snapshot = readPairing(store, name, session);
  privateDir(join(store.root, "locks"));
  const releaseBot = lock(
    join(store.root, "locks", `bot-${snapshot.bot.id}.lock`),
  );
  const api = apiFactory(snapshot.token);
  const abort = () => (api as any).abort?.();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) return { status: "stopped" };
    const rows = await api.call(
      "getUpdates",
      {
        timeout: 2,
        allowed_updates: ["message"],
        ...(snapshot.offset !== undefined ? { offset: snapshot.offset } : {}),
      },
      6000,
    );
    for (const update of rows) {
      if (signal?.aborted) return { status: "stopped" };
      let outbound: { chat_id: number; text: string } | undefined;
      const release = lock(join(directory(store), "management.lock"));
      try {
        // Re-read after every await: cancellation, expiry or redemption wins.
        if (!existsSync(path)) return { status: "closed" };
        const value = readPairing(store, name, session);
        if (value.window_id !== snapshot.window_id || value.protocol !== 2)
          return { status: "closed" };
        if (update.update_id < (value.offset ?? 0)) continue;
        value.offset = Math.max(value.offset ?? 0, update.update_id + 1);
        const m = update.message,
          id = m?.from?.id;
        if (
          m?.chat?.type === "private" &&
          Number.isSafeInteger(id) &&
          id > 0 &&
          !m.from.is_bot &&
          id === m.chat.id &&
          m.text === "/start" &&
          (m.date === undefined || m.date * 1000 >= value.opened_at - 1000) &&
          value.failed_attempts < 10 &&
          value.candidates.length < 20 &&
          !value.candidates.some((c: any) => c.user_id === id)
        ) {
          const code = randomBytes(6).toString("hex").toUpperCase();
          value.candidates.push({ user_id: id, code_hash: codeHash(code) });
          outbound = {
            chat_id: id,
            text: `Pairing code: ${code}\nPaste this code into the Codex session that started setup. This code does not grant access until redeemed there.`,
          };
        }
        // Reserve the response and cursor before sending; unknown delivery is not retried.
        atomic(path, value);
      } finally {
        release();
      }
      if (outbound && !signal?.aborted) {
        try {
          const rendered = messages(outbound.text, "system")[0]!;
          await api.call("sendMessage", { ...outbound, ...rendered });
        } catch {
          /* A reserved code remains valid; never replay an ambiguous send. */
        }
      }
    }
    return existsSync(path)
      ? pairingStatus(store, name, session)
      : { status: "closed" };
  } finally {
    signal?.removeEventListener("abort", abort);
    releaseBot();
  }
}

function commitPairing(
  store: Store,
  name: string,
  session: string,
  owner: number,
) {
  const path = pathFor(store, name);
  if (!existsSync(path)) {
    const config = store.read(name);
    if (config.thread_id !== session || config.owner_id !== owner)
      throw Error("No matching completed pairing");
    return {
      status: "configured",
      instance: name,
      username: config.username,
      owner_id: owner,
      bound_session: session,
    };
  }
  const value = readPairing(store, name, session);
  if (!value.candidates.some((candidate: any) => candidate.user_id === owner))
    throw Error("User has not completed this pairing challenge");
  if (existsSync(join(store.instance(name), "config.json"))) {
    const c = store.read(name);
    if (
      c.bot_id !== value.bot.id ||
      c.owner_id !== owner ||
      c.thread_id !== session
    )
      throw Error("Instance changed while pairing; inspect it before retrying");
  } else {
    if (store.list().some((c) => c.bot_id === value.bot.id))
      throw Error("Bot already configured");
    // Persist the cursor before config becomes visible to an installed receiver.
    const journal = new Journal(store.instance(name));
    try {
      journal.put("telegram_offset", value.offset);
    } finally {
      journal.close();
    }
    store.configure(
      name,
      value.token,
      value.bot,
      owner,
      session,
      value.endpoint,
    );
  }
  unlinkSync(path);
  return {
    status: "configured",
    instance: name,
    username: value.bot.username,
    owner_id: owner,
    bound_session: session,
  };
}

export function cancelPairing(store: Store, name: string, session: string) {
  const path = pathFor(store, name);
  const release = lock(join(directory(store), "management.lock"));
  try {
    if (!existsSync(path)) return { status: "absent", instance: name };
    if (readJSON(path).session !== session)
      throw Error("Pairing belongs to another session");
    unlinkSync(path);
    return { status: "cancelled", instance: name };
  } finally {
    release();
  }
}

function codeHash(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

/** Validate proof under the same lock as the binding commit. */
export function redeemPairing(
  store: Store,
  name: string,
  session: string,
  code: string,
) {
  const path = pathFor(store, name);
  const release = lock(join(directory(store), "management.lock"));
  try {
    const value = readPairing(store, name, session);
    if (value.protocol !== 2) throw Error("Restart this legacy pairing window");
    if (value.failed_attempts >= 10)
      throw Error("Pairing attempts exhausted; cancel and restart");
    const candidate = value.candidates.find(
      (c: any) => c.code_hash === codeHash(code.trim().toUpperCase()),
    );
    if (!candidate) {
      value.failed_attempts++;
      atomic(path, value);
      throw Error("Invalid pairing code");
    }
    // Synchronous commit cannot interleave; retain the lock across validation.
    return commitPairing(store, name, session, candidate.user_id);
  } finally {
    release();
  }
}
