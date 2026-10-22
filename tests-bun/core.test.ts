import { telegramView } from "./telegram-view";
import { test, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Journal, hash } from "../bun/state";
import { Sender, Telegram, TelegramError } from "../bun/telegram";
import { Engine, chunks } from "../bun/engine";
import { DeliveryUnknown, RpcError } from "../bun/appserver";
import { Interactions } from "../bun/interactions";
import { install, uninstall } from "../bun/install";
import { COMMANDS, HELP, parseCommand } from "../bun/commands";

test("slash command menu matches help and preserves multiline objectives", () => {
  for (const { command } of COMMANDS) expect(HELP).toContain("/" + command);
  expect(parseCommand("/goal@fixture First line\n  preserve  spaces")).toEqual({
    command: "/goal",
    args: "First line\n  preserve  spaces",
  });
});

test("command help is local, works while busy, and cannot accidentally create a goal", async () => {
  const f = engineFixture();
  f.e.activeTurn = "busy";
  f.client.call = async () => {
    throw Error("Help must not call Codex");
  };
  f.client.resume = async () => {
    throw Error("Help must not resume Codex");
  };
  try {
    let id = 1;
    for (const command of [
      "/help goal",
      "/help /goal",
      "/help model",
      "/help permissions",
    ]) {
      expect(await f.e.receiveBatch([update(id++, command)])).toBe("handled");
      expect(f.calls.at(-1).params.text).not.toContain("Unknown command");
    }
    expect(f.e.activeTurn).toBe("busy");
    expect(f.rpc).toHaveLength(0);
  } finally {
    f.done();
  }
});

test("help-like arguments retain their native meaning instead of being intercepted", async () => {
  const f = engineFixture();
  f.client.call = async (method: string, params: any) => {
    f.rpc.push({ method, params });
    return { goal: { ...params, tokensUsed: 0, timeUsedSeconds: 0 } };
  };
  try {
    await f.e.receiveBatch([update(1, "/goal help")]);
    await f.e.receiveBatch([update(2, "/goal --help")]);
    await f.e.receiveBatch([update(3, "/rename help")]);
    await f.e.receiveBatch([update(4, "/rename --help")]);
    expect(f.rpc).toEqual([
      {
        method: "thread/goal/set",
        params: {
          threadId: "thread",
          origin: "user",
          objective: "help",
          status: "active",
        },
      },
      {
        method: "thread/goal/set",
        params: {
          threadId: "thread",
          origin: "user",
          objective: "--help",
          status: "active",
        },
      },
      {
        method: "thread/name/set",
        params: { threadId: "thread", name: "help" },
      },
      {
        method: "thread/name/set",
        params: { threadId: "thread", name: "--help" },
      },
    ]);
  } finally {
    f.done();
  }
});

test("query timeouts never imply that a task may have been submitted", async () => {
  const f = engineFixture();
  f.client.call = async () => {
    throw new DeliveryUnknown("metadata timeout");
  };
  try {
    expect(await f.e.receiveBatch([update(1, "/goal")])).toBe("rejected");
    expect(f.calls.at(-1).params.text).toContain("Could not retrieve");
    expect(f.calls.at(-1).params.text).not.toContain("acceptance");
    expect(f.e.journal.status("in", "1").status).toBe("rejected");
  } finally {
    f.done();
  }
});

test("review and planning requests record the active turn immediately and stay one shot", async () => {
  const f = engineFixture();
  f.client.resume = async () => ({ model: "model", reasoningEffort: "high" });
  try {
    expect(await f.e.receiveBatch([update(1, "/plan Design a test")])).toBe(
      "handled",
    );
    expect(f.e.activeTurn).toBe("turn");
    expect(f.rpc.map((x) => x.method)).toEqual([
      "thread/settings/update",
      "turn/start",
    ]);
    await f.e.receiveBatch([update(1, "/plan Design a test")]);
    expect(f.rpc).toHaveLength(2);
    f.e.activeTurn = null;
    await f.e.receiveBatch([update(2, "/review")]);
    expect(String(f.e.activeTurn)).toBe("turn");
    await f.e.event({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: {
          type: "exitedReviewMode",
          id: "review-result",
          review: "Review complete: no findings.",
        },
      },
    });
    await f.e.event({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn" } },
    });
    expect(f.calls.at(-1).params.text).toContain(
      "Review complete: no findings.",
    );
    const count = f.calls.length;
    await f.e.event({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: {
          type: "exitedReviewMode",
          id: "review-result",
          review: "Review complete: no findings.",
        },
      },
    });
    expect(f.calls).toHaveLength(count);
  } finally {
    f.done();
  }
});

test("final forwarding includes usage reported after the final text and uses a native footer", async () => {
  const f = engineFixture();
  const event = (method: string, params: any) =>
    f.e.event({ method, params: { threadId: "thread", ...params } });
  try {
    await event("thread/tokenUsage/updated", {
      turnId: "prior",
      tokenUsage: { total: { totalTokens: 1000 } },
    });
    await event("turn/started", {
      turn: { id: "current", startedAt: Math.floor(Date.now() / 1000) - 10 },
    });
    await event("thread/tokenUsage/updated", {
      turnId: "current",
      tokenUsage: { total: { totalTokens: 1100 } },
    });
    await event("item/completed", {
      turnId: "current",
      item: {
        id: "progress",
        type: "agentMessage",
        phase: "commentary",
        text: "Progress",
      },
    });
    expect(f.calls[0].params.text).toContain(" · 0.1k · session 1.1k");
    await event("item/completed", {
      turnId: "current",
      item: {
        id: "final",
        type: "agentMessage",
        phase: "final_answer",
        text: "Done",
      },
    });
    expect(f.calls).toHaveLength(1);
    await event("thread/tokenUsage/updated", {
      turnId: "current",
      tokenUsage: { total: { totalTokens: 1250 } },
    });
    await event("turn/completed", {
      turn: { id: "current", durationMs: 12000 },
    });
    expect(f.calls[1].params.text).toBe(
      "Done\nCodex Worked 12s · 0.3k · session 1.3k",
    );
    expect(f.calls[1].params.rich_message.html).toContain(
      "<footer>Codex Worked 12s · 0.3k · session 1.3k</footer>",
    );
    await event("turn/completed", {
      turn: { id: "current", durationMs: 12000 },
    });
    expect(f.calls).toHaveLength(2);
  } finally {
    f.done();
  }
});

