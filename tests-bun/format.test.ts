import { test, expect } from "bun:test";
import { markdown, messages, type RichText } from "../bun/format";

function spans(value: RichText, type: string) {
  return value.entities
    .filter((e) => e.type === type)
    .map((e) => value.text.slice(e.offset, e.offset + e.length));
}
function valid(value: RichText, limit: number) {
  expect(value.text.length).toBeLessThanOrEqual(limit);
  for (const e of value.entities) {
    expect(e.length).toBeGreaterThan(0);
    expect(e.offset).toBeGreaterThanOrEqual(0);
    expect(e.offset + e.length).toBeLessThanOrEqual(value.text.length);
    expect(/[\uDC00-\uDFFF]/.test(value.text[e.offset] ?? "")).toBe(false);
    expect(
      /[\uD800-\uDBFF]/.test(value.text[e.offset + e.length - 1] ?? ""),
    ).toBe(false);
  }
}

test("adjacent paragraphs and fenced code keep readable block boundaries", () => {
  const value = markdown("Before\n```ts\nlet x = 1\n```\nAfter");
  expect(value.text).toBe("Before\n\nlet x = 1\n\nAfter");
  expect(spans(value, "pre")).toEqual(["let x = 1"]);
});

test("Markdown becomes text plus nested styles, code and links with UTF-16 offsets", () => {
  const value = messages(
    "😀 **bold _and italic_** ~~old~~ `a < b` [docs](https://example.com/?a=1&b=2)",
  )[0]!;
  expect(value.text).toBe(
    "😀 bold and italic old a < b docs (https://example.com/?a=1&b=2)",
  );
  expect(spans(value, "bold")).toEqual(["bold and italic"]);
  expect(spans(value, "italic")).toEqual(["and italic"]);
  expect(spans(value, "strikethrough")).toEqual(["old"]);
  expect(spans(value, "code")).toEqual(["a < b"]);
  expect(value.entities.find((e) => e.type === "text_link")?.url).toBe(
    "https://example.com/?a=1&b=2",
  );
  valid(value, 4096);
});

test("fenced code preserves literal markup, blank lines and language", () => {
  const value = markdown("```typescript\nconst x = '<b>&amp; **x**';\n\n```");
  expect(value.text).toBe("const x = '<b>&amp; **x**';\n");
  expect(value.entities).toEqual([
    {
      type: "pre",
      offset: 0,
      length: value.text.length,
      language: "typescript",
    },
  ]);
});

test("literal and unsupported markup remains visible; URLs are restricted", () => {
  const value = markdown(
    "<b>literal</b> &amp; &#128512; \\*star\\* [local](/tmp/file) [bad](javascript:alert)",
  );
  expect(value.text).toContain("<b>literal</b> & 😀 *star*");
  expect(value.text).toContain("local (/tmp/file)");
  expect(value.text).toContain("bad (javascript:alert)");
  expect(value.entities).toEqual([]);
  const plain = messages("**literal** <x> &amp;", "system")[0]!;
  expect(plain.text).toBe("System\n**literal** <x> &amp;");
  expect(spans(plain, "blockquote")).toEqual([plain.text]);
});

test("code inside styles and links never overlaps incompatible entities", () => {
  const value = markdown("**bold `code` end** [a `b` c](https://example.com)");
  expect(spans(value, "bold")).toEqual(["bold ", " end"]);
  expect(spans(value, "text_link")).toEqual(["a ", " c"]);
  for (const code of value.entities.filter((e) => e.type === "code"))
    for (const other of value.entities.filter((e) => e.type !== "code"))
      expect(
        other.offset + other.length <= code.offset ||
          other.offset >= code.offset + code.length,
      ).toBe(true);
});

test("headings, lists, tasks and tables retain their contents", () => {
  const value = markdown(
    "# Title\n\n- [x] done\n- **next**\n\n| Name | Value |\n| --- | --- |\n| A | `B` |",
  );
  expect(spans(value, "bold")).toContain("Title");
  expect(value.text).toContain("☑ done");
  expect(value.text).toContain("• next");
  expect(value.text).toContain("Name | Value");
  expect(value.text).toContain("A | B");
});

