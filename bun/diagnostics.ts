import type { AppServer } from "./appserver";
export async function hooks(client: AppServer, config: any) {
  if (config.lifecycle === "mcp")
    return {
      status: "not-required",
      lifecycle: "mcp",
      server: config.mcp_server,
    };
  if (config.lifecycle !== "session") return { status: "legacy" };
  const id = config.plugin?.id;
  if (!id) return { status: "not-installed" };
  const thread = (
    await client.call("thread/read", {
      threadId: config.thread_id,
      includeTurns: false,
    })
  ).thread;
  const rows =
    (await client.call("hooks/list", { cwds: [thread.cwd ?? process.cwd()] }))
      .data ?? [];
  const states = rows
    .flatMap((r: any) => r.hooks ?? [])
    .filter(
      (h: any) =>
        h.pluginId === id &&
        ["sessionStart", "sessionEnd"].includes(h.eventName),
    )
    .map((h: any) => ({
      event: h.eventName,
      enabled: h.enabled ?? false,
      trust: h.trustStatus ?? "unknown",
    }));
  const present = new Set(states.map((h: any) => h.event));
  const status =
    present.size !== 2
      ? "missing-hooks"
      : states.some((h: any) => !h.enabled)
        ? "disabled-hooks"
        : states.some((h: any) => !["trusted", "managed"].includes(h.trust))
          ? "review-required"
          : "ready";
  return { status, plugin_id: id, hooks: states };
}
