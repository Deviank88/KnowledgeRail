import * as nodePath from "node:path";

interface WorkspaceStateEntry {
  disposers: Map<string, () => void>;
}

const entries = new Map<string, WorkspaceStateEntry>();
const DEFAULT_WORKSPACE_STATE_CAP = 5;

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
    // Registration and access move entries to the end of the Map. Its order
    // remains exact even when timestamps tie or the wall clock moves backward.
    const oldest = entries.keys().next();
    if (oldest.done) return;
    disposeRoot(oldest.value);
  }
}

export function registerWorkspaceState(
  wikiRoot: string,
  key: string,
  dispose: () => void
): void {
  const root = normalized(wikiRoot);
  const entry = entries.get(root) ?? { disposers: new Map() };
  entry.disposers.set(key, dispose);
  entries.delete(root);
  entries.set(root, entry);
  enforceCap();
}

export function touchWorkspaceState(wikiRoot: string): void {
  const root = normalized(wikiRoot);
  const entry = entries.get(root);
  if (!entry) return;
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