test("long code and links split into valid independently formatted Unicode messages", () => {
  const body = "😀line <a> **literal**\n".repeat(500);
  const input =
    "```ts\n" +
    body +
    "```\n\n[" +
    "🦊".repeat(3000) +
    "](https://example.com)";
  const rendered = markdown(input);
  const parts = messages(input, "working");
  expect(parts.length).toBeGreaterThan(3);
  expect(parts.map((p) => p.text).join("")).toBe(rendered.text);
  for (const part of parts) {
    valid(part, 4096);
    expect(part.text).not.toContain("[CODEX");
  }
  expect(
    parts.filter((p) => p.entities.some((e) => e.type === "pre")).length,
  ).toBeGreaterThan(1);
  expect(
    parts.filter((p) => p.entities.some((e) => e.type === "text_link")).length,
  ).toBeGreaterThan(1);
});

test("entity-heavy input degrades formatting within a bounded entity count, preserving text", () => {
  const text = "**a** _b_ ".repeat(200);
  for (const part of messages(text)) {
    expect(part.entities.length).toBeLessThanOrEqual(90);
    valid(part, 4096);
  }
});

test("linked images do not create nested text_link entities", () => {
  const value = markdown(
    "[![logo](https://example.com/image.png)](https://example.com/page)",
  );
  expect(value.text).toBe(
    "logo (https://example.com/image.png) (https://example.com/page)",
  );
  expect(value.entities.find((e) => e.type === "text_link")?.url).toBe(
    "https://example.com/page",
  );
  expect(value.entities.filter((e) => e.type === "text_link")).toHaveLength(1);
});

test("native blockquotes retain inline formatting without literal quote markers", () => {
  const value = messages(
    "Before\n\n> 😀 **bold** _italic_ `code` [link](https://example.com)\n> second line\n\nAfter",
  )[0]!;
  expect(value.text).not.toContain("> ");
  expect(spans(value, "blockquote")).toEqual([
    "😀 bold italic code link (https://example.com)\nsecond line",
  ]);
  expect(spans(value, "bold")).toEqual(["bold"]);
  expect(spans(value, "italic")).toEqual(["italic"]);
  expect(spans(value, "code")).toEqual(["code"]);
  expect(spans(value, "text_link")).toEqual(["link"]);
  valid(value, 4096);
});

test("nested Markdown quotes flatten into one native quote", () => {
  const value = markdown("> outer\n>\n>> **inner**\n>\n> end");
  expect(value.entities.filter((e) => e.type === "blockquote")).toHaveLength(1);
  expect(spans(value, "blockquote")[0]).toBe(value.text);
  expect(spans(value, "bold")).toEqual(["inner"]);
});

test("long native blockquotes preserve Unicode text and quote ranges in each part", () => {
  const input = "> **" + "😀 quote text ".repeat(1200) + "**";
  const body = markdown(input);
  const parts = messages(input);
  expect(parts.length).toBeGreaterThan(2);
  expect(parts.map((p) => p.text).join("")).toBe(body.text);
  for (const part of parts) {
    valid(part, 4096);
    expect(spans(part, "blockquote")).toEqual([part.text]);
  }
});

test("progress and final footers use elapsed time without adding headings", () => {
  expect(messages("**Checking**", "working", "markdown", 4096, 83)[0]).toEqual({
    text: "Checking\nCodex Working 1m 23s",
    footerOffset: 9,
    entities: [
      { type: "bold", offset: 0, length: 8 },
      { type: "code", offset: 9, length: "Codex Working 1m 23s".length },
    ],
  });
  expect(messages("Done", "codex", "markdown", 4096, 3723)[0]!.text).toBe(
    "Done\nCodex Worked 1h 2m",
  );
  expect(messages("Done", "codex")[0]!.text).toBe("Done");
  const quoted = messages("> **quoted**", "codex", "markdown", 4096, 12)[0]!;
  expect(spans(quoted, "blockquote")).toEqual(["quoted"]);
  expect(quoted.text).toBe("quoted\nCodex Worked 12s");
});

test("token statistics use bold italic, label cumulative fallbacks and fit split message limits", () => {
  const tokens = { tokens: 12345, scope: "turn" as const };
  const final = messages("Done", "codex", "markdown", 4096, 12, tokens)[0];
  expect(final.text).toBe("Done\nCodex Worked 12s · 12.3k");
  expect(spans(final, "bold")).toEqual(["Codex Worked 12s · 12.3k"]);
  expect(
    messages("Working", "working", "plain", 4096, 10, {
      tokens: 1000000,
      scope: "session",
    })[0].text,
  ).toContain("session 1.0m");
  expect(
    messages("Notice", "system", "plain", 4096, 10, tokens)[0].text,
  ).not.toContain("tokens");
  const parts = messages(
    "**hello** 😀 ".repeat(1000),
    "codex",
    "markdown",
    4096,
    75,
    tokens,
  );
  for (const part of parts) valid(part, 4096);
  expect(
    parts.slice(0, -1).every((p) => !p.text.includes("Codex Worked")),
  ).toBe(true);
  expect(parts.at(-1)!.text).toEndWith("Codex Worked 1m 15s · 12.3k");
});

