import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateProviderResult } from "../contracts.mjs";

export const DEFAULT_PROVIDER_CONCURRENCY = 3;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
export const DEFAULT_PROVIDER_MAX_OUTPUT_BYTES = 256 * 1_024;

const MAX_PROVIDER_CONCURRENCY = 3;
const MAX_PROVIDER_TIMEOUT_MS = DEFAULT_PROVIDER_TIMEOUT_MS;
const MAX_PROVIDER_REQUEST_BYTES = 256 * 1_024;
const WORKER_PATH = fileURLToPath(
  new URL("./provider-worker.mjs", import.meta.url),
);
const REQUEST_KEYS = new Set([
  "modulePath",
  "operation",
  "input",
  "generationId",
  "timeoutMs",
  "maxOutputBytes",
  "signal",
]);
const REQUIRED_REQUEST_KEYS = new Set([
  "modulePath",
  "operation",
  "input",
  "generationId",
]);

function requireBoundedString(value, label, maxLength = 128) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new TypeError(
      `${label} must be 1 through ${maxLength} characters`,
    );
  }
  return value;
}

function requirePositiveInteger(value, label, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new RangeError(
      `${label} must be an integer between 1 and ${maximum}`,
    );
  }
  return value;
}

function cloneJson(value, label) {
  let cloned;
  try {
    cloned = structuredClone(value);
  } catch (error) {
    throw new TypeError(`${label} must be structured-cloneable`, {
      cause: error,
    });
  }
  try {
    const serialized = JSON.stringify(cloned);
    if (serialized === undefined) {
      throw new TypeError(`${label} must have a JSON representation`);
    }
  } catch (error) {
    throw new TypeError(`${label} must be JSON serializable`, {
      cause: error,
    });
  }
  return cloned;
}

function normalizeRequest(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError("provider request must be an object");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !REQUEST_KEYS.has(key))) {
    throw new TypeError("provider request contains unknown fields");
  }
  for (const key of REQUIRED_REQUEST_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`provider request requires ${key}`);
    }
  }
  if (!path.isAbsolute(value.modulePath)) {
    throw new TypeError("provider module path must be absolute");
  }
  requireBoundedString(value.operation, "provider operation");
  requireBoundedString(value.generationId, "provider generation ID");
  const timeoutMs =
    value.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const maxOutputBytes =
    value.maxOutputBytes ?? DEFAULT_PROVIDER_MAX_OUTPUT_BYTES;
  requirePositiveInteger(
    timeoutMs,
    "provider timeout",
    MAX_PROVIDER_TIMEOUT_MS,
  );
  requirePositiveInteger(
    maxOutputBytes,
    "provider output limit",
    DEFAULT_PROVIDER_MAX_OUTPUT_BYTES,
  );
  if (
    value.signal !== undefined &&
    (value.signal === null ||
      typeof value.signal !== "object" ||
      typeof value.signal.aborted !== "boolean" ||
      typeof value.signal.addEventListener !== "function" ||
      typeof value.signal.removeEventListener !== "function")
  ) {
    throw new TypeError("provider cancellation signal is invalid");
  }

  const request = {
    modulePath: value.modulePath,
    operation: value.operation,
    input: cloneJson(value.input, "provider input"),
    generationId: value.generationId,
  };
  const requestBytes = Buffer.byteLength(JSON.stringify(request));
  if (requestBytes > MAX_PROVIDER_REQUEST_BYTES) {
    throw new RangeError("provider request exceeds 256 KiB");
  }
  return {
    ...request,
    timeoutMs,
    maxOutputBytes,
    signal: value.signal,
  };
}

function boundedDiagnostic(value) {
  return String(value)
    .replaceAll("\u0000", "")
    .slice(0, 4_000);
}

function childPidsFrom(stderr) {
  return [
    ...new Set(
      [...stderr.matchAll(/CHILD_PID:([0-9]+)/g)]
        .map((match) => Number(match[1]))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    ),
  ];
}

function terminateWithTaskkill(pid) {
  return new Promise((resolve) => {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    killer.once("error", () => resolve(false));
    killer.once("close", (code) => resolve(code === 0));
  });
}

async function terminateProcessTree(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return "process-not-started";
  }
  if (process.platform === "win32") {
    if (await terminateWithTaskkill(child.pid)) {
      return "process-tree-terminated";
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
      return "process-tree-terminated";
    } catch (error) {
      if (error?.code === "ESRCH") {
        return "process-tree-exited";
      }
    }
  }
  try {
    child.kill("SIGKILL");
    return "process-terminated";
  } catch (error) {
    if (error?.code === "ESRCH") {
      return "process-exited";
    }
    return "termination-failed";
  }
}

function typedResult(request, startedAt, fields) {
  return validateProviderResult({
    ...fields,
    durationMs: Math.max(0, performance.now() - startedAt),
    generationId: request.generationId,
    operation: request.operation,
  });
}

