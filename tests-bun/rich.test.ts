import { test, expect, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, atomic } from "../bun/state";
import { Sender, Telegram, TelegramError } from "../bun/telegram";
import { markdownHtml, richMessage } from "../bun/rich";
import { messages } from "../bun/format";
import { Questions } from "../bun/questions";

test("native rich formatting escapes model HTML and preserves structural markup", () => {
  const html = markdownHtml(
    "# Heading\n\n---\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n> outer\n> > inner\n\n<script>bad</script>",
  );
  expect(html).toContain("<h1>Heading</h1>");
  expect(html).toContain("<hr/>");
  expect(html).toContain("<table>");
  expect(html).toContain("<blockquote><p>outer</p><blockquote>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(markdownHtml("[bad](javascript:alert)")).not.toContain(
    'href="javascript:',
  );
});

test("native footer is separate from the body and contains goal and question status", () => {
  const part = messages("Hello", "working", "plain", 32768, 12, undefined, {
    goal: "active",
    questions: 2,
  })[0];
  const payload = richMessage(part);
  expect(payload.html).toBe(
    "Hello<footer>Codex Working 12s · Pursuing goal · questions 2</footer>",
  );
  expect(payload.html).not.toContain("<code>");
});

test("new text sends and edits use rich_message only, preserve native body on cleanup, and preserve v1 receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "rich-"));
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
  api.call = async (method, params) => {
    calls.push({ method, params });
    return { message_id: params.message_id ?? calls.length, chat: { id: 12 } };
  };
  const sender = new Sender(store, "test", api),
    j = sender.journal;
  try {
    j.put("active_turn", "turn");
    j.put("turn_timing:turn", { started_at: Date.now() - 1000 });
    j.put("goal_state", { thread: "thread", status: "active" });
    const q = new Questions(
      j,
      {} as any,
      "thread",
      async () => ({ status: "sent" }),
      (s) => s,
    );
    await q.offer(
      { id: "question", questions: [{ title: "Choose", options: ["A", "B"] }] },
      "turn",
    );
    await sender.send("rich-progress", {
      source: "working",
      text: "# Heading\n\n---\n\n**body**",
    });
    expect(calls[0].method).toBe("sendRichMessage");
    expect(calls[0].params.text).toBeUndefined();
    expect(calls[0].params.entities).toBeUndefined();
    expect(calls[0].params.rich_message.html).toContain(
      "<h1>Heading</h1><hr/><p><b>body</b></p><footer>",
    );
    expect(calls[0].params.rich_message.html).toContain(
      "Pursuing goal · questions 1",
    );
    await sender.refreshWorking(Date.now() + 2000);
    expect(calls.at(-1).params.rich_message.html).toContain("<h1>Heading</h1>");
    sender.finishWorking("turn");
    j.put("working_edit_after", 0);
    await sender.cleanWorking();
    expect(calls.at(-1).params.rich_message.html).toBe(
      "<h1>Heading</h1><hr/><p><b>body</b></p>",
    );
    const fp = {
      chat_id: 12,
      text: "Old",
      kind: "document",
      caption: "",
      reply_to: null,
      edit_id: null,
      presentation: { version: 1, source: "codex", format: "markdown" },
    };
    j.begin("out", "old-v1", fp);
    j.finish("out", "old-v1", "unknown", {});
    const count = calls.length;
    expect((await sender.send("old-v1", { text: "Old" })).status).toBe(
      "unknown",
    );
    expect(calls).toHaveLength(count);
  } finally {
    j.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("production refresh defaults to 10 seconds and rate limits defer all sends without extra HTTP calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "rich-rate-")),
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
  let limited = false;
  api.call = async (method, params) => {
    calls.push({ method, params });
    if (limited) throw new TelegramError(429, "Too many requests", 45);
    return { message_id: params.message_id ?? calls.length, chat: { id: 12 } };
  };
  const sender = new Sender(store, "test", api),
    j = sender.journal;
  setSystemTime(new Date("2026-10-19T12:00:00Z"));
  try {
    expect(sender.refreshInterval()).toBe(10000);
    j.put("active_turn", "turn");
    j.put("turn_timing:turn", { started_at: Date.now() });
    await sender.send("progress", { source: "working", text: "Progress" });
    setSystemTime(new Date(Date.now() + 9999));
    await sender.refreshWorking();
    expect(calls).toHaveLength(1);
    setSystemTime(new Date(Date.now() + 1));
    await sender.refreshWorking();
    expect(calls).toHaveLength(2);
    limited = true;
    const rejected = await sender.send("limited", { text: "Reply" });
    expect(rejected.status).toBe("rejected");
    expect(rejected.details.queued).toBe(true);
    const count = calls.length;
    await sender.send("other-reply", { text: "Another reply" });
    await sender.refreshWorking();
    await sender.retryDeferred();
    expect(calls).toHaveLength(count);
    expect(j.status("out", "other-reply").details.queued).toBe(true);
    limited = false;
    setSystemTime(new Date(Date.now() + 45001));
    await sender.retryDeferred();
    expect(calls).toHaveLength(count + 1);
    expect(j.status("out", "limited").status).toBe("sent");
    await sender.retryDeferred();
    expect(calls).toHaveLength(count + 1);
    setSystemTime(new Date(Date.now() + 10000));
    await sender.retryDeferred();
    expect(j.status("out", "other-reply").status).toBe("sent");
    await sender.send("limited", { text: "Reply" });
    expect(calls).toHaveLength(count + 2);
  } finally {
    setSystemTime();
    j.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deferred send cannot cross a binding change or replay an ambiguous retry", async () => {
  for (const changed of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "rich-deferred-")),
      store = new Store(root);
    store.configure(
      "test",
      "123456:fixture",
      { id: 123456, username: "test" },
      12,
      "thread",
    );
    const api = new Telegram("123456:fixture");
    let calls = 0;
    api.call = async () => {
      calls++;
      if (calls === 1) throw new TelegramError(429, "Limited", 2);
      throw Error("lost response");
    };
    const sender = new Sender(store, "test", api),
      j = sender.journal;
    setSystemTime(new Date("2026-10-19T12:00:00Z"));
    try {
      await sender.send("deferred", { text: "Private reply" });
      if (changed)
        atomic(join(store.instance("test"), "config.json"), {
          ...store.read("test"),
          owner_id: 99,
          thread_id: "other-thread",
          binding_revision: 1,
        });
      setSystemTime(new Date(Date.now() + 2001));
      await sender.retryDeferred();
      if (changed) {
        expect(calls).toBe(1);
        expect(j.status("out", "deferred").status).toBe("rejected");
      } else {
        expect(calls).toBe(2);
        expect(j.status("out", "deferred").status).toBe("unknown");
      }
      setSystemTime(new Date(Date.now() + 20000));
      await sender.retryDeferred();
      expect(calls).toBe(changed ? 1 : 2);
    } finally {
      setSystemTime();
      j.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("stale queued progress expires while durable replies still deliver", async () => {
  const root = mkdtempSync(join(tmpdir(), "rich-stale-")),
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
    calls.push({ method, params });
    return { message_id: calls.length, chat: { id: 12 } };
  };
  const sender = new Sender(store, "test", api),
    j = sender.journal;
  setSystemTime(new Date("2026-10-19T12:00:00Z"));
  try {
    j.put("active_turn", "turn");
    sender.applyRateLimit(120);
    await sender.send("old-progress", {
      source: "working",
      text: "Waiting for rate limit",
    });
    await sender.send("final-reply", { text: "Completed result" });
    expect(calls).toHaveLength(0);
    setSystemTime(new Date(Date.now() + 120001));
    await sender.retryDeferred();
    expect(calls).toHaveLength(1);
    expect(j.status("out", "old-progress").details.expired).toBe(true);
    expect(j.status("out", "final-reply").status).toBe("sent");
  } finally {
    setSystemTime();
    j.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tool lines preserve explicit breaks, indentation and monospace actions", async () => {
  const { activityHtml } = await import("../bun/rich");
  expect(activityHtml("• Explored\n  └ Read a.ts\n    Search <tag>")).toBe(
    "<p><b><code>• Explored</code></b><br/><code>&nbsp;&nbsp;└ Read a.ts</code><br/><code>&nbsp;&nbsp;&nbsp;&nbsp;Search &lt;tag&gt;</code></p>",
  );
});

test("plain text keeps explicit line breaks while preformatted code keeps raw newlines", async () => {
  const { entityHtml } = await import("../bun/rich");
  expect(entityHtml({ text: "a\nb", entities: [] })).toBe("a<br/>b");
  expect(
    entityHtml({
      text: "a\nb",
      entities: [{ type: "pre", offset: 0, length: 3 }],
    }),
  ).toBe("<pre><code>a\nb</code></pre>");
});

test("rich links show their original destinations exactly once", () => {
  expect(markdownHtml("[Docs](https://example.com/a?x=1&y=2)")).toBe(
    '<p><a href="https://example.com/a?x=1&amp;y=2">Docs</a> (https://example.com/a?x=1&amp;y=2)</p>',
  );
  expect(markdownHtml("[https://example.com](https://example.com)")).toBe(
    '<p><a href="https://example.com">https://example.com</a></p>',
  );
});

test("original inline code becomes a copy button with exact escaped text", async () => {
  const { entityHtml } = await import("../bun/rich");
  expect(markdownHtml('Run `a < b & "x"` now')).toBe(
    '<p>Run <tg-button type="copy_text" text="a &lt; b &amp; &quot;x&quot;">a &lt; b &amp; &quot;x&quot;</tg-button> now</p>',
  );
  expect(
    entityHtml({
      text: "hello",
      entities: [{ type: "code", offset: 0, length: 5 }],
    }),
  ).toBe('<tg-button type="copy_text" text="hello">hello</tg-button>');
  expect(markdownHtml("`" + "x".repeat(257) + "`")).toBe(
    "<p><code>" + "x".repeat(257) + "</code></p>",
  );
  expect(markdownHtml("```sh\necho hello\n```")).toContain(
    '<pre><code class="language-sh">',
  );
});

test("Ran and Running keep commands monospace rather than copying buttons", async () => {
  const { activityHtml } = await import("../bun/rich");
  expect(activityHtml("• Ran bun run typecheck")).toBe(
    "<p><code><b>• Ran</b> bun run typecheck</code></p>",
  );
  expect(activityHtml("• Running git diff")).toBe(
    "<p><code><b>• Running</b> git diff</code></p>",
  );
});
