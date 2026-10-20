import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomic, readJSON, Store } from "./state";
import { controlMcp } from "./lifecycle";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Linux ownership primitives; never signal an unverified numeric PID.
const libc = dlopen("libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  pidfd_send_signal: {
    args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
}).symbols;
export function identity(pid: number) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(")")
      .slice(1)
      .join(")")
      .trim()
      .split(/\s+/);
    if (fields[0] === "Z") return null;
    return {
      pid,
      start_ticks: fields[19],
      boot_id: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    };
  } catch {
    return null;
  }
}
export function record(path: string) {
  try {
    return readJSON(path);
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export function live(path: string) {
  const r = record(path);
  return r && JSON.stringify(identity(r.pid)) === JSON.stringify(r) ? r : null;
}
export class LockBusyError extends Error {
  constructor(message = "Operation already running") {
    super(message);
    this.name = "LockBusyError";
  }
}
export function lock(path: string) {
  const fd = openSync(path, "a", 0o600);
  if (libc.flock(fd, 2 | 4) !== 0) {
    closeSync(fd);
    throw new LockBusyError();
  }
  return () => closeSync(fd);
}

/** Give an outgoing receiver time to release its OS lock during an upgrade. */
export async function waitForReceiverLock(
  path: string,
  signal?: AbortSignal,
  timeout = 5000,
) {
  const deadline = Date.now() + timeout;
  while (!signal?.aborted) {
    try {
      return lock(path);
    } catch (error) {
      if (!(error instanceof LockBusyError)) throw error;
      if (Date.now() >= deadline)
        throw new LockBusyError(
          "Another local Telegram receiver is still active",
        );
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }
}
export function ownedSignal(r: any) {
  const fd = libc.pidfd_open(r.pid, 0);
  if (fd < 0) return;
  try {
    if (
      JSON.stringify(identity(r.pid)) === JSON.stringify(r) &&
      libc.pidfd_send_signal(fd, 15, null, 0) !== 0
    )
      throw Error("Cannot signal owned bridge");
  } finally {
    closeSync(fd);
  }
}
export function status(s: Store, n: string) {
  const p = s.instance(n);
  const worker = live(join(p, "worker-process.json"));
  return {
    process: worker,
    worker,
    health: record(join(p, "health.json")),
    enabled: s.read(n).enabled,
    telegram_api: s.read(n).telegram_api?.mode ?? "cloud",
  };
}
export async function stop(s: Store, n: string, wait = true, disable = false) {
  const p = s.instance(n);
  const release = lock(join(p, "management.lock"));
  try {
    if (disable)
      atomic(join(p, "config.json"), { ...s.read(n), enabled: false });
    if (s.read(n).lifecycle === "mcp" && !live(join(p, "process.json"))) {
      atomic(join(p, "config.json"), { ...s.read(n), autostart: false });
      if (!live(join(p, "worker-process.json"))) return { status: "stopped" };
      // Pause is persistent; stop leaves the MCP host alive for a later start.
      // Never signal the Codex-owned host process.
      const result = await controlMcp(s.read(n), "disconnect");
      if (result?.isError)
        throw Error("MCP disconnect failed: " + JSON.stringify(result));
      return { status: "stopped" };
    }
    // Cleanup only: no independent receiver can be launched by this runtime.
    // A worker record alone may belong to Codex's MCP host; never signal it.
    const r = live(join(p, "process.json"));
    if (!r && live(join(p, "worker-process.json")))
      throw Error("Receiver ownership is unclear; no process was signalled. Inspect its plugin binding.");
    if (r) {
      ownedSignal(r);
      if (wait) {
        const deadline = Date.now() + 20000;
        while (JSON.stringify(identity(r.pid)) === JSON.stringify(r)) {
          if (Date.now() > deadline)
            throw Error("Bridge has not stopped; state retained");
          await sleep(100);
        }
      }
    }
    return { status: wait ? "stopped" : "stop-requested" };
  } finally {
    release();
  }
}
export async function pause(s: Store, n: string) {
  await stop(s, n, true, true);
  return { status: "paused" };
}
export async function start(s: Store, n: string, resume = false) {
  const p = s.instance(n);
  const release = lock(join(p, "management.lock"));
  try {
    let c = s.read(n);
    if (c.removing || c.binding_change || !c.thread_id)
      throw Error("Instance is not ready to start; inspect its binding");
    if (c.lifecycle !== "mcp")
      throw Error("Independent receivers are no longer supported. Connect this bot through the Telegram plugin; pairing is retained.");
    if (live(join(p, "process.json")))
      throw Error("A retired receiver is still running. Connect this bot through the Telegram plugin to migrate it safely.");
    if (resume) {
      c = { ...c, enabled: true };
      atomic(join(p, "config.json"), c);
    }
    if (!c.enabled) throw Error("Instance paused; resume first");
    c = { ...c, autostart: true };
    atomic(join(p, "config.json"), c);
    const result = await controlMcp(c, "connect", true);
    if (result?.isError)
      throw Error("MCP connect failed: " + JSON.stringify(result));
    return result;
  } finally {
    release();
  }
}
