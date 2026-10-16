// Real Codex sessions, MCP metadata, native plugin registration and receiver lifecycle.
// Only Telegram HTTP is stubbed; no production tokens or instances are used.
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store, atomic, readJSON } from "../bun/state";
import { AppServer } from "../bun/appserver";
import { uninstall, refresh } from "../bun/install";
import { status, sleep } from "../bun/process";
const root = mkdtempSync("/tmp/bridge-manager-probe-"),
  store = new Store(root);
const repo = resolve(import.meta.dir, ".."),
  receiver = join(root, "receiver.ts"),
  manager = join(root, "manager.ts");
writeFileSync(
  receiver,
  `
import { Store } from ${JSON.stringify(join(repo, "bun/state.ts"))};
import { Telegram } from ${JSON.stringify(join(repo, "bun/telegram.ts"))};
import { mcp } from ${JSON.stringify(join(repo, "bun/mcp.ts"))};
Telegram.prototype.call=async function(method) { if(method==='getUpdates') { await Bun.sleep(100); return []; } return { message_id:1,chat:{id:42} }; };
await mcp(new Store(${JSON.stringify(root)}),'sample');
`,
);
writeFileSync(
  manager,
  `
import { StdioServerTransport } from ${JSON.stringify(join(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"))};
import { Store,readJSON,atomic } from ${JSON.stringify(join(repo, "bun/state.ts"))};
import { Telegram } from ${JSON.stringify(join(repo, "bun/telegram.ts"))};
import { managementServer } from ${JSON.stringify(join(repo, "bun/manager.ts"))};
import { install,uninstall,codex } from ${JSON.stringify(join(repo, "bun/install.ts"))};
import {join} from 'node:path';
const root=${JSON.stringify(root)}, store=new Store(root);
Telegram.prototype.call=async function(method,params) {
 if(method==='getMe') return {id:123456,username:'fixture_bot',is_bot:true};
 if(method==='getWebhookInfo') return {};
 if(method==='getUpdates') return [{update_id:1,message:{from:{id:42,is_bot:false,first_name:'Fixture'},chat:{id:42,type:'private'},text:'/start'}}];
 if(method==='sendMessage') { if(params.text.startsWith('Pairing code:')) atomic(join(root,'code.json'),{code:params.text.match(/Pairing code: ([A-F0-9]+)/)[1]}); return {message_id:1,chat:{id:42}}; }
 throw Error('Unexpected Telegram method');
};
const runner=async (...args:string[])=>{
 if(args[0]==='add') {
  const selector=args[1].split('@')[0],path=join(root,'plugins',selector,'plugins',selector,'.mcp.json'),manifest=readJSON(path);
  for(const server of Object.values(manifest.mcpServers) as any[]) server.args=[${JSON.stringify(receiver)}];
  atomic(path,manifest);
 }
 return codex(...args);
};
await managementServer(store,{install:(s,n)=>install(s,n,true,runner),uninstall:(s,n)=>uninstall(s,n,false,runner)}).connect(new StdioServerTransport());
`,
);
const c = await AppServer.connect(undefined, 30000),
  ids: string[] = [],
  evidence: any = { root };
const options = {
  cwd: root,
  approvalPolicy: "never",
  sandbox: "read-only",
  config: {
    mcp_servers: {
      manager_probe: { command: process.execPath, args: [manager] },
    },
  },
};
async function call(id: string, tool: string, args: any = {}, error = false) {
  const r = await c.call("mcpServer/tool/call", {
    threadId: id,
    server: "manager_probe",
    tool,
    arguments: args,
  });
  if (Boolean(r.isError) !== error)
    throw Error(tool + ": " + JSON.stringify(r));
  return error ? r : JSON.parse(r.content[0].text);
}
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(100);
  }
  throw Error("Timeout: " + label);
}
try {
  for (let i = 0; i < 2; i++)
    ids.push((await c.call("thread/start", options)).thread.id);
  await sleep(500);
  if ((await call(ids[0]!, "list_bots")).bots.length)
    throw Error("Nonempty fixture");
  await call(ids[0]!, "add_bot", {
    instance: "sample",
    token: "123456:fixture",
  });
  await call(ids[1]!, "check_pairing", { instance: "sample" }, true);
  const paired = await call(ids[0]!, "check_pairing", { instance: "sample" });
  await until(() => existsSync(join(root, "code.json")), "pairing code");
  const configured = await call(ids[0]!, "confirm_pairing", {
    instance: "sample",
    code: readJSON(join(root, "code.json")).code,
  });
  evidence.installation = configured.installation;
  if (store.read("sample").thread_id !== ids[0])
    throw Error("Caller identity not used");
  evidence.pairing_metadata = true;
  // Materialize harmless fixture sessions so archive/resume can load the new plugin.
  for (const id of ids) {
    await c.call("turn/start", {
      threadId: id,
      input: [
        {
          type: "text",
          text: "Isolated bridge lifecycle fixture. Reply OK only; no tools or file changes.",
        },
      ],
    });
    await sleep(1500);
    await c.call("thread/archive", { threadId: id });
    await c.call("thread/unarchive", { threadId: id });
    await c.call("thread/resume", { ...options, threadId: id });
  }
  await until(
    () => status(store, "sample").health?.telegram?.status === "connected",
    "initial receiver",
  );
  await call(ids[1]!, "bind_bot", {
    instance: "sample",
    expected_session: ids[0],
  });
  await until(
    () =>
      status(store, "sample").health?.thread_id === ids[1] &&
      status(store, "sample").health?.telegram?.status === "connected",
    "rebind receiver",
  );
  evidence.rebound = true;
  await call(
    ids[0]!,
    "bind_bot",
    { instance: "sample", expected_session: ids[0] },
    true,
  );
  evidence.stale_write_rejected = true;
  await c.call("thread/archive", { threadId: ids[1] });
  await call(ids[0]!, "bind_bot", {
    instance: "sample",
    expected_session: ids[1],
  });
  await until(
    () =>
      status(store, "sample").health?.thread_id === ids[0] &&
      status(store, "sample").health?.telegram?.status === "connected",
    "take over archived session",
  );
  evidence.archived_session_takeover = true;
  await call(ids[0]!, "unbind_bot", {
    instance: "sample",
    expected_session: ids[0],
  });
  if (
    store.token("sample") !== "123456:fixture" ||
    store.read("sample").thread_id !== null
  )
    throw Error("Unbind lost credentials");
  evidence.unbound = true;
  await call(ids[0]!, "remove_bot", {
    instance: "sample",
    expected_session: null,
    confirm: "REMOVE_BOT",
  });
  if ((await call(ids[0]!, "list_bots")).bots.length)
    throw Error("Bot not removed");
  evidence.manager_survived_removal = true;
  atomic(join(root, "evidence.json"), evidence);
  console.log(JSON.stringify(evidence));
} finally {
  if (store.list().length)
    try {
      await uninstall(store, "sample");
    } catch (e) {
      console.error(String(e));
    }
  for (const id of ids)
    try {
      await c.call("thread/archive", { threadId: id });
    } catch {}
  c.close();
  await refresh();
}
