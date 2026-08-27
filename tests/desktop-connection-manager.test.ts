import assert from "node:assert/strict";
import { test } from "node:test";
import type { Client } from "@modelcontextprotocol/client";
import {
  DesktopGatewayAttemptTimeoutError,
  RecoverableDesktopClientProvider,
  type DesktopClientConnection,
} from "../src/desktop/connection-manager.js";

function connection(id: string, closed: string[]): DesktopClientConnection {
  return {
    client: { name: id } as unknown as Client,
    close: async () => { closed.push(id); },
  };
}

test("desktop connection provider retries after a failed attempt and stays single-flight", async () => {
  const lifecycle = new AbortController();
  const closed: string[] = [];
  let attempts = 0;
  const provider = new RecoverableDesktopClientProvider({
    lifecycleSignal: lifecycle.signal,
    maxAttempts: 1,
    retryDelayMs: 0,
    connect: async () => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      return connection("recovered", closed);
    },
  });
  await assert.rejects(provider.getClient(), /connection refused/);
  const [left, right] = await Promise.all([provider.getClient(), provider.getClient()]);
  assert.equal(left, right);
  assert.equal(attempts, 2);
  provider.invalidate(left, new Error("transport closed"));
  const replacement = await provider.getClient();
  assert.notEqual(replacement, left);
  assert.equal(attempts, 3);
  await provider.close();
  assert.deepEqual(closed, ["recovered", "recovered"]);
});

test("desktop connection provider retries with bounded backoff inside one connection budget", async () => {
  const lifecycle = new AbortController();
  let attempts = 0;
  const provider = new RecoverableDesktopClientProvider({
    lifecycleSignal: lifecycle.signal,
    attemptTimeoutMs: 50,
    connectionBudgetMs: 500,
    maxAttempts: 3,
    retryDelayMs: 1,
    connect: async () => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      return connection("third-attempt", []);
    },
  });
  assert.equal((await provider.getClient() as unknown as { name: string }).name, "third-attempt");
  assert.equal(attempts, 3);
  await provider.close();
});

test("desktop connection provider bounds a hung connection attempt", async () => {
  const lifecycle = new AbortController();
  const provider = new RecoverableDesktopClientProvider({
    lifecycleSignal: lifecycle.signal,
    attemptTimeoutMs: 20,
    retryDelayMs: 0,
    connect: async () => new Promise<DesktopClientConnection>(() => undefined),
  });
  await assert.rejects(
    provider.getClient(),
    (error: unknown) => error instanceof DesktopGatewayAttemptTimeoutError && error.code === "connection_timeout"
  );
  lifecycle.abort();
  await provider.close();
});
