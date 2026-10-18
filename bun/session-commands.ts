import { RpcError, type Client } from "./appserver";

export interface CommandContext {
  started?: (turn: any) => void;
  requestId?: string;
}

async function inventory(client: Client, method: string, params: any = {}) {
  const data: any[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.call(method, { ...params, ...(cursor ? { cursor } : {}) });
    data.push(...page.data);
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw Error("Repeated inventory cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return data;
}

export async function sessionCommand(
  client: Client, threadId: string, command: string, args: string, active: boolean,
  context: CommandContext,
): Promise<string | null> {
  const snapshot = async () => {
    try { return await client.resume(threadId); }
    catch (error) {
      if (!(error instanceof RpcError) || !error.message.includes("no rollout found for thread id " + threadId)) throw error;
      // A loaded thread can accept commands before its first persisted turn.
      const { thread } = await client.call("thread/read", { threadId, includeTurns: false });
      return { thread, cwd: thread.cwd, model: thread.model, reasoningEffort: thread.reasoningEffort };
    }
  };
  const update = async (settings: any) => {
    await client.call("thread/settings/update", { threadId, ...settings });
    // The RPC can acknowledge a queued configuration change before the thread
    // actor applies it. Observe the same thread; never replay the mutation.
    for (let attempt = 0; attempt < 6; attempt++) {
      let state;
      try { state = await snapshot(); } catch { return false; }
      const matches = Object.entries(settings).every(([key, value]) => {
        if (key === "effort") return state.reasoningEffort === value;
        if (key === "permissions") return state.activePermissionProfile?.id === value;
        if (key === "collaborationMode") return state.collaborationMode?.mode === (value as any).mode;
        if (key === "serviceTier" && value === null) return [null, "default"].includes(state.serviceTier);
        return state[key] === value;
      });
      if (matches) return true;
      if (!("serviceTier" in state)) return false;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
    return false;
  };
  const confirmation = (confirmed: boolean) => confirmed
    ? "Applies to subsequent turns." : "Change requested. Query this setting again to confirm it has taken effect.";
  const start = async (input: any[]) => {
    const result = await client.call("turn/start", {
      threadId, input, ...(context.requestId ? { clientUserMessageId: context.requestId } : {}),
    });
    context.started?.(result.turn);
  };
  if (["/model", "/effort", "/fast"].includes(command)) {
    const current = await snapshot();
    const models = await inventory(client, "model/list", { limit: 100 });
    const selected = models.find(m => m.model === current.model || m.id === current.model);
    if (command === "/model" && !args) {
      return `Current model: ${current.model}\nReasoning effort: ${current.reasoningEffort ?? "default"}\n` +
        models.map(m => `${m.model} — ${m.displayName}`).join("\n") +
        "\nUse /model MODEL [EFFORT] to switch.";
    }
    if (command === "/fast") {
      if (args && !["on", "off", "status"].includes(args)) return "Use /fast [on|off|status].";
      if ((args === "status" || !args) && !("serviceTier" in current))
        return "Current service tier unavailable before the first turn. Use /fast on or /fast off to set it explicitly.";
      if (args === "status") return `Service tier: ${current.serviceTier ?? "default"}`;
      const tier = selected?.serviceTiers?.find((t: any) => t.name.toLowerCase() === "fast");
      const enabled = args ? args === "on" : current.serviceTier !== tier?.id;
      if (enabled && !tier) return "Fast mode is not available for the current model.";
      const confirmed = await update({ serviceTier: enabled ? tier.id : null });
      return `Fast mode ${enabled ? "on" : "off"}${confirmed ? "." : " requested."} ${confirmation(confirmed)}`;
    }
    const parts = args.split(/\s+/);
    if ((command === "/effort" && parts.length > 1) || parts.length > 2)
      return "Use /model MODEL [EFFORT] or /effort LEVEL.";
    const model = command === "/model"
      ? models.find(m => m.model === parts[0] || m.id === parts[0]) : selected;
    if (!model) return "Model not found in the available catalog. Use /model to see available models.";
    const efforts = model.supportedReasoningEfforts.map((e: any) => e.reasoningEffort);
    if (command === "/effort" && !args)
      return `Reasoning effort: ${current.reasoningEffort ?? "default"}\nAvailable: ${efforts.join(", ")}\nUse /effort LEVEL.`;
    const effort = command === "/effort" ? args : parts[1] ?? model.defaultReasoningEffort;
    if (!efforts.includes(effort)) return `Available reasoning efforts for ${model.model}: ${efforts.join(", ")}`;
    const confirmed = await update({ model: model.model, effort });
    return `Model${confirmed ? "" : " requested"}: ${model.model}\nReasoning effort: ${effort}\n${confirmation(confirmed)}`;
  }
  if (command === "/permissions") {
    const current = await snapshot();
    const profiles = await inventory(client, "permissionProfile/list", { cwd: current.cwd });
    if (!args) return `Current permissions: ${current.activePermissionProfile?.id ?? current.sandbox?.type ?? "unknown"}` +
      `\nApproval policy: ${typeof current.approvalPolicy === "string" ? current.approvalPolicy : current.approvalPolicy ? "custom" : "unknown"}\n` +
      profiles.map(p => `${p.id}${p.allowed ? "" : " (unavailable)"}${p.description ? " — " + p.description : ""}`).join("\n") +
      "\nUse /permissions PROFILE to select a listed profile.";
    const profile = profiles.find(p => p.id === args);
    if (!profile?.allowed) return "Permission profile unavailable. Use /permissions to see allowed profiles.";
    const confirmed = await update({ permissions: profile.id });
    return `Permissions${confirmed ? "" : " requested"}: ${profile.id}\n${confirmation(confirmed)}`;
  }
  if (command === "/plan") {
    const current = await snapshot();
    if (args === "status") return `Mode: ${"collaborationMode" in current ? current.collaborationMode?.mode ?? "default" : "unavailable before the first turn"}`;
    if (active) return "Codex is working. Change planning mode after the current task finishes.";
    const mode = args === "off" ? "default" : "plan";
    const confirmed = await update({ collaborationMode: {
      mode, settings: { model: current.model, reasoning_effort: current.reasoningEffort, developer_instructions: null },
    } });
    if (args && !["on", "off"].includes(args)) {
      await start([{ type: "text", text: args }]);
      return "Planning request submitted.";
    }
    return `Mode${confirmed ? "" : " requested"}: ${mode}`;
  }
  if (command === "/review") {
    if (active) return "Codex is working. Start a review after the current task finishes.";
    if (["branch", "commit"].includes(args)) return "Use /review branch BRANCH or /review commit SHA.";
    let target: any = { type: "uncommittedChanges" };
    if (args.startsWith("branch ")) target = { type: "baseBranch", branch: args.slice(7).trim() };
    else if (args.startsWith("commit ")) target = { type: "commit", sha: args.slice(7).trim(), title: null };
    else if (args) target = { type: "custom", instructions: args };
    const result = await client.call("review/start", { threadId, delivery: "inline", target });
    context.started?.(result.turn);
    return "Code review started.";
  }
  if (command === "/mcp") {
    if (args && args !== "verbose") return "Use /mcp [verbose].";
    const servers = await inventory(client, "mcpServerStatus/list", { threadId, limit: 100 });
    return servers.map(s => `${s.name}: ${s.runtimeStatus ?? "unknown"} (${Object.keys(s.tools).length} tools)` +
      (args === "verbose" ? "\n" + Object.keys(s.tools).join(", ") : "")).join("\n") || "No MCP servers configured.";
  }
  if (command === "/skills") {
    if (args && active) return "Codex is working. Invoke a skill after the current task finishes.";
    const current = await snapshot();
    const { data } = await client.call("skills/list", { cwds: [current.cwd], forceReload: false });
    const skills = data.flatMap((d: any) => d.skills).filter((s: any) => s.enabled);
    if (!args) return skills.map((s: any) => `${s.name} — ${s.shortDescription ?? s.description}`).join("\n") +
      (skills.length ? "\nUse /skills NAME TASK to invoke a skill." : "No enabled skills available.");
    const match = /^(\S+)\s+([\s\S]+)$/.exec(args);
    if (!match) return "Use /skills NAME TASK to invoke a skill.";
    const found = skills.filter((s: any) => s.name === match[1]);
    if (found.length !== 1) return "Skill name unavailable or ambiguous. Use /skills to see available skills.";
    await start([
      { type: "text", text: `$${found[0].name} ${match[2]}` },
      { type: "skill", name: found[0].name, path: found[0].path },
    ]);
    return `Skill request submitted: ${found[0].name}`;
  }
  if (command === "/plugins") {
    if (args) return "Use /plugins without arguments to list installed plugins.";
    const current = await snapshot();
    const result = await client.call("plugin/installed", { cwds: [current.cwd] });
    const plugins = result.marketplaces.flatMap((m: any) => m.plugins).filter((p: any) => p.installed);
    return (plugins.map((p: any) => `${p.id}: ${p.enabled ? "enabled" : "disabled"}`).join("\n") || "No installed plugins.") +
      (result.marketplaceLoadErrors?.length ? "\nSome plugin catalogs could not be loaded." : "");
  }
  if (command === "/ps") {
    if (args) return "Use /ps without arguments to list background terminals.";
    const terminals = await inventory(client, "thread/backgroundTerminals/list", { threadId, limit: 100 });
    return terminals.map(t => `${t.processId}: ${t.command}`).join("\n") || "No background terminals running.";
  }
  return null;
}
