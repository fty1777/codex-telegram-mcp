import { randomBytes } from "node:crypto";
import type { Client } from "./appserver";
export class Interactions {
  pending = new Map<string, any>();
  constructor(
    readonly client: Client,
    readonly say: (k: string, t: string) => Promise<any>,
    readonly redact: (v: any) => string,
  ) {}
  async request(event: any) {
    const method = event.method,
      p = event.params;
    if (
      ![
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
        "item/tool/requestUserInput",
      ].includes(method)
    )
      return false;
    const key = randomBytes(4).toString("hex");
    this.pending.set(key, { id: event.id, method, params: p, answers: {} });
    const lines: string[] = [];
    if (method === "item/tool/requestUserInput") {
      lines.push(`Codex needs your input (${key}):`);
      for (const [i, q] of p.questions.entries()) {
        lines.push(`${i + 1}. ${q.question}`);
        if (q.isSecret) {
          lines.push("Sensitive input: answer in the Codex terminal.");
          continue;
        }
        for (const [n, o] of (q.options ?? []).entries())
          lines.push(`${n + 1}) ${o.label}: ${o.description ?? ""}`);
        lines.push(`/answer ${key} ${i + 1} YOUR_ANSWER_OR_OPTION_NUMBER`);
      }
    } else {
      lines.push(
        `Approval needed (${key}):`,
        method,
        p.reason ?? "",
        p.command ?? "",
        JSON.stringify(p.permissions ?? {}),
        `/approve ${key} — allow once`,
        `/deny ${key} — deny`,
      );
    }
    await this.say(
      "request-" + key,
      this.redact(lines.filter(Boolean).join("\n")),
    );
    return true;
  }
  resolve(id: any) {
    for (const [k, r] of this.pending) if (r.id === id) this.pending.delete(k);
  }
  expire(turn: string) {
    for (const [k, r] of this.pending)
      if (r.params.turnId === turn) this.pending.delete(k);
  }
  respond(command: string, args: string) {
    const words = args.trim().match(/^(\S+)(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/);
    const r = words ? this.pending.get(words[1]) : null;
    if (!r)
      return "This request has expired or was handled in another client. Check the Codex terminal.";
    if (r.submitted)
      return "A response was already submitted; it will not be sent again.";
    const p = r.params;
    let result: any;
    if (command === "/answer") {
      if (r.method !== "item/tool/requestUserInput" || !words?.[3])
        return "Use /answer REQUEST QUESTION_NUMBER ANSWER";
      const n = Number(words[2]);
      if (!Number.isInteger(n) || n < 1 || n > p.questions.length)
        return "Invalid question number.";
      const q = p.questions[n - 1];
      if (q.isSecret)
        return "Answer this sensitive question in the Codex terminal.";
      let answer = words[3];
      const option = Number(answer);
      if (
        /^\d+$/.test(answer) &&
        option >= 1 &&
        option <= (q.options ?? []).length
      )
        answer = q.options[option - 1].label;
      r.answers[q.id] = { answers: [answer] };
      if (Object.keys(r.answers).length < p.questions.length)
        return "Answer saved. Please answer the remaining questions.";
      result = { answers: r.answers };
    } else {
      if (r.method === "item/tool/requestUserInput")
        return "Use /answer for this request.";
      if (r.method === "item/permissions/requestApproval")
        result = {
          permissions: command === "/approve" ? p.permissions : {},
          scope: "turn",
        };
      else {
        let decision = command === "/approve" ? "accept" : "decline";
        const choices = p.availableDecisions;
        if (
          command === "/deny" &&
          choices &&
          !choices.includes("decline") &&
          choices.includes("cancel")
        )
          decision = "cancel";
        if (choices && !choices.includes(decision))
          return "This decision is not offered by Codex; use the terminal.";
        result = { decision };
      }
    }
    r.submitted = true;
    try {
      this.client.send({ id: r.id, result });
    } catch {
      return "Response delivery is unknown. Check the Codex terminal; do not repeat approval.";
    }
    return result.decision === "cancel"
      ? "Denied; Codex will interrupt this turn."
      : "Response submitted to Codex.";
  }
}
