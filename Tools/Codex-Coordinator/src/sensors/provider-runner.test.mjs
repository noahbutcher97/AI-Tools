import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateProviderResult } from "../contracts.mjs";
import {
  DEFAULT_PROVIDER_CONCURRENCY,
  DEFAULT_PROVIDER_MAX_OUTPUT_BYTES,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  runProvider,
  runProviderBatch,
} from "./provider-runner.mjs";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/provider-fixture.mjs", import.meta.url),
);
const GENERATION_ID = "provider-generation-1";

function asPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function request(operation, overrides = {}) {
  return {
    modulePath: FIXTURE_PATH,
    operation,
    input: {},
    generationId: GENERATION_ID,
    timeoutMs: 2_000,
    maxOutputBytes: 256 * 1_024,
    ...overrides,
  };
}

async function runWithResponsivePeerCallback(
  operation,
  overrides,
) {
  let providerSettled = false;
  let peerCallbacks = 0;
  let supervisorTimerFired = false;
  const provider = runProvider(request(operation, overrides)).finally(() => {
    providerSettled = true;
  });
  const supervisorTimer = setTimeout(() => {
    supervisorTimerFired = true;
  }, 10);

  await new Promise((resolve) => {
    setImmediate(() => {
      peerCallbacks += 1;
      resolve();
    });
  });
  assert.equal(
    providerSettled,
    false,
    `${operation} blocked the supervisor event loop`,
  );
  assert.equal(peerCallbacks, 1);

  const result = await provider;
  clearTimeout(supervisorTimer);
  assert.equal(
    supervisorTimerFired,
    true,
    `${operation} prevented supervisor timers from running`,
  );
  await new Promise((resolve) => {
    setImmediate(() => {
      peerCallbacks += 1;
      resolve();
    });
  });
  assert.equal(peerCallbacks, 2);
  return result;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`child process ${pid} remained alive after provider timeout`);
}

test("provider runner defaults enforce the v1 execution bounds", () => {
  assert.equal(DEFAULT_PROVIDER_CONCURRENCY, 3);
  assert.equal(DEFAULT_PROVIDER_TIMEOUT_MS, 30_000);
  assert.equal(DEFAULT_PROVIDER_MAX_OUTPUT_BYTES, 256 * 1_024);
  assert.throws(
    () =>
      runProvider(
        request("success", {
          timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS + 1,
        }),
      ),
    /timeout/i,
  );
});

test("provider runner applies default timeout and output bounds", async () => {
  const result = await runProvider({
    modulePath: FIXTURE_PATH,
    operation: "success",
    input: { value: "defaults" },
    generationId: GENERATION_ID,
  });

  assert.equal(result.status, "observed");
  assert.deepEqual(asPlainJson(result.value), { echo: "defaults" });
});

test("provider success returns a validated matching generation and operation", async () => {
  const result = await runWithResponsivePeerCallback("success", {
    input: { value: "ready" },
  });

  assert.deepEqual(asPlainJson(result.value), { echo: "ready" });
  assert.equal(result.status, "observed");
  assert.equal(result.generationId, GENERATION_ID);
  assert.equal(result.operation, "success");
  assert.equal(result.truncated, false);
  assert.ok(result.durationMs >= 0);
  assert.deepEqual(validateProviderResult(result), result);
});

test("provider exceptions and exits become typed unavailable results", async (t) => {
  for (const operation of ["exception", "exit"]) {
    await t.test(operation, async () => {
      const result = await runWithResponsivePeerCallback(operation, {});
      assert.equal(result.status, "unavailable");
      assert.equal(result.generationId, GENERATION_ID);
      assert.equal(result.operation, operation);
      assert.match(result.diagnostic, /exception|exit/i);
      assert.deepEqual(validateProviderResult(result), result);
    });
  }
});

test("malformed provider output and provenance mismatches are invalid", async (t) => {
  for (const operation of [
    "malformed-json",
    "malformed-result",
    "wrong-generation",
    "wrong-operation",
  ]) {
    await t.test(operation, async () => {
      const result = await runWithResponsivePeerCallback(operation, {});
      assert.equal(result.status, "invalid");
      assert.equal(result.generationId, GENERATION_ID);
      assert.equal(result.operation, operation);
      assert.match(
        result.diagnostic,
        /malformed|provider|generation|operation/i,
      );
      assert.deepEqual(validateProviderResult(result), result);
    });
  }
});

