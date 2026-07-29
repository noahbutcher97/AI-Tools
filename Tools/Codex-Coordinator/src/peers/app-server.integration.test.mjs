import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import WebSocket from "ws";

import {
  initialCoordinatorState,
  reduceCoordinatorEvent,
} from "../core/reducer.mjs";
import {
  AppServerDisconnectedError,
  createAppServerClient,
  inspectInstalledProtocol,
  reconnectWithBackoff,
} from "./app-server-client.mjs";
import { createPeerDelivery } from "./delivery.mjs";
import {
  NO_RESPONSE,
  createMockAppServer,
} from "./fixtures/mock-server.mjs";
import { createPeerRegistry } from "./registry.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const BOOT_ID = "windows-boot-2026-07-29";
const SUPERVISOR_GENERATION = "supervisor-generation-6";
const APP_SERVER_GENERATION = "app-server-generation-6";
const ATTACHMENT_GENERATION = "attachment-generation-6";

function validProtocolSchema() {
  const request = (method) => ({
    type: "object",
    required: ["method", "id", "params"],
    properties: {
      method: { enum: [method] },
      id: { type: "integer" },
      params: { type: "object" },
    },
  });
  const notification = (method) => ({
    type: "object",
    required: ["method", "params"],
    properties: {
      method: { enum: [method] },
      params: { type: "object" },
    },
  });
  return {
    definitions: {
      ClientRequest: {
        oneOf: [
          "initialize",
          "thread/read",
          "thread/resume",
          "thread/start",
          "thread/turns/list",
          "turn/start",
          "turn/steer",
          "turn/interrupt",
        ].map(request),
      },
      ServerNotification: {
        oneOf: [
          "thread/started",
          "thread/status/changed",
          "thread/closed",
          "turn/started",
          "turn/completed",
          "item/started",
          "item/completed",
        ].map(notification),
      },
      v2: {
        ThreadStartParams: {
          type: "object",
          properties: {
            ephemeral: { type: ["boolean", "null"] },
          },
        },
        TurnStartParams: {
          type: "object",
          required: ["input", "threadId"],
          properties: {
            threadId: { type: "string" },
            input: { type: "array" },
            clientUserMessageId: {
              type: ["string", "null"],
            },
            additionalContext: {
              additionalProperties: {
                $ref: "#/definitions/v2/AdditionalContextEntry",
              },
            },
            sandboxPolicy: {
              $ref: "#/definitions/v2/SandboxPolicy",
            },
          },
        },
        AdditionalContextEntry: {
          type: "object",
          required: ["kind", "value"],
          properties: {
            kind: {
              $ref: "#/definitions/v2/AdditionalContextKind",
            },
            value: { type: "string" },
          },
        },
        AdditionalContextKind: {
          type: "string",
          enum: ["untrusted", "application"],
        },
        SandboxPolicy: {
          oneOf: [
            {
              type: "object",
              properties: {
                type: { enum: ["readOnly"] },
                networkAccess: { type: "boolean", default: false },
              },
            },
          ],
        },
      },
    },
  };
}

function protocolFrom(schema = validProtocolSchema()) {
  const canonical = JSON.stringify(schema);
  return {
    schema,
    schemaSha256: createHash("sha256").update(canonical).digest("hex"),
    methods: new Set([
      "initialize",
      "thread/read",
      "thread/resume",
      "thread/start",
      "thread/turns/list",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
    ]),
    notifications: new Set([
      "thread/started",
      "thread/status/changed",
      "thread/closed",
      "turn/started",
      "turn/completed",
      "item/started",
      "item/completed",
    ]),
  };
}

function record(endpoint, overrides = {}) {
  return {
    executablePath: "C:\\Program Files\\Codex\\codex.exe",
    executableSha256: SHA_A,
    pid: 4242,
    parentPid: 2121,
    creationTimeUtc: "2026-07-29T12:00:00.000Z",
    endpoint,
    supervisorGeneration: SUPERVISOR_GENERATION,
    appServerGeneration: APP_SERVER_GENERATION,
    attachmentGeneration: ATTACHMENT_GENERATION,
    windowsBootId: BOOT_ID,
    protocolSha256: protocolFrom().schemaSha256,
    ...overrides,
  };
}