test("system messages have their heading inside a native quote and no timing footer", () => {
  const value = messages("A system notice", "system", "plain", 4096, 99)[0]!;
  expect(value).toEqual({
    text: "System\nA system notice",
    entities: [
      { type: "blockquote", offset: 0, length: 22 },
      { type: "bold", offset: 0, length: 6 },
    ],
  });
  const formatted = messages(
    "> **nested quote**\n\nText",
    "system",
    "markdown",
  )[0]!;
  expect(formatted.entities.filter((e) => e.type === "blockquote")).toEqual([
    { type: "blockquote", offset: 0, length: formatted.text.length },
  ]);
  expect(spans(formatted, "bold")).toEqual(["System", "nested quote"]);
});

test("long messages keep the complete footer only at the end and within the limit", () => {
  const input = "> **" + "😀 quote ".repeat(1300) + "**";
  const parts = messages(input, "working", "markdown", 4096, 75);
  expect(parts.length).toBeGreaterThan(2);
  expect(
    parts.slice(0, -1).every((p) => !p.text.includes("Codex Working")),
  ).toBe(true);
  expect(parts.at(-1)!.text.endsWith("\nCodex Working 1m 15s")).toBe(true);
  expect(parts.map((p) => p.text).join("")).toBe(
    markdown(input).text + "\nCodex Working 1m 15s",
  );
  for (const part of parts) valid(part, 4096);
});

test("each part of a long system notice repeats its heading inside the quote", () => {
  const body = "😀 system notice ".repeat(900);
  const parts = messages(body, "system");
  expect(parts.length).toBeGreaterThan(2);
  expect(parts.map((p) => p.text.slice("System\n".length)).join("")).toBe(body);
  for (const part of parts) {
    valid(part, 4096);
    expect(part.text.startsWith("System\n")).toBe(true);
    expect(spans(part, "bold")).toEqual(["System"]);
    expect(spans(part, "blockquote")).toEqual([part.text]);
  }
});

test("duration footer stays bold and italic even when body formatting exceeds the entity budget", () => {
  const parts = messages(
    "**bold** ".repeat(250),
    "codex",
    "markdown",
    4096,
    42,
  );
  const last = parts.at(-1)!;
  expect(spans(last, "bold").at(-1)).toBe("Codex Worked 42s");
  expect(spans(last, "italic")).toEqual(["Codex Worked 42s"]);
  expect(last.entities.length).toBeLessThanOrEqual(90);
  valid(last, 4096);
});

test("usage footer distinguishes uncached input, cached input, and output with the same scope", () => {
  const usage = {
    sessionBreakdown: {
      inputTokens: 99000,
      cachedInputTokens: 90000,
      outputTokens: 1000,
    },
    tokens: 12345,
    sessionTokens: 100000,
    scope: "turn" as const,
    inputTokens: 12000,
    cachedInputTokens: 10000,
    outputTokens: 345,
  };
  const footer =
    "Codex Worked 12s · ↑2.0k c10.0k ↓0.3k · session ↑9.0k c90.0k ↓1.0k";
  const rendered = messages("Done", "codex", "markdown", 4096, 12, usage)[0];
  expect(rendered.text).toBe("Done\n" + footer);
  expect(spans(rendered, "code")).toEqual([]);
  expect(spans(rendered, "blockquote")).toEqual([]);
  expect(spans(rendered, "bold")).toEqual([footer]);
  expect(spans(rendered, "italic")).toEqual([footer]);
  expect(
    messages("Done", "codex", "markdown", 4096, 12, {
      ...usage,
      scope: "session",
    })[0].text,
  ).toContain("session ↑9.0k c90.0k ↓1.0k");
  const parts = messages(
    "**hello** 😀 ".repeat(1000),
    "codex",
    "markdown",
    4096,
    12,
    usage,
  );
  expect(parts.every((p) => p.text.length <= 4096)).toBe(true);
  expect(parts.slice(0, -1).every((p) => !p.text.includes(" c"))).toBe(true);
  expect(parts.at(-1)!.text).toEndWith(footer);
});

