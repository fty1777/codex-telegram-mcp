import { join } from "node:path";
import { rmSync } from "node:fs";
import { Store, atomic, now } from "./state";
import { identity, lock, sleep } from "./process";
import { pluginEnabled } from "./worker";
import { diagnostic } from "./engine";
export async function supervise(s: Store, n: string) {
  const p = s.instance(n),
    unlock = lock(join(p, "supervisor.lock"));
  let stopping = false,
    child: ReturnType<typeof Bun.spawn> | undefined,
    failures = 0,
    leaseFailures = 0;
  const stop = () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  atomic(join(p, "process.json"), identity(process.pid));
  const lease = setInterval(() => {
    try {
      if (!s.read(n).enabled || !pluginEnabled(s.read(n))) stop();
      else leaseFailures = 0;
    } catch {
      if (++leaseFailures >= 3) stop();
    }
  }, 2000);
  try {
    while (!stopping && s.read(n).enabled) {
      if (!pluginEnabled(s.read(n))) break;
      let error = "";
      const entry = import.meta.path.endsWith("bridge.js")
        ? import.meta.path
        : join(import.meta.dir, "cli.ts");
      child = Bun.spawn(
        [
          process.execPath,
          entry,
          "--data-dir",
          s.root,
          "run",
          "--instance",
          n,
          "--parent-pid",
          String(process.pid),
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      );
      const drain = (async () => {
        for await (const bytes of child!.stderr as any)
          error = (error + Buffer.from(bytes).toString()).slice(-4000);
      })();
      const code = await child.exited;
      await drain;
      if (stopping || code === 0) break;
      failures++;
      const detail = diagnostic(
        error || "Worker exited with " + code,
        s.token(n),
      );
      console.error(detail);
      atomic(join(p, "health.json"), {
        status: "retrying",
        runtime: "bun",
        updated: now(),
        error: detail,
      });
      const until =
        Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
      while (!stopping && Date.now() < until) await sleep(100);
    }
  } finally {
    stop();
    clearInterval(lease);
    if (child && child.exitCode === null) {
      const killed = setTimeout(() => child!.kill("SIGKILL"), 10000);
      await child.exited;
      clearTimeout(killed);
    }
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    rmSync(join(p, "process.json"), { force: true });
    atomic(join(p, "health.json"), {
      status: "stopped",
      pid: null,
      updated: now(),
      runtime: "bun",
    });
    unlock();
  }
}
