import { decodeHTML } from "entities";

// Decode the wire HTML for content assertions shared with attachment/legacy
// tests. New Rich Message protocol tests assert the untouched payload directly.
export function telegramView(params: any) {
  if (!params?.rich_message?.html) return params;
  let text = "",
    separator = "";
  const entities: any[] = [],
    stack: any[] = [];
  const styles: Record<string, string> = {
    b: "bold",
    strong: "bold",
    i: "italic",
    em: "italic",
    s: "strikethrough",
    code: "code",
    "tg-button": "code",
    pre: "pre",
    blockquote: "blockquote",
    a: "text_link",
    footer: "footer",
  };
  for (const token of params.rich_message.html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (!token.startsWith("<")) {
      if (separator) {
        text += separator;
        separator = "";
      }
      text += decodeHTML(token).replaceAll("\u00a0", " ");
      continue;
    }
    const tag = /^<\/?([\w-]+)/.exec(token)?.[1];
    if (!tag) continue;
    if (token.startsWith("</")) {
      if (styles[tag]) {
        const index = stack.findLastIndex((e) => e.tag === tag);
        if (index >= 0) {
          const [entry] = stack.splice(index, 1);
          if (text.length > entry.offset)
            entities.push({
              type: styles[tag],
              offset: entry.offset,
              length: text.length - entry.offset,
            });
        }
      }
      if (/^(p|h[1-6]|li|tr)$/.test(tag)) separator = "\n\n";
    } else {
      if (tag === "br") {
        text += "\n";
        continue;
      }
      if (tag === "footer") separator = text ? "\n" : "";
      if (tag === "hr") {
        text += separator + "────────";
        separator = "\n\n";
      }
      if (styles[tag]) {
        if (separator) {
          text += separator;
          separator = "";
        }
        stack.push({ tag, offset: text.length });
      }
    }
  }
  return {
    ...params,
    text,
    entities: entities.sort(
      (a, b) => a.offset - b.offset || b.length - a.length,
    ),
  };
}
