import type { Journal } from "./state";

/** Persist server timestamps so progress timing survives receiver reconnects. */
export function recordTurnTiming(
  journal: Journal,
  turn: any,
  observedStart = false,
) {
  if (!turn?.id) return;
  const previous = journal.get("turn_timing:" + turn.id, {});
  const started =
    typeof turn.startedAt === "number" && Number.isFinite(turn.startedAt)
      ? turn.startedAt * 1000
      : (previous.started_at ?? (observedStart ? Date.now() : undefined));
  if (started === undefined) return;
  journal.put("turn_timing:" + turn.id, {
    started_at: started,
    completed_at:
      typeof turn.completedAt === "number" && Number.isFinite(turn.completedAt)
        ? turn.completedAt * 1000
        : previous.completed_at,
    duration_ms:
      typeof turn.durationMs === "number" && Number.isFinite(turn.durationMs)
        ? turn.durationMs
        : previous.duration_ms,
  });
}

export function elapsedSeconds(journal: Journal, turnId?: string) {
  const id = turnId ?? journal.get("active_turn");
  if (!id) return undefined;
  const value = journal.get("turn_timing:" + id);
  if (!value || !Number.isFinite(value.started_at)) return undefined;
  const milliseconds = Number.isFinite(value.duration_ms)
    ? value.duration_ms
    : (value.completed_at ?? Date.now()) - value.started_at;
  return Math.max(0, Math.floor(milliseconds / 1000));
}

export function durationText(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}