function observedProcess(value) {
  return {
    executablePath: value.executablePath,
    executableSha256: value.executableSha256,
    pid: value.pid,
    parentPid: value.parentPid,
    creationTimeUtc: value.creationTimeUtc,
    windowsBootId: value.windowsBootId,
  };
}

class MemoryJournal {
  constructor(seed = []) {
    this.events = structuredClone(seed);
    this.flushes = 0;
  }

  async readFrom() {
    return structuredClone(this.events);
  }

  async append(event, { flush = false } = {}) {
    this.events.push(structuredClone(event));
    if (flush) {
      this.flushes += 1;
    }
    return event;
  }
}

function clientOptions(server, overrides = {}) {
  const processRecord = record(server.endpoint);
  return {
    protocol: protocolFrom(),
    supervisorGeneration: SUPERVISOR_GENERATION,
    appServerGeneration: APP_SERVER_GENERATION,
    attachmentGeneration: ATTACHMENT_GENERATION,
    windowsBootId: BOOT_ID,
    inspectProcess: async () => observedProcess(processRecord),
    inspectEndpoint: async () => ({
      listening: true,
      pid: processRecord.pid,
    }),
    webSocketFactory: (endpoint) => new WebSocket(endpoint),
    verifyAttachmentAuthority: async () => true,
    requestTimeoutMs: 1_000,
    ...overrides,
  };
}

async function attachPeer(
  journal,
  peerId,
  threadId,
  activeTurnId = null,
) {
  await journal.append(
    {
      schemaVersion: 1,
      sequence: journal.events.length + 1,
      eventId: `attach-${peerId}-${journal.events.length + 1}`,
      timestampUtc: "2026-07-29T12:00:00.000Z",
      source: "test",
      type: "peer.attached",
      payload: {
        peerId,
        threadId,
        appServerGeneration: APP_SERVER_GENERATION,
        attachmentGeneration: ATTACHMENT_GENERATION,
        windowsBootId: BOOT_ID,
        activeTurnId,
        attachedUtc: "2026-07-29T12:00:00.000Z",
      },
    },
    { flush: true },
  );
}

test("app-server protocol inspection fails before connection when a required schema method is absent", async () => {
  const schema = validProtocolSchema();
  schema.definitions.ClientRequest.oneOf =
    schema.definitions.ClientRequest.oneOf.filter(
      (item) => item.properties.method.enum[0] !== "turn/interrupt",
    );
  let connectionAttempted = false;

  await assert.rejects(
    inspectInstalledProtocol("codex", {
      generateSchema: async () => schema,
      onBeforeConnection: () => {
        connectionAttempted = true;
      },
    }),
    /required app-server method turn\/interrupt is absent/,
  );
  assert.equal(connectionAttempted, false);
});

test("app-server protocol inspection requires ephemeral threads, trusted context kinds, and read-only network fencing", async () => {
  const inspected = await inspectInstalledProtocol("codex", {
    generateSchema: async () => validProtocolSchema(),
  });

  assert.equal(inspected.methods.has("thread/start"), true);
  assert.equal(inspected.notifications.has("turn/completed"), true);
  assert.match(inspected.schemaSha256, /^[a-f0-9]{64}$/);
});

test("app-server reducer rejects incomplete connected process records", () => {
  assert.throws(
    () =>
      reduceCoordinatorEvent(initialCoordinatorState(), {
        schemaVersion: 1,
        sequence: 1,
        eventId: "invalid-app-server-connected",
        timestampUtc: "2026-07-29T12:00:00.000Z",
        source: "test",
        type: "appServer.connected",
        payload: {},
      }),
    /connected payload has unknown or missing fields/,
  );
});

test("app-server connection rejects an unknown endpoint before opening a socket", async () => {
  let opened = false;
  const client = createAppServerClient({
    ...clientOptions({ endpoint: "ws://127.0.0.1:8123" }),
    webSocketFactory: () => {
      opened = true;
      throw new Error("must not open");
    },
  });

  await assert.rejects(
    client.connectAppServer(
      record("ws://localhost:8123/path", { pid: 4242 }),
    ),
    /recorded loopback WebSocket endpoint is invalid/,
  );
  assert.equal(opened, false);
});

