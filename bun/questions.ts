import { hash, type Journal } from "./state";
import type { Client } from "./appserver";

// Match Codex CLI 0.163's AnsweredQuestion envelope and question identity.
// The ID is derived from the source agent item and zero-based question index.
function boundedQuestionTitle(value: unknown) {
  let result = "";
  for (const char of String(value).replace(/[\r\n]/g, " ")) {
    if (Buffer.byteLength(result + char) > 512) break;
    result += char;
  }
  return result;
}
export function asyncAnswerText(
  itemId: string,
  questions: any[],
  answers: Record<string, unknown>,
) {
  return (
    "<send_user_message_question_reply>\n" +
    JSON.stringify(
      questions.map((q, index) => ({
        answer: String(answers[q.id]),
        question: boundedQuestionTitle(q.title),
        questionItemId: JSON.stringify([
          "request_user_input_async",
          itemId,
          index,
        ]),
      })),
    ) +
    "\n</send_user_message_question_reply>"
  );
}

/** Async agent questions are follow-up inputs, not outstanding JSON-RPC calls.
 * MCP form elicitations are real server requests and receive structured results. */
const literal = (text: unknown) =>
  String(text).replace(/([\\`*_{}\[\]()#+.!>|~-])/g, "\\$1");
export class Questions {
  constructor(
    readonly journal: Journal,
    readonly client: Client,
    readonly thread: string,
    readonly say: (key: string, text: string) => Promise<any>,
    readonly redact: (text: string) => string,
  ) {}
  async offer(item: any, turn: string) {
    if (!item?.questions?.length || !turn) return;
    const questions = item.questions.map((q: any, i: number) => ({
      id: String(i),
      title: q.title,
      options: (q.options ?? []).map((label: string) => ({
        label,
        value: label,
      })),
      secret: /password|secret|api.?key|bot.?token|密码|密钥|私钥/i.test(
        q.title ?? "",
      ),
      type: "string",
    }));
    await this.publish("aq-" + hash(this.thread + item.id).slice(0, 8), {
      kind: "async",
      turn,
      sourceItemId: item.id,
      questions,
    });
  }
  async form(event: any) {
    const p = event.params;
    const code =
      "mf-" +
      hash(
        JSON.stringify([
          this.thread,
          p.turnId,
          p.serverName,
          event.id,
          p.message,
          p.requestedSchema,
        ]),
      ).slice(0, 8);
    const schema = p.requestedSchema;
    const supported =
      ["form", "openai/form", "openaiForm"].includes(p.mode) &&
      schema?.type === "object" &&
      schema.properties;
    const questions = supported
      ? Object.entries(schema.properties).map(([id, raw]: any) => ({
          id,
          title: raw.title ?? id,
          constraints: raw,
          type: raw.type ?? "string",
          required: schema.required?.includes(id),
          secret:
            raw.format === "password" ||
            raw.writeOnly ||
            /password|secret|api.?key|token|密码|密钥|私钥/i.test(id),
          options: (raw.enum ?? raw.oneOf ?? []).map((v: any, i: number) => ({
            value: typeof v === "object" ? v.const : v,
            label:
              typeof v === "object"
                ? (v.title ?? String(v.const))
                : (raw.enumNames?.[i] ?? String(v)),
          })),
        }))
      : [];
    if (
      !questions.length ||
      questions.some(
        (q: any) =>
          !["string", "boolean", "number", "integer"].includes(q.type),
      )
    ) {
      await this.say(
        "form-unsupported-" + code,
        "Codex needs information in a form that Telegram cannot display yet. Complete it in Codex CLI.",
      );
      return;
    }
    await this.publish(code, {
      kind: "form",
      turn: p.turnId,
      requestId: event.id,
      message: p.message,
      questions,
    });
  }
  private async publish(code: string, value: any) {
    const key = "question:" + code;
    if (this.journal.get(key)) return;
    const state = {
      ...value,
      thread: this.thread,
      answers: {},
      status: "pending",
    };
    this.journal.put(key, state); // reserve before outbound delivery; never blindly replay
    const lines = [
      `Codex needs your input (\`${code}\`):`,
      ...(value.message ? [value.message] : []),
    ];
    value.questions.forEach((q: any, i: number) => {
      lines.push(`${i + 1}. ${literal(q.title)}`);
      if (q.secret) {
        lines.push("Sensitive input: answer in Codex CLI.");
        return;
      }
      q.options.forEach((o: any, n: number) =>
        lines.push(`${n + 1}) ${literal(o.label)}`),
      );
      lines.push(`\`/answer ${code} ${i + 1} OPTION_NUMBER_OR_TEXT\``);
    });
    await this.say("question-" + code, this.redact(lines.join("\n")));
  }
  list() {
    const lines: string[] = [];
    for (const row of this.journal.db
      .query("SELECT key,value FROM metadata WHERE key LIKE 'question:%'")
      .all() as any[]) {
      const state = JSON.parse(row.value);
      if (state?.thread !== this.thread || state.status !== "pending") continue;
      const code = row.key.slice("question:".length);
      state.questions.forEach((q: any, i: number) => {
        if (Object.hasOwn(state.answers, q.id)) return;
        lines.push(`\`${code}\` · ${i + 1}. ${literal(q.title)}`);
        if (q.secret) lines.push("Sensitive input: answer in Codex CLI.");
        else {
          q.options.forEach((o: any, n: number) =>
            lines.push(`${n + 1}) ${literal(o.label)}`),
          );
          lines.push(`\`/answer ${code} ${i + 1} OPTION_NUMBER_OR_TEXT\``);
        }
        lines.push("");
      });
    }
    return lines.length
      ? lines.join("\n").trimEnd()
      : "No unanswered questions.";
  }
  resolveInput(item: any) {
    if (item?.type !== "userMessage") return;
    for (const input of item.content ?? []) {
      const match =
        input.type === "text" &&
        /^<send_user_message_question_reply>\s*([\s\S]+)\s*<\/send_user_message_question_reply>$/.exec(
          input.text.trim(),
        );
      if (!match) continue;
      try {
        const parsed = JSON.parse(match[1]),
          replies = Array.isArray(parsed) ? parsed : [parsed];
        for (const reply of replies) {
          const identity = JSON.parse(reply.questionItemId);
          if (
            !Array.isArray(identity) ||
            identity[0] !== "request_user_input_async" ||
            !Number.isInteger(identity[2])
          )
            continue;
          const key =
              "question:aq-" + hash(this.thread + identity[1]).slice(0, 8),
            state = this.journal.get(key);
          const question = state?.questions?.[identity[2]];
          if (
            state?.thread !== this.thread ||
            state.status !== "pending" ||
            !question
          )
            continue;
          state.answers[question.id] = reply.answer;
          this.journal.put(key, {
            ...state,
            status: state.questions.every((q: any) =>
              Object.hasOwn(state.answers, q.id),
            )
              ? "resolved"
              : "pending",
          });
        }
      } catch {
        /* Ordinary user text is never interpreted as a question answer. */
      }
    }
  }
  has(code: string) {
    return !!this.journal.get("question:" + code);
  }
  resolve(requestId: any) {
    for (const row of this.journal.db
      .query("SELECT key,value FROM metadata WHERE key LIKE 'question:%'")
      .all() as any[]) {
      const state = JSON.parse(row.value);
      if (
        state?.kind === "form" &&
        state.requestId === requestId &&
        state.thread === this.thread
      )
        this.journal.put(row.key, { ...state, status: "resolved" });
    }
  }
  decline(code: string) {
    const key = "question:" + code,
      state = this.journal.get(key);
    if (!state || state.thread !== this.thread || state.status !== "pending")
      return "This question is no longer pending.";
    this.journal.put(key, { ...state, status: "submitting" });
    try {
      if (state.kind === "form")
        this.client.send({
          id: state.requestId,
          result: { action: "decline", content: null, _meta: null },
        });
      this.journal.put(key, { ...state, status: "answered" });
      return state.kind === "form"
        ? "Form declined."
        : "Question dismissed in Telegram.";
    } catch {
      this.journal.put(key, { ...state, status: "unknown" });
      return "Response delivery could not be confirmed. Check Codex before retrying.";
    }
  }
  async answer(args: string, activeTurn: string | null) {
    const match = /^(\S+)\s+(\d+)\s+([\s\S]+)$/.exec(args.trim());
    if (!match) return "Use /answer REQUEST QUESTION_NUMBER ANSWER";
    const key = "question:" + match[1],
      state = this.journal.get(key);
    if (!state || state.thread !== this.thread || state.status !== "pending")
      return "This question was answered, expired, or has an unconfirmed response. It will not be submitted again.";
    const question = state.questions[Number(match[2]) - 1];
    if (!question) return "Invalid question number.";
    if (question.secret) return "Answer this sensitive question in Codex CLI.";
    let value: any = match[3];
    if (question.options.length) {
      const n = /^\d+$/.test(value) ? Number(value) - 1 : -1;
      const option =
        question.options[n] ??
        question.options.find(
          (o: any) => o.label === value || String(o.value) === value,
        );
      if (!option && state.kind === "form")
        return "Choose one of the listed options.";
      if (option) value = option.value;
    }
    if (question.type === "boolean") {
      if (![true, false, "true", "false"].includes(value))
        return "Answer true or false.";
      value = value === true || value === "true";
    } else if (["number", "integer"].includes(question.type)) {
      value = Number(value);
      if (
        !Number.isFinite(value) ||
        (question.type === "integer" && !Number.isSafeInteger(value))
      )
        return "Enter a valid number.";
    }
    const limits = question.constraints ?? {};
    if (typeof value === "string") {
      if (
        (Number.isFinite(limits.minLength) &&
          Array.from(value).length < limits.minLength) ||
        (Number.isFinite(limits.maxLength) &&
          Array.from(value).length > limits.maxLength)
      )
        return "The answer does not meet the field length requirements.";
      if (limits.pattern) {
        try {
          if (!new RegExp(limits.pattern).test(value))
            return "The answer does not match the field format.";
        } catch {
          return "Complete this field in Codex CLI.";
        }
      }
    }
    if (
      typeof value === "number" &&
      ((Number.isFinite(limits.minimum) && value < limits.minimum) ||
        (Number.isFinite(limits.maximum) && value > limits.maximum))
    )
      return "The number is outside the allowed range.";
    state.answers[question.id] = value;
    this.journal.put(key, state);
    if (Object.keys(state.answers).length < state.questions.length)
      return "Answer saved. Please answer the remaining questions.";
    if (state.kind === "async" && !state.sourceItemId)
      return "This question predates synchronized answers. Answer it in Codex CLI.";
    this.journal.put(key, { ...state, status: "submitting" });
    try {
      if (state.kind === "form")
        this.client.send({
          id: state.requestId,
          result: { action: "accept", content: state.answers, _meta: null },
        });
      else {
        const text = asyncAnswerText(
          state.sourceItemId,
          state.questions,
          state.answers,
        );
        const params = {
          threadId: this.thread,
          clientUserMessageId: "telegram-answer-" + match[1],
          input: [{ type: "text", text, text_elements: [] }],
        };
        await this.client.call(activeTurn ? "turn/steer" : "turn/start", {
          ...params,
          ...(activeTurn ? { expectedTurnId: activeTurn } : {}),
        });
      }
      this.journal.put(key, { ...state, status: "answered" });
      return "Answer submitted to Codex.";
    } catch {
      this.journal.put(key, { ...state, status: "unknown" });
      return "Answer delivery could not be confirmed. Check Codex before submitting again.";
    }
  }
}
