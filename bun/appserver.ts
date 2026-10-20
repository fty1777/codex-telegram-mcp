import WebSocket from "ws";
import { join } from "node:path";
import { homedir } from "node:os";
export class RpcError extends Error {
  code: number;
  constructor(error: any) {
    super(error.message ?? "RPC failed");
    this.code = error.code;
  }
}
export class DeliveryUnknown extends Error {}
export interface Client {
  call(method: string, params: any): Promise<any>;
  send(message: any): void;
  resume(thread: string, options?: any): Promise<any>;
}
export class AppServer implements Client {
  ws: WebSocket;
  events: any[] = [];
  pending = new Map<
    number,
    {
      method: string;
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  seq = 0;
  closed = false;
  serverInfo: any;
  constructor(
    endpoint?: string,
    readonly timeout = 15000,
  ) {
    const path =
      endpoint?.replace(/^unix:\/\//, "") ||
      join(homedir(), ".codex/app-server-control/app-server-control.sock");
    if (endpoint && !endpoint.startsWith("unix://"))
      throw Error("Only local Unix endpoints supported");
    const configured = Number(process.env.CODEX_TELEGRAM_MAX_PAYLOAD_MIB ?? 256);
    if (!Number.isInteger(configured) || configured < 1 || configured > 512)
      throw Error("CODEX_TELEGRAM_MAX_PAYLOAD_MIB must be an integer from 1 to 512");
    this.ws = new WebSocket("ws+unix://" + path + ":/", { maxPayload: configured * 1024 * 1024 });
    this.ws.on("message", (data) => {
      // Bun's ws compatibility layer may not enforce the constructor option.
      // Check decoded messages too, before allocating a JSON object graph.
      const bytes = Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data.byteLength;
      if (bytes > configured * 1024 * 1024) {
        this.fail("WS_ERR_UNSUPPORTED_MESSAGE_LENGTH: Codex response exceeded the configured payload limit");
        this.ws.terminate();
        return;
      }
      try {
        const m = JSON.parse(data.toString());
        if ("id" in m && !("method" in m)) {
          const p = this.pending.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(m.id);
            m.error ? p.reject(new RpcError(m.error)) : p.resolve(m.result);
          }
        } else this.events.push(m);
      } catch {
        this.close();
      }
    });
    this.ws.on("close", (code) => this.fail("WebSocket closed (" + code + ")"));
    this.ws.on("error", (error: any) => this.fail(
      error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
        ? "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH: Codex response exceeded the configured payload limit"
        : "WebSocket transport error"));
  }
  static async connect(endpoint?: string, timeout = 15000) {
    const c = new AppServer(endpoint, timeout);
    try {
      await new Promise<void>((res, rej) => {
        const timer = setTimeout(() => {
          c.ws.terminate();
          rej(Error("App Server connection timed out"));
        }, timeout);
        c.ws.once("open", () => {
          clearTimeout(timer);
          res();
        });
        c.ws.once("error", () => {
          clearTimeout(timer);
          rej(Error("Cannot connect to local Codex App Server"));
        });
      });
      c.serverInfo = await c.call("initialize", {
        clientInfo: { name: "codex_telegram_bridge", version: "0.2.0" },
        capabilities: { experimentalApi: true },
      });
      c.send({ method: "initialized" });
      return c;
    } catch (e) {
      c.close();
      throw e;
    }
  }
  send(message: any) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN)
      throw new DeliveryUnknown("App Server disconnected; delivery unknown");
    this.ws.send(JSON.stringify(message));
  }
  call(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeliveryUnknown(method + ": timed out; delivery unknown"));
      }, this.timeout);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  async resume(threadId: string, options: any = {}) {
    try {
      return await this.call("thread/resume", {
        ...options,
        threadId,
        excludeTurns: true,
      });
    } catch (e) {
      if (
        !(e instanceof RpcError) ||
        e.code !== -32601 ||
        !e.message.includes("list_turns is not supported")
      )
        throw e;
      return this.call("thread/resume", { ...options, threadId });
    }
  }
  fail(reason = "Connection lost") {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        new DeliveryUnknown(p.method + ": " + reason + "; reconcile before retrying"),
      );
    }
    this.pending.clear();
    this.events.push({ method: "bridge/disconnected", params: { reason } });
  }
  close() {
    this.fail();
    this.ws.terminate();
  }
}