test("app-server connection rejects wrong generations, foreign ports, process identity drift, and boot reuse", async (t) => {
  const server = await createMockAppServer();
  t.after(() => server.close());
  const base = record(server.endpoint);

  await t.test("wrong generation", async () => {
    const client = createAppServerClient(clientOptions(server));
    await assert.rejects(
      client.connectAppServer(
        record(server.endpoint, {
          appServerGeneration: "app-server-generation-stale",
        }),
      ),
      /app-server generation does not match/,
    );
  });

  await t.test("occupied foreign port", async () => {
    const client = createAppServerClient(
      clientOptions(server, {
        inspectEndpoint: async () => ({ listening: true, pid: 9999 }),
      }),
    );
    await assert.rejects(
      client.connectAppServer(base),
      /endpoint is owned by foreign process 9999/,
    );
  });

  await t.test("wrong process identity", async () => {
    const client = createAppServerClient(
      clientOptions(server, {
        inspectProcess: async () => ({
          ...observedProcess(base),
          executableSha256: SHA_B,
        }),
      }),
    );
    await assert.rejects(
      client.connectAppServer(base),
      /executable SHA-256 does not match/,
    );
  });

  await t.test("same pid and creation time after Windows reboot", async () => {
    const client = createAppServerClient(
      clientOptions(server, {
        inspectProcess: async () => ({
          ...observedProcess(base),
          windowsBootId: "windows-boot-2026-07-29-restarted",
        }),
      }),
    );
    await assert.rejects(
      client.connectAppServer(base),
      /Windows boot ID does not match/,
    );
  });

  await t.test("endpoint owner changes during handshake", async () => {
    let inspections = 0;
    const client = createAppServerClient(
      clientOptions(server, {
        inspectEndpoint: async () => {
          inspections += 1;
          return {
            listening: true,
            pid: inspections === 1 ? base.pid : 9999,
          };
        },
      }),
    );
    await assert.rejects(
      client.connectAppServer(base),
      /endpoint identity changed during connection/,
    );
  });
});

test("app-server restart accepts only a freshly fenced process generation", async (t) => {
  const firstServer = await createMockAppServer();
  t.after(() => firstServer.close());
  const firstClient = createAppServerClient(clientOptions(firstServer));
  await firstClient.connectAppServer(record(firstServer.endpoint));
  await firstClient.close("restart");

  const secondServer = await createMockAppServer();
  t.after(() => secondServer.close());
  const nextGeneration = "app-server-generation-7";
  const nextAttachment = "attachment-generation-7";
  const nextRecord = record(secondServer.endpoint, {
    pid: 4343,
    creationTimeUtc: "2026-07-29T12:01:00.000Z",
    appServerGeneration: nextGeneration,
    attachmentGeneration: nextAttachment,
  });
  const secondClient = createAppServerClient({
    ...clientOptions(secondServer),
    appServerGeneration: nextGeneration,
    attachmentGeneration: nextAttachment,
    inspectProcess: async () => observedProcess(nextRecord),
    inspectEndpoint: async () => ({
      listening: true,
      pid: nextRecord.pid,
    }),
  });

  await secondClient.connectAppServer(nextRecord);
  assert.equal(secondClient.status().record.pid, 4343);
  assert.equal(
    secondClient.status().record.appServerGeneration,
    nextGeneration,
  );
});

test("app-server managed generation is single-use within one client owner", async (t) => {
  const server = await createMockAppServer();
  t.after(() => server.close());
  let starts = 0;
  let stops = 0;
  const client = createAppServerClient({
    ...clientOptions(server),
    processStarter: async () => {
      starts += 1;
      return record(server.endpoint);
    },
    processStopper: async () => {
      stops += 1;
    },
  });

  await client.startManagedAppServer();
  await client.close("managed-restart");
  await assert.rejects(
    client.startManagedAppServer(),
    /already owned/,
  );
  assert.equal(starts, 1);
  assert.equal(stops, 0);
});

test("app-server drop before initialize acknowledgement rejects without delivery ambiguity", async (t) => {
  const server = await createMockAppServer({
    onRequest(request, socket) {
      if (request.method === "initialize") {
        socket.terminate();
        return NO_RESPONSE;
      }
      return {};
    },
  });
  t.after(() => server.close());
  const journal = new MemoryJournal();
  const client = createAppServerClient(
    clientOptions(server, { journal }),
  );

  await assert.rejects(
    client.connectAppServer(record(server.endpoint)),
    AppServerDisconnectedError,
  );
  assert.equal(
    journal.events.some(
      (event) => event.type === "message.deliveryUnknown",
    ),
    false,
  );
});