test("a queued final survives reconnect before first history recovery without stale token statistics", async () => {
  const f = engineFixture();
  let recovered: Engine | undefined;
  const final = {
    id: "recover-final",
    type: "agentMessage",
    phase: "final_answer",
    text: "Recovered",
  };
  try {
    await f.e.event({
      method: "turn/started",
      params: {
        threadId: "thread",
        turn: { id: "recover-turn", startedAt: 1700000000 },
      },
    });
    await f.e.event({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread",
        turnId: "recover-turn",
        tokenUsage: { total: { totalTokens: 1000 } },
      },
    });
    await f.e.event({
      method: "item/completed",
      params: { threadId: "thread", turnId: "recover-turn", item: final },
    });
    expect(f.calls).toHaveLength(0);
    const thread = {
      status: { type: "idle" },
      turns: [
        {
          id: "recover-turn",
          status: "completed",
          startedAt: 1700000000,
          durationMs: 1000,
          items: [final],
        },
      ],
    };
    f.client.resume = async () => ({ thread });
    f.client.call = async () => ({ thread, data: thread.turns });
    recovered = new Engine(f.s, "test", f.client, f.e.sender);
    await recovered.attach();
    await recovered.recover();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].params.text).toBe("Recovered\nCodex Worked 1s");
    await recovered.recover();
    expect(f.calls).toHaveLength(1);
  } finally {
    recovered?.close();
    f.done();
  }
});

test("compaction lifecycle notices are quoted, timed and deduplicated across native and legacy events", async () => {
  const f = engineFixture();
  const item = (id: string) => ({ type: "contextCompaction", id });
  const event = (method: string, value?: any) =>
    f.e.event({
      method,
      params: { threadId: "thread", turnId: "turn", item: value },
    });
  try {
    await event("item/started", item("compact"));
    const started = f.e.journal.get("compaction:compact").started;
    const message = f.e.journal.get("compaction_timer").message;
    await event("item/started", item("compact"));
    expect(f.e.journal.get("compaction:compact").started).toBe(started);
    f.e.journal.put("compaction:compact", { started: Date.now() - 12000 });
    await event("item/completed", item("compact"));
    await event("thread/compacted");
    await event("item/completed", item("compact"));
    await f.e.refreshCompaction(Date.now() + 30000);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].method).toBe("editMessageText");
    expect(f.calls[1].params.message_id).toBe(message);
    expect(f.calls[0].params.text).toBe("System\nContext compaction started.");
    expect(f.calls[1].params.text).toMatch(
      /^System\nContext compacted\. \(1[2-3]s\)$/,
    );
    expect(
      f.calls.every((c) => c.params.entities[0].type === "blockquote"),
    ).toBe(true);
    await event("item/started", item("second"));
    await event("item/completed", item("second"));
    await f.e.refreshCompaction(Date.now() + 60000);
    expect(f.calls).toHaveLength(4);
  } finally {
    f.done();
  }
});

test("recovery skips old compactions and never invents elapsed time for a missed completion", async () => {
  const f = engineFixture();
  const event = (id: string) =>
    f.e.event({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        recovered: true,
        item: { type: "contextCompaction", id },
      },
    });
  try {
    await event("old");
    expect(f.calls).toHaveLength(0);
    f.e.journal.put("compaction:pending", { started: Date.now() - 90000 });
    await event("pending");
    expect(f.calls[0].params.text).toBe("System\nContext compacted.");
    await event("pending");
    expect(f.calls).toHaveLength(1);
  } finally {
    f.done();
  }
});

test("ambiguous compaction notices are not replayed under another lifecycle event", async () => {
  const f = engineFixture();
  let attempts = 0;
  f.api.call = async () => {
    attempts++;
    throw Error("lost reply");
  };
  try {
    for (const method of [
      "thread/compacted",
      "item/completed",
      "thread/compacted",
    ])
      await f.e.event({
        method,
        params: {
          threadId: "thread",
          turnId: "turn",
          item: { type: "contextCompaction", id: "compact" },
        },
      });
    expect(attempts).toBe(1);
  } finally {
    f.done();
  }
});

test("background terminal query redacts credentials before Telegram delivery", async () => {
  const f = engineFixture();
  f.client.call = async () => ({
    data: [
      {
        processId: "job",
        command: "curl -H Authorization: Bearer abcdefghijk",
      },
    ],
    nextCursor: null,
  });
  try {
    await f.e.receiveBatch([update(1, "/ps")]);
    expect(f.calls.at(-1).params.text).not.toContain("abcdefghijk");
    expect(f.calls.at(-1).params.text).toContain("[redacted]");
  } finally {
    f.done();
  }
});

test("dual native review result events never duplicate a confirmed or ambiguous final", async () => {
  for (const ambiguous of [false, true]) {
    const f = engineFixture();
    let attempts = 0;
    const call = f.api.call;
    f.api.call = async (...args: Parameters<typeof call>) => {
      attempts++;
      if (ambiguous) throw Error("lost response");
      return call(...args);
    };
    try {
      for (const item of [
        {
          type: "agentMessage",
          id: "agent-final",
          text: "No review findings.",
          phase: null,
        },
        {
          type: "exitedReviewMode",
          id: "review-final",
          review: "No review findings.",
        },
      ])
        await f.e.event({
          method: "item/completed",
          params: { threadId: "thread", turnId: "review-turn", item },
        });
      expect(attempts).toBe(1);
    } finally {
      f.done();
    }
  }
});

test("goal commands share the bound thread, preserve pause and usage, and never prompt the model", async () => {
  const f = engineFixture();
  let goal: any = null;
  f.client.call = async (method: string, params: any) => {
    f.rpc.push({ method, params });
    expect(params.threadId).toBe("thread");
    if (method === "thread/goal/get") return { goal };
    expect(params.origin).toBe("user");
    if (method === "thread/goal/clear") {
      const cleared = !!goal;
      goal = null;
      return { cleared };
    }
    expect(method).toBe("thread/goal/set");
    goal = {
      tokensUsed: 123,
      tokenBudget: 1000,
      timeUsedSeconds: 12,
      ...goal,
      ...params,
    };
    return { goal };
  };
  try {
    for (const [id, text] of [
      [1, "/goal"],
      [2, "/goal pause"],
      [3, "/goal@fixture Fix this\n  then  test"],
      [4, "/goal pause"],
      [5, "/goal edit Revise this\n  carefully"],
    ] as const)
      expect(await f.e.receiveBatch([update(id, text)])).toBe("handled");
    expect(goal.objective).toBe("Revise this\n  carefully");
    expect(goal.status).toBe("paused");
    expect(goal.tokensUsed).toBe(123);
    expect(goal.tokenBudget).toBe(1000);
    expect(f.rpc.at(-1).params).not.toHaveProperty("status");
    await f.e.receiveBatch([update(6, "/goal resume")]);
    expect(goal.status).toBe("active");
    await f.e.receiveBatch([update(7, "/goal edit")]);
    expect(f.calls.at(-1).params.text).toContain("/goal edit OBJECTIVE");
    await f.e.receiveBatch([update(8, "/goal clear")]);
    expect(goal).toBeNull();
    await f.e.receiveBatch([update(8, "/goal clear")]);
    expect(f.rpc.filter((x) => x.method === "thread/goal/clear")).toHaveLength(
      1,
    );
    expect(f.rpc.some((x) => x.method.startsWith("turn/"))).toBe(false);
  } finally {
    f.done();
  }
});

