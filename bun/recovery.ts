import { Engine, diagnostic, type RecoveryBoundary } from "./engine";
import type { Client } from "./appserver";
import { Sender } from "./telegram";
import { Store, hash } from "./state";

type SendOptions = Parameters<Sender["send"]>[1];

/** Stage history without doing Telegram I/O on the session event loop. */
export class HistoryRecovery {
  status: any = { status: "idle" };
  private task?: { abort: AbortController; done: Promise<void> };
  private generation = 0;
  constructor(
    readonly store: Store,
    readonly instance: string,
    readonly sender: Sender,
  ) {}

  async start(client: Client, boundary?: RecoveryBoundary) {
    this.cancel();
    const generation = this.generation;
    await this.task?.done;
    if (generation !== this.generation) return;
    const binding = this.store.read(this.instance);
    const abort = new AbortController();
    const staged = new Sender(this.store, this.instance);
    staged.send = async (key, options = {}) => {
      if (abort.signal.aborted)
        return { status: "rejected", details: { cancelled: true } };
      const queueKey = "history_queue:" + hash(key);
      const part = /^(.*)-(\d+)$/.exec(key);
      const intent = {
        key,
        ...(part && Number(part[2]) > 0
          ? { predecessor: part[1] + "-" + (Number(part[2]) - 1) }
          : {}),
        options: {
          ...options,
          ...(options.source === "working" ? { activity_page: true } : {}),
          expected_binding: {
            thread: binding.thread_id,
            owner: binding.owner_id,
            revision: binding.binding_revision,
          },
        },
      };
      const previous = this.sender.journal.get(queueKey);
      if (
        previous &&
        this.sender.journal.fingerprint(previous.options) !==
          this.sender.journal.fingerprint(intent.options)
      )
        throw Error(
          "Historical request ID already belongs to different content",
        );
      if (!previous) this.sender.journal.put(queueKey, intent);
      return { status: "queued", details: { history: true } };
    };
    // Historical completion must not trigger a live counter HTTP edit.
    staged.refreshWorking = async () => {};
    const engine = new Engine(this.store, this.instance, client, staged);
    this.status = { status: "scanning", started: Date.now() };
    const task = { abort, done: Promise.resolve() };
    this.task = task;
    task.done = engine
      .recover(abort.signal, boundary)
      .then(() => {
        this.status = {
          ...this.status,
          status: abort.signal.aborted ? "cancelled" : "staged",
          finished: Date.now(),
        };
      })
      .catch((error) => {
        // Retry the scan after reconnect; no notice spam and no ambiguous resend.
        this.status = {
          ...this.status,
          status: abort.signal.aborted ? "cancelled" : "failed",
          error: diagnostic(String(error), this.store.token(this.instance)),
          finished: Date.now(),
        };
      })
      .finally(() => {
        engine.close();
        staged.journal.close();
        if (this.task === task) this.task = undefined;
      });
  }

  cancel() {
    this.generation++;
    this.task?.abort.abort();
  }
  async stop() {
    this.cancel();
    await this.task?.done;
  }
  get scanning() {
    return !!this.task;
  }

  summary() {
    const rows = this.sender.journal.db
      .query(
        "SELECT value FROM metadata WHERE key LIKE 'history_queue:%' AND value != 'null'",
      )
      .all() as any[];
    const pending = rows.filter((r) => !JSON.parse(r.value).blocked).length;
    const blocked = rows.length - pending;
    return {
      ...this.status,
      status: this.scanning
        ? "scanning"
        : pending
          ? "delivering"
          : blocked
            ? "blocked"
            : this.status.status === "staged"
              ? "complete"
              : this.status.status,
      pending,
      blocked,
    };
  }

  async deliverNext() {
    if (Date.now() < this.sender.journal.get("working_refresh_after", 0))
      return;
    for (const row of this.sender.journal.db
      .query(
        "SELECT key,value FROM metadata WHERE key LIKE 'history_queue:%' AND value != 'null' ORDER BY rowid",
      )
      .all() as any[]) {
      const intent = JSON.parse(row.value);
      if (intent.blocked) continue;
      if (
        intent.predecessor &&
        this.sender.journal.status("out", intent.predecessor).status !== "sent"
      ) {
        this.sender.journal.put(row.key, {
          ...intent,
          blocked: true,
          receipt: {
            status: "unknown",
            details: { reason: "Previous historical chunk is unconfirmed" },
          },
        });
        continue;
      }
      const previous = this.sender.journal.status("out", intent.key);
      let receipt;
      try {
        receipt = await this.sender.send(
          intent.key,
          intent.options as SendOptions,
        );
      } catch (error) {
        receipt = {
          status: "unknown",
          details: {
            reason: diagnostic(String(error), this.store.token(this.instance)),
          },
        };
      }
      if (
        receipt.status === "sent" ||
        (receipt.status === "rejected" && receipt.details?.queued)
      )
        this.sender.journal.put(row.key, null);
      else
        this.sender.journal.put(row.key, { ...intent, blocked: true, receipt });
      if (
        previous.status === "not_found" ||
        (previous.status === "rejected" && previous.details?.error_code === 429)
      )
        return;
      // Already journaled deliveries require no network pacing. Revalidate the
      // original payload, preserve unknown receipts, then move to the next item.
      await Bun.sleep(0);
    }
  }
}