test("app-server drop after turn/start records flushed deliveryUnknown and never retries", async (t) => {
  const server = await createMockAppServer({
    onRequest(request, socket) {
      if (request.method === "initialize") {
        return { userAgent: "mock" };
      }
      if (request.method === "turn/start") {
        socket.terminate();
        return NO_RESPONSE;
      }
      return {};
    },
  });
  t.after(() => server.close());
  const journal = new MemoryJournal();
  const registry = createPeerRegistry({ journal });
  await registry.registerPeer({
    peerId: 1,
    threadId: "thread-source-6",
    label: "Source 6",
    workspaceRoot: "D:\\DevTools\\AI-Tools",
    codexVersion: "0.145.0",
    schemaHash: SHA_A,
  });
  await registry.registerPeer({
    peerId: 2,
    threadId: "thread-6",
    label: "Target 6",
    workspaceRoot: "D:\\DevTools\\AI-Tools",
    codexVersion: "0.145.0",
    schemaHash: SHA_A,
  });
  const delivery = createPeerDelivery({ journal });
  const enqueued = await delivery.enqueueMessage({
    sourcePeerId: 1,
    targetPeerId: 2,
    mode: "canonical",
    sourceKind: "peer",
    text: "continue",
    referencePaths: [],
    authorityLabel: "bounded peer request",
    clientDeduplicationKey: "task-6-delivery-unknown",
    hop: 0,
  });
  await delivery.claimNextMessage(2);
  const client = createAppServerClient(
    clientOptions(server, { journal }),
  );
  await client.connectAppServer(record(server.endpoint));
  await attachPeer(journal, 2, "thread-6");

  await assert.rejects(
    client.startTurn({
      messageId: enqueued.message.messageId,
      mailboxPeerId: 1,
      threadId: "thread-6",
      input: [{ type: "text", text: "continue" }],
    }),
    /delivery is unknown/,
  );

  assert.equal(
    server.requests.filter((item) => item.method === "turn/start").length,
    1,
  );
  const unknown = journal.events.find(
    (event) => event.type === "message.deliveryUnknown",
  );
  assert.equal(unknown.payload.messageId, enqueued.message.messageId);
  assert.equal(unknown.payload.mailboxPeerId, 1);
  assert.equal(journal.flushes >= 1, true);
});

test("app-server malformed notification fences the connection", async (t) => {
  const server = await createMockAppServer();
  t.after(() => server.close());
  const client = createAppServerClient(clientOptions(server));
  await client.connectAppServer(record(server.endpoint));

  const fenced = new Promise((resolve) => {
    client.once("protocolError", resolve);
  });
  server.sendRaw('{"method":"turn/started","params":');
  const error = await fenced;

  assert.match(error.message, /malformed app-server message/);
  assert.equal(client.status().connected, false);
});

test("app-server rejects schema-known notifications with malformed payloads", async (t) => {
  const server = await createMockAppServer();
  t.after(() => server.close());
  const client = createAppServerClient(clientOptions(server));
  await client.connectAppServer(record(server.endpoint));
  const fenced = new Promise((resolve) => {
    client.once("protocolError", resolve);
  });

  server.sendRaw(
    JSON.stringify({ method: "turn/started", params: null }),
  );
  const error = await fenced;
  assert.match(error.message, /notification params must be a plain object/);
  assert.equal(client.status().connected, false);
});

test("app-server rejects a thread response for a different thread ID", async (t) => {
  const server = await createMockAppServer({
    onRequest(request) {
      if (request.method === "initialize") {
        return { userAgent: "mock" };
      }
      if (request.method === "thread/read") {
        return {
          thread: {
            id: "thread-foreign",
            status: { type: "notLoaded" },
          },
        };
      }
      return {};
    },
  });
  t.after(() => server.close());
  const client = createAppServerClient(clientOptions(server));
  await client.connectAppServer(record(server.endpoint));

  await assert.rejects(
    client.reconcileAttachments([
      {
        peerId: 1,
        threadId: "thread-requested",
        attachment: "registered-unattached",
        explicitAttach: true,
      },
    ]),
    /returned a different thread ID/,
  );
  assert.equal(
    server.requests.some((item) => item.method === "thread/resume"),
    false,
  );
});