test("compact counts retain one decimal for small, zero and large counts", () => {
  for (const [tokens, expected] of [
    [0, "0.0k"],
    [45, "0.0k"],
    [150, "0.2k"],
    [999, "1.0k"],
    [999900, "999.9k"],
  ] as const) {
    const value = messages("Done", "codex", "plain", 4096, 1, {
      tokens,
      sessionTokens: tokens,
      scope: "turn",
    })[0];
    expect(value.text).toBe(
      `Done\nCodex Worked 1s · ${expected} · session ${expected}`,
    );
  }
});

test("session components remain visible without a turn baseline", () => {
  const usage = {
    tokens: 1000,
    sessionTokens: 1000,
    scope: "session" as const,
    sessionBreakdown: {
      inputTokens: 900,
      cachedInputTokens: 700,
      outputTokens: 100,
    },
  };
  const value = messages("Done", "codex", "plain", 4096, 1, usage)[0];
  expect(value.text).toBe("Done\nCodex Worked 1s · session ↑0.2k c0.7k ↓0.1k");
  expect(spans(value, "bold")).toEqual([value.text.split("\n").at(-1)!]);
});

test("all token counts switch individually to millions", () => {
  for (const [tokens, expected] of [
    [999900, "999.9k"],
    [1000000, "1.0m"],
    [1250000, "1.3m"],
    [125530900, "125.5m"],
  ] as const) {
    const value = messages("Done", "codex", "plain", 4096, 1, {
      tokens: 100,
      sessionTokens: tokens,
      scope: "turn",
    })[0];
    expect(value.text).toBe(
      `Done\nCodex Worked 1s · 0.1k · session ${expected}`,
    );
  }
  const value = messages("Done", "codex", "plain", 4096, 1, {
    tokens: 1234567,
    scope: "turn",
    sessionTokens: 125530900,
    inputTokens: 1200000,
    cachedInputTokens: 1000000,
    outputTokens: 34567,
    sessionBreakdown: {
      inputTokens: 125229100,
      cachedInputTokens: 122054700,
      outputTokens: 301800,
    },
  })[0];
  expect(value.text).toBe(
    "Done\nCodex Worked 1s · ↑200.0k c1.0m ↓34.6k · session ↑3.2m c122.1m ↓301.8k",
  );
});

test("working footers subtract cached input before rounding and retain session components", () => {
  const usage = {
    tokens: 1149,
    scope: "turn" as const,
    sessionTokens: 2000000,
    inputTokens: 1049,
    cachedInputTokens: 951,
    outputTokens: 100,
    sessionBreakdown: {
      inputTokens: 1900000,
      cachedInputTokens: 1900000,
      outputTokens: 100000,
    },
  };
  const value = messages("Progress", "working", "plain", 4096, 1, usage)[0];
  expect(value.text).toBe(
    "Progress\nCodex Working 1s · ↑0.1k c1.0k ↓0.1k · session ↑0.0k c1.9m ↓100.0k",
  );
  expect(spans(value, "code")).toEqual([value.text.split("\n").at(-1)!]);
});

test("statusline includes compact context size, capacity, and CLI used percentage", () => {
  const usage = {
    tokens: 100,
    scope: "turn" as const,
    context: { tokens: 123400, window: 258400, usedPercent: 45 },
  };
  const working = messages("Progress", "working", "plain", 4096, 12, usage)[0];
  expect(working.text).toContain("ctx 123.4k/258.4k 45%");
  expect(spans(working, "code")[0]).toContain("ctx 123.4k/258.4k 45%");
  const final = messages("Done", "codex", "plain", 4096, 12, usage)[0];
  expect(spans(final, "bold")[0]).toContain("ctx 123.4k/258.4k 45%");
  expect(spans(final, "italic")[0]).toContain("ctx 123.4k/258.4k 45%");
});

test("link destinations are visible and already visible URLs are not repeated", () => {
  expect(markdown("[Docs](https://example.com/a?x=1&y=2)").text).toBe(
    "Docs (https://example.com/a?x=1&y=2)",
  );
  expect(markdown("[https://example.com](https://example.com)").text).toBe(
    "https://example.com",
  );
});

test("turn and context counters consistently use millions", () => {
  const part = messages("Done", "codex", "plain", 4096, 1, {
    scope: "turn",
    tokens: 1740000,
    context: { tokens: 1740000, window: 2000000, usedPercent: 87 },
  })[0]!;
  expect(part.text).toContain(" · 1.7m · ctx 1.7m/2.0m 87%");
});

test("footer displays model effort and CLI goal completion wording", () => {
  const p = messages("Done", "codex", "plain", 4096, 1, undefined, {
    model: "gpt-test",
    effort: "high",
    goal: "complete",
  })[0]!;
  expect(p.text).toContain("gpt-test high · Goal achieved");
});
