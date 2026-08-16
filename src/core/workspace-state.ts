import * as nodePath from "node:path";

interface WorkspaceStateEntry {
  touchedAt: number;
  disposers: Map<string, () => void>;
}

const entries = new Map<string, WorkspaceStateEntry>();
const DEFAULT_WORKSPACE_STATE_CAP = 32;

function normalized(root: string): string {
  return nodePath.resolve(root);
}

function configuredCap(): number {
  const value = Number(process.env["KNOWLEDGE_RAIL_WORKSPACE_STATE_CAP"] ?? DEFAULT_WORKSPACE_STATE_CAP);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_WORKSPACE_STATE_CAP;
}

function disposeRoot(root: string): void {
  const entry = entries.get(root);
  if (!entry) return;
  entries.delete(root);
  for (const dispose of entry.disposers.values()) dispose();
}

function enforceCap(): void {
  const cap = configuredCap();
  while (entries.size > cap) {
    const oldest = [...entries.entries()].sort((left, right) =>
      left[1].touchedAt - right[1].touchedAt || left[0].localeCompare(right[0])
    )[0];
    if (!oldest) return;
    disposeRoot(oldest[0]);
  }
}

export function registerWorkspaceState(
  wikiRoot: string,
  key: string,
  dispose: () => void
): void {
  const root = normalized(wikiRoot);
  const entry = entries.get(root) ?? { touchedAt: Date.now(), disposers: new Map() };
  entry.touchedAt = Date.now();
  entry.disposers.set(key, dispose);
  entries.delete(root);
  entries.set(root, entry);
  enforceCap();
}

export function touchWorkspaceState(wikiRoot: string): void {
  const root = normalized(wikiRoot);
  const entry = entries.get(root);
  if (!entry) return;
  entry.touchedAt = Date.now();
  entries.delete(root);
  entries.set(root, entry);
}

export function evictWorkspaceState(wikiRoot: string): void {
  disposeRoot(normalized(wikiRoot));
}

export function evictWorkspaceStateForProject(projectRoot: string): void {
  evictWorkspaceState(nodePath.join(projectRoot, "wiki"));
}

export function clearWorkspaceStates(): void {
  for (const root of [...entries.keys()]) disposeRoot(root);
}

export function workspaceStateCount(): number {
  return entries.size;
}