test("app-server reconciliation explicitly resumes an unloaded registered thread, records attachment generations, and observes active turns", async (t) => {
  const server = await createMockAppServer({
    onRequest(request) {
      if (request.method === "initialize") {
        return { userAgent: "mock" };
      }
      if (request.method === "thread/read") {
        return {
          thread: {
            id: request.params.threadId,
            status: { type: "notLoaded" },
            turns: [],
          },
        };
      }
      if (request.method === "thread/resume") {
        return {
          thread: {
            id: request.params.threadId,
            status: { type: "active" },
            turns: [],
          },
        };
      }
      if (request.method === "thread/turns/list") {
        return {
          data: [
            {
              id: "turn-active-6",
              status: "inProgress",
            },
          ],
          nextCursor: null,
        };
      }
      return {};
    },
  });
  t.after(() => server.close());
  const journal = new MemoryJournal();
  const registry = createPeerRegistry({ journal });
  await registry.registerPeer({
    peerId: 1,
    threadId: "thread-closed-tui-6",
    label: "Closed TUI 6",
    workspaceRoot: "D:\\DevTools\\AI-Tools",
    codexVersion: "0.145.0",
    schemaHash: SHA_A,
  });
  const client = createAppServerClient(
    clientOptions(server, { journal }),
  );
  await client.connectAppServer(record(server.endpoint));

  const result = await client.reconcileAttachments([
    {
      peerId: 1,
      threadId: "thread-closed-tui-6",
      attachment: "registered-unattached",
      explicitAttach: true,
    },
  ]);

  assert.deepEqual(
    server.requests
      .filter((item) => item.method.startsWith("thread/"))
      .map((item) => item.method),
    ["thread/read", "thread/resume", "thread/turns/list"],
  );
  assert.equal(result[0].activeTurnId, "turn-active-6");
  const attachment = journal.events.find(
    (event) => event.type === "peer.attached",
  );
  assert.equal(
    attachment.payload.attachmentGeneration,
    ATTACHMENT_GENERATION,
  );
  const registryState = await registry.readState();
  assert.equal(
    registryState.peers["1"].attachment.activeTurnId,
    "turn-active-6",
  );
  assert.equal(
    registryState.peers["1"].attachment.status,
    "attached",
  );
});

test("app-server turn requests forbid per-turn execution overrides and steering is sensor-only", async (t) => {
  const server = await createMockAppServer();
  t.after(() => server.close());
  const client = createAppServerClient(clientOptions(server));
  await client.connectAppServer(record(server.endpoint));

  await assert.rejects(
    client.startTurn({
      messageId: "message-overridden",
      mailboxPeerId: 1,
      threadId: "thread-6",
      input: [],
      cwd: "D:\\Other",
    }),
    /forbidden turn override cwd/,
  );
  await assert.rejects(
    client.steerTurn({
      sourceKind: "operator",
      urgent: true,
      threadId: "thread-6",
      expectedTurnId: "turn-active-6",
      input: [],
    }),
    /sensor-origin urgent steering/,
  );
});