test("goal validation makes no mutation and accepts 4000 Unicode characters", async () => {
  const f = engineFixture();
  f.client.call = async (method: string, params: any) => {
    f.rpc.push({ method, params });
    return {
      goal: method.endsWith("get")
        ? null
        : { ...params, tokensUsed: 0, timeUsedSeconds: 0 },
    };
  };
  try {
    await f.e.receiveBatch([update(1, "/goal " + "😀".repeat(4001))]);
    expect(f.rpc).toHaveLength(0);
    await f.e.receiveBatch([update(2, "/goal edit A new objective")]);
    expect(f.rpc.map((x) => x.method)).toEqual(["thread/goal/get"]);
    await f.e.receiveBatch([update(3, "/goal " + "😀".repeat(4000))]);
    expect(f.rpc.at(-1).method).toBe("thread/goal/set");
    const foreign = update(4, "/goal clear");
    foreign.message.from.id = 99;
    expect(await f.e.receiveBatch([foreign])).toBe("ignored");
    expect(f.rpc.some((x) => x.method.endsWith("clear"))).toBe(false);
  } finally {
    f.done();
  }
});

test("ambiguous goal mutation and missing reply do not repeat a command", async () => {
  for (const lostReply of [false, true]) {
    const f = engineFixture();
    let mutations = 0;
    f.client.call = async () => {
      mutations++;
      if (!lostReply) throw new DeliveryUnknown("test timeout");
      return { cleared: true };
    };
    if (lostReply)
      f.api.call = async () => {
        throw Error("lost Telegram response");
      };
    try {
      const expected = lostReply ? "reply_unknown" : "unknown";
      expect(await f.e.receiveBatch([update(1, "/goal clear")])).toBe(expected);
      expect(await f.e.receiveBatch([update(1, "/goal clear")])).toBe(expected);
      expect(mutations).toBe(1);
    } finally {
      f.done();
    }
  }
});

test("unsupported or rejected native commands have calm notices and local diagnostics", async () => {
  for (const code of [-32601, -32602]) {
    const f = engineFixture();
    f.client.call = async () => {
      throw new RpcError({ code, message: "INTERNAL test exception" });
    };
    try {
      expect(await f.e.receiveBatch([update(1, "/goal")])).toBe("rejected");
      expect(f.calls.at(-1).params.text).not.toContain("INTERNAL");
      expect(f.calls.at(-1).params.text).toContain(
        code === -32601 ? "Update Codex" : "Could not retrieve",
      );
      expect(f.e.journal.status("in", "1").details.reason).toContain(
        "INTERNAL",
      );
    } finally {
      f.done();
    }
  }
});

