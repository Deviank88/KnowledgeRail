/** Small deterministic TOML reader for project declarations. No evaluation or
 * interpolation. Optional field projection validates only selected values;
 * lexical boundaries and resource limits always remain enforced. */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable { [key: string]: TomlValue }
export function parseManifestToml(text: string, fields?: readonly (readonly string[])[]): TomlTable {
  let offset = 0, nodes = 0;
  const root: TomlTable = Object.create(null) as TomlTable;
  const declared = new Set<string>();
  const inlineTables = new WeakSet<TomlTable>();
  let current = root;
  let currentPath: string[] = [];
  const relevant = (path: readonly string[]) => !fields || fields.some((field) =>
    field.slice(0, Math.min(field.length, path.length)).every((part, index) => part === path[index]));
  const fail = (): never => { throw new Error("Unsupported or malformed TOML declaration."); };
  const space = (newlines = false): void => {
    while (offset < text.length) {
      if (text[offset] === "#") { while (offset < text.length && text[offset] !== "\n") offset++; }
      else if ((newlines ? /\s/u : /[ \t\r]/u).test(text[offset]!)) offset++;
      else break;
    }
  };
  const string = (): string => {
    const quote = text[offset++]!, triple = text.slice(offset, offset + 2) === quote.repeat(2);
    if (triple) { offset += 2; if (text[offset] === "\n") offset++; }
    let value = "";
    while (offset < text.length) {
      if (text[offset] === quote && (!triple || text.slice(offset, offset + 3) === quote.repeat(3))) {
        offset += triple ? 3 : 1; return value;
      }
      const c = text[offset++]!;
      if (!triple && /[\r\n]/u.test(c)) fail();
      if (c !== "\\" || quote === "'") { value += c; continue; }
      const escaped = text[offset++]!;
      const escapes: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
      if (escaped in escapes) value += escapes[escaped];
      else if (escaped === "u" || escaped === "U") {
        const count = escaped === "u" ? 4 : 8, hex = text.slice(offset, offset + count);
        if (!new RegExp(`^[0-9a-fA-F]{${count}}$`, "u").test(hex)) fail();
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail();
        value += String.fromCodePoint(code); offset += count;
      } else if (triple && /\s/u.test(escaped)) { while (offset < text.length && /\s/u.test(text[offset]!)) offset++; }
      else fail();
    }
    return fail();
  };
  // Ignore values outside the requested declarations without validating their
  // grammar or allocating them. Lexical boundaries still matter: a table-looking
  // line inside a multiline string/array must never become a declaration.
  const skipValue = (inline = false): void => {
    const closers: string[] = [];
    while (offset < text.length) {
      const c = text[offset]!;
      if (!closers.length && (c === "\n" || (inline && (c === "," || c === "}")))) return;
      if (c === "#") { while (offset < text.length && text[offset] !== "\n") offset++; continue; }
      if (c === '"' || c === "'") {
        const triple = text.slice(offset, offset + 3) === c.repeat(3);
        offset += triple ? 3 : 1;
        let closed = false;
        while (offset < text.length) {
          if (text[offset] === c && (!triple || text.slice(offset, offset + 3) === c.repeat(3))) {
            offset += triple ? 3 : 1;
            // TOML permits one or two literal quotes just before a triple close.
            if (triple) for (let extra = 0; extra < 2 && text[offset] === c; extra++) offset++;
            closed = true; break;
          }
          if (!triple && text[offset] === "\n") fail();
          if (c === '"' && text[offset] === "\\") offset++;
          offset++;
        }
        if (!closed) fail();
        continue;
      }
      if (c === "[" || c === "{") {
        if (closers.length >= 32) fail();
        closers.push(c === "[" ? "]" : "}");
      } else if (closers.length && (c === "]" || c === "}")) {
        if (closers.pop() !== c) fail();
      }
      offset++;
    }
    if (closers.length) fail();
  };
  const key = (): string[] => {
    const parts: string[] = [];
    do {
      space();
      if (text[offset] === '"' || text[offset] === "'") parts.push(string());
      else { const match = /^[A-Za-z0-9_-]+/u.exec(text.slice(offset)); if (!match) fail(); parts.push(match![0]); offset += match![0].length; }
      space();
      if (text[offset] !== ".") break;
      if (parts.length >= 32) fail();
      offset++;
    } while (true);
    return parts;
  };
  const table = (parent: TomlTable, keys: string[]): TomlTable => {
    for (const part of keys) {
      const existing = parent[part];
      if (existing === undefined) parent[part] = Object.create(null) as TomlTable;
      if (!parent[part] || typeof parent[part] !== "object" || Array.isArray(parent[part])) fail();
      parent = parent[part] as TomlTable;
      if (inlineTables.has(parent)) fail();
    }
    return parent;
  };
  const assign = (parent: TomlTable, keys: string[], value: TomlValue): void => {
    const target = table(parent, keys.slice(0, -1)), name = keys.at(-1)!;
    if (Object.hasOwn(target, name)) fail();
    target[name] = value;
  };
  const value = (depth = 0, path: string[] = []): TomlValue => {
    if (++nodes > 16_384 || depth > 32) fail();
    space(true);
    if (text[offset] === '"' || text[offset] === "'") return string();
    if (text[offset] === "[") {
      offset++; const values: TomlValue[] = []; space(true);
      while (text[offset] !== "]") {
        values.push(value(depth + 1, path)); space(true);
        if (text[offset] !== ",") break; offset++; space(true);
      }
      if (text[offset++] !== "]") fail(); return values;
    }
    if (text[offset] === "{") {
      offset++; const target: TomlTable = Object.create(null) as TomlTable; space();
      while (text[offset] !== "}") {
        const keys = key(); if (text[offset++] !== "=") fail();
        if (relevant([...path, ...keys])) assign(target, keys, value(depth + 1, [...path, ...keys]));
        else skipValue(true);
        space();
        if (text[offset] !== ",") break; offset++; space();
        if (text[offset] === "}") fail();
      }
      if (text[offset++] !== "}") fail(); inlineTables.add(target); return target;
    }
    const literal = /^[^\s,#\]}]+/u.exec(text.slice(offset))?.[0] ?? "";
    offset += literal.length;
    if (literal === "true" || literal === "false") return literal === "true";
    if (/^[+-]?(?:0|[1-9][\d_]*)(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?$/u.test(literal)) {
      const number = Number(literal.replace(/_/gu, "")); if (Number.isFinite(number)) return number;
    }
    return fail();
  };
  while (true) {
    space(true); if (offset >= text.length) break;
    if (++nodes > 16_384) fail();
    if (text[offset] === "[") {
      offset++; const array = text[offset] === "["; if (array) offset++;
      const keys = key(); if (text[offset++] !== "]" || (array && text[offset++] !== "]")) fail();
      currentPath = keys;
      if (!relevant(keys)) { current = root; }
      else if (array) {
        const parent = table(root, keys.slice(0, -1)), name = keys.at(-1)!;
        if (parent[name] === undefined) parent[name] = [];
        if (!Array.isArray(parent[name])) fail();
        current = Object.create(null) as TomlTable; (parent[name] as TomlValue[]).push(current);
      } else {
        const identity = JSON.stringify(keys); if (declared.has(identity)) fail(); declared.add(identity);
        current = table(root, keys);
      }
    } else {
      if (!relevant(currentPath)) skipValue();
      else {
        const keys = key(); if (text[offset++] !== "=") fail();
        const path = [...currentPath, ...keys];
        if (relevant(path)) assign(current, keys, value(0, path));
        else skipValue();
      }
    }
    space(); if (offset < text.length && text[offset++] !== "\n") fail();
  }
  return root;
}

export function manifestTable(value: unknown): TomlTable {
  if (value === undefined) return Object.create(null) as TomlTable;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a manifest table.");
  return value as TomlTable;
}
export function manifestStrings(value: unknown): string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("Expected manifest string array.");
  return value as string[];
}