test("oversized provider stdout and stderr are capped and invalid", async (t) => {
  for (const operation of [
    "oversized-stdout",
    "oversized-stderr",
    "combined-output",
  ]) {
    await t.test(operation, async () => {
      const result = await runWithResponsivePeerCallback(operation, {
        input: { bytes: 32_768 },
        maxOutputBytes: 8_192,
      });
      assert.equal(result.status, "invalid");
      assert.equal(result.truncated, true);
      assert.equal(result.byteLength, 8_192);
      assert.match(result.diagnostic, /output|stderr|stdout|limit/i);
      assert.deepEqual(validateProviderResult(result), result);
    });
  }
});

test("provider cancellation contains a running worker before timeout", async () => {
  const controller = new AbortController();
  const startedAt = performance.now();
  const provider = runProvider(
    request("ignored-cancellation", {
      signal: controller.signal,
      timeoutMs: 10_000,
    }),
  );
  setTimeout(() => controller.abort("sample-superseded"), 100);

  const result = await provider;
  assert.equal(result.status, "unavailable");
  assert.match(result.diagnostic, /cancel/i);
  assert.ok(performance.now() - startedAt < 5_000);
  assert.deepEqual(validateProviderResult(result), result);
});

test("provider timeout contains infinite and cancellation-ignoring workers", async (t) => {
  for (const operation of ["infinite-loop", "ignored-cancellation"]) {
    await t.test(operation, async () => {
      const result = await runWithResponsivePeerCallback(operation, {
        timeoutMs: 300,
      });
      assert.equal(result.status, "timed-out");
      assert.match(result.diagnostic, /process-tree|terminat/i);
      assert.deepEqual(validateProviderResult(result), result);
    });
  }
});

test("delayed provider success remains responsive and within its timeout", async () => {
  const result = await runWithResponsivePeerCallback("delayed-success", {
    input: { delayMs: 100 },
    timeoutMs: 1_000,
  });
  assert.equal(result.status, "observed");
  assert.deepEqual(asPlainJson(result.value), { delayed: true });
});

test("provider timeout terminates the recorded child process tree only", async () => {
  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );
  try {
    const result = await runWithResponsivePeerCallback(
      "child-process-spawn",
      { timeoutMs: 500 },
    );

    assert.equal(result.status, "timed-out");
    assert.match(
      result.diagnostic,
      /termination=process-tree-terminated/i,
    );
    const childPid = Number(
      result.diagnostic.match(/childPids=([0-9]+)/i)?.[1],
    );
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    await waitForProcessExit(childPid);
    assert.equal(isProcessAlive(unrelated.pid), true);
    assert.equal(process.pid > 0, true);
  } finally {
    unrelated.kill();
  }
});

test("provider success cleans up detached descendants before returning", async () => {
  let childPid;
  try {
    const result = await runWithResponsivePeerCallback(
      "detached-child-success",
      {},
    );
    assert.equal(result.status, "observed");
    childPid = result.value.childPid;
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
    await waitForProcessExit(childPid);
  } finally {
    if (Number.isSafeInteger(childPid) && isProcessAlive(childPid)) {
      process.kill(childPid);
    }
  }
});

test("provider input must be bounded JSON before a worker starts", async () => {
  await assert.rejects(
    Promise.resolve().then(() =>
      runProvider(request("success", { input: undefined })),
    ),
    /JSON/i,
  );
});

test("provider batch rejects an over-budget declaration before partial start", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "codex-provider-budget-"),
  );
  const markerPath = path.join(root, "started.txt");
  try {
    const requests = [1, 2].map((id) => ({
      ...request("success", {
        input: { markerPath, value: id },
      }),
      cost: 2,
    }));

    await assert.rejects(
      runProviderBatch(requests, { concurrency: 2, costBudget: 3 }),
      /cost budget/i,
    );
    await assert.rejects(readFile(markerPath, "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider batch preserves order and never exceeds declared concurrency", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "codex-provider-concurrency-"),
  );
  const markerPath = path.join(root, "events.txt");
  try {
    const requests = [1, 2, 3, 4, 5].map((id) => ({
      ...request("tracked-delay", {
        input: { id, markerPath, delayMs: 100 },
      }),
      cost: 1,
    }));
    const results = await runProviderBatch(requests, {
      concurrency: 2,
      costBudget: 5,
    });

    assert.deepEqual(
      results.map((result) => result.value.id),
      [1, 2, 3, 4, 5],
    );
    const events = (await readFile(markerPath, "utf8"))
      .trim()
      .split(/\r?\n/);
    let active = 0;
    let peak = 0;
    for (const event of events) {
      active += event.startsWith("start:") ? 1 : -1;
      peak = Math.max(peak, active);
      assert.ok(active >= 0);
    }
    assert.equal(active, 0);
    assert.equal(peak, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