test("compact refuses active work; rename preserves text and both operate on the bound thread", async () => {
  const f = engineFixture();
  try {
    f.e.activeTurn = "busy";
    await f.e.receiveBatch([update(1, "/compact")]);
    expect(f.rpc).toHaveLength(0);
    f.e.activeTurn = null;
    await f.e.receiveBatch([update(2, "/compact now")]);
    await f.e.receiveBatch([update(3, "/rename")]);
    expect(f.rpc).toHaveLength(0);
    const notices = f.calls.length;
    await f.e.receiveBatch([update(4, "/compact")]);
    expect(f.calls).toHaveLength(notices);
    await f.e.receiveBatch([update(5, "/rename My  session")]);
    expect(f.rpc).toEqual([
      { method: "thread/compact/start", params: { threadId: "thread" } },
      {
        method: "thread/name/set",
        params: { threadId: "thread", name: "My  session" },
      },
    ]);
    await f.e.receiveBatch([update(5, "/rename My  session")]);
    expect(f.rpc).toHaveLength(2);
  } finally {
    f.done();
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bridge-bun-"));
  const s = new Store(root);
  s.configure(
    "test",
    "123456:fixture_token",
    { id: 123456, username: "fixture" },
    12,
    "thread",
  );
  return {
    s,
    p: s.instance("test"),
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}
function update(id = 1, text = "hello") {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1700000000,
      from: { id: 12 },
      chat: { id: 12, type: "private" },
      text,
    },
  };
}
function mockApi() {
  const api = new Telegram("123456:fixture_token");
  const calls: any[] = [];
  api.call = async (method, params) => {
    calls.push({ method, params: telegramView(params) });
    return { chat: { id: 12 }, message_id: calls.length };
  };
  return { api, calls };
}
test("existing Python fingerprint remains compatible", () => {
  const f = fixture(),
    j = new Journal(f.p);
  try {
    expect(j.fingerprint({ z: null, a: ["中文", true, 12] })).toBe(
      hash('{"a": ["中文", true, 12], "z": null}'),
    );
    j.begin("out", "old", { text: "你好" });
    j.close();
    const reopened = new Journal(f.p);
    expect(reopened.begin("out", "old", { text: "你好" })[0]).toBe(false);
    expect(() => reopened.begin("out", "old", { text: "changed" })).toThrow();
    reopened.close();
  } finally {
    f.done();
  }
});
test("private state and path traversal rejected", () => {
  const f = fixture();
  try {
    expect(statSync(join(f.p, "credential.json")).mode & 0o777).toBe(0o600);
    expect(() => f.s.instance("../x")).toThrow();
    symlinkSync(f.p, join(f.s.root, "instances", "link"));
    expect(() => f.s.instance("link")).toThrow();
  } finally {
    f.done();
  }
});
test("atomic inbox cursor and album batching survive reopen", () => {
  const f = fixture();
  let j = new Journal(f.p);
  try {
    const a: any = update(1),
      b: any = update(2);
    a.message.media_group_id = b.message.media_group_id = "group";
    j.enqueue([a, b], 3);
    expect(j.readyBatch()).toEqual([]);
    j.put("album_last:group", 0);
    const batch = j.readyBatch();
    expect(batch.length).toBe(2);
    j.close();
    j = new Journal(f.p);
    expect(j.readyBatch()).toEqual(batch);
    expect(j.get("telegram_offset")).toBe(3);
    j.handled([1, 2]);
    expect(j.pending()).toEqual([]);
  } finally {
    j.close();
    f.done();
  }
});
test("explicit send idempotency and content collision", async () => {
  const f = fixture(),
    { api, calls } = mockApi(),
    s = new Sender(f.s, "test", api);
  try {
    expect((await s.send("key", { text: "hi" })).status).toBe("sent");
    expect((await s.send("key", { text: "hi" })).status).toBe("sent");
    expect(calls.length).toBe(1);
    await expect(s.send("key", { text: "different" })).rejects.toThrow();
    expect(calls.length).toBe(1);
  } finally {
    s.journal.close();
    f.done();
  }
});
test("ambiguous send never replayed", async () => {
  const f = fixture(),
    { api } = mockApi();
  let calls = 0;
  api.call = async () => {
    calls++;
    throw Error("network");
  };
  const s = new Sender(f.s, "test", api);
  try {
    expect((await s.send("key", { text: "hi" })).status).toBe("unknown");
    expect((await s.send("key", { text: "hi" })).status).toBe("unknown");
    expect(calls).toBe(1);
  } finally {
    s.journal.close();
    f.done();
  }
});
test("rejected Telegram send retains rejection", async () => {
  const f = fixture(),
    { api } = mockApi();
  api.call = async () => {
    throw new TelegramError(400, "bad request");
  };
  const s = new Sender(f.s, "test", api);
  try {
    expect((await s.send("key", { text: "hi" })).details.error_code).toBe(400);
  } finally {
    s.journal.close();
    f.done();
  }
});
test("uploads restricted; ambiguous snapshot retained", async () => {
  const f = fixture(),
    { api } = mockApi();
  api.call = async () => {
    throw Error("network");
  };
  const s = new Sender(f.s, "test", api);
  try {
    const file = join(f.p, "outgoing", "file.txt");
    writeFileSync(file, "payload");
    await expect(
      s.send("bad", { file: join(f.p, "credential.json") }),
    ).rejects.toThrow();
    const r = await s.send("file", { file });
    expect(r.status).toBe("unknown");
    expect(readFileSync(r.details.retained_upload, "utf8")).toBe("payload");
    expect(statSync(r.details.retained_upload).mode & 0o777).toBe(0o600);
    expect((await s.send("file", { file })).details.retained_upload).toBe(
      r.details.retained_upload,
    );
  } finally {
    s.journal.close();
    f.done();
  }
});
function engineFixture() {
  const f = fixture(),
    { api, calls } = mockApi(),
    sender = new Sender(f.s, "test", api);
  const rpc: any[] = [];
  const client: any = {
    send: (x: any) => rpc.push(x),
    call: async (method: string, params: any) => {
      rpc.push({ method, params });
      return {
        turn: { id: "turn" },
        thread: { status: { type: "idle" }, turns: [] },
      };
    },
    resume: async () => ({ thread: { status: { type: "idle" }, turns: [] } }),
  };
  const e = new Engine(f.s, "test", client, sender);
  return {
    ...f,
    e,
    api,
    calls,
    rpc,
    client,
    done: () => {
      e.close();
      sender.journal.close();
      f.done();
    },
  };
}
test("foreign user and group ignored before any mutation", async () => {
  const f = engineFixture();
  try {
    const invalid = [
      { from: { id: 99 } },
      { chat: { id: 99, type: "private" } },
      { chat: { id: 12, type: "group" } },
      { chat: { id: 12, type: "supergroup" } },
      { from: { id: 12, is_bot: true } },
      { from: undefined },
    ];
    for (const fields of invalid) {
      for (const content of [
        { text: "/start" },
        { text: "/help" },
        { photo: [{ file_id: "never-download" }], text: undefined },
      ]) {
        const u = update();
        Object.assign(u.message, fields, content);
        expect(await f.e.receiveBatch([u])).toBe("ignored");
      }
    }
    expect(f.rpc.length).toBe(0);
    expect(f.calls.length).toBe(0);
    expect(f.e.journal.status("in", "1").status).toBe("not_found");
  } finally {
    f.done();
  }
});
test("idle starts once, busy steers consecutive messages", async () => {
  const f = engineFixture();
  try {
    await f.e.receiveBatch([update()]);
    await f.e.receiveBatch([update(2)]);
    await f.e.receiveBatch([update(3)]);
    expect(f.rpc.map((x) => x.method)).toEqual([
      "turn/start",
      "turn/steer",
      "turn/steer",
    ]);
    await f.e.receiveBatch([update(1)]);
    expect(f.rpc.length).toBe(3);
  } finally {
    f.done();
  }
});
test("compact steer rejection queues each input once without a warning", async () => {
  const f = engineFixture();
  try {
    f.e.started("compact");
    f.client.call = async (method: string, params: any) => {
      f.rpc.push({ method, params });
      if (method === "turn/steer")
        throw new RpcError({ code: -32600, message: "cannot steer a compact turn" });
      return { id: "queued" };
    };
    expect(await f.e.receiveBatch([update()])).toBe("accepted");
    expect(await f.e.receiveBatch([update()])).toBe("accepted");
    expect(await f.e.receiveBatch([update(2, "next")])).toBe("accepted");
    expect(f.rpc.map((r) => r.method)).toEqual([
      "turn/steer", "thread/queue/add", "turn/steer", "thread/queue/add",
    ]);
    expect(f.rpc[1].params.input).toEqual(f.rpc[0].params.input);
    expect(f.rpc[1].params.clientUserMessageId).toBe(f.rpc[0].params.clientUserMessageId);
    expect(f.rpc[3].params.clientUserMessageId).not.toBe(f.rpc[1].params.clientUserMessageId);
    expect(f.e.activeTurn).toBe("compact");
    expect(f.calls).toHaveLength(0);
  } finally {
    f.done();
  }
});

test("stale turn rejection queues the same input once without exposing turn IDs", async () => {
  const f = engineFixture();
  try {
    f.e.started("old-turn");
    f.client.call = async (method: string, params: any) => {
      f.rpc.push({ method, params });
      if (method === "turn/steer")
        throw new RpcError({ code: -32600, message: "expected active turn id old-turn but found `new-turn`" });
      return { id: "queued" };
    };
    expect(await f.e.receiveBatch([update()])).toBe("accepted");
    expect(await f.e.receiveBatch([update()])).toBe("accepted");
    expect(f.rpc.map(r => r.method)).toEqual(["turn/steer", "thread/queue/add"]);
    expect(f.rpc[1].params.clientUserMessageId).toBe(f.rpc[0].params.clientUserMessageId);
    expect(f.rpc[1].params.input).toEqual(f.rpc[0].params.input);
    expect(f.calls).toHaveLength(0);
  } finally { f.done(); }
});
test("unknown queue acceptance after stale turn rejection is never replayed", async () => {
  const f = engineFixture();
  try {
    f.e.started("old-turn");
    f.client.call = async (method: string) => {
      f.rpc.push(method);
      if (method === "turn/steer")
        throw new RpcError({ code: -32600, message: "expected active turn id old-turn but found `new-turn`" });
      throw new DeliveryUnknown("timeout");
    };
    expect(await f.e.receiveBatch([update()])).toBe("unknown");
    await f.e.receiveBatch([update()]);
    expect(f.rpc).toEqual(["turn/steer", "thread/queue/add"]);
  } finally { f.done(); }
});
test("other RPC rejections stay rejected and keep diagnostics private", async () => {
  const f = engineFixture();
  try {
    f.e.started("old-turn");
    f.client.call = async (method: string) => {
      f.rpc.push(method);
      throw new RpcError({ code: -32603, message: "expected active turn id private-turn but found `other-turn`" });
    };
    expect(await f.e.receiveBatch([update()])).toBe("rejected");
    expect(f.rpc).toEqual(["turn/steer"]);
    expect(JSON.stringify(f.calls)).not.toContain("private-turn");
    expect(f.e.journal.status("in", "1").status).toBe("rejected");
  } finally { f.done(); }
});

test("only explicit no-active rejection allows steer fallback", async () => {
  const f = engineFixture();
  try {
    f.e.started("old");
    f.client.call = async (method: string) => {
      f.rpc.push(method);
      if (method === "turn/steer")
        throw new RpcError({
          code: -32600,
          message: "no active turn to steer",
        });
      return { turn: { id: "new" } };
    };
    expect(await f.e.receiveBatch([update()])).toBe("accepted");
    expect(f.rpc).toEqual(["turn/steer", "turn/start"]);
    expect(f.e.activeTurn).toBe("new");
  } finally {
    f.done();
  }
});
test("ambiguous Codex acceptance does not start another turn", async () => {
  const f = engineFixture();
  try {
    f.e.started("old");
    f.client.call = async () => {
      f.rpc.push(1);
      throw new DeliveryUnknown("timeout");
    };
    expect(await f.e.receiveBatch([update()])).toBe("unknown");
    await f.e.receiveBatch([update()]);
    expect(f.rpc.length).toBe(1);
  } finally {
    f.done();
  }
});
test("oversized media is rejected before Codex and never unknown", async () => {
  const f = engineFixture();
  try {
    const u: any = update();
    u.message.document = { file_id: "id", file_size: 55 * 1024 * 1024 };
    expect(await f.e.receiveBatch([u])).toBe("rejected");
    expect(f.rpc.length).toBe(0);
    expect(f.e.journal.status("in", "1").status).toBe("rejected");
  } finally {
    f.done();
  }
});
test("album keeps all IDs and image inputs in one submission", async () => {
  const f = engineFixture();
  try {
    f.api.download = async (id) => "/private/" + id + ".jpg";
    const rows = [update(1), update(2), update(3)] as any[];
    for (const u of rows)
      u.message.photo = [
        { file_id: String(u.update_id), width: 10, height: 10 },
      ];
    await f.e.receiveBatch(rows);
    const input = f.rpc[0].params.input;
    expect(input.filter((i: any) => i.type === "localImage").length).toBe(3);
    for (const id of [1, 2, 3])
      expect(input.some((i: any) => i.text?.includes(`12:${id};`))).toBe(true);
    expect(f.rpc.length).toBe(1);
  } finally {
    f.done();
  }
});
test("public commentary delivered once; reasoning never sent", async () => {
  const f = engineFixture();
  try {
    const event = {
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "t",
        item: {
          id: "i",
          type: "agentMessage",
          phase: "commentary",
          text: "working",
        },
      },
    };
    await f.e.event(event);
    await f.e.event(event);
    await f.e.event({
      ...event,
      params: {
        ...event.params,
        item: { id: "r", type: "reasoning", text: "secret" },
      },
    });
    expect(f.calls.length).toBe(1);
    expect(f.calls[0].params.text).toBe("working");
  } finally {
    f.done();
  }
});
test("explicit tool text suppresses identical final delivery", async () => {
  const f = engineFixture();
  try {
    f.e.started("t");
    await f.e.sender.send("explicit", { text: "finished" });
    await f.e.event({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "t",
        item: { id: "i", type: "agentMessage", text: "finished" },
      },
    });
    expect(f.calls.length).toBe(1);
  } finally {
    f.done();
  }
});
test("approval is one shot and cancellation respects offered choices", async () => {
  const sent: any[] = [],
    messages: any[] = [];
  const i = new Interactions(
    { send: (x: any) => sent.push(x) } as any,
    async (_k, t) => messages.push(t),
    String,
  );
  await i.request({
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: { turnId: "t", availableDecisions: ["accept", "cancel"] },
  });
  const key = [...i.pending.keys()][0];
  expect(i.respond("/deny", key)).toContain("interrupt");
  expect(sent[0].result.decision).toBe("cancel");
  i.respond("/approve", key);
  expect(sent.length).toBe(1);
  i.resolve(1);
  expect(i.respond("/approve", key)).toContain("expired");
});
test("secret questions cannot be answered over Telegram", async () => {
  const i = new Interactions(
    {
      send: () => {
        throw Error("must not send");
      },
    } as any,
    async () => {},
    String,
  );
  await i.request({
    id: 1,
    method: "item/tool/requestUserInput",
    params: { questions: [{ id: "q", question: "password", isSecret: true }] },
  });
  expect(
    i.respond("/answer", [...i.pending.keys()][0] + " 1 secret"),
  ).toContain("terminal");
});
test("unicode chunks respect UTF16 limits", () => {
  const parts = chunks("😀".repeat(4000));
  expect(parts.join("")).toBe("😀".repeat(4000));
  expect(parts.every((p) => p.length <= 3800)).toBe(true);
});
test("Bun installation bundles JS only and uninstall retains credentials on request", async () => {
  const f = fixture();
  let installed: any[] = [];
  const runner = async (...args: string[]) => {
    if (args[0] === "list") return { installed };
    if (args[0] === "add") {
      const selector = args[1].split("@")[0];
      const path = join(f.s.root, "plugins", selector, "plugins", selector);
      installed = [{ pluginId: args[1], installed: true }];
      return { installedPath: path };
    }
    if (args[0] === "marketplace" && args[1] === "list")
      return { marketplaces: [] };
    return {};
  };
  try {
    const result = await install(f.s, "test", false, runner);
    expect(result.runtime).toBe("bun");
    const receipt = JSON.parse(
      readFileSync(join(f.p, "installation.json"), "utf8"),
    );
    expect(statSync(join(receipt.runtime, "bridge.js")).size).toBeLessThan(
      4 * 1024 * 1024,
    );
    expect(
      readFileSync(join(receipt.runtime, "codex-telegram"), "utf8"),
    ).toContain("bun");
    await uninstall(f.s, "test", true, runner);
    expect(f.s.token("test")).toBe("123456:fixture_token");
    expect(f.s.read("test").enabled).toBe(false);
  } finally {
    f.done();
  }
});

