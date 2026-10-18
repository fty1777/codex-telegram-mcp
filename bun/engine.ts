import { join } from "node:path";
import { DeliveryUnknown, RpcError, type Client } from "./appserver";
import { Store, Journal, hash, legacyJSON } from "./state";
import { Sender, Telegram } from "./telegram";
import { Interactions } from "./interactions";
import type { MessageSource } from "./format";
import { recordTurnTiming } from "./timing";
import { HELP, QUERY_METHODS, commandHelp, nativeCommand, parseCommand } from "./commands";
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
  constructor(
    readonly store: Store,
    readonly instance: string,
    readonly client: Client,
    readonly sender: Sender,
  ) {
    this.config = store.read(instance);
    this.journal = new Journal(store.instance(instance));
    this.thread = this.config.thread_id;
    this.interactions = new Interactions(
      client,
      (k, t) => this.say(k, t),
      (v) => diagnostic(v, store.token(instance), null),
    );
  }
  waitingForHistory = false;
  async attach() {
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
    if (this.config.session_settings)
      await this.client.call("thread/settings/update", {
        ...this.config.session_settings,
        threadId: this.thread,
      });
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
      if (!initialized && turn.status !== "inProgress") {
        this.journal.put("historical_turn:" + turn.id, true);
        continue;
      }
      if (this.journal.get("historical_turn:" + turn.id)) continue;
      recordTurnTiming(this.journal, turn);
      if (turn.status === "inProgress") {
        if (!initialized)
          for (const item of (turn.items ?? []).slice(0, -1))
            if (item.type === "agentMessage")
              this.journal.put("delivered_item:" + item.id, true);
        continue;
      }
      for (const item of turn.items ?? [])
        await this.event({
          method: "item/completed",
          params: { threadId: this.thread, turnId: turn.id, item },
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
    return this.sender.send(base + "-0", { text, source, turn_id: turnId });
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
        const reply = await this.command(key, text, () => { submitting = true; });
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
        (e instanceof DeliveryUnknown && (!text.startsWith("/") || submitting)) ||
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
        return this.client.call(method, params);
      },
      resume: (thread, options) => this.client.resume(thread, options),
      send: (message) => { submitting?.(); this.client.send(message); },
    };
    let reply;
    if (["/approve", "/deny", "/answer"].includes(cmd)) {
      submitting?.();
      reply = this.interactions.respond(cmd, args);
    }
    else if (cmd === "/help") reply = commandHelp(args);
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
        (await nativeCommand(client, this.thread, cmd, args, !!this.activeTurn, {
          started: (turn) => this.started(turn.id, turn),
          requestId: `telegram-${this.config.bot_id}-${key}`,
        })) ??
        "Unknown command.\n" + HELP;
    return await this.say("command-" + key, diagnostic(reply, this.store.token(this.instance), null));
  }
  async event(event: any) {
    const m = event.method,
      p = event.params ?? {};
    if (m === "bridge/disconnected") {
      this.status = "disconnected";
      return;
    }
    if (p.threadId !== this.thread) return;
    if (m === "serverRequest/resolved") {
      this.interactions.resolve(p.requestId);
      return;
    }
    if ("id" in event && (await this.interactions.request(event))) return;
    if (this.journal.get("historical_turn:" + (p.turnId ?? ""))) return;
    if (m === "turn/started") this.started(p.turn.id, p.turn);
    else if (m === "turn/completed") {
      recordTurnTiming(this.journal, p.turn);
      this.interactions.expire(p.turn.id);
      if (p.turn.id === this.activeTurn) {
        this.activeTurn = null;
        this.status = "idle";
        this.journal.put("active_turn", null);
      }
      if (p.turn.error)
        await this.say(
          "turn-error-" + p.turn.id,
          "⚠️ Turn failed:\n" +
            diagnostic(p.turn.error, this.store.token(this.instance)),
        );
    } else if (m === "error")
      await this.say(
        "error-" + this.journal.fingerprint(p),
        (p.willRetry ? "⚠️ Codex is retrying:\n" : "⚠️ Codex error:\n") +
          diagnostic(p.error, this.store.token(this.instance)),
      );
    else if (m === "item/completed") {
      const item = p.item;
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
      const publicText = item.type === "agentMessage" ? item.text :
        item.type === "exitedReviewMode" ? item.review : undefined;
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
        if (p.turnId && !["commentary", "partial_answer"].includes(item.phase)) {
          const key = "public_final:" + this.journal.fingerprint({ turn: p.turnId, text: publicText });
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
  close() {
    this.journal.close();
  }
}
