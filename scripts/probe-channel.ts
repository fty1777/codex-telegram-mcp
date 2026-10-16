// Single native plugin, real session-owned MCP processes; Telegram HTTP alone is stubbed.
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store, atomic, readJSON } from "../bun/state";
import { installManager, uninstallManager } from "../bun/manager-install";
import { codex, refresh } from "../bun/install";
import { AppServer } from "../bun/appserver";
import { status, sleep } from "../bun/process";
const root = mkdtempSync("/tmp/bridge-channel-probe-"),
  store = new Store(root),
  repo = resolve(import.meta.dir, ".."),
  script = join(root, "server.ts");
writeFileSync(
  script,
  `
import {existsSync} from 'node:fs';
import {Store,readJSON,atomic} from ${JSON.stringify(join(repo, "bun/state.ts"))};
import {Telegram} from ${JSON.stringify(join(repo, "bun/telegram.ts"))};
import {channel} from ${JSON.stringify(join(repo, "bun/channel.ts"))};
const root=${JSON.stringify(root)};
Telegram.prototype.call=async function(method,params){
 const id=Number(this.token.split(':')[0]);
 if(method==='sendMessage' && params.text.startsWith('Pairing code:')) atomic(root+'/code-'+id+'.json',{code:params.text.match(/Pairing code: ([A-F0-9]+)/)[1]});
 if(method==='getMe') return {id,username:'fixture_'+id,is_bot:true};
 if(method==='getWebhookInfo') return {};
 if(method==='getUpdates'){
  await Bun.sleep(100);
  const path=root+'/pairings/'+(id===123456?'one':'two')+'.json';
  if(params.timeout===2&&existsSync(path)) return [{update_id:1,message:{from:{id:42,is_bot:false},chat:{id:42,type:'private'},text:'/start'}}];
  return [];
 }
 return {message_id:1,chat:{id:42}};
};
await channel(new Store(root));
`,
);
const runner = async (...args: string[]) => {
  if (args[0] === "add") {
    const selector = args[1]!.split("@")[0]!,
      path = join(root, "plugins", selector, "plugins", selector, ".mcp.json"),
      m = readJSON(path);
    for (const server of Object.values(m.mcpServers) as any[])
      server.args = [script];
    atomic(path, m);
  }
  return codex(...args);
};
const c = await AppServer.connect(undefined, 30000),
  ids: string[] = [],
  evidence: any = { root };
async function tool(id: string, name: string, args: any = {}, error = false) {
  const r = await c.call("mcpServer/tool/call", {
    threadId: id,
    server: "telegram",
    tool: name,
    arguments: args,
  });
  if (Boolean(r.isError) !== error)
    throw Error(name + ": " + JSON.stringify(r));
  return error ? r : JSON.parse(r.content[0].text);
}
async function until(fn: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await sleep(100);
  }
  throw Error("Timeout " + label);
}
try {
  await installManager(store, runner);
  await refresh();
  for (let i = 0; i < 2; i++)
    ids.push(
      (
        await c.call("thread/start", {
          cwd: root,
          approvalPolicy: "never",
          sandbox: "read-only",
        })
      ).thread.id,
    );
  await sleep(500);
  for (const [i, name] of ["one", "two"].entries()) {
    await tool(ids[0]!, "add_bot", {
      instance: name,
      token: `${123456 + i}:fixture`,
    });
    await tool(ids[0]!, "check_pairing", { instance: name });
    await until(
      () => existsSync(join(root, "code-" + (123456 + i) + ".json")),
      "pairing code received",
    );
    const confirmed = await tool(ids[0]!, "confirm_pairing", {
      instance: name,
      code: readJSON(join(root, "code-" + (123456 + i) + ".json")).code,
    });
    if (confirmed.installation.status !== "connecting")
      throw Error("New bot required reload");
    await until(
      () => status(store, name).health?.telegram?.status === "connected",
      name + " started",
    );
  }
  if (status(store, "one").process.pid !== status(store, "two").process.pid)
    throw Error("Bots not sharing session host");
  evidence.two_bots_one_host = true;
  const firstPid = status(store, "two").process.pid;
  await tool(ids[1]!, "bind_bot", {
    instance: "one",
    expected_session: ids[0],
  });
  await until(
    () =>
      status(store, "one").health?.thread_id === ids[1] &&
      status(store, "one").health?.telegram?.status === "connected",
    "rebound",
  );
  if (status(store, "two").process.pid !== firstPid)
    throw Error("Other bot disturbed");
  evidence.isolated_rebind = true;
  await tool(
    ids[0]!,
    "send_text",
    { instance: "one", request_id: "old-session", text: "fixture" },
    true,
  );
  await tool(ids[1]!, "send_text", {
    instance: "one",
    request_id: "new-session",
    text: "fixture",
  });
  evidence.sender_authorization = true;
  await tool(ids[0]!, "remove_bot", {
    instance: "two",
    expected_session: ids[0],
    confirm: "REMOVE_BOT",
  });
  if ((await tool(ids[0]!, "list_bots")).bots.length !== 1)
    throw Error("Remove incorrect");
  if (!status(store, "one").process)
    throw Error("Removing sibling stopped receiver");
  await tool(ids[1]!, "remove_bot", {
    instance: "one",
    expected_session: ids[1],
    confirm: "REMOVE_BOT",
  });
  if ((await tool(ids[0]!, "list_bots")).bots.length !== 0)
    throw Error("Last bot retained");
  evidence.manager_survived_last_removal = true;
  const installed = (await runner("list")).installed.filter(
    (p: any) =>
      p.pluginId ===
      readJSON(join(root, "manager-installation.json")).plugin_id,
  );
  if (installed.length !== 1) throw Error("Plugin missing");
  evidence.single_plugin = true;
  atomic(join(root, "evidence.json"), evidence);
  console.log(JSON.stringify(evidence));
} finally {
  for (const id of ids)
    try {
      await c.call("thread/archive", { threadId: id });
    } catch {}
  await uninstallManager(store, runner);
  c.close();
  await refresh();
}