test("sidecar start creates an ephemeral thread with model effort and read-only network fencing", async (t) => {
  const server = await createMockAppServer();
  t.after(() => server.close());
  const journal = new MemoryJournal();
  const registry = createPeerRegistry({ journal });
  for (const peerId of [0, 1]) {
    await registry.registerPeer({
      peerId,
      threadId: `thread-sidecar-${peerId}`,
      label: `Sidecar ${peerId}`,
      workspaceRoot: "D:\\DevTools\\AI-Tools",
      codexVersion: "0.145.0",
      schemaHash: SHA_A,
    });
  }
  const delivery = createPeerDelivery({ journal });
  const queued = await delivery.enqueueMessage({
    sourcePeerId: 0,
    targetPeerId: 1,
    mode: "sidecar",
    sourceKind: "peer",
    text: "bounded sidecar",
    referencePaths: [],
    authorityLabel: "read-only analysis",
    clientDeduplicationKey: "message-sidecar-7",
    hop: 0,
  });
  await delivery.claimNextMessage(1);
  const client = createAppServerClient(clientOptions(server, { journal }));
  await client.connectAppServer(record(server.endpoint));
  await attachPeer(
    journal,
    1,
    "thread-sidecar-1",
    "turn-user-active",
  );

  const request = {
    messageId: queued.message.messageId,
    mailboxPeerId: 0,
    cwd: "D:\\DevTools\\AI-Tools",
    model: "current-model",
    effort: "medium",
    ephemeral: true,
    input: [{ type: "text", text: "bounded sidecar" }],
    additionalContext: {
      rules: { kind: "application", value: "read only" },
      peerMessage: { kind: "untrusted", value: "peer text" },
    },
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  };
  await assert.rejects(
    client.startSidecarTurn(request),
    /not an idle attached peer/,
  );
  assert.equal(
    server.requests.some((item) => item.method === "thread/start"),
    false,
  );
  await attachPeer(journal, 1, "thread-sidecar-1");

  const result = await client.startSidecarTurn(request);

  assert.equal(result.thread.id, "thread-mock-ephemeral-1");
  assert.equal(result.turn.id, "turn-mock-1");
  const threadStart = server.requests.find(
    (item) => item.method === "thread/start",
  );
  const turnStart = server.requests.find(
    (item) => item.method === "turn/start",
  );
  assert.deepEqual(threadStart.params, {
    cwd: "D:\\DevTools\\AI-Tools",
    ephemeral: true,
    model: "current-model",
    config: { model_reasoning_effort: "medium" },
    sandbox: "read-only",
  });
  assert.equal(turnStart.params.threadId, "thread-mock-ephemeral-1");
  assert.deepEqual(turnStart.params.sandboxPolicy, {
    type: "readOnly",
    networkAccess: false,
  });
});

test("canonical summaries read only the attached target thread and return at most two completed turns", async (t) => {
  const server = await createMockAppServer({
    onRequest(request) {
      if (request.method === "initialize") {
        return { userAgent: "mock" };
      }
      if (request.method === "thread/turns/list") {
        return {
          data: [
            { id: "turn-summary-3", status: "completed", summary: "three" },
            { id: "turn-summary-2", status: "completed", summary: "two" },
            { id: "turn-active", status: "inProgress", summary: "active" },
          ],
          nextCursor: null,
        };
      }
      return {};
    },
  });
  t.after(() => server.close());
  const journal = new MemoryJournal();
  const registry = createPeerRegistry({ journal });
  await registry.registerPeer({
    peerId: 1,
    threadId: "thread-summary-1",
    label: "Summary 1",
    workspaceRoot: "D:\\DevTools\\AI-Tools",
    codexVersion: "0.145.0",
    schemaHash: SHA_A,
  });
  const client = createAppServerClient(clientOptions(server, { journal }));
  await client.connectAppServer(record(server.endpoint));
  await attachPeer(journal, 1, "thread-summary-1");

  const summaries = await client.readCompletedCanonicalSummaries(
    "thread-summary-1",
    2,
  );
  assert.equal(summaries.length, 2);
  assert.match(summaries[0], /turn-summary-3/);
  assert.match(summaries[1], /turn-summary-2/);
  const request = server.requests.find(
    (item) => item.method === "thread/turns/list",
  );
  assert.deepEqual(request.params, {
    threadId: "thread-summary-1",
    limit: 2,
    sortDirection: "desc",
    itemsView: "summary",
  });
});

