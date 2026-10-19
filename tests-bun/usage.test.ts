import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../bun/state";
import {
  reconnectUsage,
  startUsage,
  recordUsage,
  turnUsage,
} from "../bun/usage";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telegram-usage-"));
  const journal = new Journal(root);
  return {
    journal,
    root,
    close() {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("turn usage uses cumulative differences, never the last request or a sum of snapshots", () => {
  const f = fixture(),
    j = f.journal;
  try {
    startUsage(j, "thread", "first");
    recordUsage(j, "thread", "first", {
      total: { totalTokens: 1000 },
      last: { totalTokens: 50 },
    });
    expect(turnUsage(j, "first")).toEqual({
      tokens: 1000,
      sessionTokens: 1000,
      scope: "session",
    });
    startUsage(j, "thread", "next");
    recordUsage(j, "thread", "next", {
      total: { totalTokens: 1200 },
      last: { totalTokens: 200 },
    });
    recordUsage(j, "thread", "next", {
      total: { totalTokens: 1200 },
      last: { totalTokens: 200 },
    });
    expect(turnUsage(j, "next")).toEqual({
      tokens: 200,
      sessionTokens: 1200,
      scope: "turn",
    });
    recordUsage(j, "thread", "next", {
      total: { totalTokens: 1350 },
      last: { totalTokens: 150 },
    });
    expect(turnUsage(j, "next")).toEqual({
      tokens: 350,
      sessionTokens: 1350,
      scope: "turn",
    });
    const reopened = new Journal(f.root);
    try {
      expect(turnUsage(reopened, "next")).toEqual({
        tokens: 350,
        sessionTokens: 1350,
        scope: "turn",
      });
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test("reconnects retain known turn baselines but hide stale snapshots and never reuse a stale thread checkpoint", () => {
  const f = fixture(),
    j = f.journal;
  try {
    recordUsage(j, "thread", "prior", { total: { totalTokens: 1000 } });
    startUsage(j, "thread", "active");
    recordUsage(j, "thread", "active", { total: { totalTokens: 1200 } });
    reconnectUsage(j);
    expect(turnUsage(j, "active")).toBeUndefined();
    startUsage(j, "thread", "active");
    recordUsage(j, "thread", "active", { total: { totalTokens: 1400 } });
    expect(turnUsage(j, "active")).toEqual({
      tokens: 400,
      sessionTokens: 1400,
      scope: "turn",
    });
    reconnectUsage(j);
    startUsage(j, "thread", "missed-start");
    recordUsage(j, "thread", "missed-start", { total: { totalTokens: 1800 } });
    expect(turnUsage(j, "missed-start")).toEqual({
      tokens: 1800,
      sessionTokens: 1800,
      scope: "session",
    });
    startUsage(j, "other", "another-thread");
    recordUsage(j, "other", "another-thread", { total: { totalTokens: 30 } });
    expect(turnUsage(j, "another-thread")).toEqual({
      tokens: 30,
      sessionTokens: 30,
      scope: "session",
    });
    expect(turnUsage(j, "active", "other")).toBeUndefined();
  } finally {
    f.close();
  }
});

test("invalid snapshots and counter resets never become invented or negative turn totals", () => {
  const f = fixture(),
    j = f.journal;
  try {
    for (const totalTokens of [-1, NaN, Infinity, 1.5, "100"])
      recordUsage(j, "thread", "invalid", { total: { totalTokens } });
    expect(turnUsage(j, "invalid")).toBeUndefined();
    recordUsage(j, "thread", "prior", { total: { totalTokens: 1000 } });
    startUsage(j, "thread", "reset");
    recordUsage(j, "thread", "reset", { total: { totalTokens: 10 } });
    expect(turnUsage(j, "reset")).toEqual({
      tokens: 10,
      sessionTokens: 10,
      scope: "session",
    });
    recordUsage(j, "thread", "reset", { total: { totalTokens: 1100 } });
    expect(turnUsage(j, "reset")).toEqual({
      tokens: 1100,
      sessionTokens: 1100,
      scope: "session",
    });
  } finally {
    f.close();
  }
});

test("component counts use matching turn baselines and cached input remains a subset", () => {
  const f = fixture(),
    j = f.journal;
  const snapshot = (
    totalTokens: number,
    inputTokens: number,
    cachedInputTokens: number,
    outputTokens: number,
  ) => ({
    total: { totalTokens, inputTokens, cachedInputTokens, outputTokens },
  });
  try {
    recordUsage(j, "thread", "prior", snapshot(1000, 900, 700, 100));
    expect(turnUsage(j, "prior")).toEqual({
      tokens: 1000,
      sessionTokens: 1000,
      sessionBreakdown: {
        inputTokens: 900,
        cachedInputTokens: 700,
        outputTokens: 100,
      },
      scope: "session",
      inputTokens: 900,
      cachedInputTokens: 700,
      outputTokens: 100,
    });
    startUsage(j, "thread", "next");
    recordUsage(j, "thread", "next", snapshot(1500, 1300, 1000, 200));
    recordUsage(j, "thread", "next", snapshot(1500, 1300, 1000, 200));
    const expected = {
      sessionBreakdown: {
        inputTokens: 1300,
        cachedInputTokens: 1000,
        outputTokens: 200,
      },
      tokens: 500,
      sessionTokens: 1500,
      scope: "turn" as const,
      inputTokens: 400,
      cachedInputTokens: 300,
      outputTokens: 100,
    };
    expect(turnUsage(j, "next")).toEqual({ ...expected, sessionTokens: 1500 });
    reconnectUsage(j);
    startUsage(j, "thread", "next");
    expect(turnUsage(j, "next")).toBeUndefined();
    recordUsage(j, "thread", "next", snapshot(1500, 1300, 1000, 200));
    expect(turnUsage(j, "next")).toEqual({ ...expected, sessionTokens: 1500 });
    const reopened = new Journal(f.root);
    try {
      expect(turnUsage(reopened, "next")).toEqual(expected);
    } finally {
      reopened.close();
    }
    // A component reset must not fabricate a delta even when the total grows.
    recordUsage(j, "thread", "next", snapshot(1600, 1400, 100, 200));
    expect(turnUsage(j, "next")).toEqual({
      tokens: 600,
      sessionTokens: 1600,
      sessionBreakdown: {
        inputTokens: 1400,
        cachedInputTokens: 100,
        outputTokens: 200,
      },
      scope: "turn",
    });
    recordUsage(j, "thread", "next", snapshot(2600, 2000, 1100, 600));
    expect(turnUsage(j, "next")).toEqual({
      tokens: 1600,
      sessionTokens: 2600,
      sessionBreakdown: {
        inputTokens: 2000,
        cachedInputTokens: 1100,
        outputTokens: 600,
      },
      scope: "turn",
    });
  } finally {
    f.close();
  }
});

test("old journals and invalid components never mix session components into turn counts", () => {
  const f = fixture(),
    j = f.journal;
  try {
    recordUsage(j, "thread", "old", { total: { totalTokens: 1000 } });
    startUsage(j, "thread", "upgrade");
    recordUsage(j, "thread", "upgrade", {
      total: {
        totalTokens: 1500,
        inputTokens: 1300,
        cachedInputTokens: 1000,
        outputTokens: 200,
      },
    });
    expect(turnUsage(j, "upgrade")).toEqual({
      tokens: 500,
      sessionTokens: 1500,
      sessionBreakdown: {
        inputTokens: 1300,
        cachedInputTokens: 1000,
        outputTokens: 200,
      },
      scope: "turn",
    });
    startUsage(j, "thread", "next");
    recordUsage(j, "thread", "next", {
      total: {
        totalTokens: 1700,
        inputTokens: 1450,
        cachedInputTokens: 1100,
        outputTokens: 250,
      },
    });
    expect(turnUsage(j, "next")).toEqual({
      tokens: 200,
      sessionTokens: 1700,
      sessionBreakdown: {
        inputTokens: 1450,
        cachedInputTokens: 1100,
        outputTokens: 250,
      },
      scope: "turn",
      inputTokens: 150,
      cachedInputTokens: 100,
      outputTokens: 50,
    });
    for (const components of [
      { inputTokens: 100, cachedInputTokens: 101, outputTokens: 1 },
      { inputTokens: 100, cachedInputTokens: -1, outputTokens: 1 },
      { inputTokens: 100, cachedInputTokens: 0 },
      { inputTokens: 100, cachedInputTokens: 0, outputTokens: "1" },
    ]) {
      recordUsage(j, "other", "invalid", {
        total: { totalTokens: 1000, ...components },
      });
      expect(turnUsage(j, "invalid")).toEqual({
        tokens: 1000,
        sessionTokens: 1000,
        scope: "session",
      });
    }
  } finally {
    f.close();
  }
});

test("early working messages can show known session usage without inventing a turn count", () => {
  const f = fixture(),
    j = f.journal;
  try {
    const components = {
      inputTokens: 900,
      cachedInputTokens: 700,
      outputTokens: 100,
    };
    recordUsage(j, "thread", "prior", {
      total: { totalTokens: 1000, ...components },
    });
    startUsage(j, "thread", "next");
    j.put("active_turn", "next");
    expect(turnUsage(j, "next")).toEqual({
      tokens: 1000,
      sessionTokens: 1000,
      scope: "session",
      ...components,
      sessionBreakdown: components,
    });
    expect(turnUsage(j, "next", "other")).toBeUndefined();
    j.put("active_turn", null);
    expect(turnUsage(j, "next")).toBeUndefined();
    j.put("active_turn", "next");
    reconnectUsage(j);
    expect(turnUsage(j, "next")).toBeUndefined();
  } finally {
    f.close();
  }
});

test("context size uses the last request instead of cumulative tokens, matches CLI percentage, and shrinks after compaction", () => {
  const f = fixture(),
    j = f.journal;
  try {
    recordUsage(j, "thread", "turn", {
      total: { totalTokens: 9000000 },
      last: { totalTokens: 123400 },
      modelContextWindow: 258400,
    });
    expect(turnUsage(j, "turn")?.context).toEqual({
      tokens: 123400,
      window: 258400,
      usedPercent: 45,
    });
    recordUsage(j, "thread", "turn", {
      total: { totalTokens: 9100000 },
      last: { totalTokens: 20000 },
      modelContextWindow: 258400,
    });
    expect(turnUsage(j, "turn")?.context).toEqual({
      tokens: 20000,
      window: 258400,
      usedPercent: 3,
    });
    recordUsage(j, "thread", "turn", {
      total: { totalTokens: 9200000 },
      last: { totalTokens: 300000 },
      modelContextWindow: 258400,
    });
    expect(turnUsage(j, "turn")?.context?.usedPercent).toBe(100);
    reconnectUsage(j);
    expect(turnUsage(j, "turn")).toBeUndefined();
    recordUsage(j, "thread", "turn", {
      total: { totalTokens: 9300000 },
      last: { totalTokens: 30000 },
      modelContextWindow: null,
    });
    expect(turnUsage(j, "turn")?.context).toBeUndefined();
  } finally {
    f.close();
  }
});
