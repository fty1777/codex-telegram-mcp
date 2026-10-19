import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../bun/state";
import { Questions } from "../bun/questions";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telegram-questions-")),
    journal = new Journal(root);
  const shown: any[] = [],
    calls: any[] = [],
    responses: any[] = [];
  const client: any = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      return {};
    },
    send: (value: any) => responses.push(value),
  };
  const q = new Questions(
    journal,
    client,
    "thread",
    async (key, text) => {
      shown.push({ key, text });
      return { status: "sent" };
    },
    (text) => text,
  );
  return {
    journal,
    q,
    client,
    shown,
    calls,
    responses,
    close() {
      journal.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const question = {
  id: "ask",
  questions: [
    { title: "Choose layout", options: ["One message", "Two messages"] },
  ],
};
const code = (text: string) => /\(`?(aq-[\w]+|mf-[\w]+)`?\)/.exec(text)![1];

test("async agent questions arrive once, survive reconnect, and answers steer as follow-up inputs", async () => {
  const f = fixture();
  try {
    await f.q.offer(question, "turn");
    await f.q.offer(question, "turn");
    expect(f.shown).toHaveLength(1);
    const id = code(f.shown[0].text);
    expect(f.shown[0].text).toContain("1) One message\n2) Two messages");
    const restored = new Questions(
      f.journal,
      f.client,
      "thread",
      async () => {
        throw Error("must not resend");
      },
      (text) => text,
    );
    await restored.offer(question, "turn");
    expect(await restored.answer(`${id} 1 2`, "active")).toBe(
      "Answer submitted to Codex.",
    );
    expect(f.calls[0].method).toBe("turn/steer");
    expect(f.calls[0].params.expectedTurnId).toBe("active");
    expect(f.calls[0].params.input[0].text).toBe(
      "<send_user_message_question_reply>\n" +
        JSON.stringify([
          {
            answer: "Two messages",
            question: "Choose layout",
            questionItemId: JSON.stringify([
              "request_user_input_async",
              "ask",
              0,
            ]),
          },
        ]) +
        "\n</send_user_message_question_reply>",
    );
    expect(f.responses).toHaveLength(0); // async questions are not server RPC requests
    await restored.answer(`${id} 1 1`, "active");
    expect(f.calls).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("MCP single-choice forms return typed structured content on the real request id", async () => {
  const f = fixture();
  try {
    await f.q.form({
      id: 37,
      params: {
        threadId: "thread",
        turnId: "turn",
        serverName: "fixture",
        mode: "form",
        message: "Choose a mode",
        requestedSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["one", "two"],
              enumNames: ["One message", "Two messages"],
            },
          },
          required: ["mode"],
        },
      },
    });
    const id = code(f.shown[0].text);
    expect(await f.q.answer(`${id} 1 unknown`, "turn")).toBe(
      "Choose one of the listed options.",
    );
    await f.q.answer(`${id} 1 1`, "turn");
    expect(f.responses).toEqual([
      {
        id: 37,
        result: { action: "accept", content: { mode: "one" }, _meta: null },
      },
    ]);
    expect(f.calls).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("sensitive and resolved questions are not answered over Telegram and ambiguous answers are not replayed", async () => {
  const f = fixture();
  try {
    await f.q.offer(
      { id: "secret", questions: [{ title: "Enter API key", options: null }] },
      "turn",
    );
    const secret = code(f.shown[0].text);
    expect(await f.q.answer(`${secret} 1 value`, "turn")).toContain(
      "sensitive",
    );
    expect(f.calls).toHaveLength(0);
    await f.q.offer(question, "turn");
    const id = code(f.shown[1].text);
    f.client.call = async () => {
      throw Error("response lost");
    };
    expect(await f.q.answer(`${id} 1 1`, "turn")).toContain(
      "could not be confirmed",
    );
    expect(await f.q.answer(`${id} 1 1`, "turn")).toContain(
      "will not be submitted again",
    );
  } finally {
    f.close();
  }
});

test("multiple async answers use distinct CLI question identities in one complete envelope", async () => {
  const f = fixture();
  try {
    await f.q.offer(
      {
        id: "source-item",
        questions: [
          { title: "First question", options: ["Yes", "No"] },
          { title: "Second question", options: ["Keep", "Remove"] },
        ],
      },
      "turn",
    );
    const id = code(f.shown[0].text);
    await f.q.answer(`${id} 2 2`, "turn");
    expect(f.calls).toHaveLength(0);
    await f.q.answer(`${id} 1 1`, "turn");
    const text = f.calls[0].params.input[0].text;
    const replies = JSON.parse(
      text.replace(
        /^<send_user_message_question_reply>\n|\n<\/send_user_message_question_reply>$/g,
        "",
      ),
    );
    expect(replies).toEqual([
      {
        answer: "Yes",
        question: "First question",
        questionItemId: JSON.stringify([
          "request_user_input_async",
          "source-item",
          0,
        ]),
      },
      {
        answer: "Remove",
        question: "Second question",
        questionItemId: JSON.stringify([
          "request_user_input_async",
          "source-item",
          1,
        ]),
      },
    ]);
    expect(f.calls).toHaveLength(1);
  } finally {
    f.close();
  }
});
