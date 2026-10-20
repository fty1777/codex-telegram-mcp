import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Journal, atomic, readJSON, hash } from "../bun/state";
import { chunks } from "../bun/engine";
import { AppServer } from "../bun/appserver";
import { Sender, Telegram, TelegramError } from "../bun/telegram";
import { HistoryRecovery } from "../bun/recovery";
import { runWorker } from "../bun/worker";
import { listBots } from "../bun/management";

async function until(check: () => boolean, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= end) throw Error("Condition did not become true");
    await Bun.sleep(10);
  }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telegram-recovery-"));
  const store = new Store(root);
  store.configure(
    "test",
    "123456:fixture",
    { id: 123456, username: "test" },
    12,
    "thread",
  );
  const sender = new Sender(store, "test");
  sender.journal.put("history_initialized", true);
  const turns = Array.from({ length: 12 }, (_, i) => ({
    id: "old-" + i,
    status: "completed",
    items: [
      {
        id: "reply-" + i,
        type: "agentMessage",
        phase: "final_answer",
        text: "Historical reply " + i,
      },
    ],
  }));
  const client: any = {
    events: [],
    call: async () => ({ data: turns, thread: { turns } }),
    resume: async () => ({ thread: { status: { type: "idle" }, turns: [] } }),
    send() {},
    close() {},
  };
  return {
    store,
    sender,
    turns,
    client,
    close() {
      sender.journal.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("legacy historical chunks keep their original receipts and stop behind an unknown predecessor", async () => {
  for (const confirmed of [true, false]) {
    const f = fixture(),
      recovery = new HistoryRecovery(f.store, "test", f.sender);
    const text = "legacy text ".repeat(900),
      parts = chunks(text),
      key = "bridge-" + hash("item-legacy").slice(0, 40);
    f.turns.splice(1);
    f.turns[0].items = [
      { id: "legacy", type: "agentMessage", phase: "final_answer", text },
    ];
    f.sender.journal.begin("out", key + "-0", {
      chat_id: 12,
      text: parts[0],
      kind: "document",
      caption: "",
      reply_to: null,
      edit_id: null,
    });
    if (confirmed)
      f.sender.journal.finish("out", key + "-0", "sent", { message_id: 200 });
    let calls = 0;
    f.sender.api.call = async () => ({ message_id: ++calls, chat: { id: 12 } });
    try {
      await recovery.start(f.client);
      await until(() => !recovery.scanning);
      expect(recovery.summary().pending).toBe(parts.length);
      for (let i = 0; i < parts.length + 1; i++) await recovery.deliverNext();
      expect(calls).toBe(confirmed ? parts.length - 1 : 0);
      expect(recovery.summary().blocked).toBe(confirmed ? 0 : parts.length);
    } finally {
      await recovery.stop();
      f.close();
    }
  }
}, 15000);

test("replacing a recovery waits for cancellation before starting the next scan", async () => {
  const f = fixture(),
    recovery = new HistoryRecovery(f.store, "test", f.sender);
  let release!: () => void,
    newScans = 0;
  const gate = new Promise<void>((r) => (release = r));
  f.client.call = async () => {
    await gate;
    return { data: f.turns, thread: { turns: f.turns } };
  };
  const next: any = {
    call: async () => {
      newScans++;
      return { data: [], thread: { turns: [] } };
    },
  };
  try {
    await recovery.start(f.client);
    const replacement = recovery.start(next);
    await Bun.sleep(20);
    expect(newScans).toBe(0);
    release();
    await replacement;
    await until(() => !recovery.scanning);
    expect(newScans).toBe(1);
    expect(recovery.summary().pending).toBe(0);
  } finally {
    release();
    await recovery.stop();
    f.close();
  }
});

test("simultaneous recovery starts create only the newest scan", async () => {
  const f = fixture(),
    recovery = new HistoryRecovery(f.store, "test", f.sender);
  const scanned: number[] = [];
  try {
    const client = (id: number): any => ({
      call: async () => {
        scanned.push(id);
        return { data: [], thread: { turns: [] } };
      },
    });
    await Promise.all([recovery.start(client(1)), recovery.start(client(2))]);
    await until(() => !recovery.scanning);
    expect(scanned).toEqual([2]);
  } finally {
    await recovery.stop();
    f.close();
  }
});

test("first-load recovery does not mistake a newly accepted turn for old history", async () => {
  const f = fixture(),
    recovery = new HistoryRecovery(f.store, "test", f.sender);
  f.sender.journal.put("history_initialized", null);
  f.sender.journal.put("live_turn:fresh", true);
  f.turns.splice(1);
  f.turns.push({
    id: "fresh",
    status: "completed",
    items: [
      {
        id: "fresh-answer",
        type: "agentMessage",
        phase: "final_answer",
        text: "New answer",
      },
    ],
  });
  let calls = 0;
  f.sender.api.call = async () => ({ message_id: ++calls, chat: { id: 12 } });
  try {
    await recovery.start(f.client, {
      since: Date.now(),
      activeTurn: null,
      items: new Set(),
    });
    await until(() => !recovery.scanning);
    expect(f.sender.journal.get("historical_turn:old-0")).toBe(true);
    expect(f.sender.journal.get("historical_turn:fresh")).not.toBe(true);
    expect(recovery.summary().pending).toBe(1);
    await recovery.deliverNext();
    expect(calls).toBe(1);
  } finally {
    await recovery.stop();
    f.close();
  }
}, 15000);

test("historical commentary survives flood backoff instead of expiring as live progress", async () => {
  const f = fixture(),
    recovery = new HistoryRecovery(f.store, "test", f.sender);
  f.turns.splice(1);
  f.turns[0].items[0].phase = "commentary";
  let calls = 0;
  f.sender.api.call = async () => {
    calls++;
    if (calls === 1) throw new TelegramError(429, "Limited", 1);
    return { message_id: 99, chat: { id: 12 } };
  };
  try {
    await recovery.start(f.client);
    await until(() => !recovery.scanning);
    await recovery.deliverNext();
    expect(calls).toBe(1);
    f.sender.journal.put("working_refresh_after", 0);
    f.sender.journal.put("working_edit_after", 0);
    await f.sender.retryDeferred();
    expect(calls).toBe(2);
    const deferred: any = f.sender.journal.db
      .query(
        "SELECT status,details FROM delivery WHERE key LIKE 'bridge-%' ORDER BY updated DESC LIMIT 1",
      )
      .get();
    expect(deferred.status).toBe("sent");
  } finally {
    await recovery.stop();
    f.close();
  }
}, 15000);

test("discovery keeps stop diagnostics separate from delivery success without leaking details", () => {
  const f = fixture();
  try {
    f.sender.journal.put("worker_exit", {
      reason: "worker_error",
      detail: "PRIVATE_EXCEPTION",
      updated: 1,
    });
    f.sender.journal.put("last_inbound", { status: "accepted", updated: 2 });
    f.sender.journal.put("last_outbound", {
      status: "sent",
      updated: 3,
      details: "PRIVATE_MESSAGE",
    });
    const bot = listBots(f.store)[0];
    expect(bot.receiver_status).toBe("stopped");
    expect(bot.last_exit?.reason).toBe("worker_error");
    expect(bot.last_inbound?.status).toBe("accepted");
    expect(bot.last_outbound?.status).toBe("sent");
    expect(JSON.stringify(bot)).not.toContain("PRIVATE_");
  } finally {
    f.close();
  }
});

test("recovered commentary cannot take over a live Working target", async () => {
  const f = fixture();
  f.sender.api.call = async () => ({ message_id: 10, chat: { id: 12 } });
  try {
    f.sender.journal.put("active_turn", "live");
    await f.sender.send("history-commentary", {
      text: "Historical progress",
      source: "working",
      turn_id: "live",
      activity_page: true,
    });
    expect(f.sender.journal.get("working_message")).toBeNull();
  } finally {
    f.close();
  }
});

test("history scanning persists sends without waiting for Telegram and retains stable receipts", async () => {
  const f = fixture(),
    recovery = new HistoryRecovery(f.store, "test", f.sender);
  let calls = 0;
  f.sender.api.call = async () => {
    calls++;
    return { message_id: calls, chat: { id: 12 } };
  };
  try {
    await recovery.start(f.client);
    await until(() => !recovery.scanning);
    expect(calls).toBe(0);
    expect(recovery.summary().pending).toBe(12);
    await recovery.deliverNext();
    expect(calls).toBe(1);
    await recovery.start(f.client);
    await until(() => !recovery.scanning);
    for (let i = 0; i < 13; i++) await recovery.deliverNext();
    expect(calls).toBe(12);
    expect(recovery.summary().pending).toBe(0);
  } finally {
    await recovery.stop();
    f.close();
  }
}, 15000);

test("history does not cross a binding change or replay ambiguous delivery", async () => {
  const f = fixture(),
    recovery = new HistoryRecovery(f.store, "test", f.sender);
  let calls = 0;
  f.sender.api.call = async () => {
    calls++;
    throw Error("lost response");
  };
  try {
    await recovery.start(f.client);
    await until(() => !recovery.scanning);
    await recovery.deliverNext();
    expect(calls).toBe(1);
    expect(recovery.summary().blocked).toBe(1);
    const config = f.store.read("test");
    atomic(join(f.store.instance("test"), "config.json"), {
      ...config,
      thread_id: "other",
      owner_id: 99,
      binding_revision: 1,
    });
    for (let i = 0; i < 20; i++) await recovery.deliverNext();
    expect(calls).toBe(1);
    expect(recovery.summary().blocked).toBe(12);
  } finally {
    await recovery.stop();
    f.close();
  }
}, 15000);

test("cancelled history scans cannot enqueue replies from a stale Engine", async () => {
  const f = fixture(),
    recovery = new HistoryRecovery(f.store, "test", f.sender);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.client.call = async () => {
    await gate;
    return { data: f.turns, thread: { turns: f.turns } };
  };
  try {
    await recovery.start(f.client);
    recovery.cancel();
    release();
    await recovery.stop();
    expect(recovery.summary().pending).toBe(0);
    expect(recovery.status.status).toBe("cancelled");
  } finally {
    release();
    await recovery.stop();
    f.close();
  }
});

test("blocked historical HTTP does not block polling, owner delivery, or another bot; stop reasons persist", async () => {
  const f = fixture();
  f.store.configure(
    "second",
    "234567:fixture",
    { id: 234567, username: "second" },
    34,
    "second-thread",
  );
  for (const name of ["test", "second"])
    atomic(join(f.store.instance(name), "config.json"), { ...f.store.read(name), lifecycle: "mcp" });
  const secondJournal = new Journal(f.store.instance("second"));
  secondJournal.put("history_initialized", true);
  const oldConnect = AppServer.connect,
    oldCall = Telegram.prototype.call;
  const a = new AbortController(),
    b = new AbortController();
  let updatesSent = false,
    historyStarted = false,
    accepts = 0,
    secondPolls = 0;
  const clients: any[] = [];
  AppServer.connect = async () => {
    const client: any = {
      events: [],
      close() {},
      send() {},
      resume: async (thread: string) => ({
        thread: { id: thread, status: { type: "idle" }, turns: [] },
      }),
      call: async (method: string, params: any) => {
        if (method === "thread/goal/get") return { goal: null };
        if (method === "thread/turns/list") return { data: params.threadId === "thread" ? f.turns : [] };
        if (method === "thread/read")
          return {
            thread: {
              status: { type: "idle" },
              turns: params.threadId === "thread" ? f.turns : [],
            },
          };
        if (method === "turn/start") {
          accepts++;
          return { turn: { id: "live", status: "inProgress" } };
        }
        throw Error("Unexpected RPC " + method);
      },
    };
    clients.push(client);
    return client;
  };
  Telegram.prototype.call = async function (method: string, _params: any) {
    if (method === "getUpdates") {
      await Bun.sleep(20);
      if (this.token.startsWith("234567")) {
        secondPolls++;
        return [];
      }
      if (historyStarted && !updatesSent) {
        updatesSent = true;
        return [
          {
            update_id: 1,
            message: {
              message_id: 1,
              date: Math.floor(Date.now() / 1000),
              text: "New owner message",
              chat: { id: 12, type: "private" },
              from: { id: 12, is_bot: false },
            },
          },
        ];
      }
      return [];
    }
    if (method === "setMyCommands" || method === "sendChatAction") return true;
    if (method === "sendRichMessage") {
      historyStarted = true;
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        await new Promise((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(Error("aborted")),
            { once: true },
          ),
        );
      } finally {
        this.controllers.delete(controller);
      }
    }
    throw Error("Unexpected Telegram call " + method);
  };
  const first = runWorker(f.store, "test", a.signal),
    second = runWorker(f.store, "second", b.signal);
  try {
    await until(() => historyStarted && accepts === 1 && secondPolls > 0, 6000);
    expect(f.sender.journal.get("last_inbound").status).toBe("accepted");
    await until(
      () =>
        (readJSON(join(f.store.instance("test"), "health.json")) ?? {}).telegram
          ?.status === "connected",
    );
    const bots = listBots(f.store);
    expect(
      bots.find((x) => x.instance === "test")?.recovery?.pending,
    ).toBeGreaterThan(0);
    a.abort();
    await first;
    const exit = f.sender.journal.get("worker_exit");
    expect(exit.reason).toBe("session_host_aborted");
    const previous = secondPolls;
    await until(() => secondPolls > previous);
    expect(
      (readJSON(join(f.store.instance("test"), "health.json")) ?? {}).exit
        .reason,
    ).toBe("session_host_aborted");
  } finally {
    a.abort();
    b.abort();
    await Promise.allSettled([first, second]);
    AppServer.connect = oldConnect;
    Telegram.prototype.call = oldCall;
    secondJournal.close();
    f.close();
  }
}, 15000);
