/** Shared conservative XML primitives; no entity expansion or external reads. */
export interface XmlSpan {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
}

export function wellFormedXml(content: string): boolean {
  const stack: string[] = [];
  let rootElements = 0;
  for (let offset = 0; offset < content.length;) {
    const start = content.indexOf("<", offset);
    if (start < 0) return !content.slice(offset).trim() && rootElements === 1 && stack.length === 0;
    if (stack.length === 0 && content.slice(offset, start).trim()) return false;
    if (content.startsWith("<!--", start)) {
      const end = content.indexOf("-->", start + 4);
      if (end < 0) return false;
      offset = end + 3;
      continue;
    }
    if (content.startsWith("<![CDATA[", start)) {
      if (stack.length === 0) return false;
      const end = content.indexOf("]]>", start + 9);
      if (end < 0) return false;
      offset = end + 3;
      continue;
    }
    if (content.startsWith("<?", start)) {
      const end = content.indexOf("?>", start + 2);
      if (end < 0) return false;
      offset = end + 2;
      continue;
    }
    let quote = "";
    let end = start + 1;
    for (; end < content.length; end++) {
      const value = content[end]!;
      if (quote) {
        if (value === quote) quote = "";
      } else if (value === "\"" || value === "'") {
        quote = value;
      } else if (value === ">") {
        break;
      }
    }
    if (end >= content.length || quote) return false;
    const token = content.slice(start + 1, end).trim();
    if (token.startsWith("!")) return false;
    const closing = token.startsWith("/");
    const selfClosing = !closing && token.endsWith("/");
    const name = /^\/?([A-Za-z_][\w:.-]*)(?:\s|\/|$)/u.exec(token)?.[1];
    if (!name) return false;
    if (closing) {
      if (token.slice(1 + name.length).trim() || stack.pop() !== name) return false;
    } else {
      if (stack.length === 0 && ++rootElements > 1) return false;
      if (!selfClosing) stack.push(name);
    }
    offset = end + 1;
  }
  return rootElements === 1 && stack.length === 0;
}

export function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function elementSpans(content: string, tag: string): XmlSpan[] {
  const values: XmlSpan[] = [];
  const visible = content.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/gu, (value) => value.replace(/[^\r\n]/gu, " "));
  const lower = visible.toLowerCase();
  const open = new RegExp(`<${tag}\\b[^>]*>`, "giu");
  const closeToken = `</${tag.toLowerCase()}>`;
  for (const match of visible.matchAll(open)) {
    const start = match.index ?? 0;
    const bodyStart = start + match[0].length;
    const close = lower.indexOf(closeToken, bodyStart);
    if (close < 0) continue;
    values.push({ start, bodyStart, bodyEnd: close, end: close + closeToken.length });
  }
  return values;
}

export function firstElement(content: string, tag: string): XmlSpan | undefined {
  return elementSpans(content, tag)[0];
}

export function childText(content: string, tag: string, within?: XmlSpan): string | undefined {
  const start = within?.bodyStart ?? 0;
  const end = within?.bodyEnd ?? content.length;
  const slice = content.slice(start, end);
  const span = firstElement(slice, tag);
  return span ? decodeXml(slice.slice(span.bodyStart, span.bodyEnd)) || undefined : undefined;
}
