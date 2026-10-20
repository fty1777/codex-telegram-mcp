import { telegramView } from "./telegram-view";
import { test, expect } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  statSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Journal, readJSON, atomic } from "../bun/state";
import {
  beginPairing,
  pollPairing,
  redeemPairing,
  cancelPairing,
  completePairing,
} from "../bun/pairing";
import { listBots } from "../bun/management";

test.each(["connected", "awaiting-session-reload", "failed"])(
  "pairing completion journals its acknowledgement when receiver startup is %s",
  async (startup) => {
    const f = fixture();
    try {
      await beginPairing(
        f.store,
        "sample",
        "123456:secret",
        "session-a",
        undefined,
        f.factory,
      );
      f.setUpdates([
        {
          update_id: 1,
          message: {
            from: { id: 42, is_bot: false },
            chat: { id: 42, type: "private" },
            text: "/start",
          },
        },
      ]);
      await pollPairing(f.store, "sample", "session-a", f.factory);
      const code = f.calls
        .find((c) => c.method === "sendRichMessage")
        .args.text.match(/Pairing code: ([A-F0-9]+)/)[1];
      let starts = 0;
      const connect = async () => {
        starts++;
        expect(f.store.read("sample").owner_id).toBe(42);
        if (startup === "failed") throw Error("fixture startup failure");
        return { status: startup };
      };
      await expect(
        completePairing(
          f.store,
          "sample",
          "session-a",
          "wrong",
          connect,
          f.factory(""),
        ),
      ).rejects.toThrow("Invalid pairing code");
      expect(starts).toBe(0);
      const result = await completePairing(
        f.store,
        "sample",
        "session-a",
        code,
        connect,
        f.factory(""),
      );
      expect(result.connection.status).toBe(
        startup === "failed" ? "paired_receiver_not_started" : startup,
      );
      expect(result.notification.status).toBe("sent");
      const notice = f.calls.filter((c) => c.method === "sendRichMessage").at(-1).args;
      expect(notice.text).toContain("System\nPairing complete.");
      expect(notice.text).toContain("Messages from other users and group chats are ignored without a reply and are not forwarded to Codex.");
      expect(notice.entities.some((e: any) => e.type === "blockquote")).toBe(true);
      expect(starts).toBe(1);
      expect(
        f.calls.filter((c) =>
          ["sendRichMessage", "sendRichMessage"].includes(c.method),
        ),
      ).toHaveLength(2);
      expect(listBots(f.store)[0]!.pairing_connectivity).toBe(
        "awaiting_owner_reply",
      );
      const journal = new Journal(f.store.instance("sample"));
      try {
        journal.db
          .query("UPDATE delivery SET updated=100 WHERE key='pairing-success'")
          .run();
        journal.begin("in", "owner-reply", {});
        journal.finish("in", "owner-reply", "accepted", {});
        expect(listBots(f.store)[0]!.pairing_connectivity).toBe("verified");
      } finally {
        journal.close();
      }
    } finally {
      f.clean();
    }
  },
);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bridge-pairing-")),
    store = new Store(root);
  let updates: any[] = [];
  const calls: any[] = [];
  const factory = (_token: string): any => ({
    call: async (method: string, args: any) => {
      calls.push({ method, args: telegramView(args) });
      if (method === "getMe")
        return { id: 123456, username: "fixture_bot", is_bot: true };
      if (method === "getWebhookInfo") return {};
      if (method === "getUpdates") return updates;
      if (method === "sendRichMessage")
        return { message_id: calls.length, chat: { id: args.chat_id } };
      throw Error("unexpected call");
    },
  });
  return {
    store,
    root,
    factory,
    calls,
    setUpdates: (v: any[]) => {
      updates = v;
    },
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("pairing is durable, session-scoped, explicit, and does not expose credentials", async () => {
  const f = fixture();
  try {
    const started = await beginPairing(
      f.store,
      "sample",
      "123456:secret",
      "session-a",
      undefined,
      f.factory,
    );
    expect(JSON.stringify(started)).not.toContain("secret");
    expect(statSync(join(f.root, "pairings/sample.json")).mode & 0o777).toBe(
      0o600,
    );
    expect(
      await beginPairing(
        f.store,
        "sample",
        "123456:secret",
        "session-a",
        undefined,
        f.factory,
      ),
    ).toEqual(started);
    await expect(
      beginPairing(
        f.store,
        "second",
        "123456:secret",
        "session-b",
        undefined,
        f.factory,
      ),
    ).rejects.toThrow("pending pairing");
    await expect(
      pollPairing(f.store, "sample", "session-b", f.factory),
    ).rejects.toThrow("another session");
    expect(() =>
      redeemPairing(f.store, "sample", "session-a", "wrong"),
    ).toThrow("Invalid pairing code");
    expect(started.pairing_url).not.toContain("?start=");
    const message = (
      id: number,
      text: string,
      type = "private",
      chat = id,
    ) => ({
      from: { id, first_name: "Test", is_bot: false },
      chat: { id: chat, type },
      text,
    });
    f.setUpdates([
      { update_id: 1, message: message(42, "/start wrong") },
      { update_id: 2, message: message(43, "/start", "group") },
      { update_id: 3, message: message(44, "/start", "private", 45) },
      { update_id: 4, message: message(42, "/start") },
    ]);
    const polled: any = await pollPairing(
      new Store(f.root),
      "sample",
      "session-a",
      f.factory,
    );
    expect(polled.candidate_count).toBe(1);
    const html = f.calls.find((c) => c.method === "sendRichMessage").args.rich_message.html;
    expect(html).toMatch(/<tg-button type="copy_text" text="([A-F0-9]{12})">\1<\/tg-button>/);
    const code = f.calls
      .find((c) => c.method === "sendRichMessage")
      .args.text.match(/Pairing code: ([A-F0-9]+)/)[1];
    expect(JSON.stringify(polled)).not.toContain(code);
    expect(f.store.list()).toEqual([]);
    expect(() => redeemPairing(f.store, "sample", "session-b", code)).toThrow(
      "another session",
    );
    expect(() =>
      redeemPairing(f.store, "sample", "session-a", "invalid"),
    ).toThrow("Invalid pairing code");
    expect(redeemPairing(f.store, "sample", "session-a", code).status).toBe(
      "configured",
    );
    expect(f.store.read("sample").thread_id).toBe("session-a");
    expect(f.store.read("sample").owner_id).toBe(42);
    const j = new Journal(f.store.instance("sample"));
    try {
      expect(j.get("telegram_offset")).toBe(5);
    } finally {
      j.close();
    }
    expect(existsSync(join(f.root, "pairings/sample.json"))).toBe(false);
    await expect(
      beginPairing(
        f.store,
        "second",
        "123456:secret",
        "session-a",
        undefined,
        f.factory,
      ),
    ).rejects.toThrow("already configured");
  } finally {
    f.clean();
  }
});
test("expired pairing cannot authorize and can be cancelled only by its initiating session", async () => {
  const f = fixture();
  try {
    await beginPairing(
      f.store,
      "sample",
      "123456:secret",
      "session-a",
      undefined,
      f.factory,
    );
    const path = join(f.root, "pairings/sample.json");
    atomic(path, { ...readJSON(path), expires_at: 1 });
    await expect(
      pollPairing(f.store, "sample", "session-a", f.factory),
    ).rejects.toThrow("expired");
    expect(() => cancelPairing(f.store, "sample", "session-b")).toThrow(
      "another session",
    );
    expect(cancelPairing(f.store, "sample", "session-a").status).toBe(
      "cancelled",
    );
    expect(cancelPairing(f.store, "sample", "session-a").status).toBe("absent");
    await beginPairing(
      f.store,
      "sample",
      "123456:secret",
      "session-a",
      undefined,
      f.factory,
    );
  } finally {
    f.clean();
  }
});

test("codes are single-use, bounded, and never authorize unsolicited messages", async () => {
  const f = fixture();
  try {
    await beginPairing(
      f.store,
      "sample",
      "123456:secret",
      "s",
      undefined,
      f.factory,
    );
    const message = (id: number, extra: any = {}) => ({
      from: { id, is_bot: false },
      chat: { id, type: "private" },
      text: "/start",
      ...extra,
    });
    f.setUpdates([
      { update_id: 1, message: message(1, { text: "hello" }) },
      { update_id: 2, message: message(2, { from: { id: 2, is_bot: true } }) },
      { update_id: 3, message: message(3, { date: 1 }) },
      ...Array.from({ length: 30 }, (_, i) => ({
        update_id: 4 + i,
        message: message(10 + i),
      })),
    ]);
    await pollPairing(f.store, "sample", "s", f.factory);
    expect(f.calls.filter((c) => c.method === "sendRichMessage").length).toBe(
      20,
    );
    expect(f.store.list()).toEqual([]);
    await pollPairing(f.store, "sample", "s", f.factory);
    expect(f.calls.filter((c) => c.method === "sendRichMessage").length).toBe(
      20,
    );
    const codes = f.calls
      .filter((c) => c.method === "sendRichMessage")
      .map((c) => c.args.text.match(/Pairing code: ([A-F0-9]+)/)[1]);
    expect(() => redeemPairing(f.store, "other", "s", codes[0])).toThrow();
    expect(redeemPairing(f.store, "sample", "s", codes[0]).owner_id).toBe(10);
    expect(() => redeemPairing(f.store, "sample", "s", codes[1])).toThrow();
    expect(() => redeemPairing(f.store, "sample", "s", codes[0])).toThrow();
    await expect(
      pollPairing(f.store, "sample", "s", f.factory),
    ).rejects.toThrow();
    expect(f.calls.filter((c) => c.method === "sendRichMessage").length).toBe(
      20,
    );
  } finally {
    f.clean();
  }
});

test("invalid redemption is bounded and never extends the pairing window", async () => {
  const f = fixture();
  try {
    await beginPairing(
      f.store,
      "sample",
      "123456:secret",
      "s",
      undefined,
      f.factory,
    );
    const path = join(f.root, "pairings/sample.json");
    const expiry = readJSON(path).expires_at;
    for (let i = 0; i < 10; i++)
      expect(() => redeemPairing(f.store, "sample", "s", "wrong")).toThrow(
        "Invalid pairing code",
      );
    expect(() => redeemPairing(f.store, "sample", "s", "wrong")).toThrow(
      "exhausted",
    );
    expect(readJSON(path).expires_at).toBe(expiry);
    expect(f.store.list()).toEqual([]);
  } finally {
    f.clean();
  }
});

test("cancelled in-flight poll cannot resurrect a window or send a code", async () => {
  const f = fixture();
  try {
    await beginPairing(
      f.store,
      "sample",
      "123456:secret",
      "s",
      undefined,
      f.factory,
    );
    let finish!: (rows: any[]) => void;
    const rows = new Promise<any[]>((resolve) => {
      finish = resolve;
    });
    let sends = 0;
    const polling = pollPairing(f.store, "sample", "s", () => ({
      call: async (method) => {
        if (method === "getUpdates") return rows;
        sends++;
        return {};
      },
    }));
    expect(cancelPairing(f.store, "sample", "s").status).toBe("cancelled");
    finish([
      {
        update_id: 1,
        message: {
          from: { id: 42 },
          chat: { id: 42, type: "private" },
          text: "/start",
        },
      },
    ]);
    expect((await polling).status).toBe("closed");
    expect(sends).toBe(0);
    expect(existsSync(join(f.root, "pairings/sample.json"))).toBe(false);
  } finally {
    f.clean();
  }
});

test("redemption during an in-flight code send closes the window without reviving other codes", async () => {
  const f = fixture();
  try {
    await beginPairing(
      f.store,
      "sample",
      "123456:secret",
      "s",
      undefined,
      f.factory,
    );
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let sentCode!: string;
    let started!: () => void;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let sends = 0;
    const polling = pollPairing(f.store, "sample", "s", () => ({
      call: async (method, params) => {
        if (method === "getUpdates")
          return [42, 43].map((id) => ({
            update_id: id,
            message: {
              from: { id },
              chat: { id, type: "private" },
              text: "/start",
            },
          }));
        sends++;
        sentCode = telegramView(params).text.match(
          /Pairing code: ([A-F0-9]+)/,
        )[1];
        started();
        await held;
        return {};
      },
    }));
    await sending;
    expect(redeemPairing(f.store, "sample", "s", sentCode).owner_id).toBe(42);
    finish();
    expect((await polling).status).toBe("closed");
    expect(sends).toBe(1);
    expect(existsSync(join(f.root, "pairings/sample.json"))).toBe(false);
  } finally {
    f.clean();
  }
});

test("two processes redeeming the same code commit exactly one binding", async () => {
  const f = fixture();
  try {
    await beginPairing(
      f.store,
      "sample",
      "123456:secret",
      "s",
      undefined,
      f.factory,
    );
    f.setUpdates([
      {
        update_id: 1,
        message: {
          from: { id: 42 },
          chat: { id: 42, type: "private" },
          text: "/start",
        },
      },
    ]);
    await pollPairing(f.store, "sample", "s", f.factory);
    const code = f.calls
      .find((c) => c.method === "sendRichMessage")
      .args.text.match(/Pairing code: ([A-F0-9]+)/)[1];
    const script = join(f.root, "redeem.ts");
    writeFileSync(
      script,
      `
      import { Store } from ${JSON.stringify(join(import.meta.dir, "../bun/state.ts"))};
      import { redeemPairing } from ${JSON.stringify(join(import.meta.dir, "../bun/pairing.ts"))};
      const start = Number(process.argv[2]);
      while (Date.now() < start) await Bun.sleep(1);
      try { redeemPairing(new Store(${JSON.stringify(f.root)}), "sample", "s", ${JSON.stringify(code)}); process.exit(0); }
      catch { process.exit(1); }
    `,
    );
    const barrier = String(Date.now() + 200);
    const processes = [0, 1].map(() =>
      Bun.spawn([process.execPath, script, barrier], {
        stdout: "ignore",
        stderr: "pipe",
      }),
    );
    const exits = await Promise.all(processes.map((p) => p.exited));
    expect(exits.sort()).toEqual([0, 1]);
    expect(f.store.read("sample").owner_id).toBe(42);
    expect(f.store.read("sample").thread_id).toBe("s");
    expect(existsSync(join(f.root, "pairings/sample.json"))).toBe(false);
  } finally {
    f.clean();
  }
});

test("an issued code cannot be redeemed after its window expires", async () => {
  const f = fixture();
  try {
    await beginPairing(
      f.store,
      "sample",
      "123456:secret",
      "s",
      undefined,
      f.factory,
    );
    f.setUpdates([
      {
        update_id: 1,
        message: {
          from: { id: 42 },
          chat: { id: 42, type: "private" },
          text: "/start",
        },
      },
    ]);
    await pollPairing(f.store, "sample", "s", f.factory);
    const code = f.calls
      .find((c) => c.method === "sendRichMessage")
      .args.text.match(/Pairing code: ([A-F0-9]+)/)[1];
    const path = join(f.root, "pairings/sample.json");
    atomic(path, { ...readJSON(path), expires_at: Date.now() - 1 });
    expect(() => redeemPairing(f.store, "sample", "s", code)).toThrow(
      "expired",
    );
    expect(f.store.list()).toEqual([]);
  } finally {
    f.clean();
  }
});
