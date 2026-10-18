import { test, expect } from "bun:test";
import { nativeCommand, commandHelp, COMMANDS } from "../bun/commands";
import { RpcError } from "../bun/appserver";

function fixture() {
  const state: any = {
    cwd: "/workspace", model: "alpha", reasoningEffort: "high", serviceTier: null,
    activePermissionProfile: { id: ":read-only" }, approvalPolicy: "on-request",
    collaborationMode: { mode: "default" },
  };
  const models: any[] = [
    { id: "alpha-id", model: "alpha", displayName: "Alpha", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], serviceTiers: [{ id: "priority", name: "Fast" }] },
    { id: "beta", model: "beta", displayName: "Beta", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }], serviceTiers: [] },
  ];
  const calls: any[] = [];
  const client: any = {
    resume: async (thread: string) => { expect(thread).toBe("bound"); return state; },
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "model/list") return { data: params.cursor ? [models[1]] : [models[0]], nextCursor: params.cursor ? null : "second" };
      if (method === "thread/settings/update") {
        Object.assign(state, params);
        if (params.effort) state.reasoningEffort = params.effort;
        return {};
      }
      if (method === "permissionProfile/list") return { data: [{ id: ":read-only", allowed: true }, { id: "forbidden", allowed: false }], nextCursor: null };
      if (method === "skills/list") return { data: [{ skills: [
        { name: "enabled", path: "/trusted/enabled/SKILL.md", enabled: true, description: "Enabled skill" },
        { name: "disabled", path: "/trusted/disabled/SKILL.md", enabled: false },
      ] }] };
      if (method === "mcpServerStatus/list") return { data: [{ name: "server", runtimeStatus: "connected", tools: { read: {}, write: {} }, toolsError: "PRIVATE_EXCEPTION", headers: { Authorization: "secret" } }], nextCursor: null };
      if (method === "plugin/installed") return { marketplaces: [{ plugins: [{ id: "installed@market", installed: true, enabled: true }, { id: "other@market", installed: false }] }] };
      if (method === "thread/backgroundTerminals/list") return { data: [{ processId: "job", command: "test" }], nextCursor: null };
      if (["turn/start", "review/start"].includes(method)) return { turn: { id: "new-turn" } };
      throw Error("Unexpected method: " + method);
    },
  };
  const run = (command: string, args = "", active = false, context = {}) => nativeCommand(client, "bound", command, args, active, context);
  return { state, models, calls, client, run, writes: () => calls.filter(c => ["thread/settings/update", "turn/start", "review/start"].includes(c.method)) };
}

test("every menu command has static, specific help", () => {
  for (const { command } of COMMANDS) {
    expect(commandHelp(command)).toContain("/" + command);
    expect(commandHelp(command)).not.toContain("No help");
  }
  expect(commandHelp("goal")).toContain("/goal pause");
  expect(commandHelp("goal")).toContain("/stop");
});

test("model and effort selection validates the paginated catalog before changing settings", async () => {
  const f = fixture();
  expect(await f.run("/model")).toContain("beta");
  expect(await f.run("/model", "missing")).toContain("not found");
  expect(await f.run("/model", "beta high")).toContain("Available reasoning efforts");
  expect(await f.run("/effort", "ultra")).toContain("Available reasoning efforts");
  expect(f.writes()).toHaveLength(0);
  await f.run("/model", "beta");
  expect(f.writes()[0].params).toEqual({ threadId: "bound", model: "beta", effort: "medium" });
  await f.run("/model", "alpha-id high");
  await f.run("/effort", "low");
  expect(f.writes().at(-1).params).toEqual({ threadId: "bound", model: "alpha", effort: "low" });
});

test("Fast mode uses the catalog tier id and refuses unsupported models", async () => {
  const f = fixture();
  await f.run("/fast");
  expect(f.state.serviceTier).toBe("priority");
  await f.run("/fast");
  expect(f.state.serviceTier).toBeNull();
  f.state.model = "beta";
  expect(await f.run("/fast", "on")).toContain("not available");
  expect(await f.run("/fast", "invalid")).toContain("Use /fast");
  expect(f.writes()).toHaveLength(2);
  await f.run("/fast", "off");
  expect(f.state.serviceTier).toBeNull();
});

test("queued setting changes are observed without repeating their mutation", async () => {
  const f = fixture();
  let snapshots = 0;
  const call = f.client.call;
  f.client.call = async (method: string, params: any) => {
    if (method === "thread/settings/update") { f.calls.push({ method, params }); return {}; }
    return call(method, params);
  };
  f.client.resume = async () => {
    if (++snapshots >= 3) f.state.serviceTier = "priority";
    return { ...f.state };
  };
  expect(await f.run("/fast", "on")).toContain("Applies to subsequent turns.");
  expect(snapshots).toBeGreaterThanOrEqual(3);
  expect(f.writes()).toHaveLength(1);
});

