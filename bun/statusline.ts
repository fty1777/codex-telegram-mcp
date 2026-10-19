import type { Journal } from "./state";
export function statusline(journal: Journal, thread: string) {
  const goal = journal.get("goal_state"),
    model = journal.get("model_state");
  let questions = journal.get("blocking_question_count", 0);
  for (const row of journal.db
    .query("SELECT value FROM metadata WHERE key LIKE 'question:%'")
    .all() as any[]) {
    const state = JSON.parse(row.value);
    if (state?.thread === thread && state.status === "pending")
      questions += state.questions.filter(
        (q: any) => !Object.hasOwn(state.answers, q.id),
      ).length;
  }
  return {
    goal: goal?.thread === thread ? goal.status : undefined,
    questions,
    ...(model?.thread === thread
      ? { model: model.model, effort: model.effort }
      : {}),
  };
}