test("legacy structured error receipt survives Bun recovery without replay", async () => {
  const f = engineFixture();
  try {
    const error = {
      message: "older failure",
      details: { retry: false, code: 1 },
    };
    const key = "bridge-" + hash("turn-error-old").slice(0, 40) + "-0";
    const text =
      '⚠️ Turn failed:\n{"message": "older failure", "details": {"retry": false, "code": 1}}';
    const fp = {
      chat_id: 12,
      text,
      kind: "document",
      caption: "",
      reply_to: null,
      edit_id: null,
    };
    f.e.journal.begin("out", key, fp);
    f.e.journal.finish("out", key, "sent", { message_id: 99 });
    await f.e.event({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "old", error } },
    });
    expect(f.calls.length).toBe(0);
    expect(f.e.journal.status("out", key).details.message_id).toBe(99);
  } finally {
    f.done();
  }
});

test("fresh loaded session without rollout accepts first message; unrelated resume errors still fail", async () => {
  const f = engineFixture();
  try {
    f.client.resume = async () => {
      throw new RpcError({
        code: -32600,
        message: "no rollout found for thread id thread",
      });
    };
    await f.e.attach();
    expect(f.e.waitingForHistory).toBe(true);
    await f.e.recover();
    expect(f.rpc.some((x) => x.params?.includeTurns === true)).toBe(false);
    await f.e.receiveBatch([update()]);
    expect(f.rpc.some((x) => x.method === "turn/start")).toBe(true);
    f.client.resume = async () => ({
      thread: { status: { type: "idle" }, turns: [] },
    });
    await f.e.attach();
    expect(f.e.waitingForHistory).toBe(false);
    f.client.resume = async () => {
      throw new RpcError({ code: -32600, message: "permission denied" });
    };
    await expect(f.e.attach()).rejects.toThrow("permission denied");
  } finally {
    f.done();
  }
});

