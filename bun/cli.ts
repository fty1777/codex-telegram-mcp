import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { marketplacePlugin, rescuePlugin } from "./plugin-identity";
import { Store } from "./state";
import { AppServer } from "./appserver";
import { Sender } from "./telegram";
import { start, stop, pause, status } from "./process";
import { uninstall, rollback } from "./install";
import { configure } from "./setup";
import { mcp } from "./mcp";
import { diagnostic } from "./engine";
import { listBots, changeBinding } from "./management";
import { channel, prepareSharedPlugin } from "./channel";
import { manager } from "./manager";
import { installManager, uninstallManager } from "./manager-install";
import {
  beginPairing,
  pollPairing,
  watchPairing,
  pairingStatus,
  completePairing,
  cancelPairing,
} from "./pairing";
import { readFileSync } from "node:fs";
import { hooks } from "./diagnostics";
import { updatePlugin } from "./update";
import { HandoffBlocked, assertHandoffTarget } from "./handoff";
export async function main(argv = process.argv.slice(2)) {
  const { values: v, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "data-dir": { type: "string" },
      "plugin-root": { type: "string" },
      endpoint: { type: "string" },
      instance: { type: "string" },
      "keep-config": { type: "boolean" },
      "no-start": { type: "boolean" },
      "request-id": { type: "string" },
      text: { type: "string" },
      file: { type: "string" },
      photo: { type: "boolean" },
      caption: { type: "string" },
      "reply-to": { type: "string" },
      "edit-id": { type: "string" },
      session: { type: "string" },
      activate: { type: "boolean" },
      "token-file": { type: "string" },
      code: { type: "string" },
    },
  });
  const command = p[0],
    name = v.instance ?? p[1] ?? "default",
    s = new Store(v["data-dir"]);
  let result: any;
  switch (command) {
    case "update":
      result = await updatePlugin(s, { session: v.session ?? process.env.CODEX_THREAD_ID, endpoint: v.endpoint });
      break;
    case "plugin": {
      if (!v["plugin-root"]) throw Error("--plugin-root is required");
      await channel(s, marketplacePlugin(v["plugin-root"]));
      return;
    }
    case "channel":
      await channel(s);
      return;
    case "manager":
      await manager(s);
      return;
    case "install-plugin":
    case "install-manager":
      result = await installManager(s);
      break;
    case "uninstall-plugin":
    case "uninstall-manager":
      result = await uninstallManager(s);
      break;
    case "pair-begin":
    case "pair-check":
    case "pair-status":
    case "pair-watch":
    case "pair-confirm":
    case "pair-cancel": {
      const session = v.session ?? process.env.CODEX_THREAD_ID;
      if (!session) throw Error("--session is required for rescue pairing");
      if (command === "pair-begin") {
        if (!v["token-file"])
          throw Error(
            "--token-file is required; do not put credentials in shell arguments",
          );
        result = await beginPairing(
          s,
          name,
          readFileSync(v["token-file"], "utf8").trim(),
          session,
          v.endpoint,
        );
      } else if (command === "pair-status") result = pairingStatus(s, name, session);
      else if (command === "pair-watch") {
        const controller = new AbortController();
        const abort = () => controller.abort();
        process.on("SIGINT", abort);
        process.on("SIGTERM", abort);
        try { result = await watchPairing(s, name, session, controller.signal); }
        finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
      } else if (command === "pair-check")
        result = await pollPairing(s, name, session);
      else if (command === "pair-cancel")
        result = cancelPairing(s, name, session);
      else {
        result = await completePairing(
          s,
          name,
          session,
          String(v["code"] ?? ""),
          async () => {
            await prepareSharedPlugin(s, name, rescuePlugin(s, name, v["plugin-root"], dirname(import.meta.path)));
            return start(s, name, true);
          },
        );
      }
      break;
    }
    case "install":
      result = await installManager(s);
      if (v.instance || p[1]) {
        if (!existsSync(join(s.instance(name), "config.json")))
          await configure(s, name, v.endpoint);
        await prepareSharedPlugin(s, name);
        result.connection = await start(s, name, true);
      }
      break;
    case "configure":
      await configure(s, name, v.endpoint);
      return;
    case "uninstall":
      result = await uninstall(s, name, v["keep-config"]);
      break;
    case "rollback":
      result = await rollback(s, name);
      break;
    case "start":
      if (v["plugin-root"]) await prepareSharedPlugin(s, name, marketplacePlugin(v["plugin-root"]), false);
      result = await start(s, name);
      break;
    case "resume":
      if (v["plugin-root"]) await prepareSharedPlugin(s, name, marketplacePlugin(v["plugin-root"]), false);
      result = await start(s, name, true);
      break;
    case "stop":
      result = await stop(s, name);
      break;
    case "pause":
      result = await pause(s, name);
      break;
    case "status":
      result = status(s, name);
      break;
    case "list":
      result = listBots(s);
      break;
    case "bind": {
      const target = v.session ?? process.env.CODEX_THREAD_ID;
      if (!target)
        throw Error(
          "Use --session SESSION_ID for rescue binding; agents should use bind_bot",
        );
      if (v["plugin-root"]) await assertHandoffTarget(s, name, marketplacePlugin(v["plugin-root"]), target);
      result = await changeBinding(
        s,
        name,
        target,
        s.read(name).thread_id ?? null,
        v.activate,
      );
      if (v["plugin-root"]) await prepareSharedPlugin(s, name, marketplacePlugin(v["plugin-root"]), false);
      if (s.read(name).enabled) result.connection = await start(s, name);
      break;
    }
    case "unbind":
      result = await changeBinding(
        s,
        name,
        null,
        s.read(name).thread_id ?? null,
      );
      break;
    case "mcp":
      await mcp(s, name);
      return;
    case "doctor": {
      const c = await AppServer.connect(v.endpoint);
      try {
        result = {
          app_server: "connected",
          runtime: "bun",
          bun: Bun.version,
          bun_executable: process.execPath,
          codex_executable: Bun.which("codex"),
          git_executable: Bun.which("git"),
          platform: process.platform,
          server: c.serverInfo,
          ...(v.instance
            ? {
                instance: status(s, name),
                session_hooks: await hooks(c, s.read(name)),
              }
            : {}),
        };
      } finally {
        c.close();
      }
      break;
    }
    case "send":
    case "delivery-status": {
      if (!v["request-id"]) throw Error("--request-id is required");
      const sender = new Sender(s, name);
      try {
        result =
          command === "delivery-status"
            ? sender.journal.status("out", v["request-id"])
            : await sender.send(v["request-id"], {
                text: v.text,
                file: v.file,
                kind: v.photo ? "photo" : "document",
                caption: v.caption,
                reply_to: v["reply-to"] ? Number(v["reply-to"]) : undefined,
                edit_id: v["edit-id"] ? Number(v["edit-id"]) : undefined,
              });
      } finally {
        sender.journal.close();
      }
      break;
    }
    default:
      throw Error(
        "Commands: update, install-manager, uninstall-manager, pair-begin, pair-check, pair-status, pair-watch, pair-confirm, pair-cancel, bind, unbind, install, configure, start, stop, pause, resume, status, doctor, list, send, delivery-status, uninstall, rollback",
      );
  }
  console.log(JSON.stringify(result));
}
if (import.meta.main)
  main().catch((e) => {
    if (e instanceof HandoffBlocked) console.log(JSON.stringify(e.result));
    else console.error(diagnostic(e instanceof Error ? e.message : e));
    process.exitCode = 1;
  });
