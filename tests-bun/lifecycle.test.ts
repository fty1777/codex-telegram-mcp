import { expect, test } from "bun:test";
import { McpWorkerOwner } from "../bun/lifecycle";

test("only the bound Codex metadata can start or stop a receiver", async () => {
  let starts = 0;
  const owner = new McpWorkerOwner("bound", async (signal) => {
    starts++;
    if (!signal.aborted)
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
  });
  expect(() => owner.connect(undefined)).toThrow();
  expect(() => owner.connect({ threadId: "other" })).toThrow();
  expect(owner.connect({ threadId: "bound" }).status).toBe("connecting");
  expect(owner.connect({ threadId: "bound" }).status).toBe("already-running");
  await Promise.resolve();
  expect(starts).toBe(1);
  await expect(owner.disconnect({ threadId: "other" })).rejects.toThrow();
  await owner.disconnect({ threadId: "bound" });
  owner.connect({ threadId: "bound" });
  await Promise.resolve();
  expect(starts).toBe(2);
  await owner.close();
  expect(() => owner.connect({ threadId: "bound" })).toThrow("closing");
});

test("MCP close cancels even a receiver scheduled in the same tick", async () => {
  let aborted = false;
  const owner = new McpWorkerOwner("bound", async (signal) => {
    aborted = signal.aborted;
  });
  owner.connect({ threadId: "bound" });
  await owner.close();
  expect(aborted).toBe(true);
});

test("receiver failure releases ownership and can be explicitly retried", async () => {
  let attempts = 0;
  const owner = new McpWorkerOwner("bound", async () => {
    attempts++;
    throw Error("fixture failure");
  });
  owner.connect({ threadId: "bound" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(owner.lastError).toContain("fixture failure");
  expect(owner.connect({ threadId: "bound" }).status).toBe("connecting");
  await owner.close();
  expect(attempts).toBe(2);
});

test("receiver lock waits through a handoff but respects cancellation and timeout", async () => {
  const { lock, waitForReceiverLock, LockBusyError } = await import(
    "../bun/process"
  );
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "telegram-lock-handoff-"));
  const path = join(root, "bot.lock");
  let held: (() => void) | undefined = lock(path);
  let release: (() => void) | undefined;
  try {
    const waiting = waitForReceiverLock(path, undefined, 1000);
    held();
    held = undefined;
    release = await waiting;
    expect(release).toBeFunction();
    expect(() => lock(path)).toThrow(LockBusyError);
    const controller = new AbortController();
    const cancelled = waitForReceiverLock(path, controller.signal);
    controller.abort();
    expect(await cancelled).toBeUndefined();
    await expect(waitForReceiverLock(path, undefined, 5)).rejects.toThrow(
      "Another local Telegram receiver",
    );
    expect(() => lock(path)).toThrow(LockBusyError);
  } finally {
    release?.();
    held?.();
    rmSync(root, { recursive: true, force: true });
  }
});
