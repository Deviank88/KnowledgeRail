export const MINIMUM_NODE_VERSION = "22.12.0";

interface NodeVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseNodeVersion(version: string): NodeVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compare(left: NodeVersion, right: NodeVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

const minimum = parseNodeVersion(MINIMUM_NODE_VERSION)!;

export function isSupportedNodeRuntime(version = process.versions.node): boolean {
  const parsed = parseNodeVersion(version);
  return parsed !== null && compare(parsed, minimum) >= 0;
}

export function assertSupportedNodeRuntime(version = process.versions.node): void {
  if (isSupportedNodeRuntime(version)) return;
  throw new Error(
    `KnowledgeRail v4 requires Node.js >= ${MINIMUM_NODE_VERSION}; detected ${version}. ` +
    "Upgrade the runtime before starting KnowledgeRail or migrating an existing project. " +
    "No wiki files have been modified."
  );
}
