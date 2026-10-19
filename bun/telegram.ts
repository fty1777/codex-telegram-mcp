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
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { Journal, Store, hash, privateDir } from "./state";
import { messages, type MessageSource, type TextFormat } from "./format";
import { elapsedSeconds } from "./timing";
import {
  richFields,
  markdownHtml,
  entityHtml,
  activityHtml,
  RICH_LIMIT,
} from "./rich";
import { statusline } from "./statusline";
import { activityText } from "./activity";
import { turnUsage } from "./usage";
export class TelegramError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly retryAfter?: number,
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
          result.parameters?.retry_after,
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
      activity_page?: boolean;
      activity_block?: boolean;
      expected_binding?: { thread: string; owner: number; revision?: number };
      deferred_attempt?: boolean;
      defer_on_limit?: boolean;
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
    const expected = options.expected_binding;
    if (
      expected &&
      (c.thread_id !== expected.thread ||
        c.owner_id !== expected.owner ||
        c.binding_revision !== expected.revision ||
        c.binding_change ||
        c.removing ||
        c.autostart === false)
    )
      return {
        status: "rejected",
        details: {
          reason: "Historical delivery binding changed",
          binding_changed: true,
        },
      };
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
    let workingBody: any,
      workingHadUsage = false;
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
      const elapsed = options.activity_page
        ? undefined
        : elapsedSeconds(this.journal, options.turn_id);
      const usage = options.activity_page
        ? undefined
        : turnUsage(this.journal, options.turn_id, c.thread_id);
      parts = messages(
        text,
        source,
        format,
        RICH_LIMIT,
        elapsed,
        usage,
        options.activity_page
          ? undefined
          : statusline(this.journal, c.thread_id),
      );
      // Preserve native headings, tables, nested quotes and dividers for an
      // unsplit body; oversized bodies use balanced entity-based chunks.
      if (parts.length === 1 && format === "markdown") {
        const html = markdownHtml(text);
        const blocks = (
          html.match(/<(?:p|h[1-6]|li|tr|blockquote|pre|hr)(?:[ >\/])/g) ?? []
        ).length;
        if (blocks <= 450)
          parts[0].bodyHtml =
            source === "system"
              ? `<blockquote><b>System</b><br/>${html}</blockquote>`
              : html;
      }
      if (source === "working" && edit_id === undefined && !options.activity_page) {
        workingHadUsage = !!usage;
        const footer = messages(
          "x",
          "working",
          "plain",
          RICH_LIMIT,
          elapsed,
          usage,
          statusline(this.journal, c.thread_id),
        )[0]!.text.slice(1);
        const tail = parts.at(-1)!;
        const length = tail.text
          .slice(0, tail.text.length - footer.length)
          .trimEnd().length;
        workingBody = {
          text: tail.text.slice(0, length),
          entities: tail.entities.filter(
            (e: any) => e.offset + e.length <= length,
          ),
          html: tail.bodyHtml,
        };
      }
      if (options.activity_page || options.activity_block)
        for (const part of parts) {
          const end = options.activity_block
            ? part.text.lastIndexOf("\nCodex Working ")
            : -1;
          const length = end < 0 ? part.text.length : end;
          part.bodyHtml = activityHtml(part.text.slice(0, length));
        }
      if (!parts.some((part) => part.text.trim()))
        throw Error("Text contains no visible content");

      method = edit_id !== undefined ? "editMessageText" : "sendRichMessage";
      if (edit_id !== undefined) {
        if (parts.length !== 1)
          throw Error("Edited message exceeds the Rich Message limit");
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
      const v1 = { ...fp, presentation: { version: 1, source, format } };
      if (old?.fingerprint === this.journal.fingerprint(v1)) {
        discard();
        return this.journal.status("out", key);
      }
      fp.presentation = { version: 2, source, format };
      [fresh, previous] = this.journal.begin("out", key, fp);
    } catch (e) {
      discard();
      throw e;
    }
    if (!fresh) {
      discard();
      if (
        !options.deferred_attempt &&
        options.defer_on_limit !== false &&
        previous.status === "rejected" &&
        previous.details?.error_code === 429 &&
        !previous.details?.message_ids?.length
      ) {
        this.defer(key, options, c);
        return this.journal.finish("out", key, "rejected", {
          ...previous.details,
          queued: true,
        });
      }
      return previous;
    }
    const waitUntil = this.journal.get("working_refresh_after", 0);
    if (Date.now() < waitUntil) {
      discard();
      if (!options.deferred_attempt && options.defer_on_limit !== false)
        this.defer(key, options, c);
      return this.journal.finish("out", key, "rejected", {
        error_code: 429,
        reason: "Delivery queued while Telegram rate limit is active",
        retry_after: Math.ceil((waitUntil - Date.now()) / 1000),
        queued: options.defer_on_limit !== false,
      });
    }
    let status: string, details: any;
    const sent: number[] = [];
    try {
      for (const [i, part] of (parts.length ? parts : [null]).entries()) {
        const payload = part ? { ...params, ...richFields(part) } : params;
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
        details = {
          error_code: e.code,
          reason: e.message,
          ...(e.retryAfter !== undefined ? { retry_after: e.retryAfter } : {}),
        };
        if (e.code === 429) {
          this.applyRateLimit(e.retryAfter);
          if (
            !sent.length &&
            !options.deferred_attempt &&
            options.defer_on_limit !== false
          ) {
            this.defer(key, options, c);
            details.queued = true;
          }
        }
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
    try {
      if (
        status === "sent" &&
        edit_id !== undefined &&
        !options.activity_page
      ) {
        this.journal.put("working_tail:" + edit_id, null);
        if (this.journal.get("working_message")?.message === edit_id)
          this.journal.put("working_message", null);
      }
      if (status === "sent" && workingBody) {
        const turn = options.turn_id ?? this.journal.get("active_turn");
        const current = this.store.read(this.instance);
        const previousWorking = this.journal.get("working_message");
        if (
          turn &&
          turn === this.journal.get("active_turn") &&
          !this.journal.get("completed_turn:" + turn) &&
          current.enabled &&
          current.autostart !== false &&
          !current.removing &&
          !current.binding_change &&
          current.thread_id === c.thread_id &&
          current.owner_id === owner &&
          current.binding_revision === c.binding_revision
        ) {
          const tail = parts.at(-1)!;
          const working = {
            id: hash(key),
            turn,
            thread: c.thread_id,
            owner,
            revision: c.binding_revision,
            message: sent.at(-1),
            body: workingBody,
            hadUsage: workingHadUsage,
            sequence: 0,
            next: Date.now() + this.refreshInterval(),
            signature: this.journal.fingerprint(richFields(tail).rich_message),
          };
          if (!previousWorking || previousWorking.message < working.message!)
            this.journal.put("working_message", working);
          this.journal.put("working_tail:" + working.message, working);
          const activity = this.journal.get("activity:" + turn);
          if (activity)
            this.journal.put("activity:" + turn, {
              ...activity,
              entries: activity.entries.map((e: any) =>
                e.message === null ? { ...e, message: working.message } : e,
              ),
            });
          // A newer progress message takes over the counter. Keep older bodies,
          // but queue their footers for removal immediately rather than at turn end.
          for (const row of this.journal.db
            .query(
              "SELECT key,value FROM metadata WHERE key LIKE 'working_tail:%'",
            )
            .all() as any[]) {
            const old = JSON.parse(row.value);
            if (
              old &&
              old.kind !== "activity" &&
              old.turn === turn &&
              old.thread === c.thread_id &&
              old.message < working.message! &&
              !old.cleanupQueued
            )
              this.journal.put(
                row.key,
                (this.journal.get("activity:" + turn)?.entries ?? []).some(
                  (e: any) => e.message === old.message,
                )
                  ? {
                      ...old,
                      ...(previousWorking?.message === old.message
                        ? previousWorking
                        : {}),
                      retired: true,
                      next: 0,
                      renderedVersion: -1,
                      originalBody: old.originalBody ?? old.body,
                    }
                  : {
                      ...old,
                      kind:
                        old.activityOnly && old.mode !== "keep"
                          ? "activity"
                          : old.kind,
                      cleanup: true,
                      cleanupQueued: true,
                    },
              );
          }
        }
      }
    } catch (error) {
      // Optional counter tracking cannot turn a confirmed send into a tool error.
      console.error(transportDetail(error, this.store.token(this.instance)));
    }
    return result;
  }

  refreshInterval() {
    return this.journal.get("working_refresh_interval", 10000);
  }
  applyRateLimit(seconds = 5) {
    const until =
      Date.now() + Math.max(1, Number.isFinite(seconds) ? seconds : 5) * 1000;
    this.journal.db.transaction(() =>
      this.journal.put(
        "working_refresh_after",
        Math.max(until, this.journal.get("working_refresh_after", 0)),
      ),
    )();
  }
  private defer(key: string, options: any, config: any) {
    const queueKey = "outbound_deferred:" + hash(key);
    if (!this.journal.get(queueKey))
      this.journal.put(queueKey, {
        key,
        options: {
          ...options,
          turn_id: options.turn_id ?? this.journal.get("active_turn"),
        },
        thread: config.thread_id,
        owner: config.owner_id,
        revision: config.binding_revision,
        created: Date.now(),
        attempt: 0,
      });
    if (
      options.text &&
      options.edit_id === undefined &&
      !key.startsWith("bridge-") &&
      options.source !== "system"
    )
      this.journal.put(
        "explicit:" +
          this.journal.fingerprint({
            turn: options.turn_id ?? this.journal.get("active_turn"),
            text: options.text,
          }),
        "queued",
      );
  }
  async retryDeferred(at = Date.now()) {
    if (
      at <
      Math.max(
        this.journal.get("working_refresh_after", 0),
        this.journal.get("working_edit_after", 0),
      )
    )
      return;
    const c = this.store.read(this.instance);
    if (!c.enabled || c.autostart === false || c.binding_change || c.removing)
      return;
    for (const row of this.journal.db
      .query(
        "SELECT key,value FROM metadata WHERE key LIKE 'outbound_deferred:%' ORDER BY rowid",
      )
      .all() as any[]) {
      const state = JSON.parse(row.value);
      if (!state || state.dispatching) continue;
      if (
        state.thread !== c.thread_id ||
        state.owner !== c.owner_id ||
        state.revision !== c.binding_revision
      ) {
        this.journal.put(row.key, null);
        continue;
      }
      const previous = this.journal.status("out", state.key);
      if (
        previous.status !== "rejected" ||
        previous.details?.error_code !== 429
      ) {
        this.journal.put(row.key, null);
        continue;
      }
      // Working commentary describes a moment in time, not a durable reply.
      // Never deliver stale progress after a long cooldown or a completed turn.
      if (
        !state.options.expected_binding &&
        state.options.source === "working" &&
        (!state.created ||
          at - state.created >= 60000 ||
          state.options.turn_id !== this.journal.get("active_turn"))
      ) {
        this.journal.finish("out", state.key, "rejected", {
          queued: false,
          expired: true,
          reason: "Progress update is no longer current",
        });
        this.journal.put(row.key, null);
        continue;
      }
      const child = `bridge-deferred-${hash(state.key)}-${state.attempt}`;
      this.journal.put(row.key, {
        ...state,
        dispatching: true,
        attempt: state.attempt + 1,
      });
      this.journal.finish("out", state.key, "unknown", {
        retry_request_id: child,
      });
      this.journal.put("working_edit_after", at + this.refreshInterval());
      let receipt;
      try {
        receipt = await this.send(child, {
          ...state.options,
          deferred_attempt: true,
          ...(state.options.source === "working" &&
          state.options.turn_id !== this.journal.get("active_turn")
            ? { activity_page: true }
            : {}),
        });
      } catch {
        // Dispatch was reserved; never retry if acceptance cannot be established.
        receipt = { status: "unknown", details: { retry_request_id: child } };
      }
      this.journal.finish("out", state.key, receipt.status, receipt.details);
      this.journal.put(
        row.key,
        receipt.status === "rejected" && receipt.details?.error_code === 429
          ? { ...state, attempt: state.attempt + 1 }
          : null,
      );
      return;
    }
  }

  private refreshingWorking = false;
  async refreshWorking(at = Date.now(), contentOnly = false) {
    if (this.refreshingWorking) return;
    let state = this.journal.get("working_message");
    if (!state) return;
    const activity = this.journal.get("activity:" + state.turn);
    const activityVersion = activity?.version ?? 0;
    const activityFor = (message: number) =>
      activityText(
        (activity?.entries ?? []).filter((e: any) => e.message === message),
      );
    const retired = (
      this.journal.db
        .query("SELECT value FROM metadata WHERE key LIKE 'working_tail:%'")
        .all() as any[]
    )
      .map((row) => JSON.parse(row.value))
      .find(
        (t) =>
          t?.retired &&
          t.turn === state.turn &&
          !t.cleanupQueued &&
          !t.suspended &&
          activityFor(t.message) !== (t.renderedActivity ?? ""),
      );
    if (retired)
      state = { ...retired, body: retired.originalBody ?? retired.body };
    const c = this.store.read(this.instance);
    if (
      !c.enabled ||
      c.autostart === false ||
      c.removing ||
      c.binding_change ||
      c.thread_id !== state.thread ||
      c.owner_id !== state.owner ||
      c.binding_revision !== state.revision ||
      state.turn !== this.journal.get("active_turn")
    ) {
      this.journal.put("working_message", null);
      return;
    }
    const detail =
      activity && activity.mode !== "off" && !activity.blocked
        ? activityFor(state.message)
        : "";
    const contentChanged = detail !== (state.renderedActivity ?? "");
    if (contentOnly && !contentChanged) return;
    if (
      (state.suspended && !state.pendingSignature) ||
      at < this.journal.get("working_refresh_after", 0) ||
      (!contentChanged &&
        at < Math.max(state.next, this.journal.get("working_edit_after", 0)))
    )
      return;
    const usage = turnUsage(this.journal, state.turn, state.thread);
    if (state.hadUsage && !usage) return; // Keep existing counters during a reconnect gap.
    const rendered = messages(
      "x",
      "working",
      "plain",
      RICH_LIMIT,
      elapsedSeconds(this.journal, state.turn),
      usage,
      statusline(this.journal, state.thread),
    )[0]!;
    const footer = state.retired ? "" : rendered.text.slice(1);
    // Reserve stable space for the counter so ticking does not repaginate tools.
    const room = Math.max(
      0,
      RICH_LIMIT - state.body.text.length - 512 - (state.body.text ? 2 : 0),
    );
    let end = room;
    if (end > 0 && /[\uD800-\uDBFF]/.test(detail[end - 1] ?? "")) end--;
    const summary = detail.slice(0, end);
    const overflow = detail.slice(end);
    const pages: string[] = [];
    for (let start = 0; start < overflow.length; ) {
      let stop = Math.min(overflow.length, start + 32000);
      if (/[\uD800-\uDBFF]/.test(overflow[stop - 1])) stop--;
      pages.push(overflow.slice(start, stop));
      start = stop;
    }
    const pageKey = "activity_pages:" + state.message;
    const pageState = this.journal.get(pageKey);
    if (pages.length || pageState)
      this.journal.put(pageKey, {
        ...pageState,
        turn: state.turn,
        thread: state.thread,
        owner: state.owner,
        revision: state.revision,
        parent: state.message,
        mode: activity?.mode,
        pages,
        sent: pageState?.sent ?? [],
      });
    const displayBody =
      state.body.text +
      (summary ? (state.body.text ? "\n\n" : "") + summary : "");
    const text = displayBody + footer;
    const bodyEntities = state.body.entities.slice(
      0,
      89 - rendered.entities.length,
    );
    const entities = [
      ...bodyEntities,
      ...(state.retired
        ? []
        : rendered.entities.map((e) => ({
            ...e,
            offset: e.offset - 1 + displayBody.length,
          }))),
    ];
    const bodyHtml =
      (state.body.html ?? entityHtml(state.body)) +
      (summary ? activityHtml(summary) : "");
    const payload = {
      chat_id: state.owner,
      message_id: state.message,
      ...richFields({
        text,
        entities,
        bodyHtml,
        ...(state.retired || !footer
          ? {}
          : { footerOffset: displayBody.length + 1 }),
      }),
    };
    const signature = this.journal.fingerprint(payload.rich_message);
    if (signature === state.signature || signature === state.pendingSignature) {
      if (state.retired)
        this.journal.put("working_tail:" + state.message, {
          ...state,
          renderedVersion: activityVersion,
        });
      return;
    }
    // Empty retired activity placeholders are removed by the completion cleanup.
    if (!text) {
      this.journal.put("working_tail:" + state.message, {
        ...state,
        renderedVersion: activityVersion,
      });
      return;
    }
    if (text.length > RICH_LIMIT) {
      this.journal.put("working_message", { ...state, suspended: true });
      return;
    }
    const sequence = state.sequence + 1;
    const key = `working-edit-${state.id}-${sequence}`;

    // Reserve the exact version before sending. Unknown versions are never
    // replayed; a strictly newer display may still edit the same known message.
    this.journal.put(
      state.retired ? "working_tail:" + state.message : "working_message",
      {
        ...state,
        sequence,
        suspended: true,
        pendingSignature: signature,
        next: at + this.refreshInterval(),
      },
    );
    this.journal.put("working_edit_after", at + this.refreshInterval());
    const [fresh] = this.journal.begin("out", key, payload);
    if (!fresh) return;
    this.refreshingWorking = true;
    let status = "sent",
      details: any = { message_id: state.message },
      suspended = false,
      retry = 0;
    try {
      const result = await this.api.call("editMessageText", payload, 3000);
      if (
        result?.message_id !== state.message ||
        String(result?.chat?.id) !== String(state.owner)
      )
        throw Error("Unconfirmed edit recipient");
    } catch (error) {
      const e = error as any;
      if (
        error instanceof TelegramError &&
        error.code === 400 &&
        /message is not modified/i.test(error.message)
      ) {
        details.unchanged = true;
      } else {
        status = error instanceof TelegramError ? "rejected" : "unknown";
        details = {
          error_code: e?.code,
          reason: transportDetail(error, this.store.token(this.instance)),
        };
        const limited = error instanceof TelegramError && error.code === 429;
        retry =
          limited && Number.isFinite(error.retryAfter)
            ? Math.max(1, error.retryAfter!) * 1000
            : 1000;
        suspended = error instanceof TelegramError && !limited;
        if (limited) this.applyRateLimit(error.retryAfter);
      }
    } finally {
      this.refreshingWorking = false;
    }
    this.journal.finish("out", key, status, details);
    const stateKey = state.retired
      ? "working_tail:" + state.message
      : "working_message";
    const current = this.journal.get(stateKey);
    if (current?.id === state.id && current.sequence === sequence)
      this.journal.put(stateKey, {
        ...current,
        renderedVersion: activityVersion,
        renderedActivity: status === "sent" ? detail : state.renderedActivity,
        suspended,
        pendingSignature: status === "unknown" ? signature : undefined,
        hadUsage: state.hadUsage || !!usage,
        signature: status === "sent" ? signature : state.signature,
        next:
          status === "sent"
            ? at + this.refreshInterval()
            : Date.now() + Math.max(1000, retry),
      });
    if (status === "sent" && activity) {
      const latestActivity = this.journal.get("activity:" + state.turn);
      if (!state.retired && latestActivity?.version === activity.version)
        this.journal.put("activity:" + state.turn, {
          ...latestActivity,
          message: state.message,
          merged: true,
          activityOnly: !!state.activityOnly,
          sentVersion: activity.version,
        });
      const tail = this.journal.get("working_tail:" + state.message);
      if (tail && !tail.cleanupQueued)
        this.journal.put("working_tail:" + state.message, {
          ...tail,
          sequence,
          signature,
          renderedActivity: detail,
          suspended: false,
          pendingSignature: undefined,
          next: at + this.refreshInterval(),
          renderedVersion: activityVersion,
          originalBody: state.originalBody ?? state.body,
          activityOnly: !!state.activityOnly,
          mode: activity.mode,
          body:
            activity.mode === "keep"
              ? { text: displayBody, entities: bodyEntities, html: bodyHtml }
              : state.body,
        });
    }
    if (status !== "sent")
      this.journal.put("last_working_refresh_error", {
        status,
        details,
        updated: Date.now(),
      });
  }

  async refreshActivityPages(at = Date.now()) {
    if (at < this.journal.get("working_refresh_after", 0)) return;
    const c = this.store.read(this.instance);
    if (!c.enabled || c.autostart === false || c.binding_change || c.removing)
      return;
    for (const row of this.journal.db
      .query("SELECT key,value FROM metadata WHERE key LIKE 'activity_pages:%'")
      .all() as any[]) {
      const state = JSON.parse(row.value);
      if (
        !state ||
        (state.turn !== this.journal.get("active_turn") &&
          !(
            state.mode === "keep" &&
            this.journal.get("completed_turn:" + state.turn)
          )) ||
        state.thread !== c.thread_id ||
        state.owner !== c.owner_id ||
        state.revision !== c.binding_revision ||
        state.mode === "off"
      )
        continue;
      for (let i = 0; i < state.pages.length; i++) {
        const text = state.pages[i],
          prior = state.sent[i],
          signature = hash(text);
        if (prior?.blocked || prior?.signature === signature) continue;
        this.journal.put("working_edit_after", at + this.refreshInterval());
        // Reserve a page slot before send; an ambiguous new message is never resent.
        state.sent[i] = {
          ...prior,
          blocked: !prior?.message,
          pending: signature,
        };
        this.journal.put(row.key, state);
        const receipt = await this.send(
          `bridge-activity-page-${state.parent}-${i}-${signature}-${prior?.attempt ?? 0}`,
          {
            source: "codex",
            format: "plain",
            text,
            activity_page: true,
            defer_on_limit: false,
            edit_id: prior?.message,
          },
        );
        const limited =
          receipt.status === "rejected" && receipt.details?.error_code === 429;
        if (limited) this.applyRateLimit(receipt.details.retry_after);
        const message = receipt.details?.message_id ?? prior?.message;
        state.sent[i] = {
          message,
          signature: limited ? undefined : signature,
          attempt: (prior?.attempt ?? 0) + 1,
          blocked: receipt.status !== "sent" && !message && !limited,
        };
        this.journal.put(row.key, state);
        if (receipt.status === "sent" && state.mode !== "keep")
          this.journal.put("working_tail:" + message, {
            id: `activity-page-${state.parent}-${i}`,
            kind: "activity",
            turn: state.turn,
            thread: state.thread,
            owner: state.owner,
            revision: state.revision,
            message,
          });
        return;
      }
    }
  }

  finishWorking(turn: string) {
    const latest = this.journal.get("working_message");
    if (latest?.turn === turn) {
      // Also recognize the last target created before cleanup tracking existed.
      if (!this.journal.get("working_tail:" + latest.message))
        this.journal.put("working_tail:" + latest.message, latest);
      this.journal.put("working_message", null);
    }
    for (const row of this.journal.db
      .query("SELECT key,value FROM metadata WHERE key LIKE 'working_tail:%'")
      .all() as any[]) {
      const value = JSON.parse(row.value);
      if (
        value?.turn === turn &&
        !value.cleanupQueued &&
        value.thread === this.store.read(this.instance).thread_id
      )
        this.journal.put(row.key, {
          ...value,
          kind:
            value.activityOnly && value.mode !== "keep"
              ? "activity"
              : value.kind,
          cleanup: true,
          cleanupQueued: true,
        });
    }
  }

  async cleanWorking(at = Date.now()) {
    if (
      this.refreshingWorking ||
      at <
        Math.max(
          this.journal.get("working_cleanup_after", 0),
          this.journal.get("working_refresh_after", 0),
        )
    )
      return;
    const row: any = this.journal.db
      .query(
        "SELECT key,value FROM metadata WHERE key LIKE 'working_tail:%' AND json_extract(value,'$.cleanup') = 1 ORDER BY rowid LIMIT 1",
      )
      .get();
    if (!row) return;
    const state = JSON.parse(row.value),
      c = this.store.read(this.instance);
    if (!c.enabled || c.autostart === false || c.removing || c.binding_change)
      return;
    if (
      state.thread !== c.thread_id ||
      state.owner !== c.owner_id ||
      state.revision !== c.binding_revision
    ) {
      this.journal.put(row.key, null);
      return;
    }
    const attempt = (state.cleanupAttempt ?? 0) + 1;
    const key = `working-clean-${state.id}-${attempt}`;
    const cleanText = state.body?.text.trimEnd();
    const cleanBody = state.body && {
      ...state.body,
      text: cleanText,
      entities: state.body.entities
        .map((e: any) => ({
          ...e,
          length: Math.min(e.length, cleanText.length - e.offset),
        }))
        .filter((e: any) => e.length > 0),
      bodyHtml: state.body.html?.replace(/(?:<br\s*\/?>|\s)+$/g, ""),
    };
    const payload =
      state.kind === "activity"
        ? { chat_id: state.owner, message_id: state.message }
        : {
            chat_id: state.owner,
            message_id: state.message,
            ...richFields(cleanBody),
          };
    // This edits only the known body back into the existing message. A cleanup
    // is a separate action from counter refresh; never delete the message itself.
    this.journal.put(row.key, {
      ...state,
      cleanup: false,
      cleanupAttempt: attempt,
    });
    // Finite cleanup work must not wait behind the periodic counter interval.
    // Pace removals separately, while preserving the shared Telegram 429 gate.
    this.journal.put("working_cleanup_after", at + 1000);
    this.journal.put(
      "working_edit_after",
      Math.max(this.journal.get("working_edit_after", 0), at + 1000),
    );
    const [fresh] = this.journal.begin("out", key, payload);
    if (!fresh) return;
    this.refreshingWorking = true;
    let status = "sent",
      details: any = { message_id: state.message },
      retry = false;
    try {
      const result = await this.api.call(
        state.kind === "activity" ? "deleteMessage" : "editMessageText",
        payload,
        3000,
      );
      if (
        state.kind === "activity"
          ? result !== true
          : result?.message_id !== state.message ||
            String(result?.chat?.id) !== String(state.owner)
      )
        throw Error("Unconfirmed cleanup");
    } catch (error) {
      if (
        !(
          error instanceof TelegramError &&
          error.code === 400 &&
          /message is not modified/i.test(error.message)
        )
      ) {
        status = error instanceof TelegramError ? "rejected" : "unknown";
        details = {
          error_code: (error as any)?.code,
          reason: transportDetail(error, this.store.token(this.instance)),
        };
        retry = error instanceof TelegramError && error.code === 429;
        if (retry) {
          const seconds = Number.isFinite((error as TelegramError).retryAfter)
            ? Math.max(1, (error as TelegramError).retryAfter!)
            : 1;
          this.applyRateLimit(seconds);
        }
      }
    } finally {
      this.refreshingWorking = false;
    }
    this.journal.finish("out", key, status, details);
    if (status === "sent") {
      this.journal.put(row.key, null);
      if (
        state.kind === "activity" &&
        this.journal.get("working_message")?.message === state.message
      )
        this.journal.put("working_message", null);
    } else {
      this.journal.put(row.key, {
        ...state,
        cleanup: retry,
        cleanupAttempt: attempt,
      });
      this.journal.put("last_working_cleanup_error", {
        status,
        details,
        updated: Date.now(),
      });
    }
  }
}
