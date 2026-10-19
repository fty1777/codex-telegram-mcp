// Uses two short real model turns and one manual compaction in its own disposable
// thread. Telegram is stubbed; no credentials, pairing, plugins, or production
// sessions are changed. Read before running: this consumes model usage.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppServer } from "../bun/appserver";
import { Store } from "../bun/state";
import { Telegram, Sender } from "../bun/telegram";
import { Engine } from "../bun/engine";

const root = mkdtempSync(join(tmpdir(), "telegram-telemetry-probe-"));
const client = await AppServer.connect();
let threadId: string | undefined, engine: Engine | undefined, sender: Sender | undefined;
const sent: any[] = [], usage: any[] = [];
try {
  threadId = (await client.call("thread/start", {
    cwd: root, sandbox: "read-only", approvalPolicy: "never",
    developerInstructions: "Integration check. Reply with only OK; do not use tools or access files or network.",
  })).thread.id;
  const store = new Store(join(root, "state"));
  store.configure("test", "123456:fixture", { id: 123456, username: "fixture" }, 12, threadId!);
  const api = new Telegram("123456:fixture");
  api.call = async (method, params) => { sent.push({ method, params }); return { message_id: sent.length, chat: { id: 12 } }; };
  sender = new Sender(store, "test", api);
  engine = new Engine(store, "test", client, sender);
  await engine.attach();
  async function finishTurn() {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      while (client.events.length) {
        const event = client.events.shift();
        if (event.params?.threadId !== threadId) continue;
        if (event.method === "thread/tokenUsage/updated") usage.push(event.params);
        await engine!.event(event);
        if (event.method === "turn/completed") {
          assert.equal(event.params.turn.status, "completed");
          return event.params.turn.id;
        }
      }
      await Bun.sleep(100);
    }
    throw Error("Disposable telemetry turn did not finish before the observation deadline");
  }
  const run = async (id: number) => {
    assert.equal(await engine!.receiveBatch([{ update_id: id, message: {
      message_id: id, date: Math.floor(Date.now() / 1000), text: "Reply only OK.",
      from: { id: 12 }, chat: { id: 12, type: "private" },
    } }]), "accepted");
    return finishTurn();
  };
  const first = await run(1), firstTotal = usage.filter(u => u.turnId === first).at(-1)?.tokenUsage.total.totalTokens;
  assert(Number.isSafeInteger(firstTotal));
  const second = await run(2), secondTotal = usage.filter(u => u.turnId === second).at(-1)?.tokenUsage.total.totalTokens;
  assert(Number.isSafeInteger(secondTotal) && secondTotal > firstTotal);
  const before = usage.filter(u => u.turnId === first).at(-1).tokenUsage.total;
  const after = usage.filter(u => u.turnId === second).at(-1).tokenUsage.total;
  const count = (key: string) => `${(Math.round((after[key] - before[key]) / 100) / 10).toFixed(1)}k`;
  assert(sent.some(s => s.params.text?.includes(`↑${count("inputTokens")} (cache ${count("cachedInputTokens")}) ↓${count("outputTokens")}`)));
  const sessionCount = (key: string) => {
    const millions = after[key] >= 1_000_000;
    return `${(Math.round(after[key] / (millions ? 100_000 : 100)) / 10).toFixed(1)}${millions ? "m" : "k"}`;
  };
  assert(sent.some(s => s.params.text?.includes(`session ${sessionCount("totalTokens")} ↑${sessionCount("inputTokens")} (cache ${sessionCount("cachedInputTokens")}) ↓${sessionCount("outputTokens")}`)));
  await client.call("thread/compact/start", { threadId });
  await finishTurn();
  assert.equal(sent.filter(s => s.params.text === "System\nContext compaction started.").length, 1);
  assert.equal(sent.filter(s => s.params.text?.startsWith("System\nContext compacted.")).length, 1);
  console.log(JSON.stringify({ native_usage: "verified", final_turn_delta: "verified", component_deltas: "verified", compaction_start_and_completion: "verified", telegram_delivery: "not_run", production_session: "untouched" }));
} finally {
  try { if (threadId) await client.call("thread/archive", { threadId }); }
  finally { engine?.close(); sender?.journal.close(); client.close(); rmSync(root, { recursive: true, force: true }); }
}
