import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../bun/state";
import { reconnectUsage, startUsage, recordUsage, turnUsage } from "../bun/usage";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telegram-usage-"));
  const journal = new Journal(root);
  return { journal, root, close() { journal.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("turn usage uses cumulative differences, never the last request or a sum of snapshots", () => {
  const f = fixture(), j = f.journal;
  try {
    startUsage(j, "thread", "first");
    recordUsage(j, "thread", "first", { total: { totalTokens: 1000 }, last: { totalTokens: 50 } });
    expect(turnUsage(j, "first")).toEqual({ tokens: 1000, scope: "session" });
    startUsage(j, "thread", "next");
    recordUsage(j, "thread", "next", { total: { totalTokens: 1200 }, last: { totalTokens: 200 } });
    recordUsage(j, "thread", "next", { total: { totalTokens: 1200 }, last: { totalTokens: 200 } });
    expect(turnUsage(j, "next")).toEqual({ tokens: 200, scope: "turn" });
    recordUsage(j, "thread", "next", { total: { totalTokens: 1350 }, last: { totalTokens: 150 } });
    expect(turnUsage(j, "next")).toEqual({ tokens: 350, scope: "turn" });
    const reopened = new Journal(f.root);
    try { expect(turnUsage(reopened, "next")).toEqual({ tokens: 350, scope: "turn" }); }
    finally { reopened.close(); }
  } finally { f.close(); }
});

test("reconnects retain known turn baselines but hide stale snapshots and never reuse a stale thread checkpoint", () => {
  const f = fixture(), j = f.journal;
  try {
    recordUsage(j, "thread", "prior", { total: { totalTokens: 1000 } });
    startUsage(j, "thread", "active");
    recordUsage(j, "thread", "active", { total: { totalTokens: 1200 } });
    reconnectUsage(j);
    expect(turnUsage(j, "active")).toBeUndefined();
    startUsage(j, "thread", "active");
    recordUsage(j, "thread", "active", { total: { totalTokens: 1400 } });
    expect(turnUsage(j, "active")).toEqual({ tokens: 400, scope: "turn" });
    reconnectUsage(j);
    startUsage(j, "thread", "missed-start");
    recordUsage(j, "thread", "missed-start", { total: { totalTokens: 1800 } });
    expect(turnUsage(j, "missed-start")).toEqual({ tokens: 1800, scope: "session" });
    startUsage(j, "other", "another-thread");
    recordUsage(j, "other", "another-thread", { total: { totalTokens: 30 } });
    expect(turnUsage(j, "another-thread")).toEqual({ tokens: 30, scope: "session" });
    expect(turnUsage(j, "active", "other")).toBeUndefined();
  } finally { f.close(); }
});

test("invalid snapshots and counter resets never become invented or negative turn totals", () => {
  const f = fixture(), j = f.journal;
  try {
    for (const totalTokens of [-1, NaN, Infinity, 1.5, "100"])
      recordUsage(j, "thread", "invalid", { total: { totalTokens } });
    expect(turnUsage(j, "invalid")).toBeUndefined();
    recordUsage(j, "thread", "prior", { total: { totalTokens: 1000 } });
    startUsage(j, "thread", "reset");
    recordUsage(j, "thread", "reset", { total: { totalTokens: 10 } });
    expect(turnUsage(j, "reset")).toEqual({ tokens: 10, scope: "session" });
    recordUsage(j, "thread", "reset", { total: { totalTokens: 1100 } });
    expect(turnUsage(j, "reset")).toEqual({ tokens: 1100, scope: "session" });
  } finally { f.close(); }
});
