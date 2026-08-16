import assert from "node:assert/strict";
import { test } from "node:test";
import { logger } from "../src/core/logger.js";

test("structured logger reports subsystem errors without paths or bindings", () => {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    logger.error("gateway", "forced_failure", { requestId: "request-safe" }, new Error(
      "Failed at /private/customer/project/wiki/Page.md with krb1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
    ));
  } finally {
    process.stderr.write = originalWrite as typeof process.stderr.write;
  }

  const record = JSON.parse(output) as Record<string, unknown>;
  assert.equal(record.level, "error");
  assert.equal(record.subsystem, "gateway");
  assert.equal(record.event, "forced_failure");
  assert.equal(record.requestId, "request-safe");
  assert.equal(output.includes("/private/customer"), false);
  assert.equal(output.includes("krb1_"), false);
  assert.match(String(record.errorMessage), /<path>/);
  assert.match(String(record.errorMessage), /<binding>/);
});