test("permissions only selects an explicitly allowed profile from the current workspace", async () => {
  const f = fixture();
  expect(await f.run("/permissions")).toContain(":read-only");
  await f.run("/permissions", "forbidden");
  await f.run("/permissions", "invented");
  expect(f.writes()).toHaveLength(0);
  await f.run("/permissions", ":read-only");
  expect(f.writes()[0].params).toEqual({ threadId: "bound", permissions: ":read-only" });
  expect(f.calls.find(c => c.method === "permissionProfile/list").params.cwd).toBe("/workspace");
});

test("plan mode alone does not invoke the model; inline prompts do and track their turn", async () => {
  const f = fixture(), turns: any[] = [];
  await f.run("/plan");
  expect(f.state.collaborationMode.mode).toBe("plan");
  expect(f.calls.some(c => c.method === "turn/start")).toBe(false);
  await f.run("/plan", "off");
  expect(f.state.collaborationMode.mode).toBe("default");
  await f.run("/plan", "Design\n  this", false, { started: (t: any) => turns.push(t), requestId: "stable-request" });
  expect(f.calls.at(-1).params).toEqual({ threadId: "bound", input: [{ type: "text", text: "Design\n  this" }], clientUserMessageId: "stable-request" });
  expect(turns).toEqual([{ id: "new-turn" }]);
  const writes = f.writes().length;
  expect(await f.run("/plan", "off", true)).toContain("working");
  expect(await f.run("/plan", "status", true)).toContain("plan");
  expect(f.writes()).toHaveLength(writes);
});

test("review supports changes, branch, commit and custom targets without starting a second session", async () => {
  const f = fixture();
  await f.run("/review");
  await f.run("/review", "branch main");
  await f.run("/review", "commit abc123");
  await f.run("/review", "Inspect concurrency");
  expect(f.writes().map(c => c.params)).toEqual([
    { threadId: "bound", delivery: "inline", target: { type: "uncommittedChanges" } },
    { threadId: "bound", delivery: "inline", target: { type: "baseBranch", branch: "main" } },
    { threadId: "bound", delivery: "inline", target: { type: "commit", sha: "abc123", title: null } },
    { threadId: "bound", delivery: "inline", target: { type: "custom", instructions: "Inspect concurrency" } },
  ]);
  await f.run("/review", "", true);
  expect(f.writes()).toHaveLength(4);
});

test("skills only invokes uniquely named enabled skills with a native skill input", async () => {
  const f = fixture();
  expect(await f.run("/skills")).toContain("enabled");
  expect(await f.run("/skills")).not.toContain("disabled");
  await f.run("/skills", "disabled Do work");
  await f.run("/skills", "enabled");
  await f.run("/skills", "enabled Do work", true);
  expect(f.writes()).toHaveLength(0);
  await f.run("/skills", "enabled Do work");
  expect(f.writes()[0].params.input).toEqual([
    { type: "text", text: "$enabled Do work" },
    { type: "skill", name: "enabled", path: "/trusted/enabled/SKILL.md" },
  ]);
});

test("discovery queries are thread scoped and never echo private server diagnostics or config", async () => {
  const f = fixture();
  expect(await f.run("/mcp", "verbose")).toBe("server: connected (2 tools)\nread, write");
  expect(f.calls.at(-1).params.threadId).toBe("bound");
  expect(await f.run("/plugins")).toBe("installed@market: enabled");
  expect(await f.run("/ps")).toBe("job: test");
  expect(f.writes()).toHaveLength(0);
});

test("fresh loaded sessions query without starting a paid turn and avoid guessing an unknown Fast tier", async () => {
  const f = fixture();
  f.client.resume = async () => { throw new RpcError({ code: -32600, message: "no rollout found for thread id bound" }); };
  const call = f.client.call;
  f.client.call = async (method: string, params: any) => method === "thread/read"
    ? { thread: { cwd: "/workspace", model: "alpha", reasoningEffort: "high" } } : call(method, params);
  expect(await f.run("/model")).toContain("alpha");
  expect(await f.run("/fast")).toContain("unavailable before the first turn");
  expect(f.writes()).toHaveLength(0);
  await f.run("/fast", "on");
  expect(f.writes()[0].params.serviceTier).toBe("priority");
});
