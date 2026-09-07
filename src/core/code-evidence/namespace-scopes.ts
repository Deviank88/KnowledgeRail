/** Namespace lookup over already masked source. One brace scan and binary search
 * per declaration; strings, comments and HTML cannot introduce scopes. */
export function namespaceScopes(masked: string, language: "csharp" | "php"): (offset: number) => string {
  const ends = new Map<number, number>(), braces: number[] = [];
  for (let offset = 0; offset < masked.length; offset++) {
    if (masked[offset] === "{") braces.push(offset);
    else if (masked[offset] === "}") {
      const open = braces.pop();
      if (open !== undefined) ends.set(open, offset + 1);
    }
  }
  const pattern = language === "csharp"
    ? /\bnamespace\s+([A-Za-z_][\w.]*)\s*([;{])/gu
    : /\bnamespace(?:\s+([A-Za-z_]\w*(?:\\[A-Za-z_]\w*)*))?\s*([;{])/giu;
  const scopes: Array<{ start: number; end: number; name: string; parent: number }> = [];
  const active: number[] = [];
  for (const match of masked.matchAll(pattern)) {
    const start = match.index, open = start + match[0].length - 1;
    while (active.length && scopes[active.at(-1)!]!.end <= start) active.pop();
    if (match[2] === ";" && active.length) {
      // PHP's successive unbracketed namespaces replace the previous one.
      scopes[active.pop()!]!.end = start;
    }
    const parent = active.at(-1) ?? -1;
    const prefix = language === "csharp" && parent >= 0 ? scopes[parent]!.name : "";
    scopes.push({ start, end: match[2] === "{" ? ends.get(open) ?? start : masked.length,
      name: [prefix, match[1] ?? ""].filter(Boolean).join("."), parent });
    active.push(scopes.length - 1);
  }
  return (offset) => {
    let low = 0, high = scopes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (scopes[middle]!.start <= offset) low = middle + 1;
      else high = middle;
    }
    let index = low - 1;
    while (index >= 0) {
      const scope = scopes[index]!;
      if (offset < scope.end) return scope.name;
      index = scope.parent;
    }
    return "";
  };
}