test("command reply failure is distinct from handled and is not blindly resent", async () => {
  const f = engineFixture();
  try {
    f.api.call = async () => {
      throw Error("socket reset");
    };
    expect(await f.e.receiveBatch([update(19, "/status")])).toBe(
      "reply_unknown",
    );
    const receipt = f.e.journal.status("in", "19");
    expect(receipt.status).toBe("reply_unknown");
    expect(receipt.details.reply.details.error).toContain("socket reset");
    expect(f.e.journal.get("last_outbound").status).toBe("unknown");
    f.api.call = async () => {
      throw Error("must not resend");
    };
    expect(await f.e.receiveBatch([update(19, "/status")])).toBe(
      "reply_unknown",
    );
  } finally {
    f.done();
  }
});

test("formatted sends, edits and captions have no headings; system messages are quoted", async () => {
  const f = fixture(),
    { api, calls } = mockApi(),
    sender = new Sender(f.s, "test", api);
  try {
    await sender.send("rich", { text: "**bold** `code`", source: "working" });
    expect(calls[0].params.text).toBe("bold code");
    expect(calls[0].params.entities.map((e: any) => e.type)).toEqual([
      "bold",
      "code",
    ]);
    expect(calls[0].params.parse_mode).toBeUndefined();
    await sender.send("edit", { text: "_edited_", edit_id: 1 });
    expect(calls[1].method).toBe("editMessageText");
    expect(calls[1].params.text).toBe("edited");
    expect(calls[1].params.entities[0].type).toBe("italic");
    const file = join(f.p, "outgoing", "sample.txt");
    writeFileSync(file, "sample");
    await sender.send("caption", { file, caption: "**Attachment**" });
    expect(calls[2].params.caption).toBe("Attachment");
    expect(calls[2].params.caption_entities[0].type).toBe("bold");
    await sender.send("system", {
      text: "**literal** `diagnostic`",
      source: "system",
    });
    expect(calls[3].params.text).toBe("System\n**literal** `diagnostic`");
    expect(calls[3].params.entities).toHaveLength(2);
    await expect(
      sender.send("rich", { text: "**bold** `code`", source: "codex" }),
    ).rejects.toThrow("different content");
  } finally {
    sender.journal.close();
    f.done();
  }
});

test("multipart sends record all receipts and never replay after ambiguous partial delivery", async () => {
  const f = fixture(),
    { api, calls } = mockApi(),
    sender = new Sender(f.s, "test", api);
  const normal = api.call.bind(api);
  let attempts = 0;
  api.call = async (...args) => {
    if (++attempts === 2) throw Error("network after first part");
    return normal(...args);
  };
  try {
    const options = {
      text: "```ts\n" + "😀x\n".repeat(18000) + "```",
      reply_to: 42,
    };
    const result = await sender.send("partial", options);
    expect(result.status).toBe("unknown");
    expect(result.details.message_ids).toEqual([1]);
    expect(result.details.failed_part).toBe(1);
    expect(
      sender.journal.status("out", `part-${hash("partial")}-0`).status,
    ).toBe("sent");
    expect(
      sender.journal.status("out", `part-${hash("partial")}-1`).status,
    ).toBe("unknown");
    expect(await sender.send("partial", options)).toEqual(result);
    expect(attempts).toBe(2);
    expect(calls[0].params.reply_parameters.message_id).toBe(42);
  } finally {
    sender.journal.close();
    f.done();
  }
});

test("successful multipart sends expose all message IDs and suppress identical automatic finals", async () => {
  const f = engineFixture();
  try {
    f.e.started("long-turn");
    const text = "**" + "😀".repeat(40000) + "**";
    const result = await f.e.sender.send("long-explicit", { text });
    expect(result.status).toBe("sent");
    expect(result.details.message_ids).toHaveLength(3);
    expect(await f.e.sender.send("long-explicit", { text })).toEqual(result);
    await f.e.event({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "long-turn",
        item: {
          id: "long-final",
          type: "agentMessage",
          phase: "final_answer",
          text,
        },
      },
    });
    expect(f.calls).toHaveLength(3);
    for (const call of f.calls) {
      expect(call.params.text.length).toBeLessThanOrEqual(32768);
      expect(call.params.text).not.toContain("[CODEX");
      expect(call.params.entities[0].type).toBe("bold");
    }
  } finally {
    f.done();
  }
});

test("old unknown receipts survive formatting upgrade without a resend", async () => {
  const f = fixture(),
    { api, calls } = mockApi(),
    sender = new Sender(f.s, "test", api);
  try {
    sender.journal.begin("out", "legacy-unknown", {
      chat_id: 12,
      text: "**old**",
      kind: "document",
      caption: "",
      reply_to: null,
      edit_id: null,
    });
    expect(
      (await sender.send("legacy-unknown", { text: "**old**" })).status,
    ).toBe("unknown");
    expect(calls).toHaveLength(0);
  } finally {
    sender.journal.close();
    f.done();
  }
});

