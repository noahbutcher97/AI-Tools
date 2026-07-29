import { pathToFileURL } from "node:url";
import { write } from "node:fs";

import { validateProviderResult } from "../contracts.mjs";

const MAX_REQUEST_BYTES = 256 * 1_024;

function requireString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128
  ) {
    throw new TypeError(`${label} must be 1 through 128 characters`);
  }
  return value;
}

function validateRequest(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError("provider worker request must be an object");
  }
  const keys = Object.keys(value);
  const expected = new Set([
    "modulePath",
    "operation",
    "input",
    "generationId",
  ]);
  if (
    keys.length !== expected.size ||
    keys.some((key) => !expected.has(key))
  ) {
    throw new TypeError("provider worker request schema is invalid");
  }
  if (
    typeof value.modulePath !== "string" ||
    value.modulePath.length === 0
  ) {
    throw new TypeError("provider module path must be a non-empty string");
  }
  requireString(value.operation, "provider operation");
  requireString(value.generationId, "provider generation ID");
  return value;
}

async function readRequest() {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    byteLength += chunk.length;
    if (byteLength > MAX_REQUEST_BYTES) {
      throw new RangeError("provider worker request exceeds 256 KiB");
    }
    chunks.push(chunk);
  }
  if (byteLength === 0) {
    throw new TypeError("provider worker request is empty");
  }
  return validateRequest(
    JSON.parse(Buffer.concat(chunks, byteLength).toString("utf8")),
  );
}

function diagnosticFor(error) {
  const name =
    typeof error?.name === "string" ? error.name : "ProviderError";
  const message =
    typeof error?.message === "string"
      ? error.message
      : String(error);
  return `${name}: ${message}`.slice(0, 4_000);
}

async function writeEnvelope(envelope) {
  const payload = JSON.stringify(envelope);
  await new Promise((resolve, reject) => {
    process.stdout.write(payload, "utf8", (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function closeProtocolStreams() {
  await Promise.all([
    new Promise((resolve) => process.stdout.end(resolve)),
    new Promise((resolve) => process.stderr.end(resolve)),
  ]);
}

async function signalCompletion() {
  await new Promise((resolve, reject) => {
    write(3, Buffer.from([1]), (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function providerExitError(code) {
  const error = new Error(
    `provider requested process exit with code ${String(code ?? 0)}`,
  );
  error.name = "ProviderExitError";
  return error;
}

async function main() {
  const request = await readRequest();
  let result;
  let providerValue;
  const originalExit = process.exit;
  try {
    const providerModule = await import(
      pathToFileURL(request.modulePath).href
    );
    if (typeof providerModule.runProviderOperation !== "function") {
      throw new TypeError(
        "provider module must export runProviderOperation",
      );
    }
    process.exit = (code) => {
      throw providerExitError(code);
    };
    providerValue = await providerModule.runProviderOperation({
      operation: request.operation,
      input: request.input,
      generationId: request.generationId,
    });
  } catch (error) {
    result = {
      status: "unavailable",
      diagnostic: diagnosticFor(error),
    };
  } finally {
    process.exit = originalExit;
  }
  if (result === undefined) {
    try {
      result = validateProviderResult(providerValue);
    } catch (error) {
      result = {
        status: "invalid",
        diagnostic: diagnosticFor(error),
      };
    }
  }

  await writeEnvelope({
    generationId: request.generationId,
    operation: request.operation,
    result,
  });
  await closeProtocolStreams();
  await signalCompletion();
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

main().catch((error) => {
  process.stderr.write(`${diagnosticFor(error)}\n`);
  process.exitCode = 1;
});