function invalidResult(
  request,
  startedAt,
  diagnostic,
  byteLength,
  truncated = false,
) {
  return typedResult(request, startedAt, {
    status: "invalid",
    diagnostic: boundedDiagnostic(diagnostic),
    truncated,
    byteLength: Math.min(
      byteLength,
      DEFAULT_PROVIDER_MAX_OUTPUT_BYTES,
    ),
  });
}

function validateEnvelope(request, stdout, stderr, startedAt) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    return invalidResult(
      request,
      startedAt,
      `malformed provider JSON: ${error.message}`,
      Buffer.byteLength(stdout),
    );
  }
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    Object.keys(envelope).length !== 3 ||
    !Object.hasOwn(envelope, "generationId") ||
    !Object.hasOwn(envelope, "operation") ||
    !Object.hasOwn(envelope, "result")
  ) {
    return invalidResult(
      request,
      startedAt,
      "malformed provider result envelope",
      Buffer.byteLength(stdout),
    );
  }
  if (envelope.generationId !== request.generationId) {
    return invalidResult(
      request,
      startedAt,
      "provider envelope generation does not match request",
      Buffer.byteLength(stdout),
    );
  }
  if (envelope.operation !== request.operation) {
    return invalidResult(
      request,
      startedAt,
      "provider envelope operation does not match request",
      Buffer.byteLength(stdout),
    );
  }

  let result;
  try {
    result = validateProviderResult(envelope.result);
  } catch (error) {
    return invalidResult(
      request,
      startedAt,
      `invalid provider result: ${error.message}`,
      Buffer.byteLength(stdout),
    );
  }
  if (
    Object.hasOwn(result, "generationId") &&
    result.generationId !== request.generationId
  ) {
    return invalidResult(
      request,
      startedAt,
      "provider result generation does not match request",
      Buffer.byteLength(stdout),
    );
  }
  if (
    Object.hasOwn(result, "operation") &&
    result.operation !== request.operation
  ) {
    return invalidResult(
      request,
      startedAt,
      "provider result operation does not match request",
      Buffer.byteLength(stdout),
    );
  }

  const normalized = {
    ...result,
    durationMs: Math.max(0, performance.now() - startedAt),
    generationId: request.generationId,
    operation: request.operation,
    truncated: false,
    byteLength: Buffer.byteLength(stdout),
  };
  if (
    stderr.length > 0 &&
    !Object.hasOwn(normalized, "diagnostic")
  ) {
    normalized.diagnostic = boundedDiagnostic(stderr);
  }
  try {
    return validateProviderResult(normalized);
  } catch (error) {
    return invalidResult(
      request,
      startedAt,
      `invalid normalized provider result: ${error.message}`,
      Buffer.byteLength(stdout),
    );
  }
}

