import { test, expect } from "bun:test";
import { WorkerProgress } from "../bun/worker-progress";

test("operation health identifies a stall and cancellation waits for the operation to settle", async () => {
  let finish!: () => void;
  let cancelled = 0;
  const progress = new WorkerProgress(() => { cancelled++; finish(); }, 20);
  const pending = progress.run("clean_working", () => new Promise<void>((resolve) => { finish = resolve; }));
  const initial = progress.snapshot();
  expect(initial.current_operation).toBe("clean_working");
  expect(initial.operation_started).toBeNumber();
  expect(progress.snapshot(initial.operation_started! + 21).status).toBe("stalled");
  await expect(pending).rejects.toThrow("exceeded its deadline");
  expect(cancelled).toBe(1);
  expect(progress.snapshot().status).toBe("stalled");
  let repeated = false;
  await expect(progress.run("deliver_input", async () => { repeated = true; })).rejects.toThrow("cancelled");
  expect(repeated).toBe(false);
});

test("completed operations clear their label and advance loop progress", async () => {
  const progress = new WorkerProgress(() => { throw Error("unexpected cancellation"); });
  expect(await progress.run("deliver_input", async () => "accepted")).toBe("accepted");
  expect(progress.snapshot().status).toBe("responsive");
  expect(progress.snapshot().current_operation).toBeNull();
  expect(progress.snapshot().last_loop_progress).toBeNumber();
});


test("failed operations retain a queryable phase without exposing exception contents", async () => {
  const progress = new WorkerProgress(() => {});
  await expect(progress.run("connect", async () => { throw Error("private details"); })).rejects.toThrow("private details");
  expect(progress.snapshot().last_failed_operation).toBe("connect");
  expect(progress.snapshot().last_failure_at).toBeNumber();
  expect(JSON.stringify(progress.snapshot())).not.toContain("private details");
});
