import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
export const now = () => Date.now() / 1000;
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
// Preserve Python json.dumps(sort_keys=True, ensure_ascii=False) fingerprints on upgrades.
export function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(", ") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ": " + canonical(value[k]))
        .join(", ") +
      "}"
    );
  return JSON.stringify(value);
}
// Match legacy diagnostic rendering without sorting object keys.
export function legacyJSON(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(legacyJSON).join(", ") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .map((k) => JSON.stringify(k) + ": " + legacyJSON(value[k]))
        .join(", ") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export function privateDir(path: string) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw Error("State directory must not be a symlink");
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
export function atomic(path: string, value: any) {
  privateDir(dirname(path));
  const tmp = join(dirname(path), "." + randomUUID());
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    const d = openSync(dirname(path), "r");
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
export function readJSON(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}
export class Store {
  root: string;
  constructor(root = join(homedir(), ".local/share/codex-telegram")) {
    this.root = resolve(root);
  }
  instance(name: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name))
      throw Error("Invalid instance name");
    const p = join(this.root, "instances", name);
    for (const dir of [this.root, join(this.root, "instances"), p])
      if (existsSync(dir) && lstatSync(dir).isSymbolicLink())
        throw Error("State directories must not be symlinks");
    return p;
  }
  read(name: string) {
    return readJSON(join(this.instance(name), "config.json"));
  }
  token(name: string): string {
    return readJSON(join(this.instance(name), "credential.json")).token;
  }
  list(): any[] {
    const p = join(this.root, "instances");
    return existsSync(p)
      ? readdirSync(p)
          .sort()
          .filter((n) => existsSync(join(p, n, "config.json")))
          .map((n) => this.read(n))
      : [];
  }
  configure(
    name: string,
    token: string,
    bot: any,
    owner: number,
    thread: string,
    endpoint?: string,
  ) {
    const p = this.instance(name);
    if (existsSync(join(p, "config.json")))
      throw Error("Instance already configured");
    if (
      !/^\d+:[\w-]+$/.test(token) ||
      !Number.isSafeInteger(owner) ||
      owner <= 0
    )
      throw Error("Invalid credentials");
    privateDir(p);
    for (const dir of ["inbox", "outgoing"]) privateDir(join(p, dir));
    atomic(join(p, "credential.json"), { token });
    atomic(join(p, "config.json"), {
      schema: 1,
      name,
      bot_id: bot.id,
      username: bot.username,
      owner_id: owner,
      thread_id: thread,
      endpoint: endpoint ?? null,
      delivery_mode: "steer",
      enabled: true,
    });
    return this.read(name);
  }
}
export class Journal {
  db: Database;
  constructor(path: string) {
    privateDir(path);
    const file = join(path, "delivery.sqlite3");
    closeSync(openSync(file, "a", 0o600));
    this.db = new Database(file);
    this.db.exec(`PRAGMA busy_timeout=15000; PRAGMA synchronous=FULL;
  CREATE TABLE IF NOT EXISTS delivery(direction TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,details TEXT NOT NULL,updated REAL NOT NULL,PRIMARY KEY(direction,key));
  CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0);`);
  }
  fingerprint(v: any) {
    return hash(canonical(v));
  }
  decode(row: any) {
    return row
      ? { status: row.status, details: JSON.parse(row.details) }
      : { status: "not_found", details: {} };
  }
  begin(direction: string, key: string, payload: any): [boolean, any] {
    if (!["in", "out"].includes(direction) || !key || key.length > 200)
      throw Error("Invalid delivery identity");
    return this.db
      .transaction(() => {
        const fp = this.fingerprint(payload);
        const row: any = this.db
          .query("SELECT * FROM delivery WHERE direction=? AND key=?")
          .get(direction, key);
        if (row) {
          if (row.fingerprint !== fp)
            throw Error("Request ID already belongs to different content");
          return [false, this.decode(row)] as [boolean, any];
        }
        this.db
          .query("INSERT INTO delivery VALUES(?,?,?,?,?,?)")
          .run(direction, key, fp, "unknown", "{}", now());
        return [true, { status: "unknown", details: {} }] as [boolean, any];
      })
      .immediate();
  }
  finish(direction: string, key: string, status: string, details: any) {
    if (
      !["sent", "accepted", "rejected", "unknown", "handled"].includes(
        status,
      ) &&
      !(
        direction === "in" &&
        ["reply_unknown", "reply_rejected"].includes(status)
      )
    )
      throw Error("Invalid delivery status");
    if (
      this.db
        .query(
          "UPDATE delivery SET status=?,details=?,updated=? WHERE direction=? AND key=?",
        )
        .run(status, JSON.stringify(details), now(), direction, key).changes !==
      1
    )
      throw Error("Delivery was not reserved");
    return { status, details };
  }
  status(direction: string, key: string) {
    return this.decode(
      this.db
        .query("SELECT * FROM delivery WHERE direction=? AND key=?")
        .get(direction, key),
    );
  }
  put(key: string, value: any) {
    this.db
      .query("INSERT OR REPLACE INTO metadata VALUES(?,?)")
      .run(key, JSON.stringify(value));
  }
  get(key: string, fallback: any = null): any {
    const r: any = this.db
      .query("SELECT value FROM metadata WHERE key=?")
      .get(key);
    return r ? JSON.parse(r.value) : fallback;
  }
  enqueue(updates: any[], offset: number) {
    this.db
      .transaction(() => {
        for (const u of updates) {
          const payload = canonical(u);
          const old: any = this.db
            .query("SELECT payload FROM inbox WHERE id=?")
            .get(u.update_id);
          if (old && canonical(JSON.parse(old.payload)) !== payload)
            throw Error("Telegram update ID changed content");
          this.db
            .query("INSERT OR IGNORE INTO inbox(id,payload) VALUES(?,?)")
            .run(u.update_id, payload);
          const group = u.message?.media_group_id;
          if (group && !old) {
            this.db
              .query("INSERT OR IGNORE INTO metadata VALUES(?,?)")
              .run("album_first:" + group, JSON.stringify(now()));
            this.put("album_last:" + group, now());
          }
        }
        this.put("telegram_offset", offset);
      })
      .immediate();
  }
  pending(limit = 100): any[] {
    return this.db
      .query("SELECT payload FROM inbox WHERE done=0 ORDER BY id LIMIT ?")
      .all(limit)
      .map((r: any) => JSON.parse(r.payload));
  }
  handled(ids: number[]) {
    this.db
      .transaction(() => {
        for (const id of ids)
          this.db.query("UPDATE inbox SET done=1 WHERE id=?").run(id);
        this.db.query("DELETE FROM metadata WHERE key=?").run("active_batch");
      })
      .immediate();
  }
  readyBatch() {
    const active = this.get("active_batch");
    if (active) return active;
    const rows = this.pending();
    if (!rows.length) return [];
    const group = rows[0].message?.media_group_id;
    if (
      group &&
      now() - this.get("album_last:" + group, now()) < 2 &&
      now() - this.get("album_first:" + group, now()) < 5
    )
      return [];
    const batch = group
      ? rows.filter((r) => r.message?.media_group_id === group)
      : rows.slice(0, 1);
    this.put("active_batch", batch);
    return batch;
  }
  /** Call only after the old receiver has stopped. Preserve pending evidence,
   * but never submit an old session's queue to the next binding. */
  holdPending(thread: string) {
    return this.db
      .transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS held_inbox(
        id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL,
        payload TEXT NOT NULL, held_at REAL NOT NULL)`);
        const count = this.db
          .query("SELECT count(*) AS count FROM inbox WHERE done=0")
          .get() as { count: number };
        this.db
          .query(
            `INSERT OR IGNORE INTO held_inbox(id,thread_id,payload,held_at)
        SELECT id,?,payload,? FROM inbox WHERE done=0`,
          )
          .run(thread, now());
        this.db.exec("UPDATE inbox SET done=1 WHERE done=0");
        this.db
          .query(
            "DELETE FROM metadata WHERE key IN ('active_batch','active_turn','history_initialized')",
          )
          .run();
        // Keep Telegram offset and every delivery receipt, including unknown sends.
        return { held: count.count, thread_id: thread };
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
}
