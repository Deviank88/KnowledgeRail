import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSupportedNodeRuntime,
  isSupportedNodeRuntime,
  MINIMUM_NODE_VERSION,
} from "../src/core/runtime-compatibility.js";

test("Node runtime compatibility accepts the v4 floor and newer supported releases", () => {
  assert.equal(MINIMUM_NODE_VERSION, "22.12.0");
  assert.equal(isSupportedNodeRuntime("22.12.0"), true);
  assert.equal(isSupportedNodeRuntime("22.12.1"), true);
  assert.equal(isSupportedNodeRuntime("22.99.0"), true);
  assert.equal(isSupportedNodeRuntime("24.0.0"), true);
  assert.equal(isSupportedNodeRuntime("25.0.0-pre"), true);
});

test("Node runtime compatibility rejects EOL/too-old and malformed runtimes", () => {
  assert.equal(isSupportedNodeRuntime("20.20.2"), false);
  assert.equal(isSupportedNodeRuntime("22.11.99"), false);
  assert.equal(isSupportedNodeRuntime("not-a-version"), false);

  assert.throws(
    () => assertSupportedNodeRuntime("20.20.2"),
    /requires Node\.js >= 22\.12\.0.*No wiki files have been modified/s
  );
});
