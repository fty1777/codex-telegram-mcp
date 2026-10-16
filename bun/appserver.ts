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
    this.ws = new WebSocket("ws+unix://" + path + ":/");
    this.ws.on("message", (data) => {
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
    this.ws.on("close", () => this.fail());
    this.ws.on("error", () => this.fail());
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
      this.pending.set(id, { resolve, reject, timer });
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
  fail() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        new DeliveryUnknown("Connection lost; reconcile before retrying"),
      );
    }
    this.pending.clear();
    this.events.push({ method: "bridge/disconnected", params: {} });
  }
  close() {
    this.fail();
    this.ws.terminate();
  }
}
