import type { Journal } from "./state";

type Breakdown = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
export type Usage = { tokens: number; sessionTokens?: number; scope: "turn" | "session" } & Partial<Breakdown>;
const fields = ["inputTokens", "cachedInputTokens", "outputTokens"] as const;
function breakdown(value: any): Breakdown | undefined {
  if (!value || !fields.every(field => valid(value[field])) || value.cachedInputTokens > value.inputTokens) return;
  return Object.fromEntries(fields.map(field => [field, value[field]])) as Breakdown;
}
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
    baselineBreakdown: checkpoint?.thread === thread && checkpoint.turn !== turn
      ? checkpoint.breakdown : undefined,
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
    { state.baseline = undefined; state.baselineBreakdown = undefined; }
  const currentBreakdown = breakdown(usage.total);
  // Component resets invalidate only the component baseline. Never substitute a
  // session component for a turn delta, including across older journal versions.
  if (currentBreakdown && [state.baselineBreakdown, state.breakdown].some(previous =>
      previous && fields.some(field => currentBreakdown[field] < previous[field])))
    state.baselineBreakdown = undefined;
  journal.db.transaction(() => {
    journal.put(key, { ...state, total, breakdown: currentBreakdown, generation: journal.get("usage_generation", 0) });
    journal.put("usage_checkpoint", { thread, turn, total, breakdown: currentBreakdown });
  })();
}

export function turnUsage(journal: Journal, turnId?: string, thread?: string): Usage | undefined {
  const turn = turnId ?? journal.get("active_turn");
  if (!turn) return;
  const state = journal.get("turn_usage:" + turn);
  if (!state || (thread && state.thread !== thread) ||
      state.generation !== journal.get("usage_generation", 0) || !valid(state.total)) return;
  const current = breakdown(state.breakdown);
  if (valid(state.baseline) && state.total >= state.baseline) {
    const baseline = breakdown(state.baselineBreakdown);
    const delta = current && baseline && fields.every(field => current[field] >= baseline[field])
      ? breakdown(Object.fromEntries(fields.map(field => [field, current[field] - baseline[field]]))) : undefined;
    return { tokens: state.total - state.baseline, sessionTokens: state.total, scope: "turn", ...delta };
  }
  return { tokens: state.total, sessionTokens: state.total, scope: "session", ...current };
}