export function runProvider(options) {
  const request = normalizeRequest(options);
  const startedAt = performance.now();
  if (request.signal?.aborted) {
    return Promise.resolve(
      typedResult(request, startedAt, {
        status: "unavailable",
        diagnostic: "provider cancelled before launch",
        truncated: false,
        byteLength: 0,
      }),
    );
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER_PATH], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputBytes = 0;
    let containmentReason = null;
    let termination = Promise.resolve("not-requested");
    let spawnError = null;

    const beginContainment = (reason) => {
      if (containmentReason !== null) {
        return;
      }
      containmentReason = reason;
      termination = terminateProcessTree(child).then(
        (classification) => {
          child.stdout.destroy();
          child.stderr.destroy();
          child.stdio[3].destroy();
          return classification;
        },
      );
    };

    const collect = (stream, chunk) => {
      const isStdout = stream === "stdout";
      const remaining = Math.max(
        0,
        request.maxOutputBytes - outputBytes,
      );
      if (remaining > 0) {
        (isStdout ? stdoutChunks : stderrChunks).push(
          chunk.subarray(0, remaining),
        );
      }
      outputBytes += chunk.length;
      if (isStdout) {
        stdoutBytes += chunk.length;
      } else {
        stderrBytes += chunk.length;
      }
      if (outputBytes > request.maxOutputBytes) {
        beginContainment(`${stream}-overflow`);
      }
    };

    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.stdio[3].once("data", () => {
      beginContainment("completed");
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.stdin.once("error", (error) => {
      spawnError ??= error;
      beginContainment("stdin-error");
    });

    const abort = () => beginContainment("cancelled");
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) {
      abort();
    }

    const timeout = setTimeout(() => {
      beginContainment("timeout");
    }, request.timeoutMs);

    child.once("close", async (code, signal) => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      const terminationClass = await termination;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const childPids = childPidsFrom(stderr);
      const containmentDiagnostic = [
        `termination=${terminationClass}`,
        `workerPid=${child.pid ?? "unknown"}`,
        `childPids=${childPids.join(",") || "none"}`,
        `stdoutBytes=${stdoutBytes}`,
        `stderrBytes=${stderrBytes}`,
      ].join("; ");

      if (containmentReason === "timeout") {
        resolve(
          typedResult(request, startedAt, {
            status: "timed-out",
            diagnostic: containmentDiagnostic,
            truncated: false,
            byteLength: Math.min(
              Math.max(stdoutBytes, stderrBytes),
              request.maxOutputBytes,
            ),
          }),
        );
        return;
      }
      if (containmentReason?.endsWith("-overflow")) {
        resolve(
          invalidResult(
            request,
            startedAt,
            `${containmentReason}; ${containmentDiagnostic}`,
            request.maxOutputBytes,
            true,
          ),
        );
        return;
      }
      if (containmentReason === "cancelled") {
        resolve(
          typedResult(request, startedAt, {
            status: "unavailable",
            diagnostic: boundedDiagnostic(
              `provider cancelled; ${containmentDiagnostic}`,
            ),
            truncated:
              outputBytes > request.maxOutputBytes,
            byteLength: Math.min(
              outputBytes,
              request.maxOutputBytes,
            ),
          }),
        );
        return;
      }
      if (containmentReason === "stdin-error") {
        resolve(
          typedResult(request, startedAt, {
            status: "unavailable",
            diagnostic: boundedDiagnostic(
              `provider request pipe failed: ${spawnError?.message ?? "unknown error"}; ${containmentDiagnostic}`,
            ),
            truncated:
              outputBytes > request.maxOutputBytes,
            byteLength: Math.min(
              outputBytes,
              request.maxOutputBytes,
            ),
          }),
        );
        return;
      }
      if (containmentReason === "completed") {
        if (terminationClass !== "process-tree-terminated") {
          resolve(
            typedResult(request, startedAt, {
              status: "unavailable",
              diagnostic: boundedDiagnostic(
                `provider process-tree cleanup was not fenced; ${containmentDiagnostic}`,
              ),
              truncated: false,
              byteLength: Math.min(
                outputBytes,
                request.maxOutputBytes,
              ),
            }),
          );
          return;
        }
        resolve(validateEnvelope(request, stdout, stderr, startedAt));
        return;
      }
      if (spawnError || code !== 0 || signal !== null) {
        const reason = spawnError
          ? `provider process spawn failed: ${spawnError.message}`
          : `provider process exited with code=${code} signal=${signal ?? "none"}`;
        resolve(
          typedResult(request, startedAt, {
            status: "unavailable",
            diagnostic: boundedDiagnostic(reason),
            truncated: false,
            byteLength: Math.min(
              Math.max(stdoutBytes, stderrBytes),
              request.maxOutputBytes,
            ),
          }),
        );
        return;
      }
      resolve(validateEnvelope(request, stdout, stderr, startedAt));
    });

    child.stdin.end(
      JSON.stringify({
        modulePath: request.modulePath,
        operation: request.operation,
        input: request.input,
        generationId: request.generationId,
      }),
    );
  });
}

function normalizeBatchRequest(value, index) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`provider batch request ${index} must be an object`);
  }
  if (
    !Object.hasOwn(value, "cost") ||
    !Number.isFinite(value.cost) ||
    value.cost < 0
  ) {
    throw new RangeError(
      `provider batch request ${index} requires a non-negative cost`,
    );
  }
  const { cost, ...providerRequest } = value;
  return {
    cost,
    request: normalizeRequest(providerRequest),
  };
}

export async function runProviderBatch(
  requests,
  {
    concurrency = DEFAULT_PROVIDER_CONCURRENCY,
    costBudget = Number.POSITIVE_INFINITY,
  } = {},
) {
  if (!Array.isArray(requests)) {
    throw new TypeError("provider batch requests must be an array");
  }
  requirePositiveInteger(
    concurrency,
    "provider concurrency",
    MAX_PROVIDER_CONCURRENCY,
  );
  if (
    (costBudget !== Number.POSITIVE_INFINITY &&
      !Number.isFinite(costBudget)) ||
    costBudget < 0
  ) {
    throw new RangeError(
      "provider cost budget must be a non-negative number",
    );
  }

  const normalized = requests.map(normalizeBatchRequest);
  const declaredCost = normalized.reduce(
    (total, item) => total + item.cost,
    0,
  );
  if (!Number.isFinite(declaredCost) || declaredCost > costBudget) {
    throw new RangeError(
      `provider cost budget exceeded: ${declaredCost} > ${costBudget}`,
    );
  }
  if (normalized.length === 0) {
    return [];
  }

  const results = new Array(normalized.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < normalized.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await runProvider(normalized[index].request);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, normalized.length) },
      () => worker(),
    ),
  );
  return results;
}
