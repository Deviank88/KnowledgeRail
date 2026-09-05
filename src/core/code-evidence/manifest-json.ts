/** JSON with line/block comments and trailing commas. String contents are never
 * rewritten; JSON.parse still validates all values and the remaining grammar. */
export function parseManifestJson(content: string): unknown {
  const chars = content.replace(/^\uFEFF/u, "").split("");
  let inString = false;
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char !== "/") continue;
    if (chars[i + 1] === "/") {
      while (i < chars.length && chars[i] !== "\n" && chars[i] !== "\r") chars[i++] = " ";
    } else if (chars[i + 1] === "*") {
      chars[i++] = " ";
      chars[i++] = " ";
      while (i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) chars[i++] = " ";
      if (i === chars.length) throw new Error("Unterminated manifest comment.");
      chars[i] = chars[++i] = " ";
    }
  }
  inString = false;
  for (let i = 0; i < chars.length; i++) {
    if (inString) {
      if (chars[i] === "\\") i++;
      else if (chars[i] === '"') inString = false;
    } else if (chars[i] === '"') inString = true;
    else if (chars[i] === ",") {
      let next = i + 1;
      while (/[\t\n\r ]/u.test(chars[next] ?? "x")) next++;
      let previous = i - 1;
      while (/[\t\n\r ]/u.test(chars[previous] ?? "x")) previous--;
      if ((chars[next] === "}" || chars[next] === "]") && !["[", "{", ","].includes(chars[previous] ?? "")) chars[i] = " ";
    }
  }
  return JSON.parse(chars.join("")) as unknown;
}
