// Real Codex MCP lifecycle; Telegram alone is stubbed. One harmless test turn; no user file changes.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store, atomic } from "../bun/state";
import { AppServer } from "../bun/appserver";
import { status, start, stop, pause, sleep, identity } from "../bun/process";
const root = mkdtempSync("/tmp/bridge-mcp-lifecycle-"),
  s = new Store(root),
  repo = resolve(import.meta.dir, "..");
s.configure(
  "probe",
  "123456:fixture",
  { id: 123456, username: "fixture" },
  1,
  "pending",
);
const config = join(s.instance("probe"), "config.json"),
  script = join(root, "server.ts");
writeFileSync(
  script,
  `
import {appendFileSync} from 'node:fs';
const log=(...args:any[])=>appendFileSync(${JSON.stringify(join(root, "worker.log"))},JSON.stringify(args)+'\\n');
console.error=log;
import {Store} from ${JSON.stringify(join(repo, "bun/state.ts"))};
import {Telegram} from ${JSON.stringify(join(repo, "bun/telegram.ts"))};
import {mcp} from ${JSON.stringify(join(repo, "bun/mcp.ts"))};
const s=new Store(${JSON.stringify(root)});
while(s.read('probe').thread_id==='pending') await Bun.sleep(50);
Telegram.prototype.call=async function(method,params){log(method,params);if(method==='getUpdates'){await Bun.sleep(100);return [];}return {message_id:1,chat:{id:1}}};
await mcp(s,'probe');
`,
);
const c = await AppServer.connect(undefined, 20000),
  ids: string[] = [],
  report: any = { root };
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await sleep(100);
  }
  throw Error(
    "Timeout: " +
      label +
      " " +
      JSON.stringify(status(s, "probe")) +
      " root=" +
      root,
  );
}
const options = {
  cwd: root,
  approvalPolicy: "never",
  sandbox: "read-only",
  config: {
    mcp_servers: { probe: { command: process.execPath, args: [script] } },
  },
};
try {
  const t = await c.call("thread/start", options);
  ids.push(t.thread.id);
  atomic(config, {
    ...s.read("probe"),
    thread_id: ids[0],
    lifecycle: "mcp",
    mcp_server: "probe",
    enabled: true,
    autostart: true,
    resume_options: options,
  });
  await until(
    () => status(s, "probe").health?.telegram?.status === "connected",
    "startup",
  );
  report.fresh_session_connected = true;
  await c.call("turn/start", {
    threadId: ids[0],
    input: [
      {
        type: "text",
        text: "Lifecycle integration test in an empty temporary directory. Reply only OK. Do not use tools or change files.",
      },
    ],
  });
  await sleep(1000);
  const first = status(s, "probe").process;
  report.initial_pid = first.pid;
  const other = await c.call("thread/start", options);
  ids.push(other.thread.id);
  await sleep(1000);
  if (status(s, "probe").process?.pid !== first.pid)
    throw Error("Other session stole receiver");
  report.wrong_session = await c.call("mcpServer/tool/call", {
    threadId: ids[1],
    server: "probe",
    tool: "connect",
    arguments: {},
  });
  if (!report.wrong_session.isError) throw Error("Other session allowed");
  const move = await c.call("mcpServer/tool/call", {
    threadId: ids[1], server: "probe", tool: "bind_bot",
    arguments: {expected_session: ids[0]},
  });
  if (move.isError) throw Error(JSON.stringify(move));
  await until(() => status(s,"probe").health?.thread_id === ids[1] && status(s,"probe").health?.telegram?.status === "connected", "rebind to second");
  if (status(s,"probe").process?.pid === first.pid) throw Error("Receiver did not move to target MCP");
  const revoked = await c.call("mcpServer/tool/call", {threadId: ids[0], server: "probe", tool: "send_text", arguments: {request_id: "revoked", text: "must not send"}});
  if (!revoked.isError) throw Error("Old session can still send");
  const back = await c.call("mcpServer/tool/call", {threadId: ids[0], server: "probe", tool: "bind_bot", arguments: {expected_session: ids[1]}});
  if (back.isError) throw Error(JSON.stringify(back));
  await until(() => status(s,"probe").process?.pid === first.pid && status(s,"probe").health?.telegram?.status === "connected", "rebind back");
  report.rebind_between_live_sessions = true;
  report.old_sender_revoked = true;
  await stop(s, "probe");
  await until(() => !status(s, "probe").process, "stop");
  if (!identity(first.pid)) throw Error("Stop killed MCP host");
  report.stop_preserved_mcp = true;
  await start(s, "probe");
  await until(
    () => status(s, "probe").health?.telegram?.status === "connected",
    "restart",
  );
  await pause(s, "probe");
  await until(() => !status(s, "probe").process, "pause");
  report.paused = true;
  await start(s, "probe", true);
  await until(
    () => status(s, "probe").health?.telegram?.status === "connected",
    "resume",
  );
  await c.call("thread/archive", { threadId: ids[0] });
  await until(() => !identity(first.pid), "archive");
  report.archived = true;
  await c.call("thread/unarchive", { threadId: ids[0] });
  await c.resume(ids[0], options);
  await until(
    () =>
      status(s, "probe").health?.telegram?.status === "connected" &&
      status(s, "probe").process?.pid !== first.pid,
    "session resume",
  );
  report.resumed_pid = status(s, "probe").process.pid;
  // Abrupt host death must close receiver; next native reload can recreate MCP.
  await c.call("thread/archive", { threadId: ids[0] });
  await until(() => !status(s, "probe").process, "second archive");
  report.resumed_then_stopped = true;
  atomic(join(root, "evidence.json"), report);
  console.log(JSON.stringify(report));
} finally {
  for (const id of ids)
    try {
      await c.call("thread/archive", { threadId: id });
    } catch {}
  c.close();
}
