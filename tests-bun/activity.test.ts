import { telegramView } from "./telegram-view";
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../bun/state";
import { Sender, Telegram, TelegramError } from "../bun/telegram";
import { Activity, activitySummary, activityText } from "../bun/activity";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telegram-activity-")),
    store = new Store(root);
  store.configure(
    "test",
    "123456:fixture",
    { id: 123456, username: "test" },
    12,
    "thread",
  );
  const api = new Telegram("123456:fixture"),
    calls: any[] = [];
  api.call = async (method, params) => {
    calls.push({ method, params: telegramView(params) });
    return method === "deleteMessage"
      ? true
      : { message_id: params.message_id ?? calls.length, chat: { id: 12 } };
  };
  const sender = new Sender(store, "test", api),
    activity = new Activity(store, "test", sender);
  sender.journal.put("working_refresh_interval", 1000);
  sender.journal.put("active_turn", "turn");
  return {
    store,
    sender,
    activity,
    calls,
    close() {
      sender.journal.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const item = {
  id: "read",
  type: "commandExecution",
  command: "secret argument",
  commandActions: [{ type: "read", path: "/private/home/project/telegram.ts" }],
};

test("tool summaries use safe structural actions without leaking commands, arguments, output or paths", () => {
  expect(activitySummary(item, false)).toBe("Exploring\nRead telegram.ts");
  expect(
    activitySummary({ ...item, exitCode: 1, aggregatedOutput: "secret" }, true),
  ).toBe("Explored\nRead telegram.ts");
  expect(
    activitySummary(
      {
        ...item,
        commandActions: [{ type: "search", query: "sk-poe-private-key" }],
      },
      false,
    ),
  ).toBe("Exploring\nSearch [redacted]");
  expect(
    activitySummary({ type: "reasoning", text: "secret" }, true),
  ).toBeUndefined();
  expect(
    activitySummary(
      { type: "mcpToolCall", server: "telegram", tool: "send_text" },
      false,
    ),
  ).toBeUndefined();
});

test("activity coalesces into one message and transient cleanup deletes only that message", async () => {
  const f = fixture();
  try {
    f.activity.observe("turn", item, false);
    expect(f.calls).toHaveLength(0);
    await f.activity.flush();
    expect(f.calls[0].params.text).toBe("• Exploring\n  └ Read telegram.ts");
    expect(f.calls[0].params.text).not.toContain("Worked");
    f.activity.observe("turn", item, true);
    f.sender.journal.put("working_edit_after", 0);
    f.sender.journal.put("working_cleanup_after", 0);
    await f.activity.flush(Date.now() + 2000);
    expect(f.calls[1].method).toBe("editMessageText");
    expect(f.calls[1].params.message_id).toBe(1);
    expect(f.calls[1].params.entities.some((e: any) => e.type === "code")).toBe(
      true,
    );
    f.activity.finish("turn");
    f.sender.journal.put("active_turn", null);
    f.sender.journal.put("working_edit_after", 0);
    f.sender.journal.put("working_cleanup_after", 0);
    await f.sender.cleanWorking();
    expect(f.calls[2]).toEqual({
      method: "deleteMessage",
      params: { chat_id: 12, message_id: 1 },
    });
    f.activity.finish("turn");
    f.sender.journal.put("working_edit_after", 0);
    f.sender.journal.put("working_cleanup_after", 0);
    await f.sender.cleanWorking();
    expect(f.calls).toHaveLength(3);
  } finally {
    f.close();
  }
});

test("keep and off are persisted and tool status does not start model work", async () => {
  const f = fixture();
  try {
    f.activity.setMode("keep");
    f.activity.observe("turn", item, false);
    await f.activity.flush();
    f.activity.observe("turn", item, true);
    f.activity.finish("turn");
    f.sender.finishWorking("turn");
    f.sender.journal.put("active_turn", null);
    f.sender.journal.put("working_edit_after", 0);
    f.sender.journal.put("working_cleanup_after", 0);
    await f.sender.cleanWorking();
    expect(f.calls.at(-1).params.text).toBe("• Explored\n  └ Read telegram.ts");
    expect(f.store.read("test").activity_mode).toBe("keep");
    f.sender.journal.put("working_edit_after", 0);
    f.sender.journal.put("working_cleanup_after", 0);
    await f.sender.cleanWorking();
    expect(f.calls).toHaveLength(2);
    f.activity.setMode("off");
    f.sender.journal.put("working_edit_after", 0);
    f.sender.journal.put("working_cleanup_after", 0);
    await f.sender.cleanWorking();
    expect(f.calls.at(-1).method).toBe("deleteMessage");
    f.activity.observe("turn", { ...item, id: "ignored" }, false);
    await f.activity.flush();
    expect(f.calls).toHaveLength(3);
  } finally {
    f.close();
  }
});

test("recovered and foreign tool activity cannot produce fresh messages", async () => {
  const f = fixture();
  try {
    f.activity.observe("foreign", item, true);
    f.activity.observe(
      "turn",
      { type: "reasoning", id: "private", text: "secret" },
      true,
    );
    await f.activity.flush();
    expect(f.calls).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("ambiguous activity delivery is not replayed and unchanged edits do not block later updates", async () => {
  const f = fixture();
  try {
    f.sender.api.call = async () => {
      throw Error("response lost");
    };
    f.activity.observe("turn", item, false);
    await f.activity.flush();
    expect(f.sender.journal.get("activity:turn").blocked).toBe(true);
    f.activity.observe("turn", item, true);
    f.sender.journal.put("working_edit_after", 0);
    f.sender.journal.put("working_cleanup_after", 0);
    await f.activity.flush();
    expect(f.sender.journal.get("activity:turn").version).toBe(1);
  } finally {
    f.close();
  }
  const g = fixture();
  try {
    g.activity.observe("turn", item, false);
    await g.activity.flush();
    g.sender.api.call = async () => {
      throw new TelegramError(400, "message is not modified");
    };
    g.activity.observe("turn", item, true);
    g.sender.journal.put("working_edit_after", 0);
    await g.activity.flush(Date.now() + 2000);
    expect(g.sender.journal.get("activity:turn").blocked).toBe(false);
    expect(g.sender.journal.get("activity:turn").sentVersion).toBe(2);
  } finally {
    g.close();
  }
});

test("CLI style groups preserve search details and safe command names without absolute paths", () => {
  const read = activitySummary(item, true)!;
  const search = activitySummary(
    {
      ...item,
      commandActions: [
        {
          type: "search",
          query: "observe|finish|flush",
          path: "/private/home/project/activity.ts",
        },
      ],
    },
    true,
  )!;
  const ran = activitySummary(
    {
      type: "commandExecution",
      command: "/private/home/.bun/bin/bun run typecheck",
      commandActions: [{ type: "unknown" }],
      aggregatedOutput: "$ tsc --noEmit\n",
    },
    true,
  )!;
  expect(
    activityText([{ summary: read }, { summary: search }, { summary: ran }]),
  ).toBe(
    "• Explored\n  └ Read telegram.ts\n    Search observe|finish|flush in activity.ts\n• Ran bun run typecheck\n  └ $ tsc --noEmit",
  );
  expect(
    activitySummary(
      {
        type: "commandExecution",
        command: "TOKEN=secret curl -H secret",
        aggregatedOutput: "private output",
      },
      true,
    ),
  ).toBe("Ran command");
  expect(
    activitySummary(
      {
        type: "commandExecution",
        command: "python3 - <<'PY'\nprivate script",
        aggregatedOutput: "private output",
      },
      false,
    ),
  ).toBe("Running python3 - <<'PY' …");
});

test("tool summaries and counter changes share one edit of the latest progress message", async () => {
  const f = fixture();
  try {
    f.sender.journal.put("turn_timing:turn", {
      started_at: Date.now() - 10000,
    });
    await f.sender.send("progress", {
      source: "working",
      text: "**Progress**",
    });
    f.activity.observe("turn", item, false);
    f.sender.journal.put("working_message", {
      ...f.sender.journal.get("working_message"),
      next: 0,
    });
    await f.activity.flush(Date.now() + 2000);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].method).toBe("editMessageText");
    expect(f.calls[1].params.message_id).toBe(1);
    expect(f.calls[1].params.entities.some((e: any) => e.type === "code")).toBe(
      true,
    );
    expect(f.calls[1].params.text).toContain(
      "Progress\n\n• Exploring\n  └ Read telegram.ts\nCodex Working",
    );
    f.activity.finish("turn");
    f.sender.finishWorking("turn");
    f.sender.journal.put("working_edit_after", 0);
    f.sender.journal.put("working_cleanup_after", 0);
    await f.sender.cleanWorking();
    expect(f.calls.at(-1).params.text).toBe("Progress");
    expect(f.calls.some((c) => c.method === "deleteMessage")).toBe(false);
  } finally {
    f.close();
  }
});

test("a running tool stays on its original progress message after new progress arrives", async () => {
  const f = fixture();
  try {
    const j = f.sender.journal;
    await f.sender.send("first-progress", {
      source: "working",
      text: "First progress",
    });
    f.activity.observe("turn", item, false);
    await f.activity.flush(Date.now() + 2000);
    await f.sender.send("second-progress", {
      source: "working",
      text: "Second progress",
    });
    const latest = j.get("working_message").message;
    f.activity.observe("turn", item, true);
    j.put("working_edit_after", 0);
    j.put("working_cleanup_after", 0);
    await f.activity.flush(Date.now() + 4000);
    const oldEdit = f.calls.at(-1);
    expect(oldEdit.method).toBe("editMessageText");
    expect(oldEdit.params.message_id).toBe(1);
    expect(oldEdit.params.text).toBe(
      "First progress\n\n• Explored\n  └ Read telegram.ts",
    );
    j.put("working_edit_after", 0);
    j.put("working_cleanup_after", 0);
    await f.activity.flush(Date.now() + 6000);
    expect(
      f.calls
        .filter((c) => c.params.message_id === latest)
        .every((c) => !c.params.text.includes("Read telegram.ts")),
    ).toBe(true);
    f.activity.observe(
      "turn",
      {
        ...item,
        id: "new-tool",
        commandActions: [{ type: "read", path: "new.ts" }],
      },
      false,
    );
    j.put("working_edit_after", 0);
    j.put("working_cleanup_after", 0);
    await f.activity.flush(Date.now() + 8000);
    j.put("working_edit_after", 0);
    j.put("working_cleanup_after", 0);
    await f.activity.flush(Date.now() + 10000);
    expect(f.calls.at(-1).params.message_id).toBe(latest);
    expect(f.calls.at(-1).params.text).toContain("Read new.ts");
    expect(f.calls.at(-1).params.text).not.toContain("Read telegram.ts");
    f.activity.finish("turn");
    f.sender.finishWorking("turn");
    j.put("working_edit_after", 0);
    j.put("working_cleanup_after", 0);
    await f.sender.cleanWorking();
    expect(f.calls.at(-1).params.text).toBe("First progress");
  } finally {
    f.close();
  }
});

test("tool history has no count cap and long history continues in separately tracked messages", async () => {
  const f = fixture();
  try {
    const j = f.sender.journal;
    await f.sender.send("history-progress", {
      source: "working",
      text: "Progress",
    });
    for (let i = 0; i < 15; i++)
      f.activity.observe(
        "turn",
        {
          ...item,
          id: `read-${i}`,
          commandActions: Array.from({ length: 45 }, (_, n) => ({
            type: "read",
            path: `file-${i}-${n}-${"x".repeat(65)}.ts`,
          })),
        },
        true,
      );
    expect(j.get("activity:turn").entries).toHaveLength(15);
    await f.activity.flush(Date.now() + 2000);
    expect(f.calls.at(-1).params.text).toContain("file-0-");
    const pages = j.get("activity_pages:1");
    expect(pages.pages.length).toBeGreaterThan(0);
    for (let i = 0; i < pages.pages.length; i++) {
      j.put("working_edit_after", 0);
      j.put("working_cleanup_after", 0);
      await f.sender.refreshActivityPages(Date.now() + 4000 + i * 2000);
      expect(f.calls.at(-1).params.text.length).toBeLessThanOrEqual(32768);
      expect(f.calls.at(-1).params.text).not.toContain("Codex Worked");
      expect(
        f.calls.at(-1).params.entities.some((e: any) => e.type === "code"),
      ).toBe(true);
    }
    const all = f.calls
      .filter(
        (c) => c.method === "sendRichMessage" || c.method === "editMessageText",
      )
      .map((c) => c.params.text)
      .join("");
    for (let i = 0; i < 15; i++) expect(all).toContain(`file-${i}-`);
    expect(j.get("working_message").message).toBe(1);
    f.activity.finish("turn");
    f.sender.finishWorking("turn");
    j.put("working_edit_after", 0);
    j.put("working_cleanup_after", 0);
    await f.sender.cleanWorking();
    expect(f.calls.at(-1).params.text).toBe("Progress");
    j.put("working_edit_after", 0);
    j.put("working_cleanup_after", 0);
    await f.sender.cleanWorking();
    expect(f.calls.at(-1).method).toBe("deleteMessage");
  } finally {
    f.close();
  }
});

test("command previews retain useful safe arguments and abbreviate script bodies", () => {
  const summary = (command: string) =>
    activitySummary({ type: "commandExecution", command }, true);
  expect(summary("tail -8 /tmp/checks.log")).toBe("Ran tail -8 checks.log");
  expect(summary('/usr/bin/bash -lc "tail -8 /tmp/checks.log"')).toBe(
    "Ran tail -8 checks.log",
  );
  expect(summary("bun -e 'private script'")).toBe("Ran bun -e …");
  expect(
    summary("curl -H 'Authorization: Bearer private' https://example.com"),
  ).toBe("Ran curl …");
});

test("unchanged retired tools do not delay the latest Running to Ran update", async () => {
  const f = fixture();
  try {
    await f.sender.send("old-progress", {
      source: "working",
      text: "Old progress",
    });
    f.activity.observe("turn", item, true);
    await f.activity.flush();
    await f.sender.send("new-progress", {
      source: "working",
      text: "New progress",
    });
    const command = {
      id: "last-command",
      type: "commandExecution",
      command: "git diff --check",
    };
    f.activity.observe("turn", command, false);
    await f.activity.flush();
    expect(f.calls.at(-1).params.text).toContain("Running git diff --check");
    f.activity.observe("turn", command, true);
    await f.activity.flush();
    expect(f.calls.at(-1).params.text).toContain("Ran git diff --check");
    expect(f.calls.at(-1).params.text).not.toContain("Running");
  } finally {
    f.close();
  }
});

test("nonzero exits are tool results rather than system alerts", () => {
  expect(
    activitySummary(
      { type: "commandExecution", command: "git diff --check", exitCode: 1 },
      true,
    ),
  ).toBe("Failed (exit 1) git diff --check\n(no output)");
  expect(
    activitySummary(
      { type: "commandExecution", command: "git diff --check", exitCode: 0 },
      true,
    ),
  ).toBe("Ran git diff --check");
});
