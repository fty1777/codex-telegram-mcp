import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomBytes } from "node:crypto";
import { Store, Journal } from "./state";
import { AppServer } from "./appserver";
import { Telegram } from "./telegram";
export async function ask(prompt: string) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}
export async function secret(prompt: string): Promise<string> {
  if (!stdin.isTTY) throw Error("Token entry requires an interactive terminal");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let input = "";
    const done = (error?: Error) => {
      stdin.off("data", data);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      error ? reject(error) : resolve(input.trim());
    };
    const data = (chunk: Buffer) => {
      for (const ch of chunk.toString()) {
        if (ch === "\u0003") {
          done(Error("Cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          done();
          return;
        }
        if (ch === "\u007f") input = input.slice(0, -1);
        else if (ch >= " ") input += ch;
      }
    };
    stdin.on("data", data);
  });
}
export async function configure(s: Store, n: string, endpoint?: string) {
  const token = await secret("BotFather token (hidden): "),
    api = new Telegram(token);
  const bot = await api.call("getMe", {});
  if (!bot.is_bot || !bot.username) throw Error("Invalid bot token");
  if (s.list().some((c) => c.bot_id === bot.id))
    throw Error("Bot already configured");
  if ((await api.call("getWebhookInfo", {})).url)
    throw Error(
      "Bot has an existing webhook; remove the old integration first",
    );
  const client = await AppServer.connect(endpoint);
  try {
    let thread: string | undefined;
    const current = process.env.CODEX_THREAD_ID;
    if (current) {
      try {
        const t = (
          await client.call("thread/read", {
            threadId: current,
            includeTurns: false,
          })
        ).thread;
        if (
          ["", "y", "yes"].includes(
            (
              await ask(
                `Bind current session (${t.name || t.preview || current})? [Y/n] `,
              )
            ).toLowerCase(),
          )
        )
          thread = current;
      } catch {}
    }
    if (!thread) {
      const rows = (
        await client.call("thread/list", { limit: 30, archived: false })
      ).data;
      if (!rows.length) throw Error("Create a Codex session first");
      rows.forEach((t: any, i: number) =>
        console.log(
          `${i + 1}. ${String(t.name || t.preview || "Untitled").slice(0, 100)} — ${t.cwd ?? ""}`,
        ),
      );
      while (!thread) {
        const choice = Number(await ask("Choose session number: "));
        if (Number.isInteger(choice) && choice >= 1 && choice <= rows.length)
          thread = rows[choice - 1].id;
      }
    }
    const nonce = randomBytes(24).toString("base64url");
    console.log(
      `Open https://t.me/${bot.username}?start=${nonce} and press Start.`,
    );
    let offset: number | undefined;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const rows = await api.call(
        "getUpdates",
        {
          timeout: 2,
          allowed_updates: ["message"],
          ...(offset !== undefined ? { offset } : {}),
        },
        6000,
      );
      for (const u of rows) {
        offset = Math.max(offset ?? 0, u.update_id + 1);
        const m = u.message,
          owner = m?.from?.id;
        if (
          m?.chat?.type !== "private" ||
          !Number.isSafeInteger(owner) ||
          owner <= 0 ||
          m.from.is_bot ||
          owner !== m.chat.id ||
          m.text !== "/start " + nonce
        )
          continue;
        if (
          ["y", "yes"].includes(
            (
              await ask(
                `Pair Telegram user ${m.from.username || m.from.first_name} (${owner})? [y/N] `,
              )
            ).toLowerCase(),
          )
        ) {
          s.configure(n, token, bot, owner, thread!, endpoint);
          const j = new Journal(s.instance(n));
          j.put("telegram_offset", offset);
          j.close();
          console.log(
            `Paired @${bot.username}; only your private account is allowed.`,
          );
          return;
        }
      }
    }
    throw Error("Pairing expired; no user authorized");
  } finally {
    client.close();
  }
}
