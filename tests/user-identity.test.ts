import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveWorkspaceUserIdentity,
} from "../src/core/user-identity.js";

test("workspace identity keeps only the environment email domain and prefers it to git", async () => {
  let gitCalled = false;
  const identity = await resolveWorkspaceUserIdentity(".", {
    environmentEmail: () => "Person@Internal.Example",
    gitEmail: async () => {
      gitCalled = true;
      return "other@git.example";
    },
  });
  assert.deepEqual(identity, { userEmailDomain: "internal.example", source: "environment" });
  assert.equal(gitCalled, false);
  assert.equal(JSON.stringify(identity).includes("Person@"), false);
});

test("workspace identity falls back to git and then to unknown", async () => {
  assert.deepEqual(await resolveWorkspaceUserIdentity(".", {
    environmentEmail: () => undefined,
    gitEmail: async () => "developer@Git.Example",
  }), { userEmailDomain: "git.example", source: "git" });

  assert.deepEqual(await resolveWorkspaceUserIdentity(".", {
    environmentEmail: () => "not-an-email",
    gitEmail: async () => undefined,
  }), { userEmailDomain: null, source: "unknown" });
});