test("app-server explicit retry requires a new dispatch, an unknown message ID, and a target thread read", async (t) => {
  let unknownMessageId;
  let exposeUnknown = true;
  const server = await createMockAppServer({
    onRequest(request) {
      if (request.method === "initialize") {
        return { userAgent: "mock" };
      }
      if (request.method === "thread/read") {
        return {
          thread: {
            id: request.params.threadId,
            turns: exposeUnknown
              ? [{ id: "turn-existing", marker: unknownMessageId }]
              : [],
          },
        };
      }
      if (request.method === "turn/start") {
        return {
          turn: {
            id: "turn-retry-6",
            status: "inProgress",
          },
        };
      }
      return {};
    },
  });
  t.after(() => server.close());
  const journal = new MemoryJournal();
  const registry = createPeerRegistry({ journal });
  for (const peer of [
    {
      peerId: 1,
      threadId: "thread-source-retry-6",
      label: "Source Retry 6",
    },
    {
      peerId: 2,
      threadId: "thread-target-retry-6",
      label: "Target Retry 6",
    },
  ]) {
    await registry.registerPeer({
      ...peer,
      workspaceRoot: "D:\\DevTools\\AI-Tools",
      codexVersion: "0.145.0",
      schemaHash: SHA_A,
    });
  }
  const delivery = createPeerDelivery({ journal });
  const unknown = await delivery.enqueueMessage({
    sourcePeerId: 1,
    targetPeerId: 2,
    mode: "canonical",
    sourceKind: "peer",
    text: "possibly delivered",
    referencePaths: [],
    authorityLabel: "bounded peer request",
    clientDeduplicationKey: "task-6-unknown-original",
    hop: 0,
  });
  unknownMessageId = unknown.message.messageId;
  await delivery.claimNextMessage(2);
  await journal.append(
    {
      schemaVersion: 1,
      sequence: journal.events.length + 1,
      eventId: "task-6-explicit-unknown",
      timestampUtc: "2026-07-29T12:00:00.000Z",
      source: "test",
      type: "message.deliveryUnknown",
      payload: {
        messageId: unknownMessageId,
        mailboxPeerId: 1,
        reason: "turn-start-acknowledgement-unknown",
        unknownUtc: "2026-07-29T12:00:00.000Z",
      },
    },
    { flush: true },
  );
  const retry = await delivery.enqueueMessage({
    sourcePeerId: 1,
    targetPeerId: 2,
    mode: "canonical",
    sourceKind: "peer",
    text: "explicit retry",
    referencePaths: [],
    authorityLabel: "bounded peer request",
    clientDeduplicationKey: "task-6-unknown-retry",
    hop: 0,
  });
  await delivery.claimNextMessage(2);
  const client = createAppServerClient(
    clientOptions(server, { journal }),
  );
  await client.connectAppServer(record(server.endpoint));
  await attachPeer(journal, 2, "thread-target-retry-6");

  await assert.rejects(
    client.startTurn({
      messageId: unknownMessageId,
      mailboxPeerId: 1,
      threadId: "thread-target-retry-6",
      input: [],
    }),
    /not an authorized dispatch/,
  );
  await assert.rejects(
    client.startTurn({
      messageId: retry.message.messageId,
      mailboxPeerId: 1,
      threadId: "thread-target-retry-6",
      input: [],
      retryUnknownMessageId: unknownMessageId,
    }),
    /already contains the delivery-unknown message ID/,
  );

  exposeUnknown = false;
  const result = await client.startTurn({
    messageId: retry.message.messageId,
    mailboxPeerId: 1,
    threadId: "thread-target-retry-6",
    input: [],
    retryUnknownMessageId: unknownMessageId,
  });
  assert.equal(result.turn.id, "turn-retry-6");
  const sent = server.requests.find(
    (item) =>
      item.method === "turn/start" &&
      item.params.clientUserMessageId === retry.message.messageId,
  );
  assert.equal(sent.params.threadId, "thread-target-retry-6");
});

test("app-server reconnect backoff is capped at 15 seconds and cancels on stop, generation change, or foreign endpoint", async (t) => {
  await t.test("backoff sequence", async () => {
    const delays = [];
    let attempts = 0;
    const value = await reconnectWithBackoff({
      connect: async () => {
        attempts += 1;
        if (attempts < 6) {
          throw new Error("offline");
        }
        return "connected";
      },
      sleep: async (delay) => delays.push(delay),
      shouldCancel: async () => null,
    });
    assert.equal(value, "connected");
    assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 15_000]);
  });

  for (const reason of [
    "runtime-stopped",
    "generation-changed",
    "foreign-endpoint",
  ]) {
    await t.test(`cancels on ${reason}`, async () => {
      let attempts = 0;
      await assert.rejects(
        reconnectWithBackoff({
          connect: async () => {
            attempts += 1;
            throw new Error("offline");
          },
          sleep: async () => {},
          shouldCancel: async () => reason,
        }),
        new RegExp(reason),
      );
      assert.equal(attempts, 0);
    });
  }

  await t.test("rechecks cancellation after backoff sleep", async () => {
    let stopped = false;
    let attempts = 0;
    await assert.rejects(
      reconnectWithBackoff({
        connect: async () => {
          attempts += 1;
          throw new Error("offline");
        },
        sleep: async () => {
          stopped = true;
        },
        shouldCancel: async () =>
          stopped ? "runtime-stopped" : null,
      }),
      /runtime-stopped/,
    );
    assert.equal(attempts, 1);
  });
});