test("oversized formatted edits and captions fail before network calls", async () => {
  const f = fixture(),
    { api, calls } = mockApi(),
    sender = new Sender(f.s, "test", api);
  try {
    await expect(
      sender.send("large-edit", { text: "x".repeat(32769), edit_id: 1 }),
    ).rejects.toThrow("Edited message exceeds");
    const file = join(f.p, "outgoing", "sample.txt");
    writeFileSync(file, "sample");
    await expect(
      sender.send("large-caption", { file, caption: "x".repeat(1025) }),
    ).rejects.toThrow("Formatted caption exceeds");
    expect(calls).toHaveLength(0);
    expect(sender.journal.status("out", "large-edit").status).toBe("not_found");
  } finally {
    sender.journal.close();
    f.done();
  }
});

test("automatic replies have no headings and command replies use native quotes", async () => {
  const f = engineFixture();
  try {
    await f.e.event({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "t",
        item: {
          id: "final",
          type: "agentMessage",
          phase: "final_answer",
          text: "**Done**",
        },
      },
    });
    await f.e.command("help", "/help");
    expect(f.calls[0].params.text).toBe("Done");
    expect(f.calls[1].params.entities[0].type).toBe("blockquote");
  } finally {
    f.done();
  }
});

test("legacy long automatic replies keep their original chunk receipts during recovery", async () => {
  const f = engineFixture();
  try {
    const text = "x".repeat(8000);
    const base = "bridge-" + hash("item-legacy-long").slice(0, 40);
    const old = chunks(text);
    for (const [i, part] of old.entries()) {
      f.e.journal.begin("out", `${base}-${i}`, {
        chat_id: 12,
        text: part,
        kind: "document",
        caption: "",
        reply_to: null,
        edit_id: null,
      });
      f.e.journal.finish("out", `${base}-${i}`, "sent", { message_id: i + 1 });
    }
    await f.e.event({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "t",
        item: { id: "legacy-long", type: "agentMessage", text },
      },
    });
    expect(f.calls).toHaveLength(0);
    expect(f.e.journal.get("delivered_item:legacy-long")).toBe(true);
  } finally {
    f.done();
  }
});

test("intermediate tool failures stay local while a failed turn still notifies Telegram", async () => {
  const f = engineFixture();
  try {
    for (const item of [
      {
        id: "shell",
        type: "commandExecution",
        exitCode: 1,
        command: "test",
        aggregatedOutput: "token=private-value",
      },
      {
        id: "mcp",
        type: "mcpToolCall",
        tool: "check",
        result: { isError: true },
      },
      {
        id: "dynamic",
        type: "dynamicToolCall",
        tool: "check",
        success: false,
        contentItems: [],
      },
      { id: "file", type: "fileChange", status: "failed" },
    ]) {
      await f.e.event({
        method: "item/completed",
        params: { threadId: "thread", turnId: "t", item },
      });
      expect(f.e.journal.get("last_tool_error").item_id).toBe(item.id);
      expect(JSON.stringify(f.e.journal.get("last_tool_error"))).not.toContain(
        "private-value",
      );
    }
    expect(f.calls).toHaveLength(0);
    await f.e.event({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: { id: "t", error: { message: "task failed" } },
      },
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].params.text).toContain("⚠️ Turn failed:");
  } finally {
    f.done();
  }
});

test("task timing uses server timestamps and survives completion before final forwarding", async () => {
  const f = engineFixture();
  const { recordTurnTiming, elapsedSeconds } = await import("../bun/timing");
  try {
    const startedAt = Math.floor(Date.now() / 1000) - 83;
    await f.e.event({
      method: "turn/started",
      params: {
        threadId: "thread",
        turn: { id: "timed", startedAt },
      },
    });
    expect(f.e.journal.get("turn_timing:timed").started_at).toBe(
      startedAt * 1000,
    );
    expect(elapsedSeconds(f.e.journal)).toBeGreaterThanOrEqual(83);
    await f.e.event({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "timed",
        item: {
          id: "timed-progress",
          type: "agentMessage",
          phase: "commentary",
          text: "Checking",
        },
      },
    });
    expect(f.calls[0].params.text).toMatch(/^Checking\nCodex Working 1m \d+s$/);
    recordTurnTiming(f.e.journal, { id: "timed" }, true);
    expect(f.e.journal.get("turn_timing:timed").started_at).toBe(
      startedAt * 1000,
    );
    await f.e.event({
      method: "turn/completed",
      params: {
        threadId: "thread",
        turn: {
          id: "timed",
          startedAt,
          completedAt: startedAt + 125,
          durationMs: 125000,
        },
      },
    });
    expect(f.e.journal.get("active_turn")).toBeNull();
    await f.e.event({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "timed",
        item: {
          id: "timed-final",
          type: "agentMessage",
          phase: "final_answer",
          text: "Done",
        },
      },
    });
    expect(f.calls[1].params.text).toBe("Done\nCodex Worked 2m 5s");
    const reopened = new Journal(f.p);
    try {
      expect(elapsedSeconds(reopened, "timed")).toBe(125);
    } finally {
      reopened.close();
    }
  } finally {
    f.done();
  }
});

test("attaching to an existing task restores its clock for direct progress messages", async () => {
  const f = engineFixture();
  try {
    const startedAt = Math.floor(Date.now() / 1000) - 20;
    f.client.resume = async () => ({
      thread: {
        status: { type: "active" },
        turns: [
          {
            id: "existing",
            status: "inProgress",
            startedAt,
          },
        ],
      },
    });
    await f.e.attach();
    const first = f.e.journal.get("turn_timing:existing").started_at;
    await f.e.attach();
    expect(f.e.journal.get("turn_timing:existing").started_at).toBe(first);
    await f.e.sender.send("timed-direct", {
      text: "Progress",
      source: "working",
    });
    expect(f.calls[0].params.text).toMatch(/^Progress\nCodex Working \d+s$/);
    expect(
      (
        await f.e.sender.send("timed-direct", {
          text: "Progress",
          source: "working",
        })
      ).status,
    ).toBe("sent");
    expect(f.calls).toHaveLength(1);
  } finally {
    f.done();
  }
});

test("unlabelled messages and captions use the full Telegram limits", async () => {
  const f = fixture(),
    { api, calls } = mockApi(),
    sender = new Sender(f.s, "test", api);
  try {
    await sender.send("full-edit", { text: "x".repeat(4096), edit_id: 1 });
    expect(calls[0].params.text.length).toBe(4096);
    const file = join(f.p, "outgoing", "full.txt");
    writeFileSync(file, "sample");
    await sender.send("full-caption", { file, caption: "x".repeat(1024) });
    expect(calls[1].params.caption.length).toBe(1024);
    await expect(
      sender.send("invisible", { text: "[ref]: https://example.com" }),
    ).rejects.toThrow("no visible content");
    expect(calls).toHaveLength(2);
  } finally {
    sender.journal.close();
    f.done();
  }
});

