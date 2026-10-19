import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  chmodSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { Journal, Store, hash, privateDir } from "./state";
import { messages, type MessageSource, type TextFormat } from "./format";
import { elapsedSeconds } from "./timing";
import { turnUsage } from "./usage";
export class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
function transportDetail(error: unknown, token: string) {
  const e = error as any;
  return [e?.name, e?.code, e?.message, e?.cause?.code, e?.cause?.message]
    .filter(Boolean)
    .map(String)
    .join(": ")
    .replaceAll(token, "[redacted]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .slice(0, 1000);
}
export function within(path: string, root: string) {
  const rel = relative(root, path);
  return (
    rel !== "" && !rel.startsWith("../") && rel !== ".." && !rel.startsWith("/")
  );
}
export class Telegram {
  controllers = new Set<AbortController>();
  private abortGeneration = 0;
  constructor(
    readonly token: string,
    readonly base = "https://api.telegram.org",
    readonly localDir?: string,
  ) {
    if (localDir) {
      const u = new URL(base);
      if (
        u.protocol !== "http:" ||
        !["127.0.0.1", "[::1]"].includes(u.hostname) ||
        u.username ||
        u.password ||
        u.pathname !== "/" ||
        u.search ||
        u.hash
      )
        throw Error("Local Bot API must use loopback HTTP");
    } else if (base !== "https://api.telegram.org")
      throw Error("Custom Bot API requires local directory");
  }
  static forInstance(store: Store, name: string) {
    const c = store.read(name).telegram_api ?? {};
    return c.mode === "local"
      ? new Telegram(store.token(name), c.base_url, c.directory)
      : new Telegram(store.token(name));
  }
  checkSize(size: number) {
    if (!this.localDir && size > 20 * 1024 * 1024)
      throw Error(
        "Telegram cloud downloads are limited to 20 MB; optional local Bot API supports larger files.",
      );
  }
  abort() {
    this.abortGeneration++;
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
  }
  async call(
    method: string,
    params: any,
    timeout = 10000,
    upload?: { field: string; path: string; name: string },
  ): Promise<any> {
    // Retry only side-effect-free metadata reads. Polling has its own loop;
    // sends must retain their unknown-delivery semantics.
    const generation = this.abortGeneration;
    const attempts = ["getMe", "getWebhookInfo", "getFile"].includes(method)
      ? 3
      : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.callOnce(method, params, timeout, upload);
      } catch (error) {
        if (
          attempt >= attempts ||
          error instanceof TelegramError ||
          generation !== this.abortGeneration
        )
          throw error;
        await Bun.sleep(250 * attempt);
        if (generation !== this.abortGeneration) throw error;
      }
    }
  }
  private async callOnce(
    method: string,
    params: any,
    timeout: number,
    upload?: { field: string; path: string; name: string },
  ): Promise<any> {
    const started = Date.now();
    const ctrl = new AbortController();
    this.controllers.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      let body: BodyInit,
        headers: Record<string, string> = {};
      if (upload) {
        const form = new FormData();
        for (const [k, v] of Object.entries(params))
          form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
        form.append(upload.field, Bun.file(upload.path), upload.name);
        body = form;
      } else {
        body = JSON.stringify(params);
        headers["Content-Type"] = "application/json";
      }
      const response = await fetch(
        this.base + "/bot" + this.token + "/" + method,
        { method: "POST", headers, body, signal: ctrl.signal },
      );
      const result: any = await response.json();
      if (result?.ok === false)
        throw new TelegramError(
          result.error_code,
          String(result.description).replaceAll(this.token, "[redacted]"),
        );
      if (result?.ok !== true) throw Error("Invalid response");
      return result.result;
    } catch (e) {
      if (e instanceof TelegramError) throw e;
      throw Error(
        `Telegram ${method} failed after ${Date.now() - started}ms (timeout ${timeout}ms); ` +
          (["getUpdates", "getFile", "getMe", "getWebhookInfo"].includes(method)
            ? "poll/read failed"
            : "delivery unknown") +
          ": " +
          transportDetail(e, this.token),
      );
    } finally {
      clearTimeout(timer);
      this.controllers.delete(ctrl);
    }
  }
  async download(id: string, inbox: string, suffix = ".bin") {
    const info = await this.call(
      "getFile",
      { file_id: id },
      this.localDir ? 600000 : 30000,
    );
    const remote = info.file_path;
    this.checkSize(info.file_size ?? 0);
    if (typeof remote !== "string" || !remote) throw Error("Invalid file path");
    let local: string | undefined;
    if (this.localDir) {
      local = realpathSync(remote);
      if (
        !within(local, realpathSync(this.localDir)) ||
        !statSync(local).isFile()
      )
        throw Error("File outside local API directory");
    } else if (remote.startsWith("/") || remote.split("/").includes(".."))
      throw Error("Invalid file path");
    const ext = extname(remote).toLowerCase();
    privateDir(inbox);
    const target = join(
      inbox,
      hash(id) + (/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : suffix),
    );
    if (existsSync(target)) {
      if (lstatSync(target).isSymbolicLink())
        throw Error("Cache must not be a symlink");
      return target;
    }
    const tmp = join(inbox, ".download-" + randomUUID());
    const out = await open(tmp, "wx", 0o600);
    const ctrl = new AbortController();
    this.controllers.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const stream = local
        ? Bun.file(local).stream()
        : await fetch(
            this.base +
              "/file/bot" +
              this.token +
              "/" +
              remote.split("/").map(encodeURIComponent).join("/"),
            { signal: ctrl.signal },
          );
      if (stream instanceof Response && !stream.ok)
        throw Error("Download failed");
      const body = stream instanceof Response ? stream.body : stream;
      if (!body) throw Error("Empty download");
      let size = 0;
      for await (const chunk of body as any) {
        size += chunk.length;
        this.checkSize(size);
        await out.writeFile(chunk);
      }
      await out.sync();
      await out.close();
      renameSync(tmp, target);
      return target;
    } catch {
      throw Error("Telegram attachment download failed");
    } finally {
      clearTimeout(timer);
      this.controllers.delete(ctrl);
      await out.close().catch(() => {});
      rmSync(tmp, { force: true });
    }
  }
}
export class Sender {
  journal: Journal;
  path: string;
  api: Telegram;
  constructor(
    readonly store: Store,
    readonly instance: string,
    api?: Telegram,
  ) {
    this.path = store.instance(instance);
    this.journal = new Journal(this.path);
    this.api = api ?? Telegram.forInstance(store, instance);
  }
  async send(
    key: string,
    options: {
      text?: string;
      file?: string;
      kind?: string;
      caption?: string;
      reply_to?: number;
      edit_id?: number;
      source?: MessageSource;
      turn_id?: string;
      format?: TextFormat;
    } = {},
  ): Promise<any> {
    const {
      text,
      file,
      kind = "document",
      caption = "",
      reply_to,
      edit_id,
      source = "codex",
      format = source === "system" ? "plain" : "markdown",
    } = options;
    const c = this.store.read(this.instance),
      owner = c.owner_id;
    if (!c.enabled || !Number.isSafeInteger(owner) || owner <= 0)
      throw Error("Instance paused or unpaired");
    const params: any = { chat_id: owner };
    const fp: any = {
      chat_id: owner,
      text: text ?? null,
      kind,
      caption,
      reply_to: reply_to ?? null,
      edit_id: edit_id ?? null,
    };
    let parts: any[] = [];
    let method: string, upload: any, snapshot: string | undefined;
    if (file !== undefined) {
      if (
        text !== undefined ||
        edit_id !== undefined ||
        !["photo", "document"].includes(kind)
      )
        throw Error("Invalid attachment");
      const captionParts = messages(caption, source, format, 1024);
      if (captionParts.length !== 1)
        throw Error("Formatted caption exceeds 1024 characters");
      const fileSource = realpathSync(file);
      if (
        !within(fileSource, realpathSync(join(this.path, "outgoing"))) ||
        !statSync(fileSource).isFile()
      )
        throw Error("Copy attachment into outgoing first");
      const limit =
        (kind === "photo" ? 10 : this.api.localDir ? 2000 : 50) * 1024 * 1024;
      if (!statSync(fileSource).size || statSync(fileSource).size > limit)
        throw Error("Attachment exceeds API limit");
      const staging = join(this.path, "uploads");
      privateDir(staging);
      snapshot = join(
        mkdtempSync(join(staging, "upload-")),
        basename(fileSource),
      );
      const output = await open(snapshot, "wx", 0o600);
      const digest = createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of createReadStream(fileSource)) {
          size += chunk.length;
          if (size > limit) throw Error("Attachment changed while reading");
          digest.update(chunk);
          await output.writeFile(chunk);
        }
        await output.sync();
      } catch (e) {
        rmSync(resolve(snapshot, ".."), { recursive: true, force: true });
        throw e;
      } finally {
        await output.close();
      }
      fp.sha256 = digest.digest("hex");
      fp.filename = basename(fileSource);
      if (this.api.localDir) params[kind] = new URL("file://" + snapshot).href;
      else upload = { field: kind, path: snapshot, name: basename(fileSource) };
      params.caption = captionParts[0]!.text;
      params.caption_entities = captionParts[0]!.entities;
      method = kind === "photo" ? "sendPhoto" : "sendDocument";
    } else {
      if (typeof text !== "string" || !text.trim())
        throw Error("Text must not be empty");
      parts = messages(
        text,
        source,
        format,
        4096,
        elapsedSeconds(this.journal, options.turn_id),
        turnUsage(this.journal, options.turn_id, c.thread_id),
      );
      if (!parts.some((part) => part.text.trim()))
        throw Error("Text contains no visible content");
      params.text = parts[0]!.text;
      params.entities = parts[0]!.entities;
      method = edit_id !== undefined ? "editMessageText" : "sendMessage";
      if (edit_id !== undefined) {
        if (parts.length !== 1)
          throw Error("Edited message exceeds 4096 characters");
        if (!Number.isSafeInteger(edit_id) || edit_id <= 0)
          throw Error("Invalid message ID");
        params.message_id = edit_id;
      }
    }
    const discard = () => {
      if (snapshot)
        rmSync(resolve(snapshot, ".."), { recursive: true, force: true });
    };
    if (reply_to !== undefined) {
      if (!Number.isSafeInteger(reply_to) || reply_to <= 0) {
        discard();
        throw Error("Invalid reply ID");
      }
      params.reply_parameters = { message_id: reply_to };
    }
    let fresh, previous;
    try {
      // Old receipts fingerprinted only the raw payload. Honor those exactly,
      // including unknown sends, rather than replaying them after an upgrade.
      const old: any = this.journal.db
        .query(
          "SELECT fingerprint FROM delivery WHERE direction='out' AND key=?",
        )
        .get(key);
      if (old?.fingerprint === this.journal.fingerprint(fp)) {
        discard();
        return this.journal.status("out", key);
      }
      fp.presentation = { version: 1, source, format };
      [fresh, previous] = this.journal.begin("out", key, fp);
    } catch (e) {
      discard();
      throw e;
    }
    if (!fresh) {
      discard();
      return previous;
    }
    let status: string, details: any;
    const sent: number[] = [];
    try {
      for (const [i, part] of (parts.length ? parts : [null]).entries()) {
        const payload = part
          ? { ...params, text: part.text, entities: part.entities }
          : params;
        const childKey = `part-${hash(key)}-${i}`;
        // A multipart send reserves each part before its network call. Parent
        // remains unknown after a crash, so retry never replays any part.
        if (parts.length > 1) {
          const [fresh, previous] = this.journal.begin(
            "out",
            childKey,
            payload,
          );
          if (!fresh) {
            if (previous.status !== "sent")
              throw Error(
                "Multipart delivery already has an unconfirmed part; inspect receipts",
              );
            sent.push(previous.details.message_id);
            continue;
          }
        }
        let result;
        try {
          result = await this.api.call(
            method,
            payload,
            snapshot ? 300000 : 10000,
            upload,
          );
          if (
            String(result?.chat?.id) !== String(owner) ||
            !Number.isSafeInteger(result?.message_id)
          )
            throw Error("Unconfirmed recipient");
        } catch (error) {
          if (parts.length > 1)
            this.journal.finish(
              "out",
              childKey,
              error instanceof TelegramError ? "rejected" : "unknown",
              {
                reason: transportDetail(error, this.store.token(this.instance)),
              },
            );
          throw error;
        }
        sent.push(result.message_id);
        if (parts.length > 1)
          this.journal.finish("out", childKey, "sent", {
            message_id: result.message_id,
          });
      }
      status = "sent";
      details =
        parts.length > 1 ? { message_ids: sent } : { message_id: sent[0] };
    } catch (e) {
      if (e instanceof TelegramError) {
        status = "rejected";
        details = { error_code: e.code, reason: e.message };
      } else {
        status = "unknown";
        details = {
          reason:
            "Delivery not confirmed; inspect Telegram before retrying with a new ID",
          error: transportDetail(e, this.store.token(this.instance)),
        };
      }
    }
    if (parts.length > 1 && status !== "sent") {
      details.message_ids = sent;
      details.total_parts = parts.length;
      details.failed_part = sent.length;
      // A partially delivered message is not a wholly rejected send.
      if (sent.length) status = "unknown";
    }
    if (snapshot && status === "unknown") details.retained_upload = snapshot;
    else discard();
    const result = this.journal.finish("out", key, status, details);
    this.journal.put("last_outbound", {
      key,
      status,
      details,
      updated: Date.now() / 1000,
    });
    if (
      status === "sent" &&
      text !== undefined &&
      edit_id === undefined &&
      !key.startsWith("bridge-") &&
      source !== "system"
    )
      this.journal.put(
        "explicit:" +
          this.journal.fingerprint({
            turn: this.journal.get("active_turn"),
            text,
          }),
        details.message_id ?? details.message_ids,
      );
    return result;
  }
}
