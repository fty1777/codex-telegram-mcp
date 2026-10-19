import { basename, join } from "node:path";
import { Store, Journal, atomic, hash } from "./state";
import { entityHtml, activityHtml } from "./rich";
import type { Sender } from "./telegram";

export type ActivityMode = "transient" | "keep" | "off";

const fileName = (value: unknown) =>
  typeof value === "string"
    ? basename(value.replaceAll("\\", "/"))
        .replace(/[\r\n\t]/g, " ")
        .slice(0, 80)
    : "";
const safeQuery = (value: unknown) =>
  typeof value === "string" &&
  value.length <= 120 &&
  !/[\r\n\t]/.test(value) &&
  !/(?:sk-[\w-]+|bearer\s|(?:token|password|api[_-]?key)\s*[:=]|\d{6,}:[\w-]{20,}|[A-Za-z0-9_-]{40,})/i.test(
    value,
  )
    ? value.replace(/(?:\/[\w.~-]+){2,}/g, (path) => fileName(path))
    : "[redacted]";

// Command details are allowlisted: never forward raw scripts, environment
// assignments, credential arguments, or output. Executable paths become names.
function commandName(command: unknown, depth = 0): string {
  if (typeof command !== "string") return "command";
  const match =
    /^(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|]+))(?:\s+([\s\S]*))?/.exec(
      command.trim(),
    );
  if (!match) return "command";
  const program = fileName(match[1] || match[2] || match[3]);
  if (
    !/^(bun|npm|pnpm|yarn|node|curl|tail|head|wc|sort|uniq|printf|echo|python3?|pytest|cargo|go|tsc|git|make|cmake|rg|sed|cat|ls|find|bash|sh)$/.test(
      program,
    )
  )
    return "command";
  const rest = match[4] ?? "";
  if (["bash", "sh"].includes(program) && depth < 2) {
    const wrapped = /^-(?:lc|cl|c)\s+(['"])([\s\S]*)\1$/.exec(rest);
    if (wrapped) return commandName(wrapped[2], depth + 1);
  }
  if (/^(python3?|node|bun)$/.test(program) && /^-(?:e|c)\b/.test(rest))
    return `${program} ${rest.split(/\s/)[0]} …`;
  const first = rest.split("\n")[0] ?? "";
  if (/^-(?:\s+)?<</.test(first)) return `${program} ${first.slice(0, 30)} …`;
  const tokens = first.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? [];
  const visible: string[] = [];
  let truncated = rest.includes("\n");
  for (const token of tokens) {
    if (
      /^[;&|]|\$\(|`/.test(token) ||
      /^--?(?:H|u|d|data(?:-raw|-binary)?|header|password|token|api-key|authorization)(?:=|$)/i.test(
        token,
      )
    ) {
      truncated = true;
      break;
    }
    const value = token.replace(/^(['"])(.*)\1$/, "$2");
    if (
      !/^[\w./~:*?=+@%,-]+$/.test(value) ||
      /(?:sk-|bearer|password|token|api.?key|authorization|\d{6,}:|[A-Za-z0-9_-]{40})/i.test(
        value,
      )
    ) {
      truncated = true;
      break;
    }
    visible.push(
      value.replace(/(?:\/[\w.~-]+){2,}/g, (path) => fileName(path)),
    );
    if (visible.join(" ").length > 100) {
      visible.pop();
      truncated = true;
      break;
    }
  }
  return (
    program +
    (visible.length ? " " + visible.join(" ") : "") +
    (truncated ? " …" : "")
  );
}

export function activitySummary(
  item: any,
  complete: boolean,
): string | undefined {
  if (item?.type === "commandExecution") {
    const actions = item.commandActions ?? [];
    if (
      actions.length &&
      actions.every((a: any) =>
        ["read", "search", "listFiles"].includes(a.type),
      )
    ) {
      const details = actions.map((a: any) => {
        if (a.type === "read")
          return `Read ${fileName(a.name || a.path) || "file"}`;
        if (a.type === "search")
          return `Search ${a.query ? safeQuery(a.query) : "code"}${a.path ? " in " + fileName(a.path) : ""}`;
        return `List files${a.path ? " in " + fileName(a.path) : ""}`;
      });
      return `${complete ? "Explored" : "Exploring"}\n${[...new Set(details)].join("\n")}`;
    }
    const command = commandName(item.command);
    // Preserve this familiar, safe compiler invocation without forwarding
    // arbitrary output that might contain secrets or source code.
    const output =
      complete &&
      [
        "bun run typecheck",
        "npm run typecheck",
        "pnpm run typecheck",
        "yarn typecheck",
      ].includes(command) &&
      String(item.aggregatedOutput ?? "")
        .split("\n")
        .some((line) => line.trim() === "$ tsc --noEmit")
        ? "\n$ tsc --noEmit"
        : "";
    if (
      complete &&
      ((Number.isInteger(item.exitCode) && item.exitCode !== 0) ||
        item.status === "failed")
    )
      return (
        `Failed${Number.isInteger(item.exitCode) ? ` (exit ${item.exitCode})` : ""} ${command}` +
        (String(item.aggregatedOutput ?? "").trim() ? "" : "\n(no output)")
      );
    return `${complete ? "Ran" : "Running"} ${command}${output}`;
  }
  if (["mcpToolCall", "dynamicToolCall"].includes(item?.type)) {
    if (
      /telegram/i.test(item.server ?? item.namespace ?? "") ||
      /^(send_text|send_photo|send_document|edit_text|delivery_status|list_bots)$/.test(
        item.tool ?? "",
      )
    )
      return;
    const tool = /^[\w.-]{1,80}$/.test(item.tool ?? "") ? item.tool : "tool";
    return `${complete ? "Used" : "Using"} ${tool}`;
  }
  if (item?.type === "fileChange")
    return complete ? "Edited files" : "Editing files";
}

export function activityText(entries: { summary: string }[]): string {
  const groups: { heading: string; lines: string[]; explored: boolean }[] = [];
  for (const { summary } of entries) {
    const [heading, ...lines] = summary.split("\n");
    const explored = heading === "Explored" || heading === "Exploring",
      previous = groups.at(-1);
    if (explored && previous?.explored) {
      previous.lines = [...new Set([...previous.lines, ...lines])];
      if (heading === "Exploring") previous.heading = heading;
    } else groups.push({ heading, lines, explored });
  }
  return groups
    .map(
      (g) =>
        `• ${g.heading}` +
        (g.lines.length ? `\n  └ ${g.lines.join("\n    ")}` : ""),
    )
    .join("\n");
}

export class Activity {
  readonly journal: Journal;
  constructor(
    readonly store: Store,
    readonly instance: string,
    readonly sender: Sender,
  ) {
    this.journal = sender.journal;
  }
  mode(): ActivityMode {
    return this.store.read(this.instance).activity_mode ?? "transient";
  }
  setMode(mode: ActivityMode) {
    atomic(join(this.store.instance(this.instance), "config.json"), {
      ...this.store.read(this.instance),
      activity_mode: mode,
    });
    const turn = this.journal.get("activity_current"),
      state = this.journal.get("activity:" + turn);
    if (state) {
      this.journal.put("activity:" + turn, { ...state, mode });
      if (mode === "off") this.finish(turn);
    }
  }
  observe(turn: string, item: any, complete: boolean) {
    if (
      !turn ||
      turn !== this.journal.get("active_turn") ||
      this.mode() === "off"
    )
      return;
    const summary = activitySummary(item, complete);
    if (!summary || !item.id) return;
    const key = "activity:" + turn,
      c = this.store.read(this.instance);
    const state = this.journal.get(key) ?? {
      turn,
      thread: c.thread_id,
      owner: c.owner_id,
      revision: c.binding_revision,
      mode: this.mode(),
      entries: [],
      version: 0,
    };
    if (state.done || state.blocked) return;
    const target = this.journal.get("working_message");
    const previousEntries =
      state.formatVersion === 2
        ? state.entries.map((e: any) =>
            e.message === undefined
              ? {
                  ...e,
                  message:
                    state.message ??
                    (target?.turn === turn ? target.message : null),
                }
              : e,
          )
        : [];
    if (
      previousEntries.some(
        (e: any) => e.id === item.id && e.summary === summary,
      )
    )
      return;
    const entries = previousEntries.filter((e: any) => e.id !== item.id);
    const previous = previousEntries.find((e: any) => e.id === item.id);
    entries.push({
      id: item.id,
      summary,
      complete,
      message:
        previous?.message ?? (target?.turn === turn ? target.message : null),
    });
    this.journal.put(key, {
      ...state,
      formatVersion: 2,
      entries,
      version: state.version + 1,
    });
    this.journal.put("activity_current", turn);
  }
  finish(turn: string) {
    const key = "activity:" + turn,
      state = this.journal.get(key);
    if (!state) return;
    const cleanup =
      state.message &&
      (!state.merged || state.activityOnly) &&
      state.mode !== "keep" &&
      !state.cleanupQueued;
    this.journal.put(key, {
      ...state,
      done: true,
      cleanupQueued: state.cleanupQueued || !!cleanup,
    });
    if (state.message && state.mode === "keep" && state.merged) {
      const tail = this.journal.get("working_tail:" + state.message);
      const working = this.journal.get("working_message");
      if (tail && working?.message === state.message) {
        const body = working.body;
        const detail = activityText(
          state.entries.filter((e: any) => e.message === state.message),
        ).slice(0, Math.max(0, 32254 - body.text.length));
        const offset = body.text.length + (body.text ? 2 : 0);
        this.journal.put("working_tail:" + state.message, {
          ...tail,
          body: {
            html:
              (body.html ?? entityHtml(body)) +
              (detail ? activityHtml(detail) : ""),
            text:
              body.text + (detail ? (body.text ? "\n\n" : "") + detail : ""),
            entities: [
              ...body.entities,
              ...(detail
                ? [{ type: "code", offset, length: detail.length }]
                : []),
            ],
          },
        });
      }
    }
    if (cleanup)
      this.journal.put("working_tail:" + state.message, {
        id: "activity-" + hash(turn),
        kind: "activity",
        turn,
        thread: state.thread,
        owner: state.owner,
        revision: state.revision,
        message: state.message,
        cleanup: true,
        cleanupQueued: true,
      });
  }
  async flush(at = Date.now()) {
    const turn = this.journal.get("activity_current"),
      key = "activity:" + turn;
    const state = this.journal.get(key),
      working = this.journal.get("working_message");
    if (working && working.turn === this.journal.get("active_turn")) {
      if (
        state &&
        state.turn === working.turn &&
        state.message &&
        state.message !== working.message &&
        !state.merged &&
        state.mode !== "keep"
      ) {
        const oldKey = "working_tail:" + state.message;
        if (!this.journal.get(oldKey)?.cleanupQueued)
          this.journal.put(oldKey, {
            id: "activity-" + hash(turn),
            kind: "activity",
            turn,
            thread: state.thread,
            owner: state.owner,
            revision: state.revision,
            message: state.message,
            cleanup: true,
            cleanupQueued: true,
          });
        this.journal.put(key, {
          ...state,
          message: working.message,
          merged: true,
          activityOnly: !!working.activityOnly,
        });
      }
      await this.sender.refreshWorking(at);
      return;
    }
    if (
      !state ||
      state.blocked ||
      state.dispatching ||
      state.done ||
      state.mode === "off" ||
      at < this.journal.get("working_refresh_after", 0)
    )
      return;
    const c = this.store.read(this.instance);
    if (
      !c.enabled ||
      c.autostart === false ||
      c.binding_change ||
      c.removing ||
      c.thread_id !== state.thread ||
      c.owner_id !== state.owner ||
      c.binding_revision !== state.revision ||
      turn !== this.journal.get("active_turn")
    )
      return;
    this.journal.put(key, { ...state, dispatching: true });
    this.journal.put("working_edit_after", at + this.sender.refreshInterval());
    const initial = activityText(state.entries);
    const end = /[\uD800-\uDBFF]/.test(initial[3499] ?? "") ? 3499 : 3500;
    const receipt = await this.sender.send(
      `activity-${hash(turn)}-${state.version}`,
      {
        text: initial.slice(0, end),
        format: "plain",
        source: "working",
        turn_id: turn,
        activity_block: true,
        defer_on_limit: false,
      },
    );
    const current = this.journal.get(key);
    const limited =
      receipt.status === "rejected" && receipt.details?.error_code === 429;
    const message = receipt.details?.message_id;
    this.journal.put(key, {
      ...current,
      dispatching: false,
      blocked: receipt.status !== "sent" && !limited,
      entries: current.entries.map((e: any) =>
        e.message == null ? { ...e, message } : e,
      ),
      message,
      merged: true,
      activityOnly: true,
      sentVersion:
        receipt.status === "sent" ? state.version : state.sentVersion,
    });
    if (receipt.status === "sent") {
      const target = this.journal.get("working_message");
      if (target?.message === message)
        this.journal.put("working_message", {
          ...target,
          activityOnly: true,
          body: { text: "", entities: [] },
          mode: state.mode,
        });
      const tail = this.journal.get("working_tail:" + message);
      if (tail)
        this.journal.put("working_tail:" + message, {
          ...tail,
          activityOnly: true,
          mode: state.mode,
        });
    } else if (limited) {
      this.journal.put(key, {
        ...this.journal.get(key),
        version: state.version + 1,
      });
      this.sender.applyRateLimit(receipt.details.retry_after);
    }
  }
}
