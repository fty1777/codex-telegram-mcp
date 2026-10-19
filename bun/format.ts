import { Lexer, type Token } from "marked";
import { decodeHTML } from "entities";
import { durationText } from "./timing";
import type { Usage } from "./usage";

export type MessageSource = "system" | "working" | "codex";
export type TextFormat = "markdown" | "plain";
export interface Entity {
  type:
    | "bold"
    | "italic"
    | "strikethrough"
    | "code"
    | "pre"
    | "text_link"
    | "blockquote";
  offset: number;
  length: number;
  language?: string;
  url?: string;
}
export interface RichText {
  text: string;
  entities: Entity[];
}

function safeUrl(value: string): boolean {
  try {
    return ["https:", "http:", "mailto:", "tg:"].includes(
      new URL(value).protocol,
    );
  } catch {
    return false;
  }
}

/** Render tokens directly to text; HTML is literal, never evaluated as markup. */
export function markdown(text: string): RichText {
  let output = "";
  let contentEnd = 0;
  let quoteDepth = 0;
  const entities: Entity[] = [];
  const add = (value: string, separator = false) => {
    output += value;
    if (!separator) contentEnd = output.length;
  };
  const separate = (lines = 2) => {
    if (!output) return;
    const trailing = output.match(/\n*$/)![0].length;
    if (trailing < lines) add("\n".repeat(lines - trailing), true);
  };
  const span = (type: Entity["type"], emit: () => void, extra = {}) => {
    const offset = output.length;
    emit();
    if (output.length > offset)
      entities.push({ type, offset, length: output.length - offset, ...extra });
  };
  const walk = (tokens: Token[], depth = 0) => {
    for (const t of tokens) {
      if (depth > 40) {
        add(t.raw);
        continue;
      }
      const child = () =>
        walk("tokens" in t ? (t.tokens ?? []) : [], depth + 1);
      switch (t.type) {
        case "space":
          separate();
          break;
        case "paragraph":
          child();
          separate();
          break;
        case "text":
          if (t.tokens) child();
          else add(decodeHTML(t.text));
          break;
        case "escape":
        case "html":
          add(t.text);
          break;
        case "strong":
          span("bold", child);
          break;
        case "em":
          span("italic", child);
          break;
        case "del":
          span("strikethrough", child);
          break;
        case "codespan":
          span("code", () => add(t.text));
          break;
        case "code":
          separate();
          span("pre", () => add(t.text), {
            language: /^[\w#+.-]{1,40}$/.test(t.lang ?? "") ? t.lang : "",
          });
          separate();
          break;
        case "heading":
          separate();
          span("bold", child);
          separate();
          break;
        case "br":
          add("\n");
          break;
        case "hr":
          separate();
          add("────────");
          separate();
          break;
        case "link":
        case "image":
          if (safeUrl(decodeHTML(t.href)))
            span("text_link", child, { url: decodeHTML(t.href) });
          else {
            child();
            add(` (${t.href})`);
          }
          break;
        case "blockquote": {
          separate();
          const offset = output.length;
          const outer = quoteDepth++ === 0;
          child();
          quoteDepth--;
          // Telegram cannot nest quotes. Flatten nested Markdown quote levels
          // into the outer quote while retaining their text and inline styles.
          if (outer && contentEnd > offset)
            entities.push({
              type: "blockquote",
              offset,
              length: contentEnd - offset,
            });
          separate();
          break;
        }
        case "list":
          if (output && !output.endsWith("\n")) add("\n", true);
          for (const [i, item] of t.items.entries()) {
            add(
              "  ".repeat(Math.min(depth, 8)) +
                (t.ordered ? `${Number(t.start) + i}. ` : "• "),
            );
            walk(item.tokens, depth + 1);
            if (!output.endsWith("\n")) add("\n", true);
          }
          separate();
          break;
        case "checkbox":
          add(t.checked ? "☑ " : "☐ ");
          break;
        case "table": {
          // Telegram has no tables: retain a readable plain-text column layout.
          separate();
          const rows = [t.header, ...t.rows];
          for (const row of rows) {
            for (const [i, cell] of row.entries()) {
              if (i) add(" | ");
              walk(cell.tokens, depth + 1);
            }
            add("\n", true);
          }
          separate();
          break;
        }
        case "def":
          break;
        default:
          add(t.raw);
      }
    }
  };
  try {
    walk(Lexer.lex(text, { gfm: true }));
  } catch {
    return { text, entities: [] };
  }
  // Remove renderer-added trailing separators, but retain code's own whitespace.
  const end = contentEnd;
  output = output.slice(0, end);
  // Telegram forbids formatting inside code/pre and nested non-style entities.
  // Cut surrounding styles/links around code instead of dropping code formatting.
  const code = entities.filter((e) => e.type === "code" || e.type === "pre");
  const normalized: Entity[] = [];
  for (const entity of entities) {
    let ranges = [
      {
        start: entity.offset,
        end: Math.min(end, entity.offset + entity.length),
      },
    ];
    if (
      entity.type !== "code" &&
      entity.type !== "pre" &&
      entity.type !== "blockquote"
    ) {
      for (const block of code) {
        const a = block.offset,
          b = a + block.length;
        ranges = ranges
          .flatMap((r) =>
            r.end <= a || r.start >= b
              ? [r]
              : [
                  { start: r.start, end: Math.min(r.end, a) },
                  { start: Math.max(r.start, b), end: r.end },
                ],
          )
          .filter((r) => r.end > r.start);
      }
    }
    for (const r of ranges)
      if (r.end > r.start)
        normalized.push({
          ...entity,
          offset: r.start,
          length: r.end - r.start,
        });
  }
  // Linked images may create nested links. Keep the outer destination; Telegram
  // does not allow text_link entities to contain one another.
  const links = normalized
    .filter((e) => e.type === "text_link")
    .reverse()
    .sort((a, b) => b.length - a.length);
  const kept: Entity[] = [];
  for (const link of links) {
    if (
      !kept.some(
        (e) =>
          e.offset < link.offset + link.length &&
          link.offset < e.offset + e.length,
      )
    )
      kept.push(link);
  }
  return {
    text: output,
    entities: [
      ...normalized.filter((e) => e.type !== "text_link"),
      ...kept,
    ].sort((a, b) => a.offset - b.offset || b.length - a.length),
  };
}

/** Split rendered text, clipping entity ranges and never splitting a surrogate pair. */
export function messages(
  input: string,
  source: MessageSource = "codex",
  format: TextFormat = source === "system" ? "plain" : "markdown",
  limit = 4096,
  elapsed?: number,
  usage?: Usage,
): RichText[] {
  const body =
    format === "markdown" ? markdown(input) : { text: input, entities: [] };
  if (source === "system" && body.text.length) {
    body.entities = body.entities.filter(
      (entity) => entity.type !== "blockquote",
    );
  }
  const prefix = source === "system" && body.text.length ? "System\n" : "";
  const stats: string[] = [];
  if (typeof elapsed === "number" && Number.isFinite(elapsed)) stats.push(durationText(elapsed));
  if (usage && Number.isSafeInteger(usage.tokens) && usage.tokens >= 0) {
    const count = (n: number) => `${(Math.round(n / 100) / 10).toFixed(1)}k`;
    const parts = (value?: Partial<Usage>) => {
      if (!value || ![value.inputTokens, value.cachedInputTokens, value.outputTokens].every(n => Number.isSafeInteger(n) && n! >= 0)
          || value.cachedInputTokens! > value.inputTokens!) return "";
      return `↑${count(value.inputTokens!)} (cache ${count(value.cachedInputTokens!)}) ↓${count(value.outputTokens!)}`;
    };
    if (usage.scope === "turn") stats.push(parts(usage) || count(usage.tokens));
    const session = usage.sessionTokens ?? (usage.scope === "session" ? usage.tokens : undefined);
    if (Number.isSafeInteger(session) && session! >= 0) {
      const detail = parts(usage.sessionBreakdown ?? (usage.scope === "session" ? usage : undefined));
      stats.push(`session ${count(session!)}${detail ? " " + detail : ""}`);
    }
  }
  const footer = source !== "system" && body.text.length && stats.length
    ? `(Codex ${source === "working" ? "Working" : "Worked"} ${stats.join(" · ")})` : "";
  const budget = limit - prefix.length - (footer ? footer.length + 1 : 0);
  if (budget < 2) throw Error("Message limit is too small");
  const result: RichText[] = [];
  for (let start = 0; start < body.text.length || !result.length; ) {
    let end = Math.min(body.text.length, start + budget);
    // Prefer paragraph/line boundaries when that does not create tiny chunks.
    if (end < body.text.length) {
      const line = body.text.lastIndexOf("\n", end - 1) + 1;
      if (line > start + budget / 2) end = line;
      if (end > start && /[\uD800-\uDBFF]/.test(body.text[end - 1])) end--;
    }
    const entities: Entity[] = [];
    if (prefix) {
      entities.push(
        { type: "blockquote", offset: 0, length: prefix.length + end - start },
        { type: "bold", offset: 0, length: "System".length },
      );
    }
    for (const entity of body.entities) {
      const a = Math.max(start, entity.offset);
      const b = Math.min(end, entity.offset + entity.length);
      if (b > a)
        entities.push({
          ...entity,
          offset: prefix.length + a - start,
          length: b - a,
        });
    }
    const footerEntity: Entity | undefined =
      footer && end === body.text.length
        ? {
            type: "italic",
            offset: prefix.length + end - start + 1,
            length: footer.length,
          }
        : undefined;
    // Keep well below Telegram's entity-count limits without losing any text.
    result.push({
      text:
        prefix +
        body.text.slice(start, end) +
        (footer && end === body.text.length ? "\n" + footer : ""),
      entities: [
        ...entities
          .sort((a, b) => a.offset - b.offset || b.length - a.length)
          .slice(0, footerEntity ? 89 : 90),
        ...(footerEntity ? [footerEntity] : []),
      ],
    });
    start = end;
    if (start === body.text.length) break;
  }
  return result;
}
