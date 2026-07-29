import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import WebSocket from "ws";

import {
  SCHEMA_VERSION,
  validateEvent,
} from "../contracts.mjs";
import {
  assertPeerMutationAllowed,
  preflightPeerMutation,
  reduceCoordinatorJournalEvents,
} from "./registry.mjs";

const execFile = promisify(execFileCallback);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const LOOPBACK_ENDPOINT_PATTERN =
  /^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;
const APP_SERVER_RECORD_KEYS = new Set([
  "executablePath",
  "executableSha256",
  "pid",
  "parentPid",
  "creationTimeUtc",
  "endpoint",
  "supervisorGeneration",
  "appServerGeneration",
  "attachmentGeneration",
  "windowsBootId",
  "protocolSha256",
]);
const PROCESS_IDENTITY_KEYS = [
  "executablePath",
  "executableSha256",
  "pid",
  "parentPid",
  "creationTimeUtc",
  "windowsBootId",
];
const FORBIDDEN_TURN_OVERRIDES = new Set([
  "approvalPolicy",
  "approvalsReviewer",
  "collaborationMode",
  "cwd",
  "developerInstructions",
  "effort",
  "model",
  "permissions",
  "personality",
  "runtimeWorkspaceRoots",
  "sandboxPolicy",
]);
const ACTIVE_TURN_STATUSES = new Set([
  "active",
  "inProgress",
  "in_progress",
  "running",
]);
const START_TURN_KEYS = new Set([
  "messageId",
  "mailboxPeerId",
  "threadId",
  "input",
  "additionalContext",
  "retryUnknownMessageId",
]);
const MAX_APP_SERVER_MESSAGE_BYTES = 1024 * 1024;

