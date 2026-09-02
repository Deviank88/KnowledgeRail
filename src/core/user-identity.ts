import { execFile } from "node:child_process";
import * as nodePath from "node:path";
import { getActiveWorkspaceContext } from "./workspace-context.js";
import { emailDomainFromAddress } from "./stakeholder.js";

export type UserEmailDomainSource = "environment" | "git" | "unknown";

export interface WorkspaceUserIdentity {
  /** Privacy-preserving domain only; the complete address is never retained. */
  userEmailDomain: string | null;
  source: UserEmailDomainSource;
}

interface IdentityDependencies {
  environmentEmail?: () => string | undefined;
  gitEmail?: (projectRoot: string) => Promise<string | undefined>;
}

const identityByProject = new Map<string, Promise<WorkspaceUserIdentity>>();

function readGitEmail(projectRoot: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["config", "--get", "user.email"],
      { cwd: projectRoot, encoding: "utf8", timeout: 1_500, maxBuffer: 4_096, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : String(stdout).trim() || undefined)
    );
  });
}

async function resolveUncached(
  projectRoot: string,
  dependencies: IdentityDependencies
): Promise<WorkspaceUserIdentity> {
  const environmentDomain = emailDomainFromAddress(
    (dependencies.environmentEmail ?? (() => process.env.KNOWLEDGE_RAIL_USER_EMAIL))()
  );
  if (environmentDomain) return { userEmailDomain: environmentDomain, source: "environment" };

  const gitDomain = emailDomainFromAddress(
    await (dependencies.gitEmail ?? readGitEmail)(projectRoot).catch(() => undefined)
  );
  return gitDomain
    ? { userEmailDomain: gitDomain, source: "git" }
    : { userEmailDomain: null, source: "unknown" };
}

export function resolveWorkspaceUserIdentity(
  projectRoot: string,
  dependencies: IdentityDependencies = {}
): Promise<WorkspaceUserIdentity> {
  const root = nodePath.resolve(projectRoot);
  if (dependencies.environmentEmail || dependencies.gitEmail) {
    return resolveUncached(root, dependencies);
  }
  const existing = identityByProject.get(root);
  if (existing) return existing;
  const pending = resolveUncached(root, dependencies);
  identityByProject.set(root, pending);
  return pending;
}

export async function currentWorkspaceUserIdentity(projectRoot: string): Promise<WorkspaceUserIdentity> {
  const active = getActiveWorkspaceContext();
  if (active?.authorized && nodePath.resolve(active.paths.projectRoot) === nodePath.resolve(projectRoot)) {
    return { userEmailDomain: active.userEmailDomain, source: active.userEmailDomainSource };
  }
  return resolveWorkspaceUserIdentity(projectRoot);
}

export function clearWorkspaceUserIdentityCacheForTests(): void {
  identityByProject.clear();
}
