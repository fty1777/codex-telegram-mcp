import { Questions } from "./questions";
import { Activity } from "./activity";
import { join } from "node:path";
import { DeliveryUnknown, RpcError, type Client } from "./appserver";
import { Store, Journal, hash, legacyJSON } from "./state";
import { Sender, Telegram } from "./telegram";
import { Interactions } from "./interactions";
import type { MessageSource, TextFormat } from "./format";
import { recordTurnTiming, durationText } from "./timing";
import { reconnectUsage, startUsage, recordUsage } from "./usage";
import {
  HELP,
  QUERY_METHODS,
  commandHelp,
  nativeCommand,
  parseCommand,
} from "./commands";
export { HELP } from "./commands";
export function diagnostic(v: any, token = "", limit: number | null = 1600) {
  let text = typeof v === "string" ? v : legacyJSON(v);
  if (token) text = text.replaceAll(token, "[redacted]");
  text = text
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(
      /((?:api[_-]?key|password|secret|token)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,
      "$1[redacted]",
    );
  const points = Array.from(text);
  return limit && points.length > limit
    ? "…\n" + points.slice(-limit).join("")
    : text;
}
export function chunks(text: string, limit = 3800) {
  const result: string[] = [];
  let part = "";
  for (const char of text) {
    if (part.length + char.length > limit) {
      result.push(part);
      part = "";
    }
    part += char;
  }
  if (part) result.push(part);
  return result;
}
export async function messageInput(m: any, api: Telegram, inbox: string) {
  const date = new Date(m.date * 1000).toISOString().replace(".000Z", "+00:00");
  const text = m.text || m.caption || "";
  const input: any[] = [
    {
      type: "text",
      text: `[Telegram message ${m.chat.id}:${m.message_id}; received ${date}]\n${text}`,
    },
  ];
  let media: any, kind: string | undefined;
  if (m.photo?.length) {
    media = [...m.photo].sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0];
    kind = "photo";
  } else
    for (const k of [
      "document",
      "audio",
      "voice",
      "video",
      "video_note",
      "animation",
      "sticker",
    ])
      if (m[k]) {
        media = m[k];
        kind = k;
        break;
      }
  if (media) {
    api.checkSize(media.file_size ?? 0);
    const path = await api.download(
      media.file_id,
      inbox,
      kind === "photo" ? ".jpg" : ".bin",
    );
    input[0].text += "\nAttachment: " + path;
    if (media.file_name)
      input[0].text +=
        "\nOriginal filename: " + JSON.stringify(media.file_name);
    if (
      kind === "photo" ||
      (kind === "document" &&
        ["image/jpeg", "image/png", "image/webp"].includes(media.mime_type))
    )
      input.push({ type: "localImage", path });
  } else if (!text) throw Error("Unsupported Telegram message type");
  return input;
}
export class Engine {
  config: any;
  journal: Journal;
  thread: string;
  activeTurn: string | null = null;
  status = "connecting";
  interactions: Interactions;
  activity: Activity;
  questions: Questions;
  constructor(
    readonly store: Store,
    readonly instance: string,
    readonly client: Client,
    readonly sender: Sender,
  ) {
    this.activity = new Activity(store, instance, sender);
    this.config = store.read(instance);
    this.journal = new Journal(store.instance(instance));
    this.thread = this.config.thread_id;
    this.questions = new Questions(
      this.journal,
      client,
      this.thread,
      (k, t) => this.say(k, t, "system", undefined, "markdown"),
      (v) => diagnostic(v, store.token(instance), null),
    );
    this.interactions = new Interactions(
      client,
      (k, t) => this.say(k, t),
      (v) => diagnostic(v, store.token(instance), null),
    );
  }
  recordModel(settings: any) {
    const model = settings?.model;
    if (typeof model === "string" && model)
      this.journal.put("model_state", {
        thread: this.thread,
        model,
        effort: settings.effort ?? settings.reasoningEffort ?? "default",
      });
  }
  waitingForHistory = false;
  usageAttached = false;
  async attach() {
    if (!this.usageAttached) {
      reconnectUsage(this.journal);
      this.usageAttached = true;
    }
    let result;
    try {
      result = await this.client.resume(
        this.thread,
        this.config.resume_options ?? {},
      );
      this.waitingForHistory = false;
    } catch (e) {
      // A newly opened, loaded thread has no durable rollout until its first
      // turn. Keep Telegram available so that first turn can arrive here.
      if (
        !(e instanceof RpcError) ||
        !e.message.includes("no rollout found for thread id " + this.thread)
      )
        throw e;
      result = await this.client.call("thread/read", {
        threadId: this.thread,
        includeTurns: false,
      });
      if (result.thread.status?.type !== "idle") throw e;
      this.waitingForHistory = true;
    }
    this.recordModel({ ...result.thread, ...result });
    if (this.config.session_settings)
      await this.client.call("thread/settings/update", {
        ...this.config.session_settings,
        threadId: this.thread,
      });
    try {
      const { goal } = await this.client.call("thread/goal/get", {
        threadId: this.thread,
      });
      this.journal.put(
        "goal_state",
        goal ? { ...goal, thread: this.thread } : null,
      );
    } catch {
      this.journal.put("goal_state", null);
    }
    this.status = result.thread.status?.type ?? "unknown";
    let turns = result.thread.turns ?? [];
    if (this.status === "active" && !turns.length)
      turns =
        (
          await this.client.call("thread/read", {
            threadId: this.thread,
            includeTurns: true,
          })
        ).thread.turns ?? [];
    this.activeTurn =
      [...turns].reverse().find((t) => t.status === "inProgress")?.id ?? null;
    this.journal.put("active_turn", this.activeTurn);
    const active = turns.find((turn: any) => turn.id === this.activeTurn);
    if (active) recordTurnTiming(this.journal, active, true);
  }
  async recover() {
    if (this.waitingForHistory) return;
    const t = (
      await this.client.call("thread/read", {
        threadId: this.thread,
        includeTurns: true,
      })
    ).thread;
    const initialized = this.journal.get("history_initialized", false);
    for (const turn of t.turns ?? []) {
      const observed =
        this.journal.get("pending_final:" + turn.id, []).length ||
        this.journal.get("compaction_turn:" + turn.id);
      if (!initialized && turn.status !== "inProgress" && !observed) {
        this.journal.put("historical_turn:" + turn.id, true);
        continue;
      }
      if (this.journal.get("historical_turn:" + turn.id)) continue;
      recordTurnTiming(this.journal, turn);
      if (turn.status === "inProgress") {
        for (const item of turn.items ?? [])
          if (item.type === "agentMessage" && item.questions?.length)
            await this.questions.offer(item, turn.id);
        if (!initialized)
          for (const item of (turn.items ?? []).slice(0, -1))
            if (item.type === "agentMessage")
              this.journal.put("delivered_item:" + item.id, true);
        continue;
      }
      for (const item of turn.items ?? [])
        await this.event({
          method: "item/completed",
          params: {
            threadId: this.thread,
            turnId: turn.id,
            item,
            recovered: true,
          },
        });
      await this.event({
        method: "turn/completed",
        params: { threadId: this.thread, turn },
      });
    }
    this.journal.put("history_initialized", true);
  }
  async say(
    key: string,
    text: string,
    source: MessageSource = "system",
    turnId?: string,
    format?: TextFormat,
  ): Promise<any> {
    const base = `bridge-${hash(key).slice(0, 40)}`;
    const legacy = chunks(text);
    const old: any = this.journal.db
      .query("SELECT fingerprint FROM delivery WHERE direction='out' AND key=?")
      .get(base + "-0");
    if (
      old?.fingerprint ===
      this.journal.fingerprint({
        chat_id: this.config.owner_id,
        text: legacy[0],
        kind: "document",
        caption: "",
        reply_to: null,
        edit_id: null,
      })
    ) {
      // Finish an already journaled pre-formatting message using its original
      // chunk boundaries. Never reinterpret or replay a recorded chunk.
      for (const [i, part] of legacy.entries()) {
        const result = await this.sender.send(`${base}-${i}`, {
          text: part,
          source,
        });
        if (result.status !== "sent") return result;
      }
      return { status: "sent" };
    }
    return this.sender.send(base + "-0", {
      text,
      source,
      turn_id: turnId,
      format,
    });
  }
  async receiveBatch(updates: any[]) {
    this.config = this.store.read(this.instance);
    if (!this.config.enabled) return "paused";
    const owner = this.config.owner_id;
    if (
      !Number.isSafeInteger(owner) ||
      updates.some(
        (u) =>
          u.message?.chat?.type !== "private" ||
          u.message.chat.id !== owner ||
          u.message.from?.id !== owner ||
          u.message.from?.is_bot,
      )
    )
      return "ignored";
    const key =
      updates.length === 1
        ? String(updates[0].update_id)
        : "album-" + updates[0].update_id;
    const [fresh, previous] = this.journal.begin("in", key, updates);
    if (!fresh) {
      if (previous.status === "unknown")
        await this.say(
          "unknown-" + key,
          "⚠️ Codex did not confirm acceptance. Delivery is unknown; the message was not automatically resent.",
        );
      return previous.status;
    }
    const text = updates[0].message.text ?? "";
    let submitting = false;
    try {
      if (text.startsWith("/")) {
        const reply = await this.command(key, text, () => {
          submitting = true;
        });
        const status =
          reply.status === "sent" ? "handled" : "reply_" + reply.status;
        this.journal.finish("in", key, status, { reply });
        return status;
      }
      const input: any[] = [];
      for (const u of updates)
        input.push(
          ...(await messageInput(
            u.message,
            this.sender.api,
            join(this.store.instance(this.instance), "inbox"),
          )),
        );
      if (updates.length > 1)
        input.unshift({
          type: "text",
          text: `[Telegram album batch: ${updates.length} messages. Each member retains its own source ID.]`,
        });
      const params = {
        threadId: this.thread,
        input,
        clientUserMessageId: `telegram-${this.config.bot_id}-${key}`,
      };
      let result;
      submitting = true;
      if (this.config.delivery_mode === "queue")
        result = await this.client.call("thread/queue/add", params);
      else if (this.activeTurn) {
        try {
          result = await this.client.call("turn/steer", {
            ...params,
            expectedTurnId: this.activeTurn,
          });
        } catch (e) {
          if (
            !(e instanceof RpcError) ||
            e.code !== -32600 ||
            e.message !== "no active turn to steer"
          )
            throw e;
          result = await this.client.call("turn/start", params);
          this.started(result.turn.id, result.turn);
        }
      } else {
        result = await this.client.call("turn/start", params);
        this.started(result.turn.id, result.turn);
      }
      this.journal.finish("in", key, "accepted", result);
      return "accepted";
    } catch (e) {
      if (
        (e instanceof DeliveryUnknown &&
          (!text.startsWith("/") || submitting)) ||
        (submitting && !(e instanceof RpcError))
      ) {
        await this.say(
          "unknown-" + key,
          "⚠️ Codex did not confirm acceptance. Delivery is unknown; the message was not automatically resent.",
        );
        return "unknown";
      }
      const reason = diagnostic(
        e instanceof Error ? e.message : e,
        this.store.token(this.instance),
      );
      this.journal.finish("in", key, "rejected", {
        reason,
        ...(e instanceof RpcError ? { code: e.code } : {}),
      });
      await this.say(
        "rejected-" + key,
        text.startsWith("/")
          ? e instanceof RpcError && e.code === -32601
            ? "This command is unavailable in your Codex version. Update Codex to use it."
            : submitting
              ? "Codex could not apply this command. Check /status or /goal before trying again."
              : "Could not retrieve this information from Codex. Try the command again later."
          : "⚠️ Message was not submitted to Codex:\n" + reason,
      );
      return "rejected";
    }
  }
  started(id: string, turn?: any) {
    startUsage(this.journal, this.thread, id);
    recordTurnTiming(this.journal, { ...turn, id }, true);
    this.activeTurn = id;
    this.status = "active";
    this.journal.put("active_turn", id);
  }
  async command(key: string, text: string, submitting?: () => void) {
    const { command: cmd, args } = parseCommand(text);
    const client: Client = {
      call: (method, params) => {
        if (!QUERY_METHODS.has(method)) submitting?.();
        return this.client.call(method, params).then((result) => {
          if (method === "thread/read") this.recordModel(result.thread);
          if (["thread/goal/get", "thread/goal/set"].includes(method))
            this.journal.put(
              "goal_state",
              result.goal ? { ...result.goal, thread: this.thread } : null,
            );
          if (method === "thread/goal/clear" && result.cleared)
            this.journal.put("goal_state", null);
          return result;
        });
      },
      resume: (thread, options) =>
        this.client.resume(thread, options).then((result) => {
          this.recordModel({ ...result.thread, ...result });
          return result;
        }),
      send: (message) => {
        submitting?.();
        this.client.send(message);
      },
    };
    let reply;
    if (cmd === "/deny" && this.questions.has(args.trim())) {
      submitting?.();
      reply = this.questions.decline(args.trim());
    } else if (cmd === "/answer" && this.questions.has(args.split(/\s/)[0])) {
      submitting?.();
      reply = await this.questions.answer(args, this.activeTurn);
    } else if (["/approve", "/deny", "/answer"].includes(cmd)) {
      submitting?.();
      reply = this.interactions.respond(cmd, args);
    } else if (cmd === "/questions") {
      const pending = this.questions.list(),
        blocking = this.blockingQuestions();
      return this.say(
        "command-" + key,
        diagnostic(
          (pending === "No unanswered questions." && blocking ? "" : pending) +
            blocking,
          this.store.token(this.instance),
          null,
        ),
        "system",
        undefined,
        "markdown",
      );
    } else if (cmd === "/activity") {
      if (!args)
        reply = `Tool activity: ${this.activity.mode()}\n/activity transient | keep | off`;
      else if (["transient", "keep", "off"].includes(args)) {
        this.activity.setMode(args as "transient" | "keep" | "off");
        reply = `Tool activity: ${args}`;
      } else reply = commandHelp("activity");
    } else if (cmd === "/help") reply = commandHelp(args);
    else if (cmd === "/start") reply = HELP;
    else if (["/status", "/health", "/ping"].includes(cmd)) {
      const t = (
        await client.call("thread/read", {
          threadId: this.thread,
          includeTurns: false,
        })
      ).thread;
      reply = `Telegram connected\nSession: ${t.name || this.thread}\nStatus: ${t.status?.type ?? "unknown"}`;
    } else if (cmd === "/queue")
      reply = `${(await client.call("thread/queue/list", { threadId: this.thread })).data.length} queued message(s)`;
    else if (cmd === "/stop") {
      if (this.activeTurn) {
        await client.call("turn/interrupt", {
          threadId: this.thread,
          turnId: this.activeTurn,
        });
        reply = "Interrupt requested.";
      } else reply = "No active turn.";
    } else
      reply =
        (await nativeCommand(
          client,
          this.thread,
          cmd,
          args,
          !!this.activeTurn,
          {
            started: (turn) => this.started(turn.id, turn),
            requestId: `telegram-${this.config.bot_id}-${key}`,
          },
        )) ?? "Unknown command.\n" + HELP;
    return await this.say(
      "command-" + key,
      diagnostic(reply, this.store.token(this.instance), null),
    );
  }
  syncQuestionStatus() {
    const count = [...this.interactions.pending.values()]
      .filter((r) => !r.submitted && r.method === "item/tool/requestUserInput")
      .reduce(
        (sum, r) =>
          sum +
          r.params.questions.filter((q: any) => !Object.hasOwn(r.answers, q.id))
            .length,
        0,
      );
    if (this.journal.get("blocking_question_count", 0) !== count)
      this.journal.put("blocking_question_count", count);
  }
  blockingQuestions() {
    const literal = (text: unknown) =>
      String(text).replace(/([\\`*_{}\[\]()#+.!>|~-])/g, "\\$1");
    const lines: string[] = [];
    for (const [code, r] of this.interactions.pending)
      if (!r.submitted && r.method === "item/tool/requestUserInput")
        r.params.questions.forEach((q: any, i: number) => {
          if (Object.hasOwn(r.answers, q.id)) return;
          lines.push(`\`${code}\` · ${i + 1}. ${literal(q.question)}`);
          if (q.isSecret) lines.push("Sensitive input: answer in Codex CLI.");
          else {
            (q.options ?? []).forEach((o: any, n: number) =>
              lines.push(`${n + 1}) ${literal(o.label)}`),
            );
            lines.push(`\`/answer ${code} ${i + 1} ANSWER\``);
          }
        });
    return lines.length ? "\n\n" + lines.join("\n") : "";
  }
  async event(event: any) {
    const m = event.method,
      p = event.params ?? {};
    if (m === "bridge/disconnected") {
      this.status = "disconnected";
      return;
    }
    if (p.threadId !== this.thread) return;
    if (m === "thread/settings/updated") {
      this.recordModel(p.threadSettings);
      return;
    }
    if (m === "thread/goal/updated") {
      this.journal.put("goal_state", { ...p.goal, thread: this.thread });
      return;
    }
    if (m === "thread/goal/cleared") {
      this.journal.put("goal_state", null);
      return;
    }
    if (m === "serverRequest/resolved") {
      this.interactions.resolve(p.requestId);
      this.questions.resolve(p.requestId);
      return;
    }
    if ("id" in event && m === "mcpServer/elicitation/request") {
      await this.questions.form(event);
      return;
    }
    if ("id" in event && (await this.interactions.request(event))) return;
    if (this.journal.get("historical_turn:" + (p.turnId ?? ""))) return;
    if (["item/started", "item/completed"].includes(m) && !p.recovered)
      this.activity.observe(p.turnId, p.item, m === "item/completed");
    if (m === "item/completed") this.questions.resolveInput(p.item);
    if (m === "turn/started") this.started(p.turn.id, p.turn);
    else if (m === "thread/tokenUsage/updated")
      recordUsage(this.journal, this.thread, p.turnId, p.tokenUsage);
    else if (m === "turn/completed") {
      recordTurnTiming(this.journal, p.turn);
      // Publish final tool completion before clearing the active turn/targets.
      if (p.turn.id === this.journal.get("active_turn"))
        await this.sender
          .refreshWorking(Date.now(), true)
          .catch((error) =>
            console.error(
              diagnostic(String(error), this.store.token(this.instance)),
            ),
          );
      this.journal.put("completed_turn:" + p.turn.id, true);
      this.activity.finish(p.turn.id);
      this.sender.finishWorking(p.turn.id);
      this.interactions.expire(p.turn.id);
      if (p.turn.id === this.activeTurn) {
        this.activeTurn = null;
        this.status = "idle";
        this.journal.put("active_turn", null);
      }
      const pending = this.journal.get("pending_final:" + p.turn.id, []);
      for (const item of pending)
        await this.event({
          method: "item/completed",
          params: { threadId: this.thread, turnId: p.turn.id, item },
        });
      if (pending.length) this.journal.put("pending_final:" + p.turn.id, []);
      if (p.turn.error)
        await this.say(
          "turn-error-" + p.turn.id,
          "⚠️ Turn failed:\n" +
            diagnostic(p.turn.error, this.store.token(this.instance)),
        );
    } else if (
      (m === "item/started" || m === "item/completed") &&
      p.item?.type === "contextCompaction"
    )
      await this.compaction(
        p.turnId,
        p.item.id,
        m === "item/completed",
        !p.recovered,
      );
    else if (m === "thread/compacted")
      await this.compaction(p.turnId, undefined, true);
    else if (m === "error")
      await this.say(
        "error-" + this.journal.fingerprint(p),
        (p.willRetry ? "⚠️ Codex is retrying:\n" : "⚠️ Codex error:\n") +
          diagnostic(p.error, this.store.token(this.instance)),
      );
    else if (m === "item/completed") {
      const item = p.item;
      if (item?.type === "agentMessage" && item.questions?.length) {
        if (!p.recovered) await this.questions.offer(item, p.turnId);
        return;
      }
      let failure: any;
      if (
        item.type === "commandExecution" &&
        ((item.exitCode != null && item.exitCode !== 0) ||
          item.status === "failed")
      )
        failure = `Command exited with ${item.exitCode}: ${item.command ?? ""}\n${item.aggregatedOutput || "No output returned"}`;
      else if (
        item.type === "mcpToolCall" &&
        (item.error || item.result?.isError)
      )
        failure = { tool: item.tool, error: item.error ?? item.result };
      else if (item.type === "dynamicToolCall" && item.success === false)
        failure = { tool: item.tool, output: item.contentItems };
      else if (item.type === "fileChange" && item.status === "failed")
        failure =
          "File change failed; no diagnostic detail was returned by Codex.";
      if (failure)
        this.journal.put("last_tool_error", {
          item_id: item.id,
          detail: diagnostic(failure, this.store.token(this.instance)),
          updated: Date.now() / 1000,
        });
      const publicText =
        item.type === "agentMessage"
          ? item.text
          : item.type === "exitedReviewMode"
            ? item.review
            : undefined;
      if (
        publicText &&
        [
          undefined,
          null,
          "commentary",
          "partial_answer",
          "final_answer",
        ].includes(item.phase)
      ) {
        if (
          p.turnId === this.activeTurn &&
          !["commentary", "partial_answer"].includes(item.phase) &&
          !this.journal.get("completed_turn:" + p.turnId)
        ) {
          const key = "pending_final:" + p.turnId;
          const pending = this.journal.get(key, []);
          if (!pending.some((entry: any) => entry.id === item.id))
            pending.push(item);
          this.journal.put(key, pending);
          return;
        }
        if (
          this.journal.get("delivered_item:" + item.id) ||
          this.journal.get(
            "explicit:" +
              this.journal.fingerprint({ turn: p.turnId, text: publicText }),
          )
        )
          return;
        // Native reviews emit the same final text as both agentMessage and
        // exitedReviewMode, with different item IDs. Reserve before sending so
        // an ambiguous first delivery cannot be retried through the other ID.
        if (
          p.turnId &&
          !["commentary", "partial_answer"].includes(item.phase)
        ) {
          const key =
            "public_final:" +
            this.journal.fingerprint({ turn: p.turnId, text: publicText });
          const original = this.journal.get(key);
          if (original && original !== item.id) return;
          this.journal.put(key, item.id);
        }
        const result = await this.say(
          "item-" + item.id,
          publicText,
          ["commentary", "partial_answer"].includes(item.phase)
            ? "working"
            : "codex",
          p.turnId,
        );
        if (result.status === "sent")
          this.journal.put("delivered_item:" + item.id, true);
      }
    }
  }
  async compaction(
    turn: string,
    item: string | undefined,
    completed: boolean,
    observed = true,
  ) {
    if (!turn) return;
    const turnKey = "compaction_turn:" + turn;
    const current = this.journal.get(turnKey);
    const id = item ?? current?.id ?? "legacy-" + turn;
    const key = "compaction:" + id;
    const state = this.journal.get(key, {});
    if (!observed && state.started === undefined) return;
    if (completed) {
      if (
        state.completed ||
        (current?.completed &&
          (!item ||
            (current.id === "legacy-" + turn && state.started === undefined)))
      )
        return;
      const elapsed =
        observed && Number.isFinite(state.started)
          ? Math.max(0, Math.floor((Date.now() - state.started) / 1000))
          : undefined;
      const text =
        "Context compacted." +
        (elapsed === undefined ? "" : ` (${durationText(elapsed)})`);
      // Reserve before sending; never retry an ambiguous notice under another event ID.
      this.journal.db.transaction(() => {
        this.journal.put(key, { ...state, completed: true });
        this.journal.put(turnKey, { id, completed: true });
      })();
      const timer = this.journal.get("compaction_timer");
      if (timer?.id === id)
        this.journal.put("compaction_timer", { ...timer, finalText: text });
      await this.say("compaction-completed-" + id, text);
    } else {
      if (state.started !== undefined || state.completed) return;
      this.journal.db.transaction(() => {
        this.journal.put(key, { started: Date.now() });
        this.journal.put(turnKey, { id, completed: false });
      })();
      const receipt = await this.say(
        "compaction-started-" + id,
        "Context compaction started.",
      );
      if (receipt.status === "sent" && receipt.details?.message_id) {
        const c = this.store.read(this.instance);
        this.journal.put("compaction_timer", {
          id,
          turn,
          started: this.journal.get(key).started,
          message: receipt.details.message_id,
          thread: c.thread_id,
          owner: c.owner_id,
          revision: c.binding_revision,
          next: Date.now() + this.sender.refreshInterval(),
          sequence: 0,
        });
      }
    }
  }
  async refreshCompaction(at = Date.now()) {
    const timer = this.journal.get("compaction_timer");
    if (
      !timer ||
      at <
        Math.max(
          timer.next,
          this.journal.get("working_edit_after", 0),
          this.journal.get("working_refresh_after", 0),
        )
    )
      return;
    const c = this.store.read(this.instance);
    if (!c.enabled || c.autostart === false || c.removing || c.binding_change)
      return;
    if (
      c.thread_id !== timer.thread ||
      c.owner_id !== timer.owner ||
      c.binding_revision !== timer.revision
    ) {
      this.journal.put("compaction_timer", null);
      return;
    }
    const text =
      timer.finalText ??
      `Compacting context… (${durationText(Math.max(0, Math.floor((at - timer.started) / 1000)))})`;
    const sequence = timer.sequence + 1;
    // Reserve each edit before sending; a lost response never causes a new send.
    this.journal.put("compaction_timer", {
      ...timer,
      sequence,
      next: at + this.sender.refreshInterval(),
    });
    this.journal.put("working_edit_after", at + this.sender.refreshInterval());
    const receipt = await this.sender.send(
      `compaction-timer-${hash(timer.id)}-${sequence}`,
      {
        text,
        source: "system",
        edit_id: timer.message,
        defer_on_limit: false,
      },
    );
    if (receipt.status === "rejected" && receipt.details?.error_code === 429) {
      this.sender.applyRateLimit(receipt.details.retry_after);
    } else if (timer.finalText || receipt.status === "rejected")
      this.journal.put("compaction_timer", null);
  }
  close() {
    this.journal.close();
  }
}
