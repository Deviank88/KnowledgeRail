import * as nodePath from "node:path";

export interface CodeResourceReference {
  path: string;
  fragmentId: string;
}

function decodedComponent(value: string, uri: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Code evidence resource URI contains invalid percent encoding: ${uri}`);
  }
}

export function parseCodeResourceUri(
  uri: string,
  options: { allowWorkspaceBinding?: boolean } = {}
): CodeResourceReference {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid code evidence resource URI: ${uri}`);
  }
  if (parsed.protocol !== "code:" || parsed.hostname !== "repo") {
    throw new Error(`Code evidence resources must use code://repo/: ${uri}`);
  }
  const allowedParameters = options.allowWorkspaceBinding === false ? new Set<string>() : new Set(["workspace_binding"]);
  for (const key of parsed.searchParams.keys()) {
    if (!allowedParameters.has(key)) {
      throw new Error(`Unsupported code evidence resource URI parameter: ${key}`);
    }
  }
  if (!parsed.hash) throw new Error("Code evidence resource URI must contain one symbol fragment.");
  const path = parsed.pathname.slice(1).split("/").map((part) => decodedComponent(part, uri)).join("/");
  const fragmentId = decodedComponent(parsed.hash.slice(1), uri);
  const normalizedPath = path.replace(/\\/g, "/").normalize("NFC");
  if (
    !normalizedPath || normalizedPath !== path || nodePath.posix.isAbsolute(normalizedPath) ||
    /^[A-Za-z]:/u.test(normalizedPath) ||
    nodePath.posix.normalize(normalizedPath) !== normalizedPath ||
    normalizedPath.split("/").some((part) => !part || part === "." || part === "..") ||
    !/^symbol-[a-f0-9]{20}$/.test(fragmentId)
  ) {
    throw new Error(`Code evidence resource URI has an invalid repository path or symbol: ${uri}`);
  }
  return { path: normalizedPath, fragmentId };
}

export function canonicalCodeResourceUri(uri: string): string {
  const reference = parseCodeResourceUri(uri, { allowWorkspaceBinding: false });
  const encodedPath = reference.path.split("/").map(encodeURIComponent).join("/");
  return `code://repo/${encodedPath}#${encodeURIComponent(reference.fragmentId)}`;
}
