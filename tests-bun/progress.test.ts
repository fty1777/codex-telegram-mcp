import { telegramView } from "./telegram-view";
import { test, expect, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, atomic } from "../bun/state";
import { Sender, Telegram, TelegramError } from "../bun/telegram";
import { recordUsage, startUsage, reconnectUsage } from "../bun/usage";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telegram-progress-"));
  const store = new Store(root);
  store.configure(
    "test",
    "123456:fixture",
    { id: 123456, username: "test" },
    12,
    "thread",
  );
  const api = new Telegram("123456:fixture"),
    calls: any[] = [];
  let failure: any, delay: (() => Promise<void>) | undefined;
  api.call = async (method, params) => {
    calls.push({ method, params: telegramView(params) });
    if (method === "editMessageText") {
      if (delay) await delay();
      if (failure) throw failure;
    }
    return { message_id: params.message_id ?? calls.length, chat: { id: 12 } };
  };
  const sender = new Sender(store, "test", api),
    j = sender.journal;
  j.put("working_refresh_interval", 1000);
  setSystemTime(new Date("2026-01-01T00:00:00Z"));
  recordUsage(j, "thread", "prior", {
    total: {
      totalTokens: 1000,
      inputTokens: 900,
      cachedInputTokens: 700,
      outputTokens: 100,
    },
  });
  startUsage(j, "thread", "turn");
  j.put("active_turn", "turn");
  j.put("turn_timing:turn", { started_at: Date.now() - 10000 });
  return {
    sender,
    store,
    calls,
    j,
    api,
    failure(value: any) {
      failure = value;
    },
    delay(value: () => Promise<void>) {
      delay = value;
    },
    advance(ms = 1000) {
      setSystemTime(new Date(Date.now() + ms));
    },
    close() {
      sender.journal.close();
      setSystemTime();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("working counter edits at most once per second, preserves rich body, and uses latest usage", async () => {
  const f = fixture();
  try {
    await f.sender.send("working", {
      source: "working",
      text: "**Progress** 😀 `code`",
      turn_id: "turn",
    });
    const original = f.calls[0].params;
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(1);
    f.advance();
    recordUsage(f.j, "thread", "turn", {
      total: {
        totalTokens: 1500,
        inputTokens: 1300,
        cachedInputTokens: 1000,
        outputTokens: 200,
      },
    });
    await f.sender.refreshWorking();
    const edit = f.calls[1];
    expect(edit.method).toBe("editMessageText");
    expect(edit.params.message_id).toBe(1);
    expect(edit.params.text).toContain(
      "Progress 😀 code\nCodex Working 11s · ↑0.1k c0.3k ↓0.1k · session ↑0.3k c1.0k ↓0.2k",
    );
    expect(edit.params.entities.slice(0, 2)).toEqual(
      original.entities.slice(0, 2),
    );
    expect(edit.params.entities.at(-1).type).toBe("footer");
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(2);
    // Freeze and stop immediately on completion; no extra message is sent.
    f.sender.finishWorking("turn");
    f.advance();
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(2);
  } finally {
    f.close();
  }
});

test("only the latest working tail is edited, without changing multipart body or final messages", async () => {
  const f = fixture();
  try {
    await f.sender.send("old", { source: "working", text: "Old" });
    await f.sender.send("long", {
      source: "working",
      text: "**😀 progress** ".repeat(900),
    });
    const count = f.calls.length,
      tail = f.calls.at(-1).params;
    const body = tail.text.slice(0, tail.text.lastIndexOf("\nCodex Working "));
    f.advance();
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(count + 1);
    expect(f.calls.at(-1).params.message_id).toBe(count);
    expect(
      f.calls.at(-1).params.text.startsWith(body + "\nCodex Working "),
    ).toBe(true);
    expect(f.calls.at(-1).params.text.length).toBeLessThanOrEqual(32768);
    f.sender.finishWorking("turn");
    await f.sender.send("final", {
      source: "codex",
      text: "Done",
      turn_id: "turn",
    });
    f.advance();
    await f.sender.refreshWorking();
    expect(f.calls.at(-1).method).toBe("sendRichMessage");
  } finally {
    f.close();
  }
});

test("unchanged counters skip edits and 429 respects retry_after across newer working messages", async () => {
  const f = fixture();
  try {
    await f.sender.send("initial", { source: "working", text: "Progress" });
    await f.sender.refreshWorking(Date.now() + 1000); // clock and rendered values unchanged
    expect(f.calls).toHaveLength(1);
    f.advance();
    f.failure(new TelegramError(429, "Too many requests", 5));
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(2);
    await f.sender.send("new", { source: "working", text: "New progress" });
    f.failure(undefined);
    f.advance(4000);
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(2); // the new send also waits for the shared deadline
    f.advance();
    await f.sender.retryDeferred();
    expect(f.calls).toHaveLength(3);
    f.advance();
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(4);
    expect(f.calls.at(-1).params.message_id).toBe(3);
  } finally {
    f.close();
  }
});

test("unknown edit versions are retained, terminal edits suspend, and not-modified is harmless", async () => {
  for (const failure of [
    new Error("response lost"),
    new TelegramError(400, "message to edit not found"),
  ]) {
    const f = fixture();
    try {
      await f.sender.send("progress", { source: "working", text: "Progress" });
      f.failure(failure);
      f.advance();
      await f.sender.refreshWorking();
      expect(f.j.get("working_message").suspended).toBe(
        failure instanceof TelegramError,
      );
      const reopened = new Sender(f.store, "test", f.api);
      try {
        f.advance(10000);
        await reopened.refreshWorking();
      } finally {
        reopened.journal.close();
      }
      expect(f.calls).toHaveLength(failure instanceof TelegramError ? 2 : 3);
      expect(
        f.calls.every(
          (c) => c.params.message_id === undefined || c.params.message_id === 1,
        ),
      ).toBe(true);
      expect(f.j.get("last_working_refresh_error").status).toBe(
        failure instanceof TelegramError ? "rejected" : "unknown",
      );
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    await f.sender.send("progress", { source: "working", text: "Progress" });
    f.failure(new TelegramError(400, "Bad Request: message is not modified"));
    f.advance();
    await f.sender.refreshWorking();
    expect(f.j.get("working_message").suspended).toBe(false);
    expect(f.j.get("last_working_refresh_error")).toBeNull();
  } finally {
    f.close();
  }
});

test("manual edits, turn changes and pairing changes prevent stale counter updates", async () => {
  const f = fixture();
  try {
    await f.sender.send("a", { source: "working", text: "Progress" });
    await f.sender.send("manual", { edit_id: 1, text: "User edited" });
    expect(f.j.get("working_message")).toBeNull();
    await f.sender.send("b", { source: "working", text: "Progress" });
    f.j.put("active_turn", "different");
    f.advance();
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(3);
    f.j.put("active_turn", "turn");
    await f.sender.send("c", { source: "working", text: "Progress" });
    atomic(join(f.store.instance("test"), "config.json"), {
      ...f.store.read("test"),
      owner_id: 13,
      thread_id: "other",
    });
    f.advance();
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(4);
    expect(f.j.get("working_message")).toBeNull();
  } finally {
    f.close();
  }
});

test("an in-flight edit cannot overwrite a newer working message registration", async () => {
  const f = fixture();
  try {
    await f.sender.send("a", { source: "working", text: "First" });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    f.delay(() => pending);
    f.advance();
    const editing = f.sender.refreshWorking();
    await f.sender.send("b", { source: "working", text: "Second" });
    release();
    await editing;
    expect(f.j.get("working_message").message).toBe(3);
    expect(f.j.get("working_message").sequence).toBe(0);
    expect(f.j.get("working_message").body.text).toBe("Second");
  } finally {
    f.close();
  }
});

test("known working targets survive reconnect without clearing displayed counters", async () => {
  const f = fixture();
  try {
    recordUsage(f.j, "thread", "turn", {
      total: {
        totalTokens: 1500,
        inputTokens: 1300,
        cachedInputTokens: 1000,
        outputTokens: 200,
      },
    });
    await f.sender.send("a", { source: "working", text: "Progress" });
    const reopened = new Sender(f.store, "test", f.api);
    try {
      reconnectUsage(f.j);
      f.advance();
      await reopened.refreshWorking();
      expect(f.calls).toHaveLength(1);
      recordUsage(f.j, "thread", "turn", {
        total: {
          totalTokens: 1600,
          inputTokens: 1400,
          cachedInputTokens: 1050,
          outputTokens: 200,
        },
      });
      await reopened.refreshWorking();
      expect(f.calls).toHaveLength(2);
      expect(f.calls.at(-1).params.text).toContain("session ↑0.4k c1.1k ↓0.2k");
    } finally {
      reopened.journal.close();
    }
  } finally {
    f.close();
  }
});

test("completion removes only Working footers from every progress message, preserving body and Worked final", async () => {
  const f = fixture();
  try {
    await f.sender.send("first", {
      source: "working",
      text: "**First** 😀 `code`",
    });
    const bodyEntities = f.calls[0].params.entities.slice(0, 2);
    await f.sender.send("second", {
      source: "working",
      text: "> Second quote",
    });
    await f.sender.send("final", { source: "codex", text: "Done" });
    f.sender.finishWorking("turn");
    f.j.put("active_turn", null);
    await f.sender.cleanWorking();
    expect(f.calls[3].method).toBe("editMessageText");
    expect(f.calls[3].params).toMatchObject({
      chat_id: 12,
      message_id: 1,
      text: "First 😀 code",
      entities: bodyEntities,
    });
    await f.sender.cleanWorking();
    expect(f.calls).toHaveLength(4); // cleanup edits share the one-second budget
    f.advance();
    await f.sender.cleanWorking();
    expect(f.calls[4].params).toMatchObject({
      chat_id: 12,
      message_id: 2,
      text: "Second quote",
      entities: [{ type: "blockquote", offset: 0, length: 12 }],
    });
    f.advance();
    await f.sender.cleanWorking();
    expect(f.calls).toHaveLength(5);
    expect(f.calls[2].params.text).toContain("Codex Worked");
    expect(f.calls.some((c) => c.method === "deleteMessage")).toBe(false);
  } finally {
    f.close();
  }
});

test("queued footer cleanup survives reopening, respects 429, and manual edits opt out", async () => {
  const f = fixture();
  try {
    await f.sender.send("a", { source: "working", text: "First" });
    await f.sender.send("b", { source: "working", text: "Second" });
    f.sender.finishWorking("turn");
    await f.sender.send("manual", { edit_id: 1, text: "Manual replacement" });
    const reopened = new Sender(f.store, "test", f.api);
    try {
      f.failure(new TelegramError(429, "Too many requests", 5));
      await reopened.cleanWorking();
      expect(f.calls.at(-1).params.message_id).toBe(2);
      expect(f.j.get("working_tail:2").cleanup).toBe(true);
      const count = f.calls.length;
      f.failure(undefined);
      f.advance(4000);
      await reopened.cleanWorking();
      expect(f.calls).toHaveLength(count);
      f.advance();
      await reopened.cleanWorking();
      expect(f.calls.at(-1).params.text).toBe("Second");
      expect(f.j.get("working_tail:2")).toBeNull();
      expect(f.j.get("working_tail:1")).toBeNull();
    } finally {
      reopened.journal.close();
    }
  } finally {
    f.close();
  }
});

test("ambiguous cleanup is never replayed by a duplicate completion", async () => {
  const f = fixture();
  try {
    await f.sender.send("a", { source: "working", text: "First" });
    f.sender.finishWorking("turn");
    f.failure(new Error("response lost"));
    await f.sender.cleanWorking();
    expect(f.j.get("last_working_cleanup_error").status).toBe("unknown");
    f.sender.finishWorking("turn");
    f.advance(10000);
    await f.sender.cleanWorking();
    expect(f.calls).toHaveLength(2);
  } finally {
    f.close();
  }
});

test("new progress removes older Working footers while the turn is still active", async () => {
  const f = fixture();
  try {
    await f.sender.send("old", { source: "working", text: "**First**" });
    await f.sender.send("latest", { source: "working", text: "Second" });
    await f.sender.cleanWorking();
    expect(f.calls.at(-1).params).toMatchObject({
      chat_id: 12,
      message_id: 1,
      text: "First",
      entities: [{ type: "bold", offset: 0, length: 5 }],
    });
    expect(f.j.get("working_message").message).toBe(2);
    expect(f.j.get("active_turn")).toBe("turn");
  } finally {
    f.close();
  }
});

test("an ambiguous version is never replayed; a newer clock version can replace the same known message", async () => {
  const f = fixture();
  try {
    await f.sender.send("working", { source: "working", text: "Progress" });
    f.failure(new Error("response lost"));
    f.advance();
    await f.sender.refreshWorking();
    const original = f.j.get("working_message");
    // Allow the throttle deadline to expire without changing the rendered clock.
    f.j.put("working_edit_after", 0);
    f.j.put("working_message", { ...original, next: 0 });
    const reopened = new Sender(f.store, "test", f.api);
    try {
      await reopened.refreshWorking();
      expect(f.calls).toHaveLength(2);
      f.advance();
      f.failure(undefined);
      await reopened.refreshWorking();
      expect(f.calls).toHaveLength(3);
      expect(f.calls.at(-1).params.message_id).toBe(1);
      expect(f.calls[1].params.text).not.toBe(f.calls[2].params.text);
      expect(f.j.status("out", `working-edit-${original.id}-1`).status).toBe(
        "unknown",
      );
      expect(f.j.get("working_message").suspended).toBe(false);
    } finally {
      reopened.journal.close();
    }
  } finally {
    f.close();
  }
});

test("footer cleanup does not queue behind ten-second counter refreshes", async () => {
  const f = fixture();
  try {
    f.j.put("working_refresh_interval", 10000);
    await f.sender.send("a", { source: "working", text: "First" });
    await f.sender.send("b", { source: "working", text: "Second" });
    f.sender.finishWorking("turn");
    f.j.put("working_edit_after", Date.now() + 10000);
    await f.sender.cleanWorking();
    expect(f.calls).toHaveLength(3);
    await f.sender.cleanWorking();
    expect(f.calls).toHaveLength(3);
    f.advance();
    await f.sender.cleanWorking();
    expect(f.calls).toHaveLength(4);
    expect(f.calls[3].params.text).toBe("Second");
  } finally {
    f.close();
  }
});

test("tool changes bypass the footer timer but never Telegram cooldown", async () => {
  const f = fixture();
  try {
    f.j.put("working_refresh_interval", 10000);
    await f.sender.send("progress", { source: "working", text: "Progress" });
    const activity = {
      mode: "transient",
      version: 1,
      entries: [{ message: 1, summary: "Ran bun run typecheck" }],
    };
    f.j.put("activity:turn", activity);
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].params.text).toContain("Ran bun run typecheck");
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(2);
    f.sender.applyRateLimit(5);
    f.j.put("activity:turn", {
      ...activity,
      version: 2,
      entries: [...activity.entries, { message: 1, summary: "Ran bun test" }],
    });
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(2);
    f.advance(5001);
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2].params.text).toContain("Ran bun test");
    f.advance(9999);
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(3);
    f.advance(1);
    await f.sender.refreshWorking();
    expect(f.calls).toHaveLength(4);
  } finally {
    f.close();
  }
});
