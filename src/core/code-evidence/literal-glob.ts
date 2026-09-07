/** Literal glob matching without regular-expression backtracking. Compilation is
 * shared by all names in a manifest. The general case takes O(pattern × value)
 * time and O(value) space; literal patterns need no matching buffers. */
export function literalGlob(pattern: string, options: { pathPrefix?: boolean; questionMark?: boolean } = {}): (value: string) => boolean {
  const { pathPrefix = false, questionMark = false } = options;
  if (!pattern.includes("*") && !(questionMark && pattern.includes("?"))) {
    return (value) => value === pattern || (pathPrefix && (!pattern || value.startsWith(`${pattern}/`)));
  }
  const tokens: Array<{ literal?: string; star?: boolean; question?: boolean }> = [];
  for (const char of pattern) {
    if (char === "*") {
      const previous = tokens.at(-1);
      if (previous?.star !== undefined) previous.star = true;
      else tokens.push({ star: !pathPrefix });
    } else tokens.push(questionMark && char === "?" ? { question: true } : { literal: char });
  }
  return (value) => {
    const chars = [...value];
    let previous = new Uint8Array(chars.length + 1), next = new Uint8Array(chars.length + 1);
    previous[0] = 1;
    for (const token of tokens) {
      next.fill(0);
      if (token.star !== undefined) {
        next[0] = previous[0]!;
        for (let i = 1; i <= chars.length; i++) next[i] = previous[i]! || (next[i - 1]! && (token.star || chars[i - 1] !== "/") ? 1 : 0);
      } else {
        for (let i = 1; i <= chars.length; i++) next[i] = previous[i - 1]! && (token.question || token.literal === chars[i - 1]) ? 1 : 0;
      }
      [previous, next] = [next, previous];
    }
    return Boolean(previous[chars.length]) || (pathPrefix && chars.some((char, index) => char === "/" && previous[index]));
  };
}
