import { AppServer, RpcError } from "./appserver";

/** One MCP host owns one worker. Thread identity comes from Codex tool metadata,
 * never from a caller-supplied tool argument or a global process environment. */
export class McpWorkerOwner {
  private active?: { abort: AbortController; done: Promise<void> };
  private closed = false;
  lastError?: string;
  constructor(
    public thread: string,
    private run: (signal: AbortSignal) => Promise<void>,
  ) {}
  authorize(meta: any) {
    if (meta?.threadId !== this.thread)
      throw Error(
        "This Telegram instance belongs to a different Codex session",
      );
  }
  connect(meta: any) {
    this.authorize(meta);
    if (this.closed) throw Error("MCP host is closing");
    if (this.active) return { status: "already-running" };
    const abort = new AbortController();
    const active = { abort, done: Promise.resolve() };
    this.active = active;
    this.lastError = undefined;
    active.done = Promise.resolve()
      .then(() => this.run(abort.signal))
      .catch((e) => {
        this.lastError = String(e);
      })
      .finally(() => {
        if (this.active === active) this.active = undefined;
      });
    return { status: "connecting" };
  }
  async disconnect(meta: any) {
    this.authorize(meta);
    await this.stop();
    return { status: "stopped" };
  }
  async rebind(thread: string) {
    if (this.closed) throw Error("MCP host is closing");
    if (thread === this.thread) return;
    await this.stop();
    if (this.closed) throw Error("MCP host is closing");
    this.thread = thread;
  }
  private async stop() {
    const active = this.active;
    active?.abort.abort();
    await active?.done;
  }
  async close() {
    this.closed = true;
    await this.stop();
  }
}

/** Route to the bound session's MCP, without loading or resuming that session.
 * A global plugin can start in other sessions; none may own this bot's poller. */
export async function controlMcp(
  config: any,
  tool: "connect" | "disconnect",
  refreshLoaded = false,
) {
  if (!config.mcp_server) throw Error("Missing installed MCP server name");
  const client = await AppServer.connect(config.endpoint);
  try {
    const { thread } = await client.call("thread/read", {
      threadId: config.thread_id,
      includeTurns: false,
    });
    if (thread.status?.type === "notLoaded")
      return { status: "awaiting-session" };
    const call = () =>
      client.call("mcpServer/tool/call", {
        threadId: config.thread_id,
        server: config.mcp_server,
        tool,
        arguments: config.shared_mcp ? { instance: config.name } : {},
      });
    try {
      return await call();
    } catch (e) {
      if (
        !refreshLoaded ||
        tool !== "connect" ||
        !(e instanceof RpcError) ||
        !e.message.includes("unknown MCP server")
      )
        throw e;
      // A running session can retain its old MCP catalog. Do not report a
      // successful connection while the newly installed server is absent.
      return {
        status: "awaiting-session-reload",
        detail:
          "Plugin installed, but this running session has not loaded it. Reload the bound Codex session; its MCP receiver will connect automatically.",
      };
    }
  } finally {
    client.close();
  }
}
