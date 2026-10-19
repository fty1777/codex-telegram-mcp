import { Lexer, type Token } from "marked";
import { decodeHTML } from "entities";
import type { RichText } from "./format";

export const RICH_LIMIT = 32768;
export const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const COPY_TEXT_LIMIT = 256;
function inlineCodeTags(text: string): [string, string] {
  return text.trim() && text.length <= COPY_TEXT_LIMIT
    ? [
        `<tg-button type="copy_text" text="${escapeHtml(text)}">`,
        "</tg-button>",
      ]
    : ["<code>", "</code>"];
}
export function copyCodeHtml(text: string): string {
  const [open, close] = inlineCodeTags(text);
  return open + escapeHtml(text) + close;
}
const safeUrl = (url: string) => {
  try {
    return ["https:", "http:", "mailto:", "tg:"].includes(
      new URL(url).protocol,
    );
  } catch {
    return false;
  }
};

// Reopen ranges at crossing boundaries so generated markup is always nested.
export function entityHtml(body: RichText): string {
  const end = body.text.length;
  const entities = body.entities.filter(
    (e) => e.length > 0 && e.offset >= 0 && e.offset + e.length <= end,
  );
  const bounds = [
    ...new Set([
      0,
      end,
      ...entities.flatMap((e) => [e.offset, e.offset + e.length]),
    ]),
  ].sort((a, b) => a - b);
  const tags = (e: (typeof entities)[number]): [string, string] => {
    if (e.type === "text_link")
      return safeUrl(e.url ?? "")
        ? [`<a href="${escapeHtml(e.url!)}">`, "</a>"]
        : ["", ""];
    if (e.type === "code")
      return inlineCodeTags(body.text.slice(e.offset, e.offset + e.length));
    if (e.type === "pre")
      return [
        `<pre><code${e.language ? ` class="language-${escapeHtml(e.language)}"` : ""}>`,
        "</code></pre>",
      ];
    const tag = (
      {
        bold: "b",
        italic: "i",
        strikethrough: "s",
        code: "code",
        blockquote: "blockquote",
      } as Record<string, string>
    )[e.type];
    return tag ? [`<${tag}>`, `</${tag}>`] : ["", ""];
  };
  let result = "";
  let previous: typeof entities = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i],
      b = bounds[i + 1];
    const active = entities
      .filter((e) => e.offset <= a && e.offset + e.length >= b)
      .sort((x, y) =>
        x.type === "blockquote"
          ? -1
          : y.type === "blockquote"
            ? 1
            : x.offset - y.offset || y.length - x.length,
      );
    let common = 0;
    while (
      common < previous.length &&
      common < active.length &&
      previous[common] === active[common]
    )
      common++;
    const escaped = escapeHtml(body.text.slice(a, b));
    const content = active.some((e) => e.type === "pre")
      ? escaped
      : escaped.replaceAll("\n", "<br/>");
    result +=
      previous
        .slice(common)
        .reverse()
        .map((e) => tags(e)[1])
        .join("") +
      active
        .slice(common)
        .map((e) => tags(e)[0])
        .join("") +
      content;
    previous = active;
  }
  return (
    result +
    previous
      .reverse()
      .map((e) => tags(e)[1])
      .join("")
  );
}

/** Only emit allowlisted markup. Model-authored HTML is always literal text. */
export function markdownHtml(input: string): string {
  const walk = (tokens: Token[], depth = 0): string =>
    tokens
      .map((t: any): string => {
        if (depth >= 7) return escapeHtml(t.raw ?? t.text ?? "");
        const child = () => walk(t.tokens ?? [], depth + 1);
        switch (t.type) {
          case "space":
          case "def":
            return "";
          case "paragraph":
            return `<p>${child()}</p>`;
          case "text":
            return t.tokens ? child() : escapeHtml(decodeHTML(t.text));
          case "escape":
          case "html":
            return escapeHtml(t.text);
          case "strong":
            return `<b>${child()}</b>`;
          case "em":
            return `<i>${child()}</i>`;
          case "del":
            return `<s>${child()}</s>`;
          case "codespan":
            return copyCodeHtml(t.text);
          case "code":
            return `<pre><code${/^[\w#+.-]{1,40}$/.test(t.lang ?? "") ? ` class="language-${escapeHtml(t.lang)}"` : ""}>${escapeHtml(t.text)}</code></pre>`;
          case "heading":
            return `<h${t.depth}>${child()}</h${t.depth}>`;
          case "br":
            return "<br/>";
          case "hr":
            return "<hr/>";
          case "blockquote":
            return `<blockquote>${child()}</blockquote>`;
          case "link":
          case "image": {
            const url = decodeHTML(t.href),
              label = child() || escapeHtml(t.text ?? url);
            const suffix =
              decodeHTML(label.replace(/<[^>]*>/g, "")) === url
                ? ""
                : escapeHtml(` (${url})`);
            return (
              (safeUrl(url) && !label.includes("<tg-button ")
                ? `<a href="${escapeHtml(url)}">${label}</a>`
                : label) + suffix
            );
          }
          case "list":
            return `<${t.ordered ? "ol" : "ul"}>${t.items.map((i: any) => `<li>${i.task ? (i.checked ? "☑ " : "☐ ") : ""}${walk(i.tokens, depth + 1)}</li>`).join("")}</${t.ordered ? "ol" : "ul"}>`;
          case "checkbox":
            return "";
          case "table": {
            if (t.header.length > 20) return `<p>${escapeHtml(t.raw)}</p>`;
            const row = (cells: any[], tag: string) =>
              `<tr>${cells.map((c) => `<${tag}>${walk(c.tokens, depth + 1)}</${tag}>`).join("")}</tr>`;
            return `<table>${row(t.header, "th")}${t.rows.map((r: any[]) => row(r, "td")).join("")}</table>`;
          }
          default:
            return escapeHtml(t.raw ?? "");
        }
      })
      .join("");
  try {
    return walk(Lexer.lex(input, { gfm: true }));
  } catch {
    return `<p>${escapeHtml(input)}</p>`;
  }
}

export function richMessage(
  part: RichText & { bodyHtml?: string; footerOffset?: number },
): { html: string } {
  const offset = part.footerOffset;
  const body =
    offset === undefined
      ? part
      : {
          text: part.text.slice(0, offset).replace(/\n$/, ""),
          entities: part.entities.filter((e) => e.offset + e.length <= offset),
        };
  const html = part.bodyHtml ?? entityHtml(body);
  return {
    html:
      html +
      (offset === undefined
        ? ""
        : `<footer>${escapeHtml(part.text.slice(offset))}</footer>`),
  };
}

export function richFields(
  part: RichText & { bodyHtml?: string; footerOffset?: number },
) {
  return { rich_message: richMessage(part) };
}

/** Compact tool lines with explicit breaks; HTML collapses raw whitespace. */
export function activityHtml(text: string): string {
  return (
    "<p>" +
    text
      .split("\n")
      .map((line) => {
        const safe = escapeHtml(line).replace(/^ +/, (spaces) =>
          "&nbsp;".repeat(spaces.length),
        );
        const command =
          /^(• (?:Ran|Running|Failed(?: \(exit -?\d+\))?)) (.+)$/.exec(line);
        if (command)
          return `<code><b>${escapeHtml(command[1])}</b> ${escapeHtml(command[2])}</code>`;
        return line.startsWith("• ")
          ? `<b><code>${safe}</code></b>`
          : `<code>${safe}</code>`;
      })
      .join("<br/>") +
    "</p>"
  );
}
