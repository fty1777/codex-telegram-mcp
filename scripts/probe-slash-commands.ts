// Real local App Server compatibility check. Creates and archives only its own
// disposable thread. No model turns, Telegram requests, or production bindings.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppServer } from "../bun/appserver";
import { nativeCommand, commandHelp } from "../bun/commands";

const cwd = mkdtempSync(join(tmpdir(), "telegram-slash-probe-"));
const client = await AppServer.connect();
let threadId: string | undefined;
const methods: string[] = [];
const originalCall = client.call.bind(client);
client.call = (method, params) => { methods.push(method); return originalCall(method, params); };
try {
  const id: string = (await client.call("thread/start", { cwd, sandbox: "read-only", approvalPolicy: "never" })).thread.id;
  threadId = id;
  const run = (command: string, args = "") => nativeCommand(client, threadId!, command, args, false);
  assert.match(commandHelp("goal"), /\/goal pause/);
  assert.match(await run("/model") ?? "", /Current model:/);
  // Persist a fixture without generating a model turn, so resume can read all
  // settings. Fresh loaded-thread queries above exercise the no-rollout case.
  await client.call("thread/inject_items", {
    threadId, items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Slash command API fixture." }] }],
  });
  const initial = await client.resume(id);
  const model = (await client.call("model/list", { limit: 100 })).data.find((m: any) => m.model === initial.model);
  assert(model, "Current model must be available in the model catalog");
  await run("/plan");
  assert.equal((await client.resume(id)).collaborationMode.mode, "plan");
  await run("/model", `${model.model} ${model.defaultReasoningEffort}`);
  let state = await client.resume(id);
  assert.equal(state.model, model.model);
  assert.equal(state.reasoningEffort, model.defaultReasoningEffort);
  assert.equal(state.collaborationMode.mode, "plan");
  await run("/effort", model.supportedReasoningEfforts[0].reasoningEffort);
  state = await client.resume(id);
  assert.equal(state.reasoningEffort, model.supportedReasoningEfforts[0].reasoningEffort);
  assert.equal(state.collaborationMode.settings.reasoning_effort, state.reasoningEffort);
  const fast = model.serviceTiers.find((t: any) => t.name.toLowerCase() === "fast");
  if (fast) {
    await run("/fast", "on");
    assert.equal((await client.resume(id)).serviceTier, fast.id);
  }
  await run("/fast", "off");
  assert([null, "default"].includes((await client.resume(id)).serviceTier));
  const profiles = await client.call("permissionProfile/list", { cwd });
  const profile = profiles.data.find((p: any) => p.id === ":read-only" && p.allowed);
  assert(profile, "Disposable test needs the allowed read-only profile");
  await run("/permissions", profile.id);
  assert.equal((await client.resume(id)).activePermissionProfile.id, profile.id);
  await run("/plan", "off");
  assert.equal((await client.resume(id)).collaborationMode.mode, "default");
  for (const command of ["/permissions", "/plan", "/fast", "/effort", "/mcp", "/skills", "/plugins", "/ps"]) {
    const args = ["/plan", "/fast"].includes(command) ? "status" : "";
    assert.equal(typeof await run(command, args), "string");
  }
  assert(!methods.includes("turn/start") && !methods.includes("review/start"));
  assert.equal((await client.call("thread/read", { threadId, includeTurns: true })).thread.turns.length, 0);
  console.log(JSON.stringify({ native_settings: "verified", discovery_queries: "verified", model_turns: 0, telegram_delivery: "not_run", production_session: "untouched" }));
} finally {
  try { if (threadId) await client.call("thread/archive", { threadId }); }
  finally { client.close(); rmSync(cwd, { recursive: true, force: true }); }
}
