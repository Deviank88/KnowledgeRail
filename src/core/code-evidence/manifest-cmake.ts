/** Bounded by the shared manifest byte limit. Decode CMake command boundaries,
 * quoted/bracket arguments and comments without evaluating variables or calls. */
export function cmakeCommands(content: string): Array<{ name: string; args: string[] }> {
  const result: Array<{ name: string; args: string[] }> = [];
  let index = 0;
  const bracket = (): string | undefined => {
    const open = /^\[(=*)\[/u.exec(content.slice(index, index + 64));
    if (!open) return;
    const start = index + open[0].length, end = content.indexOf(`]${open[1]}]`, start);
    if (end < 0) throw new Error("Unterminated CMake bracket argument.");
    index = end + open[0].length;
    return content.slice(start, end);
  };
  const comment = () => {
    index++;
    if (bracket() === undefined) {
      const end = content.indexOf("\n", index); index = end < 0 ? content.length : end;
    }
  };
  while (index < content.length) {
    if (/\s/u.test(content[index]!)) { index++; continue; }
    if (content[index] === "#") { comment(); continue; }
    const name = /^[A-Za-z_]\w*/u.exec(content.slice(index));
    if (!name) throw new Error("Invalid CMake command.");
    index += name[0].length;
    while (/\s/u.test(content[index] ?? "")) index++;
    if (content[index++] !== "(") throw new Error("Invalid CMake command arguments.");
    const args: string[] = [];
    let depth = 1, token = "", active = false;
    const flush = () => { if (active) args.push(token); token = ""; active = false; };
    while (index < content.length && depth) {
      const char = content[index]!;
      if (char === "#") { flush(); comment(); continue; }
      if (/\s/u.test(char)) { flush(); index++; continue; }
      if (char === "\"") {
        index++; active = true;
        while (index < content.length && content[index] !== "\"") {
          if (content[index] === "\\") index++;
          if (index < content.length) token += content[index++];
        }
        if (content[index++] !== "\"") throw new Error("Unterminated CMake string.");
        continue;
      }
      const value = char === "[" ? bracket() : undefined;
      if (value !== undefined) { token += value; active = true; continue; }
      if (char === "(") depth++;
      else if (char === ")" && --depth === 0) { flush(); index++; break; }
      token += char; active = true; index++;
      if (args.length > 16_384 || depth > 32) throw new Error("CMake structure limit.");
    }
    if (depth) throw new Error("Unterminated CMake command.");
    result.push({ name: name[0].toLowerCase(), args });
  }
  return result;
}
