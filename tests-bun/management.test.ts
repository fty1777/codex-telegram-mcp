import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Journal, atomic } from "../bun/state";
import { listBots, callingSession } from "../bun/management";

test("session switch holds the entire queue and frozen batch, preserving unknown receipts and cursor", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-management-"));
  const s = new Store(root);
  s.configure(
    "sample",
    "123456:fixture",
    { id: 123456, username: "fixture" },
    12,
    "old-session",
  );
  const j = new Journal(s.instance("sample"));
  try {
    const updates = Array.from({ length: 125 }, (_, i) => ({
      update_id: i + 1,
      message: { message_id: i + 1, text: "private fixture" },
    }));
    j.enqueue(updates, 126);
    j.put("active_batch", [updates[0], updates[1]]);
    j.put("active_turn", "old-turn");
    j.put("history_initialized", true);
    j.begin("in", "1", updates[0]);
    j.begin("out", "ambiguous", { text: "private fixture" });
    expect(j.holdPending("old-session").held).toBe(125);
    expect(j.readyBatch()).toEqual([]);
    expect(j.get("telegram_offset")).toBe(126);
    expect(j.get("active_turn")).toBe(null);
    expect(j.get("history_initialized")).toBe(null);
    expect(j.status("in", "1").status).toBe("unknown");
    expect(j.status("out", "ambiguous").status).toBe("unknown");
    expect(j.holdPending("old-session").held).toBe(0);
    expect(
      (j.db.query("SELECT count(*) AS n FROM held_inbox").get() as any).n,
    ).toBe(125);
    j.enqueue([{ update_id: 126, message: { text: "new" } }], 127);
    expect(j.readyBatch()[0].update_id).toBe(126);
    atomic(join(s.instance("sample"), "config.json"), {
      ...s.read("sample"),
      extra_secret: "must-not-leak",
    });
    const listed = listBots(s);
    expect(listed[0].held_messages).toBe(125);
    expect(listed[0].pending_messages).toBe(1);
    expect(JSON.stringify(listed)).not.toContain("private fixture");
    expect(JSON.stringify(listed)).not.toContain("extra_secret");
    expect(JSON.stringify(listed)).not.toContain("123456:fixture");
  } finally {
    j.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("management requires Codex-supplied current-session metadata", () => {
  expect(() => callingSession(undefined)).toThrow();
  expect(() => callingSession({ threadId: "" })).toThrow();
  expect(callingSession({ threadId: "current-session" })).toBe(
    "current-session",
  );
});

test("handoff pauses before draining, preserves credentials and paused state, and refuses stale binding writes", async () => {
  const { changeBinding } = await import("../bun/management");
  const root = mkdtempSync(join(tmpdir(), "bridge-handoff-")),
    s = new Store(root);
  s.configure(
    "sample",
    "123456:fixture",
    { id: 123456, username: "fixture" },
    12,
    "old",
  );
  const j = new Journal(s.instance("sample"));
  j.enqueue([{ update_id: 1, message: { text: "old pending" } }], 2);
  let released = false;
  const services = {
    validateSession: async (id: string) => {
      if (id === "missing") throw Error("missing session");
    },
    waitReceiver: async () => {
      expect(s.read("sample").enabled).toBe(false);
      expect(s.read("sample").thread_id).toBe("old");
      return () => {
        released = true;
      };
    },
  };
  try {
    await expect(
      changeBinding(s, "sample", "missing", "old", undefined, services),
    ).rejects.toThrow("missing");
    expect(s.read("sample").enabled).toBe(true);
    const result = await changeBinding(
      s,
      "sample",
      "new",
      "old",
      undefined,
      services,
    );
    expect(result.held_messages).toBe(1);
    expect(released).toBe(true);
    expect(s.token("sample")).toBe("123456:fixture");
    expect(s.read("sample").thread_id).toBe("new");
    expect(s.read("sample").enabled).toBe(true);
    expect(j.readyBatch()).toEqual([]);
    await expect(
      changeBinding(s, "sample", "another", "old", undefined, services),
    ).rejects.toThrow("Binding changed");
    const immediate = {
      validateSession: async () => {},
      waitReceiver: async () => () => {},
    };
    await changeBinding(s, "sample", null, "new", undefined, immediate);
    expect(s.read("sample").enabled).toBe(false);
    expect(s.read("sample").thread_id).toBe(null);
    await changeBinding(s, "sample", "new", null, undefined, immediate);
    expect(s.read("sample").enabled).toBe(false);
  } finally {
    j.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed receiver stop leaves old binding paused and queue intact", async () => {
  const { changeBinding } = await import("../bun/management");
  const root = mkdtempSync(join(tmpdir(), "bridge-stop-failure-")),
    s = new Store(root);
  s.configure(
    "sample",
    "123456:fixture",
    { id: 123456, username: "fixture" },
    12,
    "old",
  );
  const j = new Journal(s.instance("sample"));
  j.enqueue([{ update_id: 1, message: { text: "pending" } }], 2);
  try {
    await expect(
      changeBinding(s, "sample", "new", "old", true, {
        validateSession: async () => {},
        waitReceiver: async () => {
          throw Error("still running");
        },
      }),
    ).rejects.toThrow("still running");
    expect(s.read("sample").thread_id).toBe("old");
    expect(s.read("sample").enabled).toBe(false);
    expect(j.pending().length).toBe(1);
  } finally {
    j.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit activation of the same binding preserves queued messages", async () => {
  const { changeBinding } = await import("../bun/management");
  const root = mkdtempSync(join(tmpdir(), "bridge-reactivate-")),
    s = new Store(root);
  s.configure(
    "sample",
    "123456:fixture",
    { id: 123456, username: "fixture" },
    12,
    "same",
  );
  atomic(join(s.instance("sample"), "config.json"), {
    ...s.read("sample"),
    enabled: false,
  });
  const j = new Journal(s.instance("sample"));
  j.enqueue([{ update_id: 1, message: { text: "pending" } }], 2);
  try {
    const changed = await changeBinding(s, "sample", "same", "same", true, {
      validateSession: async () => {},
      waitReceiver: async () => {
        throw Error("must not drain same binding");
      },
    });
    expect(changed.enabled).toBe(true);
    expect(s.read("sample").autostart).toBe(true);
    expect(j.pending().length).toBe(1);
  } finally {
    j.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent binding operations cannot overwrite each other or reactivate a stopped bot", async () => {
  const { changeBinding } = await import("../bun/management");
  const root = mkdtempSync(join(tmpdir(), "bridge-concurrent-bind-")),
    s = new Store(root);
  s.configure(
    "sample",
    "123456:fixture",
    { id: 123456, username: "fixture" },
    12,
    "old",
  );
  atomic(join(s.instance("sample"), "config.json"), {
    ...s.read("sample"),
    autostart: false,
  });
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const first = changeBinding(s, "sample", "winner", "old", undefined, {
    validateSession: async () => {
      await gate;
    },
    waitReceiver: async () => () => {},
  });
  try {
    await expect(
      changeBinding(s, "sample", "loser", "old", true, {
        validateSession: async () => {},
        waitReceiver: async () => () => {},
      }),
    ).rejects.toThrow();
    unblock();
    expect((await first).enabled).toBe(false);
    expect(s.read("sample").thread_id).toBe("winner");
    expect(s.read("sample").autostart).toBe(false);
  } finally {
    unblock();
    await first;
    rmSync(root, { recursive: true, force: true });
  }
});

test("pairing connectivity requires confirmed outbound and a later accepted inbound", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-connectivity-"));
  const s = new Store(root);
  s.configure(
    "sample",
    "123456:fixture",
    { id: 123456, username: "fixture" },
    12,
    "session",
  );
  const j = new Journal(s.instance("sample"));
  try {
    expect(listBots(s)[0]!.pairing_connectivity).toBe("not_tested");
    j.begin("out", "pairing-success", {});
    expect(listBots(s)[0]!.pairing_connectivity).toBe("outbound_unconfirmed");
    j.finish("out", "pairing-success", "sent", {});
    j.db.query("UPDATE delivery SET updated=100 WHERE direction='out'").run();
    j.begin("in", "old", {});
    j.finish("in", "old", "accepted", {});
    j.db.query("UPDATE delivery SET updated=99 WHERE direction='in'").run();
    expect(listBots(s)[0]!.pairing_connectivity).toBe("awaiting_owner_reply");
    j.begin("in", "new", {});
    j.finish("in", "new", "accepted", {});
    expect(listBots(s)[0]!.pairing_connectivity).toBe("verified");
  } finally {
    j.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("receiver discovery ignores retired process records and verifies the MCP worker", async () => {
  const { identity } = await import("../bun/process");
  const root = mkdtempSync(join(tmpdir(), "telegram-mcp-health-"));
  const store = new Store(root);
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  store.configure("sample", "123456:fixture", { id: 123456, username: "fixture" }, 42, "session");
  try {
    const path = store.instance("sample");
    const worker = identity(child.pid)!;
    expect(worker).not.toBeNull();
    atomic(join(path, "process.json"), identity(process.pid));
    atomic(join(path, "worker-process.json"), worker);
    atomic(join(path, "health.json"), {
      pid: child.pid, updated: Date.now() / 1000, status: "active",
      telegram: { status: "connected" }, recovery: { status: "complete", pending: 0, blocked: 0 },
    });
    const bot = listBots(store)[0];
    expect(bot.running).toBe(true);
    expect(bot.receiver_status).toBe("connected");
    expect(bot.setup_stage).toBe("receiver_connected");
    expect(bot.recovery?.status).toBe("complete");
    atomic(join(path, "worker-process.json"), { ...worker, start_ticks: "invalid" });
    const stale = listBots(store)[0];
    expect(stale.running).toBe(false);
    expect(stale.receiver_status).toBe("stopped");
    expect(stale.setup_stage).toBe("paired_receiver_not_ready");
    expect(stale.recovery).toBeNull();
  } finally {
    child.kill(); await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