test("async choice questions are forwarded before turn completion and answered through the bound session", async () => {
  const f = engineFixture();
  try {
    await f.e.event({
      method: "turn/started",
      params: { threadId: "thread", turn: { id: "turn" } },
    });
    await f.e.event({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: {
          id: "async-choice",
          type: "agentMessage",
          phase: "final_answer",
          text: "",
          questions: [{ title: "Which layout?", options: ["One", "Two"] }],
        },
      },
    });
    expect(f.calls).toHaveLength(1);
    const text = f.calls[0].params.text;
    expect(text).toContain("One");
    expect(text).toContain("Two");
    const code = /aq-[a-f0-9]+/.exec(text)![0];
    expect(f.e.journal.get("pending_final:turn", [])).toEqual([]);
    await f.e.command("answer-async", `/answer ${code} 1 2`);
    expect(f.rpc.at(-1).method).toBe("turn/steer");
    expect(f.rpc.at(-1).params.threadId).toBe("thread");
    expect(f.rpc.at(-1).params.expectedTurnId).toBe("turn");
    expect(f.rpc.at(-1).params.input[0].text).toContain('"answer":"Two"');
  } finally {
    f.done();
  }
});

test("compaction timer edits the confirmed start message and stops on completion", async () => {
  const f = engineFixture();
  try {
    await f.e.event({
      method: "item/started",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: { type: "contextCompaction", id: "timer" },
      },
    });
    const timer = f.e.journal.get("compaction_timer");
    f.e.journal.put("compaction_timer", {
      ...timer,
      next: timer.started + 1000,
    });
    await f.e.refreshCompaction(timer.started + 3000);
    expect(f.calls.at(-1).method).toBe("editMessageText");
    expect(f.calls.at(-1).params.message_id).toBe(timer.message);
    expect(f.calls.at(-1).params.text).toBe("System\nCompacting context… (3s)");
    expect(f.calls.at(-1).params.entities[0].type).toBe("blockquote");
    const count = f.calls.length;
    await f.e.refreshCompaction(timer.started + 3001);
    expect(f.calls).toHaveLength(count);
    await f.e.event({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: { type: "contextCompaction", id: "timer" },
      },
    });
    f.e.journal.put("working_edit_after", 0);
    await f.e.refreshCompaction(timer.started + 16000);
    expect(f.calls.at(-1).params.text).toContain("Context compacted.");
    expect(f.calls.filter((call) => !call.method.startsWith("edit"))).toHaveLength(1);
    expect(f.e.journal.get("compaction_timer")).toBeNull();
    const finalCount = f.calls.length;
    await f.e.refreshCompaction(timer.started + 17000);
    expect(f.calls).toHaveLength(finalCount);
  } finally {
    f.done();
  }
});

test("questions command is a local query with copyable IDs and answer commands; status follows external answers", async () => {
  const f = engineFixture();
  try {
    await f.e.questions.offer(
      {
        id: "copyable",
        questions: [
          { title: "Choose layout", options: ["One", "Two"] },
          { title: "Keep tools?", options: ["Yes", "No"] },
        ],
      },
      "turn",
    );
    f.client.call = async () => {
      throw Error("Questions query must not call Codex");
    };
    await f.e.command("list-questions", "/questions");
    const prompt = f.calls.at(-1).params;
    expect(prompt.rich_message.html).toContain(
      '<tg-button type="copy_text" text="aq-',
    );
    expect(prompt.rich_message.html).toContain(
      '<tg-button type="copy_text" text="/answer aq-',
    );
    expect(prompt.text).toContain("Choose layout");
    f.e.questions.resolveInput({
      type: "userMessage",
      content: [
        {
          type: "text",
          text:
            "<send_user_message_question_reply>\n" +
            JSON.stringify([
              {
                questionItemId: JSON.stringify([
                  "request_user_input_async",
                  "copyable",
                  0,
                ]),
                answer: "One",
              },
            ]) +
            "\n</send_user_message_question_reply>",
        },
      ],
    });
    expect(f.e.questions.list()).not.toContain("Choose layout");
    expect(f.e.questions.list()).toContain("Keep tools");
  } finally {
    f.done();
  }
});

test("goal and pending input status comes from events and excludes already answered fields", async () => {
  const f = engineFixture();
  try {
    const { statusline } = await import("../bun/statusline");
    await f.e.event({
      method: "thread/goal/updated",
      params: { threadId: "thread", goal: { status: "paused" } },
    });
    expect(statusline(f.e.journal, "thread").goal).toBe("paused");
    await f.e.questions.offer(
      {
        id: "pending-status",
        questions: [
          { title: "First", options: [] },
          { title: "Second", options: [] },
        ],
      },
      "turn",
    );
    expect(statusline(f.e.journal, "thread").questions).toBe(2);
    const code = "aq-" + hash("thread" + "pending-status").slice(0, 8);
    await f.e.questions.answer(`${code} 1 yes`, "turn");
    expect(statusline(f.e.journal, "thread").questions).toBe(1);
    f.e.interactions.pending.set("blocking", {
      method: "item/tool/requestUserInput",
      answers: {},
      params: {
        questions: [
          { id: "live", question: "Live choice", options: [{ label: "A" }] },
        ],
      },
    });
    f.e.syncQuestionStatus();
    expect(statusline(f.e.journal, "thread").questions).toBe(2);
    await f.e.event({
      method: "thread/goal/cleared",
      params: { threadId: "thread" },
    });
    expect(statusline(f.e.journal, "thread").goal).toBeUndefined();
  } finally {
    f.done();
  }
});

test("statusline follows model settings events and ignores foreign threads", async () => {
  const { statusline } = await import("../bun/statusline");
  const f = engineFixture();
  try {
    await f.e.event({
      method: "thread/settings/updated",
      params: {
        threadId: "thread",
        threadSettings: { model: "gpt-test", effort: "high" },
      },
    });
    expect(statusline(f.e.journal, "thread")).toMatchObject({
      model: "gpt-test",
      effort: "high",
    });
    await f.e.event({
      method: "thread/settings/updated",
      params: {
        threadId: "foreign",
        threadSettings: { model: "other", effort: "low" },
      },
    });
    expect(statusline(f.e.journal, "thread").model).toBe("gpt-test");
  } finally {
    f.done();
  }
});

test("an active session without a known turn queues input rather than starting a conflicting turn", async () => {
  const f = engineFixture();
  try {
    f.e.status = "active";
    f.e.activeTurn = null;
    expect(await f.e.receiveBatch([update()])).toBe("accepted");
    expect(await f.e.receiveBatch([update()])).toBe("accepted");
    expect(f.rpc.map((r) => r.method)).toEqual(["thread/queue/add"]);
    expect(f.rpc[0].params.clientUserMessageId).toBeString();
  } finally { f.done(); }
});