export const REQUIRED_APP_SERVER_METHODS = Object.freeze([
  "initialize",
  "thread/read",
  "thread/resume",
  "thread/start",
  "thread/turns/list",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

export const REQUIRED_LIFECYCLE_NOTIFICATIONS = Object.freeze([
  "thread/started",
  "thread/status/changed",
  "thread/closed",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
]);

export class AppServerDisconnectedError extends Error {
  constructor(message, { sent = false, cause } = {}) {
    super(message, { cause });
    this.name = "AppServerDisconnectedError";
    this.sent = sent;
  }
}

function requirePlainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function requireExactKeys(value, keys, label) {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.size ||
    actual.some((key) => !keys.has(key))
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function requireIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !IDENTIFIER_PATTERN.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requireUtc(value, label) {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be a UTC timestamp`);
  }
  return value;
}

function requirePositivePid(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function methodNames(definition) {
  return new Set(
    (definition?.oneOf ?? [])
      .map((item) => item?.properties?.method?.enum?.[0])
      .filter((item) => typeof item === "string"),
  );
}

function hasReadOnlyNetworkFence(sandboxPolicy) {
  return (sandboxPolicy?.oneOf ?? []).some(
    (variant) =>
      variant?.properties?.type?.enum?.includes("readOnly") &&
      variant?.properties?.networkAccess?.type === "boolean" &&
      variant?.properties?.networkAccess?.default === false,
  );
}

function validateProtocolSchema(schema) {
  requirePlainObject(schema, "app-server protocol schema");
  const definitions = requirePlainObject(
    schema.definitions,
    "app-server protocol definitions",
  );
  const v2 = requirePlainObject(
    definitions.v2,
    "app-server v2 protocol definitions",
  );
  const methods = methodNames(definitions.ClientRequest);
  const notifications = methodNames(definitions.ServerNotification);

  for (const method of REQUIRED_APP_SERVER_METHODS) {
    if (!methods.has(method)) {
      throw new Error(
        `required app-server method ${method} is absent from installed schema`,
      );
    }
  }
  for (const method of REQUIRED_LIFECYCLE_NOTIFICATIONS) {
    if (!notifications.has(method)) {
      throw new Error(
        `required app-server notification ${method} is absent from installed schema`,
      );
    }
  }
  if (
    v2.ThreadStartParams?.properties?.ephemeral === undefined
  ) {
    throw new Error(
      "installed app-server schema lacks ephemeral thread/start support",
    );
  }
  const turnStart = v2.TurnStartParams;
  if (
    turnStart?.properties?.additionalContext === undefined ||
    turnStart?.properties?.sandboxPolicy === undefined ||
    turnStart?.properties?.clientUserMessageId === undefined
  ) {
    throw new Error(
      "installed app-server schema lacks required turn context or sandbox fields",
    );
  }
  const contextKinds = new Set(v2.AdditionalContextKind?.enum ?? []);
  if (
    !contextKinds.has("application") ||
    !contextKinds.has("untrusted")
  ) {
    throw new Error(
      "installed app-server schema lacks application and untrusted context kinds",
    );
  }
  if (!hasReadOnlyNetworkFence(v2.SandboxPolicy)) {
    throw new Error(
      "installed app-server schema lacks read-only network-disabled sandbox support",
    );
  }
  return { methods, notifications };
}

async function generateInstalledSchema(codexExecutable) {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "codex-coordinator-schema-"),
  );
  try {
    const arguments_ = [
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      temporaryDirectory,
    ];
    if (path.extname(codexExecutable).toLowerCase() === ".ps1") {
      await execFile("pwsh.exe", [
        "-NoProfile",
        "-File",
        codexExecutable,
        ...arguments_,
      ]);
    } else {
      await execFile(codexExecutable, arguments_);
    }
    return JSON.parse(
      await readFile(
        path.join(
          temporaryDirectory,
          "codex_app_server_protocol.schemas.json",
        ),
        "utf8",
      ),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function inspectInstalledProtocol(
  codexExecutable,
  {
    generateSchema = generateInstalledSchema,
  } = {},
) {
  if (
    typeof codexExecutable !== "string" ||
    codexExecutable.length === 0
  ) {
    throw new TypeError("Codex executable is required");
  }
  if (typeof generateSchema !== "function") {
    throw new TypeError("schema generator must be a function");
  }
  const schema = await generateSchema(codexExecutable);
  const { methods, notifications } = validateProtocolSchema(schema);
  const schemaSha256 = createHash("sha256")
    .update(JSON.stringify(schema), "utf8")
    .digest("hex");
  return Object.freeze({
    schema: structuredClone(schema),
    schemaSha256,
    methods,
    notifications,
  });
}

function validateProtocol(protocol) {
  requirePlainObject(protocol, "app-server protocol inspection");
  if (
    !(protocol.methods instanceof Set) ||
    !(protocol.notifications instanceof Set) ||
    !SHA256_PATTERN.test(protocol.schemaSha256)
  ) {
    throw new TypeError("app-server protocol inspection is invalid");
  }
  for (const method of REQUIRED_APP_SERVER_METHODS) {
    if (!protocol.methods.has(method)) {
      throw new Error(`app-server protocol lacks ${method}`);
    }
  }
  for (const method of REQUIRED_LIFECYCLE_NOTIFICATIONS) {
    if (!protocol.notifications.has(method)) {
      throw new Error(`app-server protocol lacks ${method}`);
    }
  }
}

function validateEndpoint(endpoint) {
  const match = LOOPBACK_ENDPOINT_PATTERN.exec(endpoint);
  const port = Number(match?.[1]);
  if (match === null || port > 65_535) {
    throw new Error("recorded loopback WebSocket endpoint is invalid");
  }
  return port;
}

function validateAppServerRecord(value) {
  requirePlainObject(value, "app-server process record");
  requireExactKeys(
    value,
    APP_SERVER_RECORD_KEYS,
    "app-server process record",
  );
  if (
    typeof value.executablePath !== "string" ||
    !path.win32.isAbsolute(value.executablePath)
  ) {
    throw new TypeError("app-server executable path is invalid");
  }
  if (!SHA256_PATTERN.test(value.executableSha256)) {
    throw new TypeError("app-server executable SHA-256 is invalid");
  }
  requirePositivePid(value.pid, "app-server PID");
  requirePositivePid(value.parentPid, "app-server parent PID");
  requireUtc(value.creationTimeUtc, "app-server creation time");
  validateEndpoint(value.endpoint);
  requireIdentifier(
    value.supervisorGeneration,
    "supervisor generation",
  );
  requireIdentifier(
    value.appServerGeneration,
    "app-server generation",
  );
  requireIdentifier(
    value.attachmentGeneration,
    "attachment generation",
  );
  requireIdentifier(value.windowsBootId, "Windows boot ID");
  if (!SHA256_PATTERN.test(value.protocolSha256)) {
    throw new TypeError("app-server protocol SHA-256 is invalid");
  }
  return structuredClone(value);
}

function compareProcessIdentity(record, observed) {
  requirePlainObject(observed, "observed app-server process identity");
  for (const key of PROCESS_IDENTITY_KEYS) {
    if (!Object.hasOwn(observed, key)) {
      throw new Error(`observed app-server identity lacks ${key}`);
    }
  }
  if (
    record.executablePath.toLowerCase() !==
    observed.executablePath.toLowerCase()
  ) {
    throw new Error("app-server executable path does not match");
  }
  if (record.executableSha256 !== observed.executableSha256) {
    throw new Error("app-server executable SHA-256 does not match");
  }
  if (record.pid !== observed.pid) {
    throw new Error("app-server PID does not match");
  }
  if (record.parentPid !== observed.parentPid) {
    throw new Error("app-server parent PID does not match");
  }
  if (record.creationTimeUtc !== observed.creationTimeUtc) {
    throw new Error("app-server creation time does not match");
  }
  if (record.windowsBootId !== observed.windowsBootId) {
    throw new Error("app-server Windows boot ID does not match");
  }
}

function isSequenceContention(error) {
  return (
    error instanceof RangeError &&
    /journal sequence must be/i.test(error.message)
  );
}

function activeTurnId(response) {
  const turns = response?.data ?? response?.turns ?? [];
  const active = turns.find((turn) => {
    const status =
      typeof turn?.status === "string"
        ? turn.status
        : turn?.status?.type;
    return ACTIVE_TURN_STATUSES.has(status);
  });
  return active?.id ?? null;
}

function requestError(response) {
  const message =
    response?.error?.message ?? "app-server request failed";
  const error = new Error(message);
  error.code = response?.error?.code;
  return error;
}

export async function reconnectWithBackoff({
  connect,
  sleep = (delay, signal) =>
    new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("reconnect aborted"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
  shouldCancel = async () => null,
  onCancelled = async () => {},
  signal,
}) {
  if (
    typeof connect !== "function" ||
    typeof sleep !== "function" ||
    typeof shouldCancel !== "function" ||
    typeof onCancelled !== "function"
  ) {
    throw new TypeError("reconnect dependencies are invalid");
  }
  let delay = 1_000;
  for (;;) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("reconnect aborted");
    }
    const before = await shouldCancel();
    if (before !== null) {
      await onCancelled(before);
      throw new Error(`app-server reconnect cancelled: ${before}`);
    }
    try {
      const result = await connect();
      const after = await shouldCancel();
      if (after !== null) {
        await onCancelled(after, result);
        throw new Error(`app-server reconnect cancelled: ${after}`);
      }
      return result;
    } catch (error) {
      const cancellation = await shouldCancel();
      if (cancellation !== null) {
        throw new Error(`app-server reconnect cancelled: ${cancellation}`, {
          cause: error,
        });
      }
      await sleep(delay, signal);
      delay = Math.min(delay * 2, 15_000);
    }
  }
}

export function createAppServerClient({
  protocol,
  supervisorGeneration,
  appServerGeneration,
  attachmentGeneration,
  windowsBootId,
  inspectProcess,
  inspectEndpoint,
  webSocketFactory = (endpoint) =>
    new WebSocket(endpoint, {
      maxPayload: MAX_APP_SERVER_MESSAGE_BYTES,
      perMessageDeflate: false,
    }),
  processStarter,
  processStopper,
  journal,
  clock = {
    nowUtc: () => new Date().toISOString(),
  },
  idFactory = randomUUID,
  requestTimeoutMs = 10_000,
  runtimeStopped = () => false,
  currentSupervisorGeneration = () => supervisorGeneration,
  verifyAttachmentAuthority = async () => false,
  sleep,
} = {}) {
  validateProtocol(protocol);
  requireIdentifier(supervisorGeneration, "supervisor generation");
  requireIdentifier(appServerGeneration, "app-server generation");
  requireIdentifier(attachmentGeneration, "attachment generation");
  requireIdentifier(windowsBootId, "Windows boot ID");
  if (
    typeof inspectProcess !== "function" ||
    typeof inspectEndpoint !== "function" ||
    typeof webSocketFactory !== "function" ||
    typeof verifyAttachmentAuthority !== "function"
  ) {
    throw new TypeError(
      "app-server process, endpoint, and WebSocket inspectors are required",
    );
  }
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1
  ) {
    throw new TypeError("app-server request timeout is invalid");
  }
  if (
    journal !== undefined &&
    (typeof journal?.readFrom !== "function" ||
      typeof journal?.append !== "function")
  ) {
    throw new TypeError("app-server journal is invalid");
  }

  const events = new EventEmitter();
  let socket = null;
  let connectedRecord = null;
  let nextRequestId = 1;
  let starting = false;
  let managedGenerationConsumed = false;
  let disconnectRecorded = false;
  let disconnectPromise = Promise.resolve(null);
  const pending = new Map();

  async function appendEvent(type, payload) {
    if (journal === undefined) {
      return null;
    }
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const existing = await journal.readFrom(0);
      const coordinatorState =
        await reduceCoordinatorJournalEvents(existing);
      assertPeerMutationAllowed(coordinatorState);
      const candidate = validateEvent({
        schemaVersion: SCHEMA_VERSION,
        sequence: (existing.at(-1)?.sequence ?? 0) + 1,
        eventId: idFactory(),
        timestampUtc: clock.nowUtc(),
        source: "peers.app-server",
        type,
        payload,
      });
      await preflightPeerMutation(coordinatorState, candidate);
      try {
        await journal.append(candidate, { flush: true });
        return candidate;
      } catch (error) {
        if (!isSequenceContention(error)) {
          throw error;
        }
      }
    }
    throw new Error(
      "app-server lifecycle journal contention did not settle",
    );
  }

  function rejectPending(error) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new AppServerDisconnectedError(error.message, {
          sent: item.sent,
          cause: error,
        }),
      );
    }
    pending.clear();
  }

  function recordDisconnect(reason) {
    if (disconnectRecorded) {
      return disconnectPromise;
    }
    if (connectedRecord === null) {
      return Promise.resolve(null);
    }
    disconnectRecorded = true;
    const prior = connectedRecord;
    connectedRecord = null;
    disconnectPromise = appendEvent("appServer.disconnected", {
      appServerGeneration: prior.appServerGeneration,
      attachmentGeneration: prior.attachmentGeneration,
      reason,
      disconnectedUtc: clock.nowUtc(),
    });
    void disconnectPromise.catch((error) =>
      events.emit("journalError", error),
    );
    return disconnectPromise;
  }

  function fenceConnection(error, reason, expectedSocket = socket) {
    if (socket !== expectedSocket) {
      return;
    }
    const activeSocket = expectedSocket;
    socket = null;
    rejectPending(error);
    recordDisconnect(reason);
    if (
      activeSocket !== null &&
      [WebSocket.CONNECTING, WebSocket.OPEN].includes(
        activeSocket.readyState,
      )
    ) {
      activeSocket.terminate();
    }
  }

  function validateNotification(message) {
    requirePlainObject(message.params, `${message.method} notification params`);
    const params = message.params;
    if (message.method.startsWith("thread/")) {
      if (
        message.method === "thread/started" &&
        typeof params.thread?.id !== "string"
      ) {
        throw new TypeError("thread/started notification is invalid");
      }
      if (
        message.method !== "thread/started" &&
        typeof params.threadId !== "string"
      ) {
        throw new TypeError(`${message.method} notification is invalid`);
      }
    } else if (message.method.startsWith("turn/")) {
      if (
        typeof params.threadId !== "string" ||
        typeof params.turn?.id !== "string"
      ) {
        throw new TypeError(`${message.method} notification is invalid`);
      }
    } else if (message.method.startsWith("item/")) {
      if (
        typeof params.threadId !== "string" ||
        typeof params.turnId !== "string" ||
        typeof params.item?.id !== "string"
      ) {
        throw new TypeError(`${message.method} notification is invalid`);
      }
    }
  }

  function validateResponse(method, result, params) {
    requirePlainObject(result, `${method} response`);
    if (
      ["thread/read", "thread/resume"].includes(method) &&
      typeof result.thread?.id !== "string"
    ) {
      throw new TypeError(`${method} response is invalid`);
    }
    if (
      ["thread/read", "thread/resume"].includes(method) &&
      result.thread.id !== params.threadId
    ) {
      throw new Error(`${method} returned a different thread ID`);
    }
    if (
      method === "thread/turns/list" &&
      !Array.isArray(result.data)
    ) {
      throw new TypeError("thread/turns/list response is invalid");
    }
    if (
      method === "turn/start" &&
      typeof result.turn?.id !== "string"
    ) {
      throw new TypeError("turn/start response is invalid");
    }
  }

  function handleSocketMessage(candidate, data) {
    if (socket !== candidate) {
      return;
    }
    let message;
    try {
      if (data.byteLength > MAX_APP_SERVER_MESSAGE_BYTES) {
        throw new RangeError("app-server message exceeds size limit");
      }
      message = JSON.parse(data.toString("utf8"));
      requirePlainObject(message, "app-server message");
    } catch (cause) {
      const error = new Error("malformed app-server message", { cause });
      fenceConnection(error, "protocol-error", candidate);
      events.emit("protocolError", error);
      return;
    }
    if (Object.hasOwn(message, "id")) {
      const item = pending.get(message.id);
      if (item === undefined) {
        const error = new Error(
          `unexpected app-server response ID ${message.id}`,
        );
        fenceConnection(error, "protocol-error");
        events.emit("protocolError", error);
        return;
      }
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (Object.hasOwn(message, "error")) {
        item.reject(requestError(message));
      } else if (Object.hasOwn(message, "result")) {
        try {
          validateResponse(item.method, message.result, item.params);
          item.resolve(message.result);
        } catch (error) {
          item.reject(error);
          fenceConnection(error, "protocol-error", candidate);
          events.emit("protocolError", error);
        }
      } else {
        const error = new Error(
          "app-server response lacks result or error",
        );
        item.reject(error);
        fenceConnection(error, "protocol-error", candidate);
        events.emit("protocolError", error);
      }
      return;
    }
    if (
      typeof message.method !== "string" ||
      !protocol.notifications.has(message.method) ||
      !Object.hasOwn(message, "params")
    ) {
      const error = new Error("malformed app-server notification");
      fenceConnection(error, "protocol-error");
      events.emit("protocolError", error);
      return;
    }
    try {
      validateNotification(message);
      events.emit("notification", structuredClone(message));
      events.emit(message.method, structuredClone(message.params));
    } catch (error) {
      fenceConnection(error, "protocol-error", candidate);
      events.emit("protocolError", error);
    }
  }

  function handleSocketClose(candidate) {
    if (socket !== candidate) {
      return;
    }
    const error = new Error("app-server WebSocket closed");
    socket = null;
    rejectPending(error);
    recordDisconnect("connection-closed");
    events.emit("disconnected", error);
  }

  async function openWebSocket(endpoint, signal) {
    const candidate = webSocketFactory(endpoint);
    if (
      candidate === null ||
      typeof candidate.on !== "function" ||
      typeof candidate.send !== "function"
    ) {
      throw new TypeError("WebSocket factory returned an invalid client");
    }
    socket = candidate;
    candidate.on("message", (data) =>
      handleSocketMessage(candidate, data),
    );
    candidate.on("close", () => handleSocketClose(candidate));
    candidate.on("error", (error) => {
      events.emit("socketError", error);
    });
    await new Promise((resolve, reject) => {
      if (candidate.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        candidate.off("open", onOpen);
        candidate.off("error", onError);
        candidate.off("close", onClose);
      };
      const finish = (operation) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        operation();
      };
      const onOpen = () => {
        finish(resolve);
      };
      const onError = (error) => {
        finish(() => reject(error));
      };
      const onClose = () => {
        finish(() =>
          reject(
            new AppServerDisconnectedError(
              "app-server disconnected before WebSocket acknowledgement",
            ),
          ),
        );
      };
      const onAbort = () => {
        finish(() =>
          reject(signal.reason ?? new Error("app-server connect aborted")),
        );
        candidate.terminate();
      };
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new AppServerDisconnectedError(
              "app-server WebSocket acknowledgement timed out",
            ),
          ),
        );
        candidate.terminate();
      }, requestTimeoutMs);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      candidate.once("open", onOpen);
      candidate.once("error", onError);
      candidate.once("close", onClose);
    });
  }

  function sendRequest(method, params) {
    if (
      socket === null ||
      socket.readyState !== WebSocket.OPEN
    ) {
      throw new AppServerDisconnectedError(
        "app-server is not connected",
      );
    }
    if (!protocol.methods.has(method)) {
      throw new Error(`installed app-server does not support ${method}`);
    }
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const item = {
        method,
        params: structuredClone(params),
        resolve,
        reject,
        sent: false,
        timer: setTimeout(() => {
          pending.delete(id);
          reject(
            new AppServerDisconnectedError(
              `app-server ${method} acknowledgement timed out`,
              { sent: item.sent },
            ),
          );
        }, requestTimeoutMs),
      };
      pending.set(id, item);
      try {
        socket.send(
          JSON.stringify({ id, method, params }),
          (error) => {
            if (error) {
              pending.delete(id);
              clearTimeout(item.timer);
              reject(
                new AppServerDisconnectedError(
                  `app-server ${method} send failed`,
                  { sent: item.sent, cause: error },
                ),
              );
            }
          },
        );
        item.sent = true;
      } catch (cause) {
        pending.delete(id);
        clearTimeout(item.timer);
        reject(
          new AppServerDisconnectedError(
            `app-server ${method} send failed`,
            { sent: false, cause },
          ),
        );
      }
    });
  }

  function sendNotification(method, params = {}) {
    if (
      socket === null ||
      socket.readyState !== WebSocket.OPEN
    ) {
      throw new AppServerDisconnectedError(
        "app-server is not connected",
      );
    }
    socket.send(JSON.stringify({ method, params }));
  }

  async function connectAppServer(value, { signal } = {}) {
    if (socket !== null || connectedRecord !== null) {
      throw new Error("app-server client already owns a connection");
    }
    const candidate = validateAppServerRecord(value);
    if (candidate.supervisorGeneration !== supervisorGeneration) {
      throw new Error("supervisor generation does not match");
    }
    if (candidate.appServerGeneration !== appServerGeneration) {
      throw new Error("app-server generation does not match");
    }
    if (candidate.attachmentGeneration !== attachmentGeneration) {
      throw new Error("attachment generation does not match");
    }
    if (candidate.windowsBootId !== windowsBootId) {
      throw new Error("Windows boot ID does not match");
    }
    if (candidate.protocolSha256 !== protocol.schemaSha256) {
      throw new Error("app-server protocol SHA-256 does not match");
    }

    const observed = await inspectProcess(candidate.pid);
    compareProcessIdentity(candidate, observed);
    const endpoint = await inspectEndpoint(candidate.endpoint);
    requirePlainObject(endpoint, "observed app-server endpoint");
    if (endpoint.listening !== true) {
      throw new Error("recorded app-server endpoint is not listening");
    }
    if (endpoint.pid !== candidate.pid) {
      throw new Error(
        `recorded app-server endpoint is owned by foreign process ${endpoint.pid}`,
      );
    }

    disconnectRecorded = false;
    disconnectPromise = Promise.resolve(null);
    let connectedEventDurable = false;
    try {
      await openWebSocket(candidate.endpoint, signal);
      await sendRequest("initialize", {
        clientInfo: {
          name: "operation-phoenix-coordinator",
          title: "Operation Phoenix Coordinator",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      sendNotification("initialized");
      compareProcessIdentity(
        candidate,
        await inspectProcess(candidate.pid),
      );
      const confirmedEndpoint = await inspectEndpoint(
        candidate.endpoint,
      );
      if (
        confirmedEndpoint?.listening !== true ||
        confirmedEndpoint.pid !== candidate.pid
      ) {
        throw new Error(
          "app-server endpoint identity changed during connection",
        );
      }
      await appendEvent("appServer.connected", {
        ...candidate,
        connectedUtc: clock.nowUtc(),
      });
      connectedEventDurable = true;
      connectedRecord = candidate;
      if (socket?.readyState !== WebSocket.OPEN) {
        throw new AppServerDisconnectedError(
          "app-server disconnected while recording ownership",
        );
      }
      events.emit("connected", structuredClone(candidate));
      return status();
    } catch (error) {
      const activeSocket = socket;
      socket = null;
      if (connectedEventDurable) {
        await recordDisconnect("connection-failed-after-record");
      } else {
        connectedRecord = null;
      }
      if (
        activeSocket !== null &&
        [WebSocket.CONNECTING, WebSocket.OPEN].includes(
          activeSocket.readyState,
        )
      ) {
        activeSocket.terminate();
      }
      throw error;
    }
  }

  async function startManagedAppServer(startOptions = {}) {
    if (
      starting ||
      socket !== null ||
      connectedRecord !== null ||
      managedGenerationConsumed
    ) {
      throw new Error("a managed app-server is already owned");
    }
    if (
      typeof processStarter !== "function" ||
      typeof processStopper !== "function"
    ) {
      throw new Error("managed app-server process starter is unavailable");
    }
    starting = true;
    managedGenerationConsumed = true;
    let startedRecord = null;
    try {
      startedRecord = await processStarter({
        ...startOptions,
        listen: "ws://127.0.0.1:0",
        supervisorGeneration,
        appServerGeneration,
        attachmentGeneration,
        windowsBootId,
        protocolSha256: protocol.schemaSha256,
      });
      return await connectAppServer(startedRecord);
    } catch (error) {
      if (startedRecord !== null) {
        await processStopper(startedRecord);
      }
      throw error;
    } finally {
      starting = false;
    }
  }

  async function reconcileAttachments(peers) {
    if (!Array.isArray(peers)) {
      throw new TypeError("registered peers must be an array");
    }
    const reconciled = [];
    for (const peer of peers) {
      requirePlainObject(peer, "registered peer");
      const peerId = peer.peerId;
      if (!Number.isSafeInteger(peerId) || peerId < 1) {
        throw new TypeError("registered peer ID is invalid");
      }
      const threadId = requireIdentifier(peer.threadId, "thread ID");
      const read = await sendRequest("thread/read", {
        threadId,
        includeTurns: false,
      });
      const readStatus =
        typeof read.thread.status === "string"
          ? read.thread.status
          : read.thread.status?.type;
      if (
        !["active", "idle", "loaded", "notLoaded"].includes(
          readStatus,
        )
      ) {
        throw new Error(
          `thread/read returned unsupported status ${readStatus}`,
        );
      }
      if (
        readStatus === "notLoaded" &&
        !(
          await verifyAttachmentAuthority({
            peer: structuredClone(peer),
            read: structuredClone(read),
            connectedRecord:
              connectedRecord === null
                ? null
                : structuredClone(connectedRecord),
            mode:
              peer.explicitAttach === true
                ? "explicit-attach"
                : "restart-reconciliation",
          })
        )
      ) {
        throw new Error(
          "unloaded thread attachment authority could not be proven",
        );
      }
      await sendRequest("thread/resume", {
        threadId,
        excludeTurns: true,
      });
      const turns = await sendRequest("thread/turns/list", {
        threadId,
        limit: 100,
        sortDirection: "desc",
        itemsView: "summary",
      });
      const attachment = {
        peerId,
        threadId,
        appServerGeneration,
        attachmentGeneration,
        windowsBootId,
        activeTurnId: activeTurnId(turns),
        attachedUtc: clock.nowUtc(),
      };
      await appendEvent("peer.attached", attachment);
      reconciled.push(attachment);
    }
    return reconciled;
  }

  async function markDeliveryUnknown(request, reason) {
    await appendEvent("message.deliveryUnknown", {
      messageId: request.messageId,
      mailboxPeerId: request.mailboxPeerId,
      reason,
      unknownUtc: clock.nowUtc(),
    });
  }

  async function validateTurnDispatch(request) {
    if (journal === undefined) {
      throw new Error(
        "turn/start requires the authoritative coordinator journal",
      );
    }
    const coordinatorState = await reduceCoordinatorJournalEvents(
      await journal.readFrom(0),
    );
    assertPeerMutationAllowed(coordinatorState);
    const message =
      coordinatorState.peers.delivery.messages[request.messageId];
    if (
      message?.status !== "dispatching" ||
      message.sourcePeerId !== request.mailboxPeerId
    ) {
      throw new Error(
        `message ${request.messageId} is not an authorized dispatch`,
      );
    }
    const target =
      coordinatorState.peers.registry.peers[
        String(message.targetPeerId)
      ];
    if (target?.threadId !== request.threadId) {
      throw new Error(
        "turn/start target thread does not match the dispatched peer",
      );
    }
    if (request.retryUnknownMessageId === undefined) {
      return;
    }
    requireIdentifier(
      request.retryUnknownMessageId,
      "unknown message ID",
    );
    const unknown =
      coordinatorState.peers.delivery.messages[
        request.retryUnknownMessageId
      ];
    if (
      unknown?.status !== "delivery-unknown" ||
      unknown.targetPeerId !== message.targetPeerId
    ) {
      throw new Error(
        "explicit retry does not reference delivery-unknown work for this target",
      );
    }
    const thread = await sendRequest("thread/read", {
      threadId: request.threadId,
      includeTurns: true,
    });
    if (
      JSON.stringify(thread).includes(request.retryUnknownMessageId)
    ) {
      throw new Error(
        "target thread already contains the delivery-unknown message ID",
      );
    }
  }

  async function startTurn(request) {
    requirePlainObject(request, "turn/start request");
    for (const key of Object.keys(request)) {
      if (FORBIDDEN_TURN_OVERRIDES.has(key)) {
        throw new Error(`forbidden turn override ${key}`);
      }
      if (!START_TURN_KEYS.has(key)) {
        throw new TypeError(`unknown turn/start field ${key}`);
      }
    }
    requireIdentifier(request.messageId, "message ID");
    if (
      !Number.isSafeInteger(request.mailboxPeerId) ||
      request.mailboxPeerId < 1
    ) {
      throw new TypeError("mailbox peer ID is invalid");
    }
    const threadId = requireIdentifier(request.threadId, "thread ID");
    if (!Array.isArray(request.input)) {
      throw new TypeError("turn input must be an array");
    }
    if (request.additionalContext !== undefined) {
      requirePlainObject(
        request.additionalContext,
        "additional turn context",
      );
      for (const entry of Object.values(request.additionalContext)) {
        requirePlainObject(entry, "additional turn context entry");
        if (
          !["application", "untrusted"].includes(entry.kind) ||
          typeof entry.value !== "string"
        ) {
          throw new TypeError(
            "additional turn context entry is invalid",
          );
        }
      }
    }
    await validateTurnDispatch(request);
    try {
      return await sendRequest("turn/start", {
        threadId,
        input: structuredClone(request.input),
        clientUserMessageId: request.messageId,
        ...(request.additionalContext === undefined
          ? {}
          : {
              additionalContext: structuredClone(
                request.additionalContext,
              ),
            }),
      });
    } catch (error) {
      if (error instanceof AppServerDisconnectedError && error.sent) {
        await markDeliveryUnknown(
          request,
          "turn-start-acknowledgement-unknown",
        );
        throw new Error(
          `message ${request.messageId} delivery is unknown`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async function steerTurn(request) {
    requirePlainObject(request, "turn/steer request");
    if (request.sourceKind !== "sensor" || request.urgent !== true) {
      throw new Error(
        "turn/steer is restricted to sensor-origin urgent steering",
      );
    }
    requireIdentifier(request.threadId, "thread ID");
    requireIdentifier(request.expectedTurnId, "expected turn ID");
    if (!Array.isArray(request.input)) {
      throw new TypeError("steer input must be an array");
    }
    return sendRequest("turn/steer", {
      threadId: request.threadId,
      expectedTurnId: request.expectedTurnId,
      input: structuredClone(request.input),
      ...(request.additionalContext === undefined
        ? {}
        : {
            additionalContext: structuredClone(
              request.additionalContext,
            ),
          }),
    });
  }

  async function interruptTurn(request) {
    requirePlainObject(request, "turn/interrupt request");
    requireIdentifier(request.threadId, "thread ID");
    requireIdentifier(request.turnId, "turn ID");
    return sendRequest("turn/interrupt", {
      threadId: request.threadId,
      turnId: request.turnId,
    });
  }

  async function reconnect(record, { signal } = {}) {
    return reconnectWithBackoff({
      connect: () => connectAppServer(record, { signal }),
      sleep,
      signal,
      shouldCancel: async () => {
        if (runtimeStopped()) {
          return "runtime-stopped";
        }
        if (
          currentSupervisorGeneration() !== supervisorGeneration
        ) {
          return "generation-changed";
        }
        const endpoint = await inspectEndpoint(record.endpoint);
        if (
          endpoint.listening === true &&
          endpoint.pid !== record.pid
        ) {
          return "foreign-endpoint";
        }
        return null;
      },
      onCancelled: async () => close("reconnect-cancelled"),
    });
  }

  async function close(reason = "client-stopped") {
    const activeSocket = socket;
    socket = null;
    if (activeSocket !== null) {
      await new Promise((resolve) => {
        if (
          [WebSocket.CLOSED, WebSocket.CLOSING].includes(
            activeSocket.readyState,
          )
        ) {
          resolve();
          return;
        }
        activeSocket.once("close", resolve);
        activeSocket.close();
      });
    }
    rejectPending(new Error(reason));
    await recordDisconnect(reason);
  }

  function status() {
    return Object.freeze({
      connected:
        connectedRecord !== null &&
        socket?.readyState === WebSocket.OPEN,
      record:
        connectedRecord === null
          ? null
          : structuredClone(connectedRecord),
      pendingRequestCount: pending.size,
    });
  }

  return Object.freeze({
    connectAppServer,
    startManagedAppServer,
    reconcileAttachments,
    startTurn,
    steerTurn,
    interruptTurn,
    reconnect,
    close,
    status,
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
  });
}

export async function connectAppServer(record, options) {
  const client = createAppServerClient(options);
  await client.connectAppServer(record);
  return client;
}

export async function startManagedAppServer(options) {
  const client = createAppServerClient(options);
  await client.startManagedAppServer(options?.startOptions);
  return client;
}

export async function reconcileAttachments(peers, client) {
  return client.reconcileAttachments(peers);
}

export async function startTurn(request, client) {
  return client.startTurn(request);
}

export async function steerTurn(request, client) {
  return client.steerTurn(request);
}

export async function interruptTurn(request, client) {
  return client.interruptTurn(request);
}
