import type { Journal } from "./state";

export type Usage = { tokens: number; scope: "turn" | "session" };
const valid = (value: any): value is number => Number.isSafeInteger(value) && value >= 0;

// A connection gap may hide whole turns. Never use its old thread checkpoint as
// the baseline for a new turn, but retain baselines of turns already observed.
export function reconnectUsage(journal: Journal) {
  journal.db.transaction(() => {
    journal.put("usage_checkpoint", null);
    journal.put("usage_generation", journal.get("usage_generation", 0) + 1);
  })();
}

export function startUsage(journal: Journal, thread: string, turn: string) {
  const key = "turn_usage:" + turn;
  if (journal.get(key)?.thread === thread) return;
  const checkpoint = journal.get("usage_checkpoint");
  journal.put(key, {
    thread,
    baseline: checkpoint?.thread === thread && checkpoint.turn !== turn
      ? checkpoint.total : undefined,
  });
}

export function recordUsage(journal: Journal, thread: string, turn: string, usage: any) {
  const total = usage?.total?.totalTokens;
  if (!turn || !valid(total)) return;
  const key = "turn_usage:" + turn;
  const previous = journal.get(key);
  const state = previous?.thread === thread ? previous : { thread };
  // Counter resets cannot be interpreted as negative usage or a new baseline.
  if ((valid(state.total) && total < state.total) || (valid(state.baseline) && total < state.baseline))
    state.baseline = undefined;
  journal.db.transaction(() => {
    journal.put(key, { ...state, total, generation: journal.get("usage_generation", 0) });
    journal.put("usage_checkpoint", { thread, turn, total });
  })();
}

export function turnUsage(journal: Journal, turnId?: string, thread?: string): Usage | undefined {
  const turn = turnId ?? journal.get("active_turn");
  if (!turn) return;
  const state = journal.get("turn_usage:" + turn);
  if (!state || (thread && state.thread !== thread) ||
      state.generation !== journal.get("usage_generation", 0) || !valid(state.total)) return;
  if (valid(state.baseline) && state.total >= state.baseline)
    return { tokens: state.total - state.baseline, scope: "turn" };
  return { tokens: state.total, scope: "session" };
}
