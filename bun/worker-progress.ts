/** Observe and cancel a stuck operation without abandoning it or replaying it. */
export class WorkerProgress {
  private operation: string | null = null;
  private operationStarted: number | null = null;
  private lastProgress = Date.now();
  private timedOut = false;
  private lastFailedOperation: string | null = null;
  private lastFailureAt: number | null = null;
  private currentDeadline = 45000;
  constructor(private cancel: () => void, private deadline = 45000) {}

  snapshot(at = Date.now()) {
    return {
      status: this.timedOut || (this.operationStarted !== null && at - this.operationStarted >= this.currentDeadline)
        ? "stalled" : "responsive",
      current_operation: this.operation,
      last_failed_operation: this.lastFailedOperation,
      last_failure_at: this.lastFailureAt,
      operation_started: this.operationStarted,
      last_loop_progress: this.lastProgress,
    };
  }

  async run<T>(operation: string, work: () => Promise<T>, deadline = this.deadline): Promise<T> {
    if (this.timedOut) throw Error("Worker operation was cancelled after its deadline");
    this.operation = operation;
    this.operationStarted = Date.now();
    this.currentDeadline = deadline;
    const timer = setTimeout(() => {
      this.timedOut = true;
      this.cancel();
    }, deadline);
    try {
      const result = await work();
      if (this.timedOut) throw Error("Worker operation exceeded its deadline: " + operation);
      return result;
    } catch (error) {
      this.lastFailedOperation = operation;
      this.lastFailureAt = Date.now();
      throw error;
    } finally {
      clearTimeout(timer);
      if (!this.timedOut) {
        this.lastProgress = Date.now();
        this.operation = null;
        this.operationStarted = null;
      }
    }
  }
}
